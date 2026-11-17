// Which commit each line of a note's text comes from: git's answer for the committed file, carried over to
// the text as it is now. Plain data (self-check: blame.test.mjs); editor.ts draws it in the margin.

import { lineDiff } from "../../textDiff.ts";

/** A commit, as the core's `git.log` gives it. */
export interface Commit {
  rev: string;
  author: string;
  /** ISO 8601, e.g. `2026-11-16T21:04:33+02:00`. */
  date: string;
  subject: string;
}

/** `git.blame`: lines `from` to `to` (1-based, inclusive) of the committed file were last changed by this commit. */
export interface BlameRange extends Commit {
  from: number;
  to: number;
}

/** Lines `from` to `to` (1-based, inclusive) of the text now: from `commit`, or not committed yet (null). */
export interface Mark {
  from: number;
  to: number;
  commit: Commit | null;
}

/**
 * The marks for the text `now`, given the text of the last commit and git's ranges for it. A line that is
 * in both texts keeps its commit, wherever it moved to; a line that is only in `now` is not committed yet.
 * Lines next to each other with the same answer are one mark. A committed line git said nothing about (the
 * empty line after a final newline) has no mark.
 */
export function marks(ranges: BlameRange[], committed: string, now: string): Mark[] {
  const all: Mark[] = [];
  let range = 0;
  for (const line of lineDiff(committed, now)) {
    if (line.kind === "remove") continue;
    let commit: Commit | null = null;
    if (line.kind === "same") {
      // Both the ranges and the lines that stayed are in the order of the committed file.
      while (range < ranges.length && ranges[range].to < line.before) range++;
      if (range === ranges.length || ranges[range].from > line.before) continue;
      commit = ranges[range];
    }
    const last = all[all.length - 1];
    if (last && last.to + 1 === line.after && last.commit?.rev === commit?.rev) last.to = line.after;
    else all.push({ from: line.after, to: line.after, commit });
  }
  return all;
}
