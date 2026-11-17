// Comparing two texts: by characters, to put one text in place of another in an editor with the smallest
// change (`middle`), and by lines, to show what differs (`lineDiff`, `fold`; drawn by components/DiffView.tsx)
// or to put a text in place stretch by stretch (`lineChanges`).

/**
 * The one change that turns `now` into `next`: what is between their common start and their common end.
 * `now.slice(0, from) + insert + now.slice(to)` is `next`, always; with repeated characters only which of
 * the equal runs counts as changed is a choice (the last one).
 */
export function middle(now: string, next: string): { from: number; to: number; insert: string } {
  const { start, end } = ends(now, next);
  return { from: start, to: now.length - end, insert: next.slice(start, next.length - end) };
}

/** How many items two texts (as characters) or two lists of lines have in common at the start, and after that at the end. */
function ends(now: ArrayLike<string>, next: ArrayLike<string>): { start: number; end: number } {
  let start = 0;
  while (start < now.length && start < next.length && now[start] === next[start]) start++;
  // The common end stops at the common start, so no item counts for both.
  let end = 0;
  while (end < now.length - start && end < next.length - start && now[now.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { start, end };
}

/** One line of a comparison of two texts. `before` and `after` are its 1-based line numbers in the two texts. */
export type DiffLine =
  | { kind: "same"; text: string; before: number; after: number }
  | { kind: "remove"; text: string; before: number }
  | { kind: "add"; text: string; after: number };

/** Above this many pairs of lines between the common start and end, `lineDiff` does not look for common lines. */
const MAX_PAIRS = 4_000_000;

/**
 * The lines of `before` and `after` in order, each marked as in both, only in `before` (removed) or only in
 * `after` (added). The lines kept are a longest common subsequence, so the changes shown are as few as can be.
 * In a changed stretch the removed lines come first. A text is split at "\n": one that ends in a newline has
 * an empty last line, as in the editor.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const { start, end } = ends(a, b);
  const n = a.length - start - end;
  const m = b.length - start - end;
  const lines: DiffLine[] = [];
  const same = (i: number, j: number) => lines.push({ kind: "same", text: a[i], before: i + 1, after: j + 1 });
  const remove = (i: number) => lines.push({ kind: "remove", text: a[i], before: i + 1 });
  const add = (j: number) => lines.push({ kind: "add", text: b[j], after: j + 1 });
  for (let i = 0; i < start; i++) same(i, i);
  // shortcut: two texts that differ over more than MAX_PAIRS pairs of lines (about 2000 changed lines each)
  // show that whole stretch as removed and added; use Myers' algorithm when notes that large are compared
  if (n * m > MAX_PAIRS) {
    for (let i = 0; i < n; i++) remove(start + i);
    for (let j = 0; j < m; j++) add(start + j);
  } else {
    // common[i * (m + 1) + j]: how many lines a[start + i…] and b[start + j…] can keep in common.
    const common = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        common[i * (m + 1) + j] =
          a[start + i] === b[start + j] ? common[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(common[(i + 1) * (m + 1) + j], common[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) same(start + i++, start + j++);
      else if (i < n && (j === m || common[(i + 1) * (m + 1) + j] >= common[i * (m + 1) + j + 1])) remove(start + i++);
      else add(start + j++);
    }
  }
  for (let k = end; k > 0; k--) same(a.length - k, b.length - k);
  return lines;
}

/**
 * The changes that turn `now` into `next`, one for each stretch of lines that differ, as character ranges of
 * `now` from top to bottom. Applied together they give `next`, always. Unlike the one change of `middle`,
 * they leave the lines between the stretches alone, so a cursor there stays where it is.
 */
export function lineChanges(now: string, next: string): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = [];
  // Where the line that comes next starts in each text, and where the stretch that is open starts.
  let a = 0;
  let b = 0;
  let open: { a: number; b: number } | null = null;
  for (const line of lineDiff(now, next)) {
    if (line.kind === "same") {
      if (open) changes.push({ from: open.a, to: a, insert: next.slice(open.b, b) });
      open = null;
    } else open ??= { a, b };
    // Each line with the newline after it. The last line has none, so both counts end one past their text.
    if (line.kind !== "add") a += line.text.length + 1;
    if (line.kind !== "remove") b += line.text.length + 1;
  }
  // A stretch that runs to the end of both texts has no newline after it, and takes the one before it
  // instead, which both texts have unless the stretch starts at their top.
  if (open) changes.push({ from: Math.max(0, open.a - 1), to: now.length, insert: next.slice(Math.max(0, open.b - 1)) });
  return changes;
}

/** A run of unchanged lines that a view of the comparison shows as one row until it is opened. */
export interface Fold {
  kind: "fold";
  lines: DiffLine[];
}

/**
 * `lines` with each run of unchanged lines folded, but for `context` lines next to a change. A run is only
 * folded when that hides at least two lines. Two texts that are the same give one fold, or nothing.
 */
export function fold(lines: DiffLine[], context = 2): (DiffLine | Fold)[] {
  const rows: (DiffLine | Fold)[] = [];
  for (let i = 0; i < lines.length; ) {
    let to = i;
    while (to < lines.length && lines[to].kind === "same") to++;
    if (to === i) {
      rows.push(lines[i++]);
      continue;
    }
    // Lines stay open after a change (not at the top of the text) and before one (not at its end).
    const from = i + (i === 0 ? 0 : context);
    const until = to - (to === lines.length ? 0 : context);
    if (until - from < 2) rows.push(...lines.slice(i, to));
    else rows.push(...lines.slice(i, from), { kind: "fold", lines: lines.slice(from, until) }, ...lines.slice(until, to));
    i = to;
  }
  return rows;
}
