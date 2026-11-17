// What the review inbox lists, as the core's `review.list` gives it, and the two things worked out from it
// without the app (self-check: inbox.test.mjs).

export interface Commit {
  rev: string;
  author: string;
  date: string;
  subject: string;
}

/** A note that waits for review. */
export interface Entry {
  path: string;
  status: "changed" | "added" | "deleted";
  /** Lines the note has more and fewer than when the user last looked. */
  added: number;
  removed: number;
  /** The commits since then that changed it, newest first. */
  commits: Commit[];
  /** Whether its text on disk is not the last commit's. */
  uncommitted: boolean;
}

/**
 * The note that is picked after the list changed: the same one while it still waits, else the one that took
 * its place in the list, so a row of accepts and rejects needs no click in between. Null when nothing waits.
 */
export function follow(before: Entry[], after: Entry[], selected: string | null): string | null {
  if (selected === null || after.some((e) => e.path === selected)) return selected;
  const at = Math.max(before.findIndex((e) => e.path === selected), 0);
  return after[Math.min(at, after.length - 1)]?.path ?? null;
}

/** Where a note's change came from, for its row: the newest commit's author and subject, or that it is not committed. */
export function origin(entry: Entry): string {
  const [last] = entry.commits;
  if (!last) return "not committed yet";
  const more = entry.commits.length > 1 ? ` (+${entry.commits.length - 1} more)` : "";
  return `${last.author}: ${last.subject}${more}${entry.uncommitted ? ", and not committed changes" : ""}`;
}
