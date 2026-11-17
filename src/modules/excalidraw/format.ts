// The file format of a drawing: `<name>.excalidraw.md`, as the Obsidian Excalidraw plugin
// writes it with compression off, also for files written by other tools in this format:
//
//     <frontmatter with `excalidraw-plugin: parsed`>
//     # Excalidraw Data
//
//     ## Text Elements
//     <raw text> ^<8-char id>
//
//     ## Element Links
//     <8-char id>: [[Note]]
//
//     %%
//     ## Drawing
//     ```json
//     { "type": "excalidraw", "elements": [...], ... }
//     ```
//     %%
//
// Pure functions over text: no React and no DOM, so `pnpm test:excalidraw` runs them in plain Node.

import { type Eol, eolOf, toLf, withEol } from "../../components/lineEndings.ts";

export interface SceneElement {
  id: string;
  type: string;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface Scene {
  elements: SceneElement[];
  files?: Record<string, unknown>;
  appState?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Drawing {
  scene: Scene;
  /** The file's text up to the scene JSON, as found. */
  before: string;
  /** The file's text from the fence that closes the scene JSON, as found. */
  after: string;
  /** The file's line ending. `before` and `after` are held with "\n"; `serialize` writes this one again. */
  eol: Eol;
}

/** Reads a drawing file. Throws, saying why, if it is not one this app can show and save. */
export function parse(text: string): Drawing {
  const eol = eolOf(text);
  text = toLf(text);
  if (text.includes("```compressed-json\n")) {
    throw new Error(
      'the drawing is saved compressed. In Obsidian, run "Decompress current Excalidraw file" and turn off compression in the Excalidraw plugin\'s Saving settings',
    );
  }
  const marker = /(?:^|\n)##? Drawing\n[^`]*```json\n/.exec(text);
  if (!marker) throw new Error("it has no `## Drawing` json block, so it is not an Excalidraw drawing");
  const start = marker.index + marker[0].length;
  // The newline that ends the line before the JSON also starts an empty block's closing fence.
  const end = text.indexOf("\n```", start - 1);
  if (end < 0) throw new Error("its `## Drawing` json block is not closed");
  let scene: unknown;
  try {
    scene = JSON.parse(text.slice(start, Math.max(start, end)));
  } catch (e) {
    throw new Error(`its drawing data is not valid JSON (${e instanceof Error ? e.message : e})`);
  }
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    throw new Error("its drawing data is not a JSON object");
  }
  const elements = (scene as Scene).elements ?? [];
  if (!Array.isArray(elements)) throw new Error("its drawing data has no list of elements");
  return { scene: { ...(scene as Scene), elements }, before: text.slice(0, start), after: text.slice(Math.max(start, end)), eol };
}

/**
 * The file's text with `elements` (and `files`, when given) as its scene.
 * Deleted elements are left out. Everything outside the scene JSON is kept byte for byte, except
 * the `## Text Elements` and `## Element Links` sections, which are written again from the elements
 * as files written by other tools in this format have them (Obsidian reads search text and links from them). A file without a
 * `## Text Elements` section does not get one. The JSON is plain, indented with tabs, never compressed.
 */
export function serialize(drawing: Drawing, elements: readonly SceneElement[], files?: Record<string, unknown>): string {
  const was = new Map(drawing.scene.elements.map((e) => [e.id, e]));
  const live = shortTextIds(elements.filter((e) => !e.isDeleted)).map((e) => {
    const old = was.get(e.id);
    if (!old) return e;
    // Excalidraw drops properties it does not know, e.g. the Obsidian plugin's `rawText`
    // (a text's source, with its `[[links]]`). What the file had is kept, unless the text was edited.
    const merged = { ...old, ...e };
    if (old.rawText !== undefined && e.originalText !== old.originalText) merged.rawText = e.originalText ?? e.text;
    return merged;
  });
  const scene = { ...drawing.scene, elements: live, files: files ?? drawing.scene.files };
  return withEol(sections(drawing.before, live) + JSON.stringify(scene, null, "\t") + drawing.after, drawing.eol);
}

/**
 * Gives every text element an id of exactly 8 characters, and updates what points at it.
 * The Obsidian plugin finds a text's block in `## Text Elements` with `\s\^(.{8})[\n]+`,
 * and Excalidraw itself makes longer ids. The new id is the start of the old one, so each save picks the same.
 * It is never an id another element has or was just given. An id of 8 characters is left as it is.
 */
function shortTextIds(elements: SceneElement[]): SceneElement[] {
  const used = new Set(elements.map((e) => e.id));
  const renamed = new Map<string, string>();
  for (const e of elements) {
    if (e.type !== "text" || e.id.length === 8) continue;
    const start = e.id.padEnd(8, "0").slice(0, 8);
    let id = start;
    for (let i = 1; used.has(id) && i + 8 <= e.id.length; i++) id = e.id.slice(i, i + 8);
    // Still taken, as for `t1` and `t10`, which both start as `t1000000`: the start with a number at its
    // end, counted up until the id is free.
    for (let n = 1; used.has(id); n++) id = start.slice(0, 8 - String(n).length) + n;
    used.add(id);
    renamed.set(e.id, id);
  }
  if (!renamed.size) return elements;
  const name = (id: unknown) => (typeof id === "string" ? (renamed.get(id) ?? id) : id);
  const end = (binding: unknown) =>
    binding && typeof binding === "object" ? { ...binding, elementId: name((binding as { elementId?: unknown }).elementId) } : binding;
  return elements.map((e) => ({
    ...e,
    id: name(e.id) as string,
    ...(Array.isArray(e.boundElements) && {
      boundElements: e.boundElements.map((b: { id: string }) => ({ ...b, id: name(b.id) })),
    }),
    ...("startBinding" in e && { startBinding: end(e.startBinding) }),
    ...("endBinding" in e && { endBinding: end(e.endBinding) }),
  }));
}

/** `before` with its `## Text Elements` and `## Element Links` sections written from `live`. */
function sections(before: string, live: SceneElement[]): string {
  const heading = /^##? Text Elements[ \t]*\n/m.exec(before);
  if (!heading) return before;
  const from = heading.index + heading[0].length;
  // The two sections end where `## Embedded Files` starts, or the lines that open the scene block.
  const length = before.slice(from).search(/^(?:## Embedded Files\n|%%\n##? Drawing\n|##? Drawing\n)/m);
  if (length < 0) return before;
  const texts = live
    .filter((e) => e.type === "text")
    .map((e) => `${e.rawText || e.originalText || e.text} ^${e.id}\n\n`);
  const links = live.filter((e) => e.link).map((e) => `${e.id}: ${e.link}\n\n`);
  return (
    before.slice(0, from) + texts.join("") + (links.length ? "## Element Links\n" + links.join("") : "") + before.slice(from + length)
  );
}

/**
 * The frame's slideshow record, `frame.customData.slideshow`, in its normal form, or null when the frame has none or
 * an invalid one. The format is the one the Obsidian Excalidraw plugin's slideshow script writes; it is specified
 * in docs/slideshow-spec.md, "The slideshow record". `withNotes` in slideshow.ts is the one place this app writes it.
 */
export function slideshowData(frame: SceneElement): SlideshowData | null {
  const stored = (frame.customData as { slideshow?: unknown } | null | undefined)?.slideshow;
  if (!isObject(stored)) return null;
  const { schemaVersion, kind, order, excluded, deckName, notes, animation } = stored;
  if (schemaVersion !== 2 || kind !== "frame" || !Number.isInteger(order) || (order as number) < 0) return null;
  if (excluded !== undefined && typeof excluded !== "boolean") return null;
  if (!optionalString(deckName) || !optionalString(notes)) return null;
  const data: SlideshowData = { schemaVersion, kind, order: order as number };
  if (excluded !== undefined) data.excluded = excluded;
  if (deckName?.trim()) data.deckName = deckName;
  if (notes?.trim()) data.notes = notes;
  if (animation !== undefined) {
    if (!isObject(animation) || !Array.isArray(animation.steps)) return null;
    const steps = animation.steps.map(buildStep);
    // One step the app cannot play makes the record one it must not half play.
    if (steps.includes(null)) return null;
    data.animation = { steps: steps as BuildStep[] };
  }
  return data;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
/** A field that may be left out, and is a time in milliseconds when it is there. */
const optionalMs = (value: unknown): value is number | undefined => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

const EFFECTS: readonly unknown[] = ["appear", "fade", "slide", "zoom", "disappear", "fade-out", "slide-out", "zoom-out"] satisfies BuildStep["effect"][];
const DIRECTIONS: readonly unknown[] = ["left", "right", "up", "down"] satisfies NonNullable<BuildStep["direction"]>[];

/** A stored step in its normal form, or null when it is not a valid one. See docs/slideshow-spec.md, "A step" and "A target". */
function buildStep(stored: unknown): BuildStep | null {
  if (!isObject(stored)) return null;
  const { id, targets, effect, trigger, delayMs, durationMs, direction } = stored;
  if (typeof id !== "string" || !id || !Array.isArray(targets) || !targets.length) return null;
  if (!EFFECTS.includes(effect) || (trigger !== "advance" && trigger !== "after-delay")) return null;
  if (!optionalMs(delayMs) || !optionalMs(durationMs) || (direction !== undefined && !DIRECTIONS.includes(direction))) return null;
  const step: BuildStep = { id, targets: [], effect: effect as BuildStep["effect"], trigger };
  for (const target of targets) {
    if (!isObject(target) || (target.type !== "element" && target.type !== "group") || typeof target.id !== "string" || !target.id) return null;
    // Any other `scope` is the frame's, which is what leaving it out means.
    step.targets.push({ type: target.type, id: target.id, ...(target.scope === "viewport" && { scope: "viewport" as const }) });
  }
  // The defaults are applied where the step plays, so what was read says what the file has.
  if (delayMs !== undefined) step.delayMs = delayMs;
  if (durationMs !== undefined) step.durationMs = durationMs;
  if (direction !== undefined) step.direction = direction as BuildStep["direction"];
  return step;
}

/** One build of a slide: an entry of `animation.steps`. See docs/slideshow-spec.md, "A step". */
export interface BuildStep {
  id: string;
  /** Elements by id, or groups by group id. With `scope: "viewport"` a target counts when it is anywhere on screen with the slide, not only over the frame. */
  targets: { type: "element" | "group"; id: string; scope?: "viewport" }[];
  /** The first four bring the targets in; `disappear` and the `-out` ones take them away. */
  effect: "appear" | "fade" | "slide" | "zoom" | "disappear" | "fade-out" | "slide-out" | "zoom-out";
  /** `advance`: when the presenter moves on. `after-delay`: by itself, `delayMs` after the build before it. */
  trigger: "advance" | "after-delay";
  delayMs?: number;
  durationMs?: number;
  /** For `slide`: the side it comes in from. For `slide-out`: the side it leaves to. */
  direction?: "left" | "right" | "up" | "down";
}

export interface SlideshowData {
  schemaVersion: 2;
  kind: "frame";
  order: number;
  excluded?: boolean;
  deckName?: string;
  /** Presenter notes, Markdown. */
  notes?: string;
  animation?: { steps: BuildStep[] };
}

export interface Slide<T> {
  frame: T;
  /** The frame's name, or `Frame 03` for the third frame of the scene when it has none. */
  title: string;
  /** The frame's slideshow data, or null: see `slideshowData`. */
  data: SlideshowData | null;
}

/**
 * Every frame of the drawing in presenting order, excluded ones too, each with its title and slideshow data.
 * See docs/slideshow-spec.md, "The deck".
 */
export function deck<T extends SceneElement>(elements: readonly T[]): Slide<T>[] {
  const all = elements
    .filter((e) => e.type === "frame" && !e.isDeleted)
    .map((frame, i) => ({ frame, title: typeof frame.name === "string" ? frame.name : `Frame ${String(i + 1).padStart(2, "0")}`, data: slideshowData(frame) }));
  // `sort` keeps the element list's order for frames that compare equal. Titles are compared by code unit, which
  // is what `<` does on strings, so the order does not depend on the system's language.
  return all.sort((a, b) => {
    if (a.data && b.data) return a.data.order - b.data.order;
    if (a.data || b.data) return a.data ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
}

/** The slides of a slideshow: `deck` without the frames marked `excluded`. */
export function slides<T extends SceneElement>(elements: readonly T[]): Slide<T>[] {
  return deck(elements).filter((slide) => !slide.data?.excluded);
}

/** The largest zoom a slide is shown at, which is also Excalidraw's own limit. */
const MAX_ZOOM = 30;

/**
 * The canvas zoom and scroll that show a slide: as large as fits in a
 * viewport of `width` by `height` CSS pixels with no margin, centred.
 * Excalidraw draws a scene point `p` at `(p + scroll) * zoom`.
 */
export function fitSlide(slide: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const zoom = Math.min(width / slide.width, height / slide.height, MAX_ZOOM);
  return {
    zoom,
    scrollX: (width / zoom - slide.width) / 2 - slide.x,
    scrollY: (height / zoom - slide.height) / 2 - slide.y,
  };
}
