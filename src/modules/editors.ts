// The Markdown editors on screen, for the modules that work on a note's text as typed: the review module
// compares with it and rejects into it, the tasks module ticks a checkbox in it. A module that needs them
// registers `extension` (`AppApi.editor.registerExtension`); CodeMirror keeps one copy however many do.

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { inActivePane, notePath } from "../modules";

/** The editors on screen: one per pane that shows a note as text. */
const views = new Set<EditorView>();

/** An editor that shows the note at `path`, the active pane's first. All editors of a note have the same text. */
export function viewFor(path: string): EditorView | null {
  const showing = [...views].filter((view) => view.state.facet(notePath) === path);
  return inActivePane(showing, (view) => view.dom) ?? showing[0] ?? null;
}

/** The editor a command acts on: the active pane's, or the only one. Null while there is none. */
export const currentView = (): EditorView | null => inActivePane(views, (view) => view.dom);

// For React's `useSyncExternalStore`: `version` changes when an editor came or went or its text changed.
const listeners = new Set<() => void>();
let version = 0;
export const editors = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  version: () => version,
};
function changed() {
  version++;
  listeners.forEach((listener) => listener());
}

// shortcut: the history module keeps a list of its own (modules/history/editor.ts), tied to its margin;
// have it use this one when that file is next reworked
export const extension: Extension = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      views.add(view);
      changed();
    }
    update(update: ViewUpdate) {
      if (update.docChanged) changed();
    }
    destroy() {
      views.delete(this.view);
      changed();
    }
  },
);
