// The review module: an inbox of the notes that changed since the user last looked. Agents edit notes by
// writing files and committing to the vault's git repository, also while the app is closed; "Review changes"
// lists what they did, shows each note against the text the user last saw, and lets the user accept the
// change or reject it.
//
// The list and what counts as seen are the core's (`review.*`, crates/core/src/review.rs): git is only read,
// and the state is kept outside the vault. The text last seen is the one the user last accepted, else the
// one at the commit review started from. What the user does in the app (typing, a rename, a move, a delete)
// is accepted as it happens: the saves by `review.saved` below, the rest by the core, which App.tsx tells
// with `own`. Accepting marks a text as seen and changes no file. Rejecting
// puts the earlier text back the way the user could: as an edit in the note's editor when it is open (Undo
// takes it back, and it is saved like typing), else as a write that fails if the file changed since the
// comparison was shown. A new note goes to `.trash/`, a deleted one is made again.
//
// This file, inbox.ts and ../editors.ts load when the module is switched on, View.tsx when the inbox is first opened.

import { isolateHistory } from "@codemirror/commands";
import { Inbox as InboxIcon } from "lucide-react";
import { createElement, lazy, useEffect, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { diffCounts } from "../../components/DiffPane";
import type { AppApi } from "../../modules";
import { middle } from "../../textDiff";
import { extension, viewFor } from "../editors";
import { type Entry, follow } from "./inbox";

/** What the inbox shows. A new object on every change, for `useSyncExternalStore`. */
export interface Shown {
  /** Whether the inbox is on screen. */
  open: boolean;
  /** False when the vault is not in a git repository with a commit: there is nothing to compare with. */
  repository: boolean;
  /** The notes that wait, by path. */
  entries: Entry[];
  /** The path of the note whose changes show, or null. */
  selected: string | null;
  /** That note's text when the user last looked and on disk now, null where it is not there. Null while they are read. */
  texts: { path: string; base: string | null; disk: string | null } | null;
}

let shown: Shown = { open: false, repository: true, entries: [], selected: null, texts: null };
const listeners = new Set<() => void>();
function set(change: Partial<Shown>) {
  shown = { ...shown, ...change };
  listeners.forEach((listener) => listener());
}
export const inbox = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  get: () => shown,
  /** View.tsx says whether it is on screen. */
  opened: (open: boolean) => set({ open }),
};

/** Calls into the Rust core. Set when the module is switched on. */
let call: AppApi["core"]["call"];

/** Reads the two texts of the picked note. */
async function load() {
  const path = shown.selected;
  if (path === null) return set({ texts: null });
  const [base, disk] = await Promise.all([
    call<{ content: string | null }>("review.base", { path }).then((r) => r.content),
    // A note that is not there: deleted, which is one of the changes to review.
    call<{ content: string }>("note.read", { path }).then((r) => r.content, () => null),
  ]);
  if (shown.selected === path) set({ texts: { path, base, disk } });
}

async function read() {
  const listed = await call<{ repository: boolean; entries: Entry[] }>("review.list");
  set({ ...listed, selected: follow(shown.entries, listed.entries, shown.selected) });
  await load();
}

// One reading at a time, and at most one waiting: that one sees everything that happened before it starts.
let running: Promise<void> = Promise.resolve();
let waiting: Promise<void> | null = null;

/** Asks the core again what waits. Resolves when the inbox shows the answer. */
export function refresh(): Promise<void> {
  waiting ??= running
    .catch(() => {})
    .then(() => {
      waiting = null;
      return read();
    });
  running = waiting;
  return waiting;
}

/** Picks the note whose changes show, or none. */
export async function select(path: string | null) {
  set({ selected: path, texts: shown.texts?.path === path ? shown.texts : null });
  await load();
}

/** The two texts the comparison of the picked note is between: `after` is what its editor has, if it is open. Null while they are read. */
export function compared(): { before: string; after: string } | null {
  const { texts, selected } = shown;
  if (!texts || texts.path !== selected) return null;
  return { before: texts.base ?? "", after: viewFor(texts.path)?.state.doc.toString() ?? texts.disk ?? "" };
}

/** Marks a note's text as seen, or everything without a path. No file changes. */
async function accept(path?: string) {
  await call("review.accept", path === undefined ? {} : { path });
  await refresh();
}

