// The rules of a slideshow that do not need the canvas: which elements a build step shows or hides, what Forward
// and Backward do, and how presenter notes are written into a frame. The data format is the one the Obsidian
// Excalidraw plugin's slideshow script writes, so a deck made there plays here, and the other way round.
// The format and the behaviour are specified in docs/slideshow-spec.md.
//
// Pure functions: no React and no DOM, so `pnpm test:excalidraw` runs them in plain Node.

import { deck, fitSlide, type BuildStep, type SceneElement } from "./format.ts";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether the effect takes its targets away. The others bring them in. */
export function exits(effect: BuildStep["effect"]): boolean {
  return effect === "disappear" || effect.endsWith("-out");
}

/** A geometry field of an element, or 0 for one the element does not have. */
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Whether the element's box touches the rectangle. See docs/slideshow-spec.md, "Which elements are on a slide". */
export function overlaps(e: SceneElement, rect: Rect): boolean {
  const centreX = number(e.x) + number(e.width) / 2;
  const centreY = number(e.y) + number(e.height) / 2;
  // Half the size of the upright box around the element turned about its centre. A negative size spans the same area.
  const halfWidth = Math.abs(number(e.width)) / 2;
  const halfHeight = Math.abs(number(e.height)) / 2;
  const cos = Math.abs(Math.cos(number(e.angle)));
  const sin = Math.abs(Math.sin(number(e.angle)));
  const reachX = halfWidth * cos + halfHeight * sin;
  const reachY = halfWidth * sin + halfHeight * cos;
  // `<=`: sharing only an edge or a corner counts.
  return (
    centreX - reachX <= rect.x + rect.width &&
    centreX + reachX >= rect.x &&
    centreY - reachY <= rect.y + rect.height &&
    centreY + reachY >= rect.y
  );
}

/** The screen a deck's author is taken to see a slide on: it decides which off-frame elements a `viewport` target can reach. */
const REFERENCE_SCREEN = { width: 1920, height: 1080 };
/** How far the area of a `viewport` target reaches past what the screens show, as a share of that on each side. */
const VIEWPORT_MARGIN = 0.1;

/** What a screen of this size shows of the drawing with the frame fitted on it. */
function shownOn(frame: Rect, screen: { width: number; height: number }): Rect {
  const { zoom, scrollX, scrollY } = fitSlide(frame, screen.width, screen.height);
  return { x: -scrollX, y: -scrollY, width: screen.width / zoom, height: screen.height / zoom };
}

/** The area a `viewport` target looks in. See docs/slideshow-spec.md, "Viewport scope". */
function viewportArea(frame: Rect, viewport?: { width: number; height: number }): Rect {
  const screens = [shownOn(frame, REFERENCE_SCREEN), ...(viewport ? [shownOn(frame, viewport)] : [])];
  const left = Math.min(...screens.map((s) => s.x));
  const top = Math.min(...screens.map((s) => s.y));
  const width = Math.max(...screens.map((s) => s.x + s.width)) - left;
  const height = Math.max(...screens.map((s) => s.y + s.height)) - top;
  return {
    x: left - width * VIEWPORT_MARGIN,
    y: top - height * VIEWPORT_MARGIN,
    width: width * (1 + 2 * VIEWPORT_MARGIN),
    height: height * (1 + 2 * VIEWPORT_MARGIN),
  };
}

/**
 * What a step has when the file leaves the field out. Part of the format: the Obsidian plugin does not write a
 * value the author kept, so a deck plays the same here only with the same two numbers.
 */
export const DEFAULT_DELAY_MS = 1000;
export const DEFAULT_DURATION_MS = 350;

/** A build step with the elements it acts on now. */
export interface Build {
  step: BuildStep;
  ids: string[];
}

/**
 * The steps of a slide with the elements each acts on, looked up in `elements` as they are now. A step that acts
 * on nothing is left out. `viewport` is the presenting window's size in CSS pixels, when known.
 * See docs/slideshow-spec.md, "Build steps of a slide".
 */
