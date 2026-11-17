// What the tasks panel lists, as the core's `vault.tasks` gives it, and the one change the panel makes to a
// note: ticking a checkbox (self-check: tasks.test.mjs).

export interface Task {
  /** 1-based line in the note. */
  line: number;
  /** The text after the checkbox, 200 characters of it at most. */
  text: string;
}

/** A note with open checkboxes. */
export interface NoteTasks {
  path: string;
  tasks: Task[];
}

// An open checkbox line, as the core reads it (`open_task` in crates/core/src/index.rs): a list marker
// (`-`, `*`, `+`, `1.`, `1)`), `[ ]`, then nothing or a space and the text. The groups are what is before
// the space between the brackets and what is after it.
const OPEN = /^(\s*(?:[-*+]|\d+[.)])[ \t]\s*\[) (\](?:\s[^]*)?)$/;

/**
 * `content` with the checkbox on `line` ticked (`[ ]` to `[x]`), every other character as it was. Null
 * when that line is not an open checkbox with this text any more: the note changed since the list was read.
 */
export function tick(content: string, task: Task): string | null {
  const lines = content.split("\n");
  const found = OPEN.exec(lines[task.line - 1] ?? "");
  // The list has 200 characters of the text, counted as the core counts them.
  if (!found || [...found[2].slice(1).trim()].slice(0, 200).join("") !== task.text) return null;
  lines[task.line - 1] = `${found[1]}x${found[2]}`;
  return lines.join("\n");
}

/** How many checkboxes are open in all the notes. */
export function count(notes: NoteTasks[]): number {
  return notes.reduce((sum, note) => sum + note.tasks.length, 0);
}
