// The history module: git in the app. "Show note history" lists the commits that changed the open note in
// the right sidebar; picking one shows what differs between that version and the text now, and can put the
// version back. "Toggle history margin" shows beside the text who last changed each part of it.
//
// Git is only read (the core's `git.log`, `git.show` and `git.blame`). A restored version is an edit in the
// editor like typed text: Undo takes it back, and it is saved the way every edit is.
//
// What differs shows under the list in the sidebar, or, with the option `historyDiff` set to "pane"
// (the switch at the top of the panel), in a pane of its own beside the note (Diff.tsx).
//
// This file and editor.ts load when the module is switched on, Panel.tsx when the panel is first opened.

import { isolateHistory } from "@codemirror/commands";
import { History } from "lucide-react";
import { lazy } from "react";
import { currentOptions } from "../../config";
import { type AppApi, notePath } from "../../modules";
import { lineDiff, middle } from "../../textDiff";
import type { Commit } from "./blame";
import { blameMarks, blameOn, current, extension, setBlame, viewFor } from "./editor";

/** What the panel shows while it is open, kept here by Panel.tsx for the commands and `ui_state`. */
export interface Shown {
  /** The note the versions are of, or null when the active tab shows none. */
  path: string | null;
  /** Newest first. Empty also while they are being read. */
  revisions: Commit[];
  /** The hash of the version that is picked, or null. */
  selected: string | null;
  /** The text of that version. Null without one and if it cannot be read, undefined while it is read. */
  before: string | null | undefined;
  select(rev: string | null): void;
}
export const panel: { shown: Shown | null } = { shown: null };

/** Calls into the Rust core, for Panel.tsx. Set when the module is switched on. */
export let call: AppApi["core"]["call"];

/** Shows and hides the comparison's own pane, for Panel.tsx. Set when the module is switched on. */
export let views: AppApi["views"];
/** The view that is the comparison in a pane of its own. */
export const DIFF_VIEW = "history-diff";

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export function activate(app: AppApi) {
  call = app.core.call;
  views = app.views;
  app.editor.registerExtension(extension(app.core.call));
  app.ui.registerPanel({ id: "history", title: "History", component: lazy(() => import("./Panel")) });
  app.views.register(DIFF_VIEW, { title: "Changes since version", component: lazy(() => import("./Diff")) });
  // A button to find it by: with the module on and no button, nothing on screen says it is there.
  app.ui.registerRibbon({ id: "history", title: "Show note history", icon: History, command: "history.open" });

  // `gitHistory` in `ui_state`. `open`: whether the panel shows. `path`: the note it is about. `revisions`: the
  // versions listed, newest first, as `{rev, author, date, subject}`. `selected`: the hash of the picked one, or
  // null. `diff`: `{added, removed}`, the lines the text now has more and fewer than the picked version; null
  // without one. `diffIn`: where that comparison shows, "sidebar" or "pane" (the option `historyDiff`). `blame`:
  // whether the margin is on. `blameRanges`: what the active editor's margin shows, as
  // `{from, to, rev, author, date}` with 1-based lines and `rev` null for lines not committed yet; null while off.
  app.ui.registerState(() => {
    const { shown } = panel;
    const now = shown?.path ? viewFor(shown.path)?.state.doc.toString() : undefined;
    const lines = shown?.before != null && now !== undefined ? lineDiff(shown.before, now) : null;
    const count = (kind: string) => lines!.filter((line) => line.kind === kind).length;
    return {
      gitHistory: {
        open: shown !== null,
        path: shown?.path ?? null,
        revisions: shown?.revisions ?? [],
        selected: shown?.selected ?? null,
        diff: lines && { added: count("add"), removed: count("remove") },
        diffIn: currentOptions().historyDiff,
        blame: blameOn(),
        blameRanges: blameOn()
          ? (blameMarks() ?? []).map(({ from, to, commit }) => ({ from, to, rev: commit?.rev ?? null, author: commit?.author ?? null, date: commit?.date ?? null }))
          : null,
      },
    };
  });

  app.commands.register({
    id: "history.open",
    title: "Show note history",
    key: "Mod+Shift+H",
    // Opens the panel, or closes it when it is open. `{open}` says which.
    run: (params) => app.ui.togglePanel("history", param(params).open as boolean | undefined),
  });
  app.commands.register({
    id: "history.select",
    title: "History: select older version",
    // `{rev}`: picks the version with that hash, or none with null. Without it, the version before the picked
    // one, the newest first.
    run: (params) => {
      const { shown } = panel;
      if (!shown) throw new Error("Open the history panel first");
      const { rev } = param(params);
      if (rev === null) return shown.select(null);
      const at = shown.revisions.findIndex((c) => c.rev === shown.selected);
      const found = typeof rev === "string" && rev ? shown.revisions.find((c) => c.rev.startsWith(rev)) : shown.revisions[at + 1];
      if (!found) throw new Error(rev === undefined ? "There is no older version" : "This note has no such version");
      shown.select(found.rev);
    },
  });
  app.commands.register({
    id: "history.restore",
    title: "History: restore selected version",
    // `{rev}`: the hash of the version to put back. Without it, the one picked in the panel.
    run: async (params) => {
      // The active pane's editor, or, from the comparison's own pane, the editor of the note it is about.
      const editor = () => current.view ?? (panel.shown?.path ? viewFor(panel.shown.path) : null);
      const view = editor();
      if (!view) throw new Error("Open a note first");
      const path = view.state.facet(notePath);
      const rev = param(params).rev ?? (panel.shown?.path === path ? panel.shown.selected : null);
      if (typeof rev !== "string") throw new Error("Select a version in the history panel first");
      const { content } = await call<{ content: string | null }>("git.show", { path, rev });
      if (content === null) throw new Error("That version of the note could not be read");
      // The same editor, still on screen: the text never goes to another note than the one it is a version of.
      if (editor() !== view) throw new Error("The note was closed before its version was read");
      const now = view.state.doc.toString();
      if (now === content) return;
      // An edit like any typed one, in one undo step: the editor reports it, and the app saves it as it saves typing.
      view.dispatch({ changes: middle(now, content), annotations: isolateHistory.of("full"), scrollIntoView: true });
    },
  });
  app.commands.register({
    id: "history.blame",
    title: "Toggle history margin",
    // The margin beside the text that names the last commit of each part. `{on}` says whether it shows.
    run: (params) => setBlame((param(params).on as boolean | undefined) ?? !blameOn()),
  });
}