export function builds(frame: SceneElement, steps: readonly BuildStep[], elements: readonly SceneElement[], viewport?: { width: number; height: number }): Build[] {
  // The slide's own frame is left out here, so no target can find it.
  const live = elements.filter((e) => !e.isDeleted && e.id !== frame.id);
  const byId = new Map(live.map((e) => [e.id, e]));

  // Visual units: a text and what it is bound to. `partners` holds both ways of every such pair, and a unit is
  // everything that can be reached over pairs.
  const partners = new Map<string, string[]>();
  const pair = (a: string, b: string) => {
    partners.set(a, [...(partners.get(a) ?? []), b]);
    partners.set(b, [...(partners.get(b) ?? []), a]);
  };
  for (const e of live) {
    if (e.type === "text" && typeof e.containerId === "string" && byId.has(e.containerId)) pair(e.id, e.containerId);
    for (const bound of Array.isArray(e.boundElements) ? (e.boundElements as { id?: unknown }[]) : []) {
      if (typeof bound?.id === "string" && byId.get(bound.id)?.type === "text") pair(e.id, bound.id);
    }
  }
  const unit = (id: string) => {
    const found = new Set([id]);
    for (const member of found) for (const partner of partners.get(member) ?? []) found.add(partner);
    return [...found];
  };

  const rect = { x: number(frame.x), y: number(frame.y), width: number(frame.width), height: number(frame.height) };
  let wide: Rect | undefined;
  const out: Build[] = [];
  for (const step of steps) {
    const ids = new Set<string>();
    for (const target of step.targets) {
      const area = target.scope === "viewport" ? (wide ??= viewportArea(rect, viewport)) : rect;
      const on = (id: string) => overlaps(byId.get(id)!, area);
      if (target.type === "element") {
        // The whole unit comes when any member is on the slide, also when the targeted one is not.
        const members = byId.has(target.id) ? unit(target.id) : [];
        if (members.some(on)) for (const id of members) ids.add(id);
      } else {
        for (const e of live) {
          if (Array.isArray(e.groupIds) && e.groupIds.includes(target.id) && on(e.id)) for (const id of unit(e.id)) ids.add(id);
        }
      }
    }
    if (ids.size) out.push({ step, ids: [...ids] });
  }
  return out;
}

/** The elements that are hidden when the first `done` builds have run. See docs/slideshow-spec.md, "Hidden elements". */
export function hidden(steps: readonly Build[], done: number): Set<string> {
  const state = new Map<string, boolean>();
  // Builds that have not run, last to first: what is left for an element is the first of them that acts on it,
  // and before an entrance it is hidden.
  for (let i = steps.length - 1; i >= Math.max(done, 0); i--) for (const id of steps[i].ids) state.set(id, !exits(steps[i].step.effect));
  // Builds that have run, first to last, over that: the last one that acts on an element decides.
  for (const { step, ids } of steps.slice(0, Math.max(done, 0))) for (const id of ids) state.set(id, exits(step.effect));
  return new Set([...state].filter(([, gone]) => gone).map(([id]) => id));
}

/** Where a slideshow is: the slide, from 0, how many of its builds have run, and how many it has. */
export interface Place {
  slide: number;
  done: number;
  total: number;
}

/**
 * Where Forward (1) or Backward (-1) leads in a deck of `count` slides, or null when it ends the slideshow.
 * `done: "all"` stands for a slide entered backward: its builds are only known once it is entered.
 * See docs/slideshow-spec.md, "Moving through a slideshow".
 */
export function stepFrom(now: Place, count: number, by: 1 | -1): { slide: number; done: number | "all" } | null {
  if (by === 1) {
    if (now.done < now.total) return { slide: now.slide, done: now.done + 1 };
    return now.slide + 1 < count ? { slide: now.slide + 1, done: 0 } : null;
  }
  if (now.done > 0) return { slide: now.slide, done: now.done - 1 };
  return now.slide > 0 ? { slide: now.slide - 1, done: "all" } : null;
}

/**
 * What a key asks of a running slideshow, as the message the presenter window sends for it, or null for a key
 * that is not the slideshow's. The drawing's window acts on the same message, so both windows have the same keys.
 * See docs/slideshow-spec.md, "Keys".
 */
