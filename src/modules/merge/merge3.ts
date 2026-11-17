// A three-way merge by lines, for a note that changed on disk under an unsaved edit (self-check: merge3.test.mjs).

// The `.ts` ending is for the self-check, which plain Node runs.
import { lineDiff } from "../../textDiff.ts";

/** One side's change: the lines `start` up to `end` (not included, from 0) of the base become `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** What `text` changed in `base`, top to bottom. Two hunks of one text have a line of the base between them. */
function hunks(base: string, text: string): Hunk[] {
  const all: Hunk[] = [];
  let open: Hunk | null = null;
  let at = 0;
  for (const line of lineDiff(base, text)) {
    if (line.kind === "same") {
      open = null;
      at++;
      continue;
    }
    if (!open) all.push((open = { start: at, end: at, lines: [] }));
    if (line.kind === "remove") open.end = ++at;
    else open.lines.push(line.text);
  }
  return all;
}

/**
 * `base` with the changes of both `mine` and `theirs`, or null when that cannot be said for sure: a change of
 * one side touches a change of the other, which is the same lines, lines next to each other, or two insertions
 * at one spot. The same change made by both sides is taken once.
 *
 * Lines are what is between "\n"s, so a "\r" before one is part of its line and stays as it is, and a final
 * newline that is there or missing is a change of the last line like any other.
 */
// shortcut: the two sides are lined up with the base by `lineDiff`, which gives up above about 2000 changed
// lines a side and then reports one large change, so such a merge ends as a conflict; nothing is lost by it
export function merge3(base: string, mine: string, theirs: string): string | null {
  const lines = base.split("\n");
  const ours = hunks(base, mine);
  const others = hunks(base, theirs);
  const out: string[] = [];
  let at = 0;
  let m = 0;
  let t = 0;
  while (m < ours.length || t < others.length) {
    const a = ours[m];
    const b = others[t];
    let take: Hunk;
    if (a && b && a.start <= b.end && b.start <= a.end) {
      // They touch. Only the heads of the two lists need the test: a later hunk of either side starts past a
      // line of the base that this one leaves alone.
      const equal = a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
      if (!equal) return null;
      take = a;
      m++;
      t++;
    } else if (!b || (a && a.start < b.start)) {
      take = a;
      m++;
    } else {
      take = b;
      t++;
    }
    for (let i = at; i < take.start; i++) out.push(lines[i]);
    for (const line of take.lines) out.push(line);
    at = take.end;
  }
  for (let i = at; i < lines.length; i++) out.push(lines[i]);
  return out.join("\n");
}
