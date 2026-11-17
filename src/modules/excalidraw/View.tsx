import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, exportToCanvas, exportToSvg, getCommonBounds, hashElementsVersion, newElementWith, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement, ExcalidrawFrameLikeElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { ChevronDown, ChevronLeft, ChevronRight, Maximize, Minimize, NotebookPen, Presentation, X } from "lucide-react";
import { below, Menu, Select, type MenuAt } from "../../components/Menu";
import { closePresenterWindow, isFullscreen, onFullscreenChange, onPresenterClosed, openPresenterWindow, setFullscreen } from "../../core/client";
import type { ViewProps } from "../../modules";
import { deck, fitSlide, parse, serialize, slides, type SceneElement, type Slide } from "./format";
import { drawings, lastSlide, type PresentOptions, type Presenter } from "./index";
import { isDark, unlink } from "./render";
import {
  builds,
  DEFAULT_DELAY_MS,
  DEFAULT_DURATION_MS,
  exits,
  hidden,
  keyMessage,
  overlaps,
  PRESENTER_CHANNEL,
  stepFrom,
  withNotes,
  type Build,
  type FromPresenter,
  type PresenterState,
  type ToPresenter,
} from "./slideshow";

/** The file as the canvas last got it from disk, with what tells a later edit apart from it. */
function load(text: string) {
  const drawing = parse(text);
  // Restored here, as Excalidraw does on loading, so `version` is that of the elements the canvas starts with.
  const elements = restoreElements(drawing.scene.elements as unknown as ExcalidrawElement[], null, {
    repairBindings: true,
  });
  return {
    /** The file's text: as read, then as last reported through `onChange`. */
    text,
    drawing,
    elements,
    /** Changes when any element changes. Selecting, scrolling and zooming leave it as it is. */
    version: hashElementsVersion(elements),
    /** How many image files the scene holds. */
    files: Object.keys(drawing.scene.files ?? {}).length,
  };
}

// The app saves the drawing and sets its look, so Excalidraw's own open, save and theme controls are off.
const UI: ExcalidrawProps["UIOptions"] = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false },
};

/** The canvas state a slideshow changes, kept when it starts and put back when it ends. None of it is in the file. */
const CHANGED = ["scrollX", "scrollY", "zoom", "frameRendering", "viewModeEnabled", "selectedElementIds", "shouldCacheIgnoreZoom"] as const;

// The motion of a slideshow. docs/slideshow-spec.md leaves these to the app: no deck depends on them.
/** How long the canvas travels from one slide to the next. */
const TRAVEL_MS = 500;
/** Slow, fast, slow, for the travel and for a build that slides or zooms: the same curve as a function and as CSS. */
const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2);
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";
/** The size a zoom starts from, or shrinks to, as a share of full size. */
const ZOOM_SMALL = 0.04;
/** The room around a build's elements in their picture, in scene units, so thick strokes and a flat line are not cut. */
const PICTURE_MARGIN = 16;
/** How long the picture of a slide or zoom entrance stays over the elements once they are drawn under it, so the canvas has painted them before it goes. */
const HANDOFF_MS = 80;

/**
 * Runs something over `ms`: `frame` gets the share of the time that has passed, 0 to 1, each time the window
 * draws, and `end` is called once when the time is up. The end comes from a timer, because a window that is covered
 * gets no frames and must still arrive. Returns a function that stops it, without calling `end`.
 */
function over(ms: number, frame: (t: number) => void, end: () => void): () => void {
  const start = performance.now();
  let next = requestAnimationFrame(function tick() {
    frame(Math.min(1, (performance.now() - start) / ms));
    next = requestAnimationFrame(tick);
  });
  const stop = () => {
    cancelAnimationFrame(next);
    clearTimeout(timer);
  };
  const timer = window.setTimeout(() => {
    stop();
    end();
  }, ms);
  return stop;
}

/** A slideshow that is running. */
interface Show {
  /** The deck, as it was when the slideshow started. Nothing can be edited while presenting. */
  slides: Slide<SceneElement>[];
  /** The slide on screen, or being travelled to, from 0. */
  at: number;
  before: Pick<AppState, (typeof CHANGED)[number]>;
  /** Whether the window was fullscreen before the slideshow, and whether it is now. */
  wasFullscreen: boolean;
  fullscreen: boolean;
  /** Stops the travel to a slide that is under way. Null when the canvas is at rest. */
  stop: (() => void) | null;
  /**
   * False until the first slide is entered. Until then the canvas is where the drawing was left, and the window
   * changing size (it goes fullscreen) does not put it on the slide: the first travel starts from there.
   */
  entered: boolean;
  /**
   * The builds of the slide on screen, and how many of them have run. A build counts as run from the moment its
   * effect starts, so Forward and Backward during the effect go on from there.
   */
  steps: Build[];
  done: number;
  /** True while a build's fade, slide or zoom is playing. */
  animating: boolean;
  /**
   * The elements the slide's builds act on, by id, as the drawing has them. The canvas gets copies of these with
   * another opacity while they are hidden or fading, and these back when the slide is left.
   */
  own: Map<string, ExcalidrawElement>;
  /** The build effect that is playing. `finish` ends it at once: the slide is drawn as the effect would have left it. */
  playing: { finish: () => void } | null;
  /** The timer of a build that runs by itself, while it waits. */
  wait: number | null;
  startedAt: number;
  /**
   * Presenting with notes: the channel to the presenter window, whether that window is there, what it says it
   * shows, and `unwatch`, which stops listening for its closing.
   */
  presenter: { channel: BroadcastChannel; open: boolean; shown: unknown; unwatch: () => void } | null;
  /** The presenter view's pictures, by slide, builds run and look. The drawing does not change while presenting. */
  pictures: Map<string, Promise<string | null>>;
}

