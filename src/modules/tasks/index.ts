// The tasks module: every open checkbox (`- [ ]`) of the vault in one list, in the right sidebar, grouped by
// note. A click on a task's text opens its note at that line; a click on its checkbox ticks it in the note.
//
// The list is the core's (`vault.tasks`) and is read again when the vault changes. Ticking changes the note
// the way the user could: as an edit in the note's editor when it is open (Undo takes it back, and it is
// saved like typing), else as a write that the core refuses if the file changed since it was read here.
//
// This file, tasks.ts and ../editors.ts load when the module is switched on, Panel.tsx when the panel is first opened.

import { isolateHistory } from "@codemirror/commands";
import { ListTodo } from "lucide-react";
import { createElement, lazy, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import type { AppApi } from "../../modules";
import { middle } from "../../textDiff";
import { extension, viewFor } from "../editors";
import { polled } from "../polled";
import { count, type NoteTasks, tick } from "./tasks";

/** Calls into the Rust core. Set when the module is switched on. */
let call: AppApi["core"]["call"];

/** The notes with open checkboxes, by path. */
export const tasks = polled<NoteTasks[]>([], () => call<NoteTasks[]>("vault.tasks"));

/** Whether the panel is on screen, said by Panel.tsx. */
export const panel = { open: false };

/** Opens a note at a line, for Panel.tsx. Set when the module is switched on. */
export let openNote: AppApi["notes"]["open"];

/** Ticks the checkbox on `line` of the note at `path`. */
async function tickTask(path: string, line: number) {
  const listed = () => tasks.get().find((note) => note.path === path)?.tasks ?? [];
  const clicked = listed().find((t) => t.line === line);
  if (!clicked) throw new Error(`${path} has no open task on line ${line}`);
  const changed = new Error(`${path} changed since its tasks were listed. The list is read again.`);
  // What was typed and still waits goes to disk first, so no write of it lands after this.
  await commands.execute("note.save");
  try {
    // Lines typed above the task and saved just now moved it: it is the task with that text, if there is one only.
    await tasks.refresh();
    const same = listed().filter((t) => t.text === clicked.text);
    const task = same.find((t) => t.line === line) ?? (same.length === 1 ? same[0] : null);
    if (!task) throw changed;
    const view = viewFor(path);
    if (view) {
      // An edit like any typed one, in one undo step: the editor reports it, and the app saves it as it saves typing.
      const now = view.state.doc.toString();
      const next = tick(now, task);
      if (next === null) throw changed;
      view.dispatch({ changes: middle(now, next), annotations: isolateHistory.of("full") });
      await commands.execute("note.save");
    } else {
      // Not open: written over the text just read, so a change made in between is refused by the core as a
      // conflict and not written over.
      const { content } = await call<{ content: string }>("note.read", { path });
      const next = tick(content, task);
      if (next === null) throw changed;
      await call("note.write", { path, content: next, base: content });
    }
  } finally {
    await tasks.refresh();
  }
}

/** The count on the ribbon button: how many checkboxes are open. */
function Badge() {
  const left = count(useSyncExternalStore(tasks.subscribe, tasks.get));
  return left ? createElement("span", { className: "ribbon-badge", "aria-label": `${left} open tasks` }, left > 99 ? "99+" : left) : null;
}

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export function activate(app: AppApi) {
  call = app.core.call;
  openNote = app.notes.open;
  app.editor.registerExtension(extension);
  app.ui.registerPanel({ id: "tasks", title: "Tasks", component: lazy(() => import("./Panel")) });
  app.ui.registerRibbon({ id: "tasks", title: "Show open tasks", icon: ListTodo, command: "tasks.open", badge: Badge });

  // The list follows the vault: a save, a write by another program, another vault.
  app.notes.onChanged(() => void tasks.refresh().catch(commands.onError));
  void tasks.refresh().catch(commands.onError);

  // `tasks` in `ui_state`. `open`: whether the panel shows. `count`: how many checkboxes are open. `notes`: the
  // notes that have some, by path, as `{path, tasks}` with `tasks` as `{line, text}`, `line` from 1.
  app.ui.registerState(() => ({ tasks: { open: panel.open, count: count(tasks.get()), notes: tasks.get() } }));

  app.commands.register({
    id: "tasks.open",
    title: "Show open tasks",
    // Opens the panel, or closes it when it is open. `{open}` says which.
    run: async (params) => {
      app.ui.togglePanel("tasks", param(params).open as boolean | undefined);
      await tasks.refresh();
    },
  });
  app.commands.register({
    id: "tasks.tick",
    title: "Tasks: tick a task",
    // `{path, line}`: ticks the open checkbox on that line of that note. The checkboxes of the panel run it.
    run: (params) => {
      const { path, line } = param(params);
      if (typeof path !== "string" || typeof line !== "number") throw new Error("Tick a task in the tasks panel");
      return tickTask(path, line);
    },
  });
}
