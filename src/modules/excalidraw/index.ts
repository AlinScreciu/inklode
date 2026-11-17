// The Excalidraw module: `.excalidraw.md` files open in a canvas, `![[name.excalidraw]]` shows the
// drawing in a note, and a drawing's frames can be presented as slides.
//
// This file is small and loads when the module is switched on. The Excalidraw library is only
// imported by View.tsx and render.ts, which load when a drawing is first opened or embedded.

import { lazy } from "react";
import { inActivePane, type AppApi } from "../../modules";
import { parse } from "./format";

/** How a slideshow starts. With none of these: fullscreen, at the first slide. */
export interface PresentOptions {
  /** Stay in the window as it is, not fullscreen. */
  windowed?: boolean;
  /** Start at the slide this drawing's last slideshow was on. Remembered until the app is closed. */
  resume?: boolean;
  /** Start at this slide, from 0, or at the frame that is selected on the canvas (the first slide if none is). */
  from?: number | "selected";
  /** Also open the presenter view in a second window: the slide's notes, what comes next, a clock. */
  notes?: boolean;
}

/** What the commands can do to a drawing that is open. The slideshow ones, all but `present`, throw if no slideshow is running. */
export interface Presenter {
  /** Starts the slideshow. Throws if the drawing has no slide to show. While one is running, moves on as `step(1)`. */
  present(options?: PresentOptions): Promise<void>;
  /**
   * Forward (1): the slide's next build, or the next slide when it is fully built. Backward (-1): undoes the last
   * build, or goes to the previous slide, fully built. Past the last slide or before the first, the slideshow ends.
   */
  step(by: 1 | -1): void;
  /** Shows this slide, from 0, with none of its builds run; a number outside the deck means the first or the last. */
  goto(index: number): void;
  /** Fullscreen on or off. */
  toggleFullscreen(): Promise<void>;
  /** Leaves the slideshow and puts the canvas and the window back as they were. */
  exit(): void;
  /**
   * Presenter notes of a frame: the one named by `frame` (its name or id), else the selected one. With `text`
   * (Markdown; blank removes the notes) they are saved; without, a panel opens to edit them. Not while presenting.
   */
  notes(params?: { frame?: string; text?: string }): void;
}

/**
 * The drawings on screen, each with the element it is drawn in and whether it is presenting.
 * Kept by View.tsx. Several can be on screen, in split panes.
 */
export const drawings = new Map<Presenter, { root(): Element | null; presenting(): boolean }>();

/** The slide each drawing's last slideshow was on, by the drawing's path, for `resume`. */
export const lastSlide = new Map<string, number>();

/** The last SVG drawn for each embedded file, with the text and look it was drawn from, so an unchanged drawing is not exported again. */
const drawn = new Map<string, { from: string; svg: Promise<SVGSVGElement> }>();

export function activate(app: AppApi) {
  // Excalidraw's fonts come with the app, at `/fonts` (vite.config.ts copies them from the package): the
  // library is told so here, before it loads, or it would fetch them from a CDN.
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = "/";
  app.views.register("excalidraw", {
    component: lazy(() => import("./View")),
    check: (content) => void parse(content),
  });
  app.files.registerExtension(".excalidraw.md", "excalidraw");

  app.markdown.registerEmbed(".excalidraw", async (path) => {
    const [{ content }, { isDark, toSvg }] = await Promise.all([
      app.core.call<{ content: string }>("note.read", { path }),
      import("./render"),
    ]);
    // shortcut: an embed keeps its look until the note is drawn again, so one drawn in light stays light
    // right after the appearance turns dark; redraw embeds on that change if it shows
    const from = (isDark() ? "dark\n" : "light\n") + content;
    let entry = drawn.get(path);
    if (entry?.from !== from) {
      const { scene } = parse(content);
      entry = { from, svg: toSvg(scene.elements, scene.files) };
      drawn.set(path, entry);
    }
    // A copy, because a note can embed the same drawing twice.
    return (await entry.svg).cloneNode(true) as Element;
  });

  // The drawing a command acts on: the active pane's, or the only one open, or the only one presenting.
  const drawing = () => {
    const root = (view: Presenter) => drawings.get(view)?.root();
    const view = inActivePane(drawings.keys(), root) ?? inActivePane([...drawings.keys()].filter((v) => drawings.get(v)!.presenting()), root);
    if (!view) throw new Error(drawings.size ? "Click the drawing you mean first: several are open" : "Open a drawing first");
    return view;
  };
  const commands: [id: string, title: string, run: (view: Presenter, params: Record<string, unknown>) => void | Promise<void>][] = [
    // Params `{windowed?, resume?, from?, notes?}`: see `PresentOptions`.
    ["excalidraw.present", "Present drawing as slides", (view, params) => view.present(params as PresentOptions)],
    ["slideshow.next", "Slideshow: next build or slide", (view) => view.step(1)],
    ["slideshow.prev", "Slideshow: previous build or slide", (view) => view.step(-1)],
    // Params `{frame?, text?}`: see `Presenter.notes`.
    ["slideshow.notes", "Slideshow: notes of the selected frame", (view, params) => {
      const { frame, text } = params;
      if ((frame !== undefined && typeof frame !== "string") || (text !== undefined && typeof text !== "string")) {
        throw new Error("slideshow.notes takes `frame` (a frame's name or id) and `text` (Markdown), both text");
      }
      view.notes({ frame, text });
    }],
    // Params `{index}`: the slide, from 0.
    ["slideshow.goto", "Slideshow: go to slide", (view, { index }) => {
      if (typeof index !== "number") throw new Error("slideshow.goto needs `index`, a slide number from 0");
      view.goto(index);
    }],
    ["slideshow.fullscreen", "Slideshow: fullscreen on or off", (view) => view.toggleFullscreen()],
    ["slideshow.exit", "Slideshow: leave", (view) => view.exit()],
  ];
  for (const [id, title, run] of commands) {
    app.commands.register({ id, title, run: (params) => run(drawing(), (params ?? {}) as Record<string, unknown>) });
  }
}