/**
 * The Excalidraw canvas for one `.excalidraw.md` file, and its slideshow.
 * The parent gives it `key={path}` and only mounts it for a file that `parse` accepts.
 *
 * The slideshow is the canvas itself, over the whole window and read-only, travelling from frame to frame. It
 * presents decks in the format the Obsidian Excalidraw plugin's slideshow script writes, with the builds a frame
 * stores (`animation.steps`). The format and the behaviour are specified in docs/slideshow-spec.md.
 *
 * Builds and the file: presenting never changes the file (docs/slideshow-spec.md, "Presenting never changes the
 * file"). While a slideshow runs `changed` reports nothing at all, and the file is only written from `changed`,
 * after the slideshow.
 */
// shortcut: images are not shown: the Obsidian plugin keeps them as links under `## Embedded Files`, not in the
// scene's `files`. That section is kept as found, but an image pasted here is saved into `files`, which Obsidian
// does not read; load and write `## Embedded Files` when drawings with images matter
export default function View({ ref, path, content, onChange }: ViewProps) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const file = useRef<ReturnType<typeof load> | null>(null);
  file.current ??= load(content);
  const [dark, setDark] = useState(isDark);
  const root = useRef<HTMLDivElement>(null);
  // The ref is the truth. The two states draw it: the slide's number, or null when not presenting.
  const show = useRef<Show | null>(null);
  const [slide, setSlide] = useState<number | null>(null);
  const [fullscreen, setFull] = useState(false);
  // The menu of the Present button, and the panel that edits one frame's presenter notes.
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [notes, setNotes] = useState<{ id: string; title: string; text: string } | null>(null);
  const notesNow = useRef(notes);
  notesNow.current = notes;

  const sceneElements = () => (api.current?.getSceneElements() ?? []) as unknown as SceneElement[];
  const toast = (error: unknown) => api.current?.setToast({ message: String((error as Error)?.message ?? error), closable: true, duration: 4000 });

  /**
   * Shows slide `to`: the canvas travels there, or without `animate` is there at once. `arrived` runs when it gets
   * there. While it travels, `Show.stop` stops it.
   */
  const move = (to: number, animate = true, arrived?: () => void) => {
    const running = show.current!;
    running.stop?.();
    running.at = to;
    setSlide(to);
    lastSlide.set(path, to);
    const canvas = api.current!;
    const frame = running.slides[to].frame as unknown as { x: number; y: number; width: number; height: number };
    const viewport = () => ({ width: root.current!.clientWidth, height: root.current!.clientHeight });
    // `travelling` lets Excalidraw scale the elements' pictures it has while the zoom changes with every frame. At
    // rest it draws them again, sharp.
    const put = (view: { zoom: number; scrollX: number; scrollY: number }, travelling: boolean) =>
      canvas.updateScene({
        appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom as AppState["zoom"]["value"] }, shouldCacheIgnoreZoom: travelling },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    // The slide is fitted to the window as it is when the canvas gets there, not as it was when it set off.
    const arrive = () => {
      running.stop = null;
      const size = viewport();
      put(fitSlide(frame, size.width, size.height), false);
      arrived?.();
    };
    const from = canvas.getAppState();
    const size = viewport();
    const there = fitSlide(frame, size.width, size.height);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (!animate || (near(from.zoom.value, there.zoom) && near(from.scrollX, there.scrollX) && near(from.scrollY, there.scrollY))) return arrive();
    // The point of the drawing in the middle of the window goes in a straight line to the middle of the slide, and
    // the zoom changes by the same factor in the same time all the way, so zooming in looks as fast as zooming out.
    const zoom = from.zoom.value;
    const centre = { x: size.width / 2 / zoom - from.scrollX, y: size.height / 2 / zoom - from.scrollY };
    const goal = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    running.stop = over(
      TRAVEL_MS,
      (t) => {
        const share = ease(t);
        // Aimed again on every frame: the window may be changing size (it goes fullscreen as the slideshow starts).
        const { width, height } = viewport();
        const z = zoom * (fitSlide(frame, width, height).zoom / zoom) ** share;
        const x = centre.x + (goal.x - centre.x) * share;
        const y = centre.y + (goal.y - centre.y) * share;
        put({ zoom: z, scrollX: width / 2 / z - x, scrollY: height / 2 / z - y }, true);
      },
      arrive,
    );
  };

  /**
   * Draws the slide as its builds stand: the elements that are hidden get no opacity, the others their own.
   * `part` is for a build that is playing: its elements are drawn at that share of their own opacity.
   *
   * The canvas gets copies with the same `version`, so nothing here counts as an edit, and `changed` reports
   * nothing while a slideshow runs: an opacity set here never reaches the file.
   */
  const draw = (part?: { ids: readonly string[]; share: number }) => {
    const now = show.current;
    const canvas = api.current;
    if (!now || !canvas || !now.own.size) return;
    const gone = hidden(now.steps, now.done);
    // shortcut: every element of the drawing is handed to the canvas again on each frame of a fade; draw the fade
    // on a layer over the canvas if drawings get large enough for fades to stutter
    canvas.updateScene({
      elements: canvas.getSceneElementsIncludingDeleted().map((e) => {
        const own = now.own.get(e.id);
        if (!own) return e;
        const share = part?.ids.includes(e.id) ? part.share : gone.has(e.id) ? 0 : 1;
        return share === 1 ? own : { ...own, opacity: own.opacity * share };
      }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  /** Ends a build effect or a timed wait that is under way: the slide is drawn as its builds stand. */
  const settle = () => {
    const now = show.current;
    if (!now) return;
    // First the effect, because a build that ends starts the wait of a timed one after it.
    now.playing?.finish();
    if (now.wait !== null) clearTimeout(now.wait);
    now.wait = null;
  };

  /** Shows every element of the slide as the drawing has it and forgets the slide's builds. */
  const restore = () => {
    settle();
    const now = show.current!;
    now.steps = [];
    now.done = 0;
    // With no builds nothing is hidden: the canvas gets the drawing's own elements back.
    draw();
    now.own = new Map();
  };

  /** Starts the wait of the slide's next build, if that is one that runs by itself. */
  const waitForNext = () => {
    const now = show.current;
    const next = now?.steps[now.done]?.step;
    if (!now || next?.trigger !== "after-delay") return;
    now.wait = window.setTimeout(() => {
      now.wait = null;
      build(1);
    }, next.delayMs ?? DEFAULT_DELAY_MS);
  };

  /**
   * A picture of these elements as the drawing has them, for a build to move over the canvas, placed where the
   * canvas draws them now. Null if it cannot be made.
   */
  const pictureOf = async (now: Show, ids: readonly string[]): Promise<HTMLElement | null> => {
    const canvas = api.current;
    const within = root.current;
    if (!canvas || !within) return null;
    const elements = canvas.getSceneElements().flatMap((e) => (ids.includes(e.id) ? [now.own.get(e.id) ?? e] : []));
    const [left, top, right, bottom] = getCommonBounds(elements);
    const svg = unlink(
      await exportToSvg({
        elements,
        files: canvas.getFiles(),
        appState: { exportBackground: false, exportWithDarkMode: isDark() },
        exportPadding: PICTURE_MARGIN,
        // The picture goes into this page, where the drawing's fonts are already available by name.
        skipInliningFonts: true,
      }),
    );
    // Excalidraw draws a scene point `p` at `(p + scroll) * zoom` from its own corner.
    const { zoom, scrollX, scrollY, offsetLeft, offsetTop } = canvas.getAppState();
    const corner = within.getBoundingClientRect();
    const picture = document.createElement("div");
    picture.style.left = `${(left - PICTURE_MARGIN + scrollX) * zoom.value + offsetLeft - corner.left}px`;
    picture.style.top = `${(top - PICTURE_MARGIN + scrollY) * zoom.value + offsetTop - corner.top}px`;
    // From the elements, not from the size the SVG says it has, which is in pixels of the screen it was made for.
    picture.style.width = `${(right - left + 2 * PICTURE_MARGIN) * zoom.value}px`;
    picture.style.height = `${(bottom - top + 2 * PICTURE_MARGIN) * zoom.value}px`;
    picture.append(svg);
    return picture;
  };

  /** Runs the slide's next build (1) or undoes its last one (-1), with the step's effect. */
  const build = (by: 1 | -1) => {
    settle();
    const now = show.current!;
    const { step, ids } = now.steps[by === 1 ? now.done : now.done - 1];
    now.done += by;
    publish();
    // What is seen depends on whether the elements come or go, not on the way the presenter moves: an exit that is
    // undone brings them in as the entrance of the same kind does.
    const entering = exits(step.effect) === (by === -1);
    const kind = step.effect.replace("-out", "") as "appear" | "disappear" | "fade" | "slide" | "zoom";
    const ms = kind === "appear" || kind === "disappear" ? 0 : (step.durationMs ?? DEFAULT_DURATION_MS);
    let clear = () => {};
    const finish = () => {
      clear();
      now.playing = null;
      now.animating = false;
      draw();
      // Only a build that ran forward is followed by a timed one: after an undo the presenter moves on.
      if (by === 1) waitForNext();
    };
    if (ms === 0) return finish();
    now.animating = true;
    now.playing = { finish };

    if (kind === "fade") {
      const fade = (t: number) => draw({ ids, share: entering ? t : 1 - t });
      fade(0);
      clear = over(ms, fade, finish);
      return;
    }

    // Slide and zoom: all the step's elements move as one picture over the canvas, and the canvas does not draw
    // them meanwhile. Until the picture is made they stand as the effect starts: out of sight to come in, in
    // place to go.
    let stopped = false;
    clear = () => (stopped = true);
    draw({ ids, share: entering ? 0 : 1 });
    void pictureOf(now, ids)
      .catch((error: unknown) => (console.error("Slideshow: no picture for a build", error), null))
      .then((picture) => {
        if (stopped) return;
        const layer = root.current?.querySelector(".slideshow-build");
        if (!picture || !layer) return finish();
        layer.append(picture);
        // After the picture is there, so elements that go are never missing from both.
        draw({ ids, share: 0 });
        const rest = "translate(0px, 0px) scale(1)";
        let away = `translate(0px, 0px) scale(${ZOOM_SMALL})`;
        if (kind === "slide") {
          // The off-place is past the window's edge on that side, and at least the picture's own size away.
          const box = picture.getBoundingClientRect();
          const all = layer.getBoundingClientRect();
          const [dx, dy] = {
            left: [-Math.max(box.width, box.right - all.left), 0],
            right: [Math.max(box.width, all.right - box.left), 0],
            up: [0, -Math.max(box.height, box.bottom - all.top)],
            down: [0, Math.max(box.height, all.bottom - box.top)],
          }[step.direction ?? "left"];
          away = `translate(${dx}px, ${dy}px) scale(1)`;
        }
        // A zoom that goes fades as it shrinks. Everything else is fully visible all the way.
        const off = { transform: away, opacity: kind === "zoom" && !entering ? 0 : 1 };
        picture.animate(entering ? [off, { transform: rest, opacity: 1 }] : [{ transform: rest, opacity: 1 }, off], { duration: ms, easing: EASE, fill: "both" });
        // The end comes from timers, not from the animation: a covered window does not play it.
        let timer = window.setTimeout(() => {
          if (!entering) return finish();
          // The elements are drawn in place under the picture, which goes a moment later: no gap between the two.
          draw();
          timer = window.setTimeout(finish, HANDOFF_MS);
        }, ms);
        clear = () => {
          clearTimeout(timer);
          picture.remove();
        };
      });
  };

  /** Goes to slide `to` with none of its builds run, or all of them (`built`: it was entered backward). */
  const enter = (to: number, built: boolean) => {
    settle();
    restore();
    const now = show.current!;
    now.entered = true;
    // The slide's steps are matched now, against the drawing and the window as they are.
    const { frame, data } = now.slides[to];
    now.steps = builds(frame, data?.animation?.steps ?? [], sceneElements(), { width: root.current!.clientWidth, height: root.current!.clientHeight });
    now.done = built ? now.steps.length : 0;
    const acted = new Set(now.steps.flatMap((step) => step.ids));
    now.own = new Map(api.current!.getSceneElements().flatMap((e) => (acted.has(e.id) ? [[e.id, e]] : [])));
    draw();
    // A timed first build waits until the canvas is on the slide.
    move(to, true, waitForNext);
    publish();
  };

  /** A PNG of slide `at` with `done` of its builds run, for the presenter view: what touches the frame, cut to the frame. */
  // shortcut: the frame's own rectangle, not what a 16:9 screen would show of the slide (the frame grown to that
  // shape); the same for frames drawn 16:9, so grow the picture when decks use other shapes
  const picture = (now: Show, at: number, done: number): Promise<string | null> => {
    const key = `${at}:${done}:${isDark()}`;
    const had = now.pictures.get(key);
    if (had) return had;
    const { frame, data } = now.slides[at];
    const scene = api.current!.getSceneElements();
    // A slide that is not on screen has its steps matched without a window.
    const steps = at === now.at ? now.steps : builds(frame, data?.animation?.steps ?? [], scene as unknown as SceneElement[]);
    const gone = hidden(steps, done);
    const rect = frame as unknown as Parameters<typeof overlaps>[1];
    // The frame, and what is on the slide and not hidden, each as the drawing has it: the canvas may hold a copy
    // that a build of the slide on screen has hidden.
    const elements = scene
      .filter((e) => e.id === frame.id || (!gone.has(e.id) && overlaps(e as unknown as SceneElement, rect)))
      .map((e) => now.own.get(e.id) ?? e);
    const made: Promise<string | null> = exportToCanvas({
      elements,
      files: api.current!.getFiles(),
      appState: { exportBackground: false, exportWithDarkMode: isDark() },
      exportingFrame: frame as unknown as ExcalidrawFrameLikeElement,
      exportPadding: 0,
      maxWidthOrHeight: 960,
    })
      .then((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png"))
      .catch((error: unknown) => (console.error("Slideshow: no picture for the presenter view", error), null));
    now.pictures.set(key, made);
    return made;
  };

  /** Tells the presenter window what the slideshow shows now: the facts at once, the two pictures when they are drawn. */
  const publish = () => {
    const now = show.current;
    if (!now?.presenter) return;
    const following = now.slides[now.at + 1];
    const kind = now.done < now.steps.length ? "build" : following ? "slide" : "end";
    const state: PresenterState = {
      key: `${now.at}:${now.done}:${isDark()}`,
      index: now.at,
      count: now.slides.length,
      title: now.slides[now.at].title,
      build: { done: now.done, total: now.steps.length },
      next: { kind, title: kind === "slide" ? following.title : null },
      notes: now.slides[now.at].data?.notes ?? "",
      startedAt: now.startedAt,
      dark: isDark(),
      css: [...document.querySelectorAll("style[data-inklode-theme], style[data-inklode-snippet]")].map((style) => style.textContent).join("\n"),
      options: document.documentElement.style.cssText,
    };
    const { channel } = now.presenter;
    channel.postMessage({ type: "state", state } satisfies ToPresenter);
    const next = kind === "build" ? picture(now, now.at, now.done + 1) : kind === "slide" ? picture(now, now.at + 1, 0) : null;
    void Promise.all([picture(now, now.at, now.done), next]).then(([current, next]) => {
      if (show.current === now) channel.postMessage({ type: "pictures", key: state.key, current, next } satisfies ToPresenter);
    });
  };

  // What the commands, the keys and the toolbar do. Made once: it only uses refs, state setters and `path`,
  // which does not change for a mounted view.
  const me = useMemo<Presenter>(() => {
    const running = () => {
      if (!show.current) throw new Error("No slideshow is running");
      return show.current;
    };
    const presenter: Presenter = {
      async present({ windowed, resume, from, notes: withNotesView }: PresentOptions = {}) {
        // Asked to present while presenting, it moves on.
        if (show.current) return presenter.step(1);
        const canvas = api.current;
        if (!canvas) throw new Error("The drawing is still loading");
        const deck = slides(sceneElements());
        if (!deck.length) {
          throw new Error(
            sceneElements().some((e) => e.type === "frame")
              ? "Every frame of this drawing is excluded from the slideshow"
              : "This drawing has no frames. Draw a frame around each slide to present it.",
          );
        }
        const state = canvas.getAppState();
        const first =
          from === "selected"
            ? deck.findIndex((s) => state.selectedElementIds[s.frame.id])
            : typeof from === "number"
              ? from
              : resume
                ? (lastSlide.get(path) ?? 0)
                : 0;
        const starting: Show = {
          slides: deck,
          at: Math.max(0, Math.min(Math.trunc(first), deck.length - 1)),
          before: Object.fromEntries(CHANGED.map((key) => [key, state[key]])) as Show["before"],
          wasFullscreen: false,
          fullscreen: false,
          stop: null,
          entered: false,
          steps: [],
          done: 0,
          animating: false,
          own: new Map(),
          playing: null,
          wait: null,
          startedAt: Date.now(),
          presenter: null,
          pictures: new Map(),
        };
        show.current = starting;
        setNotes(null);
        // Keys go to the slideshow, not into a note that had the cursor in another pane.
        (document.activeElement as HTMLElement | null)?.blur?.();
        canvas.updateScene({
          // Read-only, nothing selected, and no frame outlines or names.
          appState: { viewModeEnabled: true, selectedElementIds: {}, frameRendering: { ...state.frameRendering, enabled: false } },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        setSlide(starting.at);
        if (withNotesView) {
          const channel = new BroadcastChannel(PRESENTER_CHANNEL);
          const view: NonNullable<Show["presenter"]> = { channel, open: false, shown: null, unwatch: () => {} };
          starting.presenter = view;
          // Closing the presenter window does not end the slideshow.
          view.unwatch = onPresenterClosed(() => ((view.open = false), (view.shown = null)));
          channel.onmessage = ({ data }: MessageEvent<FromPresenter>) => {
            if (show.current !== starting) return;
            view.open = data.type !== "closed";
            if (data.type === "hello") publish();
            else if (data.type === "shown") view.shown = data.shown;
            else if (data.type === "closed") view.shown = null;
            else if (data.type === "step") presenter.step(data.by);
            else if (data.type === "goto") presenter.goto(data.index === "current" ? starting.at : data.index === "last" ? Infinity : data.index);
            else presenter.exit();
          };
          // Before the window goes fullscreen, so the presenter window opens on the desktop the app was on.
          // Without it the slideshow still runs.
          await openPresenterWindow().catch(toast);
        }
        try {
          starting.wasFullscreen = starting.fullscreen = await isFullscreen();
          if (!windowed && !starting.fullscreen && show.current === starting) await presenter.toggleFullscreen();
        } catch (e) {
          // Presenting in the window is better than not presenting.
          console.error("Slideshow: fullscreen is not available", e);
        }
        setFull(starting.fullscreen);
        // Unless it was left while the window was changing.
        if (show.current === starting) enter(starting.at, false);
      },
      step(by) {
        const now = running();
        const to = stepFrom({ slide: now.at, done: now.done, total: now.steps.length }, now.slides.length, by);
        if (!to) presenter.exit();
        else if (to.slide !== now.at) enter(to.slide, to.done === "all");
        else {
          // A build plays on the slide, so a canvas still on its way there is put there first.
          if (now.stop) move(now.at, false);
          build(by);
        }
      },
      goto(index) {
        // The slide's builds start over, also for the slide that is on screen.
        enter(Math.max(0, Math.min(Math.trunc(index), running().slides.length - 1)), false);
      },
      async toggleFullscreen() {
        const now = running();
        // Set before the window changes, so the change is known to be this one (see `onFullscreenChange` below).
        const set = (on: boolean) => setFull((now.fullscreen = on));
        set(!now.fullscreen);
        await setFullscreen(now.fullscreen).catch((e) => {
          set(!now.fullscreen);
          throw e;
        });
      },
      exit() {
        const was = running();
        was.stop?.();
        settle();
        restore();
        show.current = null;
        api.current?.updateScene({ appState: was.before, captureUpdate: CaptureUpdateAction.NEVER });
        setSlide(null);
        if (was.fullscreen !== was.wasFullscreen) setFullscreen(was.wasFullscreen).catch(console.error);
        leavePresenter(was);
      },
      notes({ frame, text } = {}) {
        if (show.current) throw new Error("End the slideshow first");
        const all = deck(sceneElements());
        const selected = api.current?.getAppState().selectedElementIds ?? {};
        const target = frame === undefined ? all.find((s) => selected[s.frame.id]) : all.find((s) => s.frame.id === frame || s.title === frame);
        if (!target) throw new Error(frame === undefined ? "Select a frame first: notes belong to a slide." : `This drawing has no frame "${frame}"`);
        if (text !== undefined) return saveNotes(target.frame.id, text);
        setNotes({ id: target.frame.id, title: target.title, text: target.data?.notes ?? "" });
        // Also when the panel was already open, for another frame: typing goes into it, not onto the canvas.
        setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(".slideshow-notes textarea")?.focus());
      },
    };
    return presenter;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The slideshow is over: the presenter window is told, and closed. */
  const leavePresenter = (was: Show) => {
    if (!was.presenter) return;
    was.presenter.channel.postMessage({ type: "end" } satisfies ToPresenter);
    was.presenter.channel.close();
    was.presenter.unwatch();
    closePresenterWindow().catch(console.error);
  };

  /**
   * Sets a frame's presenter notes. An edit like any other: the frames get a new `version`, so `changed` writes
   * the file. See `withNotes` for what the frames get.
   */
  const saveNotes = (frameId: string, text: string) => {
    const data = withNotes(sceneElements(), frameId, text);
    if (!data) return;
    api.current!.updateScene({
      elements: api.current!.getSceneElements().map((e) => {
        const customData = data.get(e.id);
        return customData && JSON.stringify(customData) !== JSON.stringify(e.customData) ? newElementWith(e, { customData }) : e;
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  // Excalidraw reports every change of its state here. Only a change to the elements or the files is an edit.
  const changed = (elements: readonly ExcalidrawElement[], _: unknown, files: BinaryFiles) => {
    // Presenting is read-only: nothing the canvas reports meanwhile is an edit.
    if (show.current) return;
    const was = file.current!;
    const version = hashElementsVersion(elements);
    const count = Object.keys(files).length;
    if (version === was.version && count === was.files) return;
    was.version = version;
    was.files = count;
    // shortcut: the whole file is built again on every change, also while a shape is dragged;
    // report a change without its text and build it when saving if large drawings get slow
    was.text = serialize(was.drawing, elements as unknown as SceneElement[], files);
    // shortcut: only the last 20 reports are remembered; one older than that coming back late would be
    // loaded as if it were new, which a drag with more than 20 changes per frame of the app would need
    if (reported.current.push(was.text) > 20) reported.current.shift();
    onChange(path, was.text);
  };

  // The texts this view reported and has not got back as `content` yet. The app hands every edit back at
  // once (so the same drawing in another pane follows), and during a drag an older one can arrive after
  // newer ones were reported: loading that would take the last strokes off the canvas.
  const reported = useRef<string[]>([]);

  // The file changed on disk, or the same drawing was edited in another pane. This view's own edit coming
  // back is the same text and nothing happens.
  useEffect(() => {
    if (content === file.current!.text) return void (reported.current = []);
    if (reported.current.includes(content)) return;
    try {
      file.current = load(content);
    } catch {
      return; // no longer a drawing: the app shows it as text
    }
    // A slideshow holds elements of the drawing as it was: it ends, and the canvas gets the new drawing.
    if (show.current) me.exit();
    api.current?.updateScene({ elements: file.current.elements, captureUpdate: CaptureUpdateAction.NEVER });
  }, [content, me]);

  useEffect(() => {
    const update = () => setDark(isDark());
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", update);
    const appearance = new MutationObserver(update);
    appearance.observe(document.documentElement, { attributeFilter: ["data-appearance"] });
    return () => {
      system.removeEventListener("change", update);
      appearance.disconnect();
    };
  }, []);

  // The presenter view follows the app's light or dark.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(publish, [dark]);

  useEffect(() => {
    // For the commands, which act on the active pane's drawing (index.ts).
    drawings.set(me, { root: () => root.current, presenting: () => show.current !== null });
    return () => {
      drawings.delete(me);
      // The drawing was closed while presenting: the canvas goes with it, the travel stops, the window is put back
      // and the presenter window closes.
      const was = show.current;
      if (!was) return;
      show.current = null;
      was.stop?.();
      // A wait and an effect under way end with the view. The canvas is not drawn again: it is going, and the file
      // never had what a build set.
      if (was.wait !== null) clearTimeout(was.wait);
      was.playing?.finish();
      if (was.fullscreen !== was.wasFullscreen) setFullscreen(was.wasFullscreen).catch(console.error);
      leavePresenter(was);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const presenting = slide !== null;
  useEffect(() => {
    if (!presenting) return;
    // The keys of a running slideshow (docs/slideshow-spec.md, "Keys"). On the window and before anything else gets
    // them, after the app's own shortcuts, which were registered first.
    const key = (e: KeyboardEvent) => {
      const now = show.current;
      if (!now) return;
      // Typed into the command palette, a prompt or a menu that is open over the slides: theirs.
      if (e.target instanceof Element && e.target.closest(".palette-backdrop, .menu")) return;
      // No key reaches the canvas, which would act on some of them (Delete, Cmd+Z) although nothing is selected.
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const message = keyMessage(e.key);
      const fullscreen = e.key === "f" || e.key === "F";
      if (!message && !fullscreen) return;
      // Not also what the browser does with the key: scrolling, going back, pressing a focused button of the toolbar.
      e.preventDefault();
      // Once per press: not when the key is let go, and not for the repeats of a key held down.
      if (e.type !== "keydown" || e.repeat) return;
      if (!message) void me.toggleFullscreen().catch(console.error);
      else if (message.type === "step") me.step(message.by);
      else if (message.type === "goto") me.goto(message.index === "last" ? Infinity : now.at);
      else me.exit();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    // The window changed size (fullscreen on or off): the slide is fitted again, unless it is on its way and aims itself.
    const resized = new ResizeObserver(() => {
      const now = show.current;
      if (!now?.entered || now.stop) return;
      // A picture that a build moves was placed for the old size: the build ends where it was going.
      now.playing?.finish();
      move(now.at, false);
    });
    resized.observe(root.current!);
    // Fullscreen changed by the system's own means (the green button, Ctrl+Cmd+F, the menu), not by the slideshow.
    const unwatch = onFullscreenChange((on) => {
      const now = show.current;
      if (!now || on === now.fullscreen) return;
      setFull((now.fullscreen = on));
      if (on) return;
      // Left fullscreen: the slideshow ends. The window stays as the user put it.
      now.wasFullscreen = false;
      me.exit();
    });
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      resized.disconnect();
      unwatch();
    };
    // `me` and `move` only use refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting]);

  useImperativeHandle(
    ref,
    () => ({
      uiState(dirty) {
        const elements = sceneElements();
        const state = api.current?.getAppState();
        const now = show.current;
        return {
          drawing: {
            elements: elements.length,
            // The frames that are slides, in slide order.
            frames: slides(elements).map((s) => s.frame.name ?? ""),
            dirty,
            // What a slideshow changes on the canvas and puts back.
            canvas: state && {
              zoom: state.zoom.value,
              scrollX: state.scrollX,
              scrollY: state.scrollY,
              viewMode: state.viewModeEnabled,
              frameRendering: state.frameRendering.enabled,
              selected: Object.keys(state.selectedElementIds).length,
            },
            // The elements the canvas draws see-through, by id: what a running build hides or fades.
            faded: Object.fromEntries(elements.filter((e) => e.opacity !== 100).map((e) => [e.id, e.opacity])),
            // The notes panel, when it is open: the frame it edits and the text in it.
            notesPanel: notesNow.current && { frame: notesNow.current.title, text: notesNow.current.text },
          },
          slideshow: now && {
            index: now.at,
            count: now.slides.length,
            frame: now.slides[now.at].frame.name ?? null,
            title: now.slides[now.at].title,
            fullscreen: now.fullscreen,
            // True while the canvas is travelling to the slide.
            transitioning: now.stop !== null,
            // The slide's builds: how many have run, and whether one is playing its effect.
            build: { done: now.done, total: now.steps.length, animating: now.animating },
            // The presenter window: whether it is there, and what it says it has on screen (see Presenter.tsx).
            presenter: { open: now.presenter?.open ?? false, shown: now.presenter?.shown ?? null },
          },
        };
      },
    }),
    // `sceneElements` only uses refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { drawing, elements } = file.current;
  // A drawing on Excalidraw's default white gets a clear canvas, so the app's own background shows through
  // (`.drawing` in app.css). A colour picked for the drawing is kept. Only the canvas: the file's
  // `appState` is written back as it was read (format.ts).
  const background = drawing.scene.appState?.viewBackgroundColor as string | undefined;
  const shown = show.current?.slides ?? [];
  const present = (options: PresentOptions) => void me.present(options).catch(toast);
  const closeNotes = (save: boolean) => {
    try {
      if (save && notes) saveNotes(notes.id, notes.text);
    } catch (error) {
      toast(error);
    }
    setNotes(null);
  };
  return (
    <div className={"drawing" + (presenting ? " slideshow-canvas" : "")} ref={root}>
      <Excalidraw
        excalidrawAPI={(instance) => (api.current = instance)}
        initialData={{
          elements,
          appState: { viewBackgroundColor: !background || /^#fff(fff)?$/i.test(background) ? "transparent" : background },
          files: drawing.scene.files as BinaryFiles | undefined,
          scrollToContent: true,
        }}
        theme={dark ? "dark" : "light"}
        // No web page is shown inside a drawing: an embeddable element (a video, a post) would load another
        // site's scripts in a frame of the app's own page. It is drawn as a box with its address.
        validateEmbeddable={false}
        UIOptions={UI}
        onChange={changed}
        renderTopRightUI={() => (
          <div className="slideshow-start">
            <button
              title="Present as slides, fullscreen. With Alt: in the window. With Shift: from the slide you left at."
              aria-label="Present as slides"
              // A drawing without slides gets a toast saying so.
              onClick={(e) => present({ windowed: e.altKey, resume: e.shiftKey })}
            >
              <Presentation size={16} />
            </button>
            <button title="More ways to present" aria-label="More ways to present" aria-haspopup="menu" onClick={(e) => setMenu(below(e.currentTarget, true))}>
              <ChevronDown size={12} />
            </button>
            <button
              title="Slide notes: what to say on the selected frame"
              aria-label="Slide notes"
              onClick={() => {
                try {
                  me.notes();
                } catch (error) {
                  toast(error);
                }
              }}
            >
              <NotebookPen size={16} />
            </button>
          </div>
        )}
      />
      {menu && (
        <Menu
          label="Present"
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Present", icon: Presentation, onPick: () => present({}) },
            { label: "Present with notes", icon: NotebookPen, onPick: () => present({ notes: true }) },
            { label: "Present in the window", onPick: () => present({ windowed: true }) },
          ]}
        />
      )}
      {notes && (
        <form
          className="slideshow-notes"
          aria-label={`Notes for ${notes.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            closeNotes(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeNotes(false);
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) closeNotes(true);
          }}
        >
          <header>
            <NotebookPen size={14} />
            <span>{notes.title}</span>
          </header>
          <textarea autoFocus value={notes.text} placeholder="What to say on this slide. Markdown." onChange={(e) => setNotes({ ...notes, text: e.target.value })} />
          <footer>
            <small>Shown in the presenter view</small>
            <button type="button" className="button is-quiet" onClick={() => closeNotes(false)}>
              Cancel
            </button>
            <button className="button">Save</button>
          </footer>
        </form>
      )}
      {/* Where a build that slides or zooms moves the picture of its elements. */}
      {presenting && <div className="slideshow-build" />}
      {presenting && (
        <div className="slideshow-bar" role="toolbar" aria-label="Slideshow">
          <button title="Previous" aria-label="Previous" onClick={() => me.step(-1)}>
            <ChevronLeft size={16} />
          </button>
          <Select
            label="Go to slide"
            value={String(slide)}
            options={shown.map((s, i) => ({ value: String(i), label: `${s.title} (${i + 1}/${shown.length})` }))}
            onChange={(value) => me.goto(Number(value))}
          />
          <button title="Next" aria-label="Next" onClick={() => me.step(1)}>
            <ChevronRight size={16} />
          </button>
          <span className="slideshow-bar-rule" />
          <button
            title={fullscreen ? "Leave fullscreen (F)" : "Fullscreen (F)"}
            aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            onClick={() => void me.toggleFullscreen().catch(console.error)}
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
          <button title="End the slideshow (Esc)" aria-label="End the slideshow" onClick={() => me.exit()}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
