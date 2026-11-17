// What of each note is not on disk yet, and the rules for writing it. Plain data with no timers and no I/O
// (self-check: saves.test.mjs); App.tsx does the writes and the reads and reports here what happened.
//
// Per note, by path:
// - `base`: the file's text as the app last read or wrote it. Every write sends it, and the core refuses the
//   write when the file has another text by then, so a change made by another program is never written over.
// - `pending`: the edit that waits to be written. It stays until a write of it succeeded.
// - one write at most is in flight. A second one would send a base the first is about to change.
// - `failed`: the last write did not work (disk full, no permission). The edit is kept and tried again.
// - `conflict`: the file has another text than `base` (`theirs`), or is gone (`theirs` null). The edit is kept
//   and nothing is written until the user chooses (`keepMine`, `takeTheirs`).
//
// All of it belongs to one vault, counted by `gen`. `reset` starts the next one, and what an editor or a
// write of an earlier vault reports after that is ignored, so text never goes to another vault than its own.

/** What is wrong with a note's saving, for the banner in its pane. */
export type Issue =
  | { kind: "failed"; message: string }
  /** `theirs`: the file's text now. Undefined until it is read. */
  | { kind: "conflict"; theirs?: string }
  | { kind: "gone" };

interface Note {
  base?: string;
  pending?: string;
  /** The text of the write in flight. */
  writing?: string;
  /** Writes begun, so a read can tell that a write ran while it did. */
  writes: number;
  /** Failed writes in a row. */
  tries: number;
  issue?: Issue;
  /** The file is gone or changed: `base` for the next write once the user chose to keep their text. */
  theirs?: string | null;
}

/** A write that was begun: what to send to the core, and what `done` and `fail` need back. */
export interface Job {
  gen: number;
  path: string;
  content: string;
  base: string;
  note: Note;
}

/**
 * What a read of the file means:
 * - "take": the file has a new text and nothing is unsaved: show it.
 * - "same": nothing to do.
 * - "conflict": the file has another text than the unsaved edit was made on.
 * - "retry": a conflict is over (the file is as it was again): save the edit.
 * - "stale": a write ran during the read, so the text may be older than that write. The write's own change
 *   event reads the file again.
 */
export type Seen = "take" | "same" | "conflict" | "retry" | "stale";

/** A three-way merge of a note's text: `base` with the changes of both `mine` and `theirs`, or null when they cannot be merged for sure. */
export type Merge = (base: string, mine: string, theirs: string, path: string) => string | null;

export class Saves {
  /** What `merged` merges with. Null, so every conflict goes to the user, unless the `merge` module is on (src/modules/merge). */
  static merge: Merge | null = null;

  gen = 0;
  private notes = new Map<string, Note>();

  private note(path: string): Note {
    let note = this.notes.get(path);
    if (!note) this.notes.set(path, (note = { writes: 0, tries: 0 }));
    return note;
  }

  /** Another vault: everything is forgotten, and reports from before are ignored from now on. */
  reset(): number {
    this.notes.clear();
    return ++this.gen;
  }

  /** An edit, as the note's whole new text. False, and nothing kept, when it comes from an earlier vault. */
  edit(gen: number, path: string, content: string): boolean {
    if (gen !== this.gen) return false;
    this.note(path).pending = content;
    return true;
  }

  /** Whether a note has an edit that is not on disk yet. */
  dirty(path: string): boolean {
    const note = this.notes.get(path);
    return note !== undefined && (note.pending !== undefined || note.writing !== undefined);
  }

  /** The note's text when it is newer than the file: the edit that waits, or the one being written. */
  text(path: string): string | undefined {
    const note = this.notes.get(path);
    return note?.pending ?? note?.writing;
  }

  issue(path: string): Issue | undefined {
    return this.notes.get(path)?.issue;
  }

  /** Every note with something wrong, by path. */
  issues(): Record<string, Issue> {
    const all: Record<string, Issue> = {};
    for (const [path, note] of this.notes) if (note.issue) all[path] = note.issue;
    return all;
  }

  /** The notes with an edit waiting or a write in flight. */
  unsaved(): string[] {
    return [...this.notes.keys()].filter((path) => this.dirty(path));
  }

  /** Whether the edit that waits is written by itself after a while. Not while the user has to choose. */
  autosaves(path: string): boolean {
    const kind = this.notes.get(path)?.issue?.kind;
    return kind !== "conflict" && kind !== "gone";
  }

  /** Starts a write of the edit that waits. Null when there is none, one is in flight, or the user has to choose first. */
  begin(path: string): Job | null {
    const note = this.notes.get(path);
    if (!note || note.pending === undefined || note.writing !== undefined || !this.autosaves(path)) return null;
    if (note.base === undefined) {
      // Never written blind: without the text the edit was made on, the core could not tell what it replaces.
      note.issue = { kind: "failed", message: "the file was not read before it was edited" };
      return null;
    }
    const content = note.pending;
    note.pending = undefined;
    note.writing = content;
    note.writes++;
    return { gen: this.gen, path, content, base: note.base, note };
  }

  /** Whether a job is still about its note: not after another vault was opened, or the note was dropped or moved. */
  private current(job: Job): boolean {
    return job.gen === this.gen && this.notes.get(job.path) === job.note;
  }

  /** The write worked: the file has this text now. False when the job is not current any more. */
  done(job: Job): boolean {
    if (!this.current(job)) return false;
    const { note } = job;
    note.writing = undefined;
    note.base = job.content;
    note.tries = 0;
    if (note.issue?.kind === "failed") note.issue = undefined;
    return true;
  }