/** Takes a note back to the text the user last saw. */
async function reject(path: string) {
  const entry = shown.entries.find((e) => e.path === path);
  if (!entry) throw new Error(`${path} is not waiting for review`);
  // What was typed and still waits goes to disk first, so no write of it lands after this.
  await commands.execute("note.save");
  try {
    if (entry.status === "added") {
      // The app's own delete: to `.trash/`, and the tabs that show the note let go of it.
      await commands.execute("note.delete", { path, confirmed: true });
      return;
    }
    const { content: base } = await call<{ content: string | null }>("review.base", { path });
    if (base === null) throw new Error(`The earlier text of ${path} could not be read`);
    const view = viewFor(path);
    if (entry.status === "deleted") await call("note.create", { path, content: base });
    else if (view) {
      // An edit like any typed one, in one undo step: the editor reports it, and the app saves it as it saves typing.
      const now = view.state.doc.toString();
      if (now !== base) view.dispatch({ changes: middle(now, base), annotations: isolateHistory.of("full"), scrollIntoView: true });
      await commands.execute("note.save");
    } else {
      // Not open: written over the text the comparison was shown against, so a change made since then is
      // refused by the core as a conflict and not written over.
      const seen = shown.texts?.path === path ? shown.texts.disk : (await call<{ content: string }>("note.read", { path })).content;
      await call("note.write", { path, content: base, base: seen ?? "" });
    }
  } finally {
    await refresh();
  }
}

/** The count on the ribbon button: how many notes wait. */
function Badge() {
  const { entries } = useSyncExternalStore(inbox.subscribe, inbox.get);
  // shortcut: a commit made outside changes no file of the vault, so no event tells of it and its author
  // shows only at the next change; coming back to the window reads again, and `.git` could be watched if
  // that is too late
  useEffect(() => {
    const again = () => void refresh().catch(() => {});
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  return entries.length ? createElement("span", { className: "ribbon-badge", "aria-label": `${entries.length} notes to review` }, entries.length > 99 ? "99+" : entries.length) : null;
}

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export function activate(app: AppApi) {
  call = app.core.call;
  app.editor.registerExtension(extension);
  app.views.register("review", { title: "Review", component: lazy(() => import("./View")) });
  app.ui.registerRibbon({ id: "review", title: "Review changes", icon: InboxIcon, command: "review.open", badge: Badge });

  // The inbox follows the vault: a write by an agent, a save, another vault.
  app.notes.onChanged(() => void refresh().catch(commands.onError));
  // The user's own edits do not wait for review: a note that was not waiting before a save is not after it.
  // The event for the write comes later and reads the list again.
  app.notes.onSaved((path, before, after) => void call("review.saved", { path, before, after }).catch(commands.onError));
  void refresh().catch(commands.onError);

  // `review` in `ui_state`. `open`: whether the inbox shows. `repository`: false in a vault that is not in a
  // git repository. `entries`: the notes that wait, as `{path, status, added, removed, commits, uncommitted}`.
  // `selected`: the path of the note whose changes show, or null. `diff`: `{added, removed}`, the lines its
  // text now has more and fewer than the text last seen, as the comparison marks them; null without one.
  app.ui.registerState(() => {
    const { open, repository, entries, selected } = shown;
    const texts = compared();
    return { review: { open, repository, entries, selected, diff: texts && diffCounts(texts.before, texts.after) } };
  });

  app.commands.register({
    id: "review.open",
    title: "Review changes",
    key: "Mod+Shift+R",
    // Shows the inbox in the active tab.
    run: async () => {
      app.views.show("review");
      await refresh();
    },
  });
  app.commands.register({
    id: "review.select",
    title: "Review: select next note",
    // `{path}`: shows the changes of that note, in the inbox. Without it, of the note after the picked one.
    run: async (params) => {
      const { path } = param(params);
      const at = shown.entries.findIndex((e) => e.path === shown.selected);
      const entry = typeof path === "string" ? shown.entries.find((e) => e.path === path) : shown.entries[at + 1];
      if (!entry) throw new Error(path === undefined ? "There is no next note to review" : `${String(path)} is not waiting for review`);
      app.views.show("review");
      await select(entry.path);
    },
  });
  app.commands.register({
    id: "review.accept",
    title: "Review: accept all changes",
    // `{path}`: marks that note's text as seen. Without it, everything that waits.
    run: (params) => accept(param(params).path as string | undefined),
  });
  app.commands.register({
    id: "review.reject",
    title: "Review: reject the selected note's changes",
    // `{path}`: takes that note back to the text last seen. Without it, the note picked in the inbox.
    run: (params) => {
      const path = param(params).path ?? shown.selected;
      if (typeof path !== "string") throw new Error("Select a note in the review inbox first");
      return reject(path);
    },
  });
}
