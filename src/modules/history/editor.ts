// The history module's part in the Markdown editor: it keeps track of the editors on screen, for the panel
// and the commands, and draws the margin that says who last changed each part of the note (`history.blame`).

import { Compartment, StateEffect, StateField, type Extension } from "@codemirror/state";
import { type EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type AppApi, inActivePane, notePath } from "../../modules";
import { type BlameRange, type Mark, marks } from "./blame";

/** The editors on screen: one per pane that shows a note as text. */
const views = new Set<EditorView>();

/** The editor the commands act on: the active pane's, or the only one. Null while there is none. */
export const current = {
  get view(): EditorView | null {
    return inActivePane(views, (view) => view.dom);
  },
};

/** An editor that shows the note at `path`, the active pane's first. All editors of a note have the same text. */
export function viewFor(path: string): EditorView | null {
  const showing = [...views].filter((view) => view.state.facet(notePath) === path);
  return inActivePane(showing, (view) => view.dom) ?? showing[0] ?? null;
}

// For React's `useSyncExternalStore`: `version` changes when an editor came or went, its text changed, the
// margin was switched, or another version was picked in the panel (`changed`, called by Panel.tsx).
const listeners = new Set<() => void>();
let version = 0;
export const editors = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  version: () => version,
};
export function changed() {
  version++;
  listeners.forEach((listener) => listener());
}

/** Calls into the Rust core. Set by `extension`. */
let call: AppApi["core"]["call"];
/** Whether the margin shows, in every editor. */
let on = false;

/** What git says about a note: its text in the last commit, and who last changed which lines of that. */
interface Committed {
  text: string;
  ranges: BlameRange[];
}

const loaded = StateEffect.define<Committed | null>();

/** What git said, and what it means for the text as it is now. Null for a note with no committed version. */
const blame = StateField.define<{ committed: Committed; marks: Mark[] } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(loaded)) return effect.value && { committed: effect.value, marks: marks(effect.value.ranges, effect.value.text, tr.state.doc.toString()) };
    }
    // Typing moves the committed lines and adds lines that are not committed yet.
    if (!value || !tr.docChanged) return value;
    return { committed: value.committed, marks: marks(value.committed.ranges, value.committed.text, tr.state.doc.toString()) };
  },
});

/** What the margin shows next to a line. `label` is empty on the lines of a paragraph after its first. */
class Note extends GutterMarker {
  constructor(
    readonly label: string,
    readonly title: string,
    readonly committed: boolean,
  ) {
    super();
  }
  eq(other: Note) {
    return other.label === this.label && other.title === this.title;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "blame-mark" + (this.committed ? "" : " is-uncommitted");
    el.textContent = this.label;
    el.title = this.title;
    return el;
  }
}

const margin: Extension = [
  blame,
  gutter({
    class: "blame-gutter",
    lineMarker(view, block) {
      const all = view.state.field(blame)?.marks;
      if (!all) return null;
      const line = view.state.doc.lineAt(block.from);
      const mark = all.find((m) => m.from <= line.number && line.number <= m.to);
      if (!mark) return null;
      // Named where it starts and at the start of each paragraph in it, so a long stretch is not left unnamed.
      const first = line.text.trim() !== "" && (line.number === mark.from || view.state.doc.line(line.number - 1).text.trim() === "");
      const { commit } = mark;
      if (!commit) return new Note(first ? "Not committed yet" : "", "Changed since the last commit", false);
      const day = commit.date.slice(0, 10);
      return new Note(first ? `${commit.author} · ${day}` : "", `${commit.subject}\n${commit.author}, ${day} (${commit.rev.slice(0, 7)})`, true);
    },
    lineMarkerChange: (update) => update.startState.field(blame, false) !== update.state.field(blame, false),
  }),
];

/** Holds `margin` while the margin is on, nothing while it is off. */
const slot = new Compartment();

const loading = new WeakSet<EditorView>();

/** Asks git about an editor's note and hands the answer to its margin. A failed read leaves the margin as it was. */
async function load(view: EditorView) {
  if (loading.has(view)) return;
  loading.add(view);
  const path = view.state.facet(notePath);
  try {
    const [ranges, { content }] = await Promise.all([call<BlameRange[]>("git.blame", { path }), call<{ content: string | null }>("git.show", { path })]);
    if (views.has(view)) view.dispatch({ effects: loaded.of(content === null ? null : { text: content, ranges }) });
  } catch {
    // The margin is an extra: no banner for it.
  } finally {
    loading.delete(view);
  }
}

const tracker = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      views.add(view);
      // An editor that comes up while the margin is on gets it too. Not here: an editor takes no change while it is being made.
      if (on) queueMicrotask(() => views.has(view) && view.dispatch({ effects: slot.reconfigure(margin) }));
      changed();
    }
    update(update: ViewUpdate) {
      if (update.docChanged) changed();
      // git is asked when the margin is switched on, which is a change to the editor's extensions, and again
      // whenever the editor takes its modules' extensions anew, which it does when a file of the vault changed
      // on disk (`refresh` in components/Editor.tsx): after every save.
      // shortcut: a commit made outside the app changes no file of the vault, so the margin shows it only
      // after the next save or when switched off and on; watch `.git` for it if that is too late
      if (on && update.transactions.some((tr) => tr.reconfigured)) void load(update.view);
    }
    destroy() {
      views.delete(this.view);
      changed();
    }
  },
);

/** The module's CodeMirror extension. `core` is how it reaches git. */
export function extension(core: AppApi["core"]["call"]): Extension {
  call = core;
  return [tracker, slot.of([])];
}

/** Shows or hides the margin in every editor. */
export function setBlame(next: boolean) {
  on = next;
  for (const view of views) view.dispatch({ effects: slot.reconfigure(on ? margin : []) });
  changed();
}

export const blameOn = () => on;

/** The marks in the active editor's margin, or null while it has none. */
export const blameMarks = (): Mark[] | null => current.view?.state.field(blame, false)?.marks ?? null;