  /**
   * The write did not work and wrote nothing. The edit waits again, unless a newer one does. `conflict`: the
   * core refused it because the file is not as `base` any more. False when the job is not current any more.
   */
  fail(job: Job, conflict: boolean, message: string): boolean {
    if (!this.current(job)) return false;
    const { note } = job;
    note.writing = undefined;
    note.pending ??= job.content;
    if (conflict) note.issue = { kind: "conflict" };
    else {
      note.tries++;
      note.issue = { kind: "failed", message };
    }
    return true;
  }

  /** How long to wait before the next try, from `first` ms doubling up to `max`. */
  retryIn(path: string, first: number, max = 10_000): number {
    return Math.min(first * 2 ** (this.notes.get(path)?.tries ?? 0), max);
  }

  /** Before a read of the file: what `disk` and `gone` need to tell whether a write ran meanwhile. */
  stamp(path: string): number {
    const note = this.notes.get(path);
    return note ? (note.writing !== undefined ? -1 : note.writes) : 0;
  }

  private fresh(note: Note, stamp: number): boolean {
    return stamp >= 0 && note.writing === undefined && stamp === note.writes;
  }

  /** The file was read and has this text. */
  disk(path: string, text: string, stamp: number): Seen {
    const note = this.note(path);
    if (!this.fresh(note, stamp)) return "stale";
    const was = note.issue?.kind === "conflict" || note.issue?.kind === "gone";
    if (note.pending === undefined || note.pending === text) {
      // Nothing unsaved, or the file already has what was typed.
      const changed = note.base !== text && note.pending === undefined;
      note.base = text;
      note.pending = undefined;
      note.theirs = undefined;
      if (was) note.issue = undefined;
      return changed ? "take" : "same";
    }
    if (text === note.base) {
      if (!was) return "same";
      note.issue = undefined;
      note.theirs = undefined;
      return "retry";
    }
    note.theirs = text;
    // The same object while nothing changed, so what draws it is not drawn again.
    if (note.issue?.kind !== "conflict" || note.issue.theirs !== text) note.issue = { kind: "conflict", theirs: text };
    return "conflict";
  }

  /** The file was read and is not there: moved or deleted by another program. False for a read that a write overtook. */
  gone(path: string, stamp: number): boolean {
    const note = this.note(path);
    if (!this.fresh(note, stamp)) return false;
    note.theirs = null;
    if (note.issue?.kind !== "gone") note.issue = { kind: "gone" };
    return true;
  }

  /**
   * The user keeps their text over the file's: `mine` is the editor's text, for when nothing was unsaved. The
   * next write replaces the file as it was last read, or makes it again if it was gone, and is refused like
   * any other if the file changed once more. False when there is nothing to choose.
   */
  keepMine(path: string, mine: string): boolean {
    const note = this.notes.get(path);
    if (!note || note.theirs === undefined) return false;
    // The core takes a file that is missing as empty.
    note.base = note.theirs ?? "";
    note.pending ??= mine;
    note.theirs = undefined;
    note.issue = undefined;
    return true;
  }

  /**
   * Ends a conflict without the user when the edit and the file changed different parts of the note. `mine` is
   * the editor's text. Returns the merged text, which now waits to be written over the file as it was just
   * read; the caller puts it into the editors. Undefined, and nothing changed, when there is no merge
   * function, no conflict with a text on both sides, `mine` is not the edit that waits, or the merge does not
   * work out: the conflict stays for the user.
   */
  merged(path: string, mine: string): string | undefined {
    const note = this.notes.get(path);
    if (!Saves.merge || !note || note.issue?.kind !== "conflict" || typeof note.theirs !== "string") return undefined;
    if (note.base === undefined || note.pending !== mine || note.writing !== undefined) return undefined;
    let text: string | null;
    try {
      text = Saves.merge(note.base, mine, note.theirs, path);
    } catch {
      return undefined;
    }
    if (typeof text !== "string") return undefined;
    note.base = note.theirs;
    note.pending = text;
    note.theirs = undefined;
    note.issue = undefined;
    return text;
  }

  /** The user takes the file's text: their edit is dropped. Returns that text, or undefined when there is none to take. */
  takeTheirs(path: string): string | undefined {
    const note = this.notes.get(path);
    if (!note || typeof note.theirs !== "string") return undefined;
    const text = note.theirs;
    note.base = text;
    note.pending = undefined;
    note.theirs = undefined;
    note.issue = undefined;
    return text;
  }

  /** The note was renamed or moved by the app: its edit and its base go with it, and what was wrong at the old path is over. */
  move(from: string, to: string) {
    const note = this.notes.get(from);
    if (!note) return;
    this.notes.delete(from);
    // A write that is in flight went to the old path and reports to nobody now: its text waits again. If it
    // did land before the move, the next write is refused and the read that follows finds the text already there.
    note.pending ??= note.writing;
    note.writing = undefined;
    note.issue = undefined;
    note.theirs = undefined;
    note.tries = 0;
    this.notes.set(to, note);
  }

  /** Forgets a note with its edit: it was deleted, or the user gave the edit up. A write in flight reports to nobody. */
  drop(path: string) {
    this.notes.delete(path);
  }

  /** Forgets the notes that are not in `keep` and have nothing unsaved. */
  prune(keep: readonly string[]) {
    for (const path of [...this.notes.keys()]) if (!keep.includes(path) && !this.dirty(path)) this.notes.delete(path);
  }
}