export function keyMessage(key: string): Extract<FromPresenter, { type: "step" | "goto" | "exit" }> | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    // Presentation remotes send Page Down and Page Up.
    case "PageDown":
      return { type: "step", by: 1 };
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return { type: "step", by: -1 };
    case "Home":
      return { type: "goto", index: "current" };
    case "End":
      return { type: "goto", index: "last" };
    case "Escape":
    case "Backspace":
      return { type: "exit" };
    default:
      return null;
  }
}

/**
 * The frames' `customData` after the notes of frame `frameId` are set to `notes` (Markdown), by frame id, or null
 * if that changes nothing. Blank notes remove the field.
 *
 * Other frames' records are written too. What is written, and what is left alone, is specified in
 * docs/slideshow-spec.md, "Writing records".
 */
export function withNotes(elements: readonly SceneElement[], frameId: string, notes: string): Map<string, Record<string, unknown>> | null {
  const all = deck(elements);
  const target = all.find((slide) => slide.frame.id === frameId);
  if (!target) throw new Error("That frame is no longer in the drawing");
  const stored = (frame: SceneElement) => (frame.customData as { slideshow?: unknown } | null | undefined)?.slideshow;
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const wanted = notes.trim() ? notes : undefined;
  // Read from the stored record, so the notes of a rejected record are compared too.
  const was = stored(target.frame);
  const had = isRecord(was) && typeof was.notes === "string" && was.notes.trim() ? was.notes : undefined;
  if (had === wanted) return null;
  // The deck's name: of the first frame in the element list that has one, not the first slide.
  const deckName = elements.map((e) => all.find((slide) => slide.frame === e)?.data?.deckName).find(Boolean);
  const out = new Map<string, Record<string, unknown>>();
  all.forEach((slide, order) => {
    const { frame } = slide;
    const isTarget = frame.id === frameId;
    const record = stored(frame);
    let next: Record<string, unknown>;
    if (slide.data && isRecord(record)) {
      // Changed in place: a copy keeps every stored field where it is, and a field that is added goes last.
      next = { ...record, order };
      if (deckName && !slide.data.deckName) next.deckName = deckName;
    } else if (isRecord(record)) {
      // A record this app does not understand: its notes are the user's to edit, the rest is not ours to touch.
      if (!isTarget) return;
      next = { ...record };
    } else if (record == null || isTarget) {
      next = { schemaVersion: 2, kind: "frame", order, ...(deckName && { deckName }) };
    } else {
      return;
    }
    if (isTarget) {
      if (wanted === undefined) delete next.notes;
      else next.notes = wanted;
    }
    out.set(frame.id, { ...(frame.customData as Record<string, unknown> | null | undefined), slideshow: next });
  });
  return out;
}

/** What the presenter window is told to show. The pictures follow in a second message, when they are drawn. */
export interface PresenterState {
  /** Changes with every slide and build, so pictures that arrive late are matched to what they show. */
  key: string;
  index: number;
  count: number;
  title: string;
  build: { done: number; total: number };
  /** What Forward does next, and the title of the slide it leads to. */
  next: { kind: "build" | "slide" | "end"; title: string | null };
  notes: string;
  /** When the slideshow started, in ms since the epoch. */
  startedAt: number;
  dark: boolean;
  /**
   * The vault's look, as text, because the presenter window cannot read the vault: the CSS of its theme and
   * snippets, and the look options as the inline style of the main window's <html> (src/appearance.ts).
   */
  css: string;
  options: string;
}

/**
 * The messages on the `BroadcastChannel` between the drawing (main window) and the presenter window.
 * The presenter window only gets what to show and only asks to move: it has no other way into the app.
 */
export const PRESENTER_CHANNEL = "inklode-presenter";
export type ToPresenter =
  | { type: "state"; state: PresenterState }
  /** PNG data URLs of the slide now and of what Forward shows (null at the end). */
  | { type: "pictures"; key: string; current: string | null; next: string | null }
  | { type: "end" };
export type FromPresenter =
  /** The window is ready and wants the state. */
  | { type: "hello" }
  | { type: "step"; by: 1 | -1 }
  | { type: "goto"; index: number | "current" | "last" }
  | { type: "exit" }
  /** What the window has on screen: the state's fields it drew, the notes as the text it shows, and which pictures it has. */
  | { type: "shown"; shown: Record<string, unknown> }
  | { type: "closed" };
