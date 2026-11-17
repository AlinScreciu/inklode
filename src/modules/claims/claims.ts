// A claim as the core's `claims.list` gives it, and the logic of the claims module that needs no window:
// where the marker is on a line, which listed claim a line of the editor is, and the order of the review
// queue (self-check: claims.test.mjs).

export type Status = "unchecked" | "failing" | "stale" | "passing";

export interface Claim {
  path: string;
  /** 1-based line in the note. */
  line: number;
  /** The line without its marker. */
  text: string;
  /** What is after `check:` in the marker. */
  evidence: string;
  kind: "command" | "file" | "url";
  /** `stale`: it passed, but over 30 days ago, or the evidence file changed since. */
  status: Status;
  /** The day of the last check, `YYYY-MM-DD`, or null. */
  checked: string | null;
  /** The end of what the last check printed, or why it failed, or null. */
  output: string | null;
}

/** What identifies a claim in the commands and in `ui_state`: `path:line`. */
export const keyOf = (claim: Pick<Claim, "path" | "line">) => `${claim.path}:${claim.line}`;

// The marker: an HTML comment that starts with `check:` and ends the line. The evidence has no `-->` in it,
// so of two comments on a line only the last can be the marker.
const MARKER = /<!--\s*check:\s*((?:(?!-->).)*?)\s*-->[ \t]*$/;

/**
 * The marker of a claim line: where the comment starts and ends in `line` (without the spaces after it) and
 * the evidence it names. Null for a line with no marker, or with one that names nothing.
 */
export function marker(line: string): { from: number; to: number; evidence: string } | null {
  const found = MARKER.exec(line);
  if (!found || !found[1]) return null;
  return { from: found.index, to: found.index + found[0].trimEnd().length, evidence: found[1] };
}

/**
 * Of a note's listed claims, the one that line `line` of the editor is: the one listed on that line, else the
 * nearest one with the same evidence (lines typed above it and not listed yet moved it). Null when the core
 * lists no such claim, e.g. for a marker inside a code block.
 */
// shortcut: two claims of a note with the same evidence, one of them new and not saved yet, show the same
// status until the note is saved; compare the text too if that confuses
export function locate(claims: Claim[], path: string, line: number, evidence: string): Claim | null {
  let best: Claim | null = null;
  for (const claim of claims) {
    if (claim.path !== path) continue;
    if (claim.line === line) return claim;
    if (claim.evidence === evidence && (!best || Math.abs(claim.line - line) < Math.abs(best.line - line))) best = claim;
  }
  return best;
}

export interface Queue {
  failing: Claim[];
  /** Oldest check first. */
  stale: Claim[];
  unchecked: Claim[];
  passing: Claim[];
}

/** The review queue: the claims by status, each group in the list's order (path, then line), the stale ones by the day of their check. */
export function queue(claims: Claim[]): Queue {
  const of = (status: Status) => claims.filter((claim) => claim.status === status);
  // `sort` keeps the list's order for claims checked on the same day.
  const stale = of("stale").sort((a, b) => (a.checked ?? "").localeCompare(b.checked ?? ""));
  return { failing: of("failing"), stale, unchecked: of("unchecked"), passing: of("passing") };
}

/** What "Check all" checks, in the order of the queue: everything that is not passing. */
export function pending(claims: Claim[]): Claim[] {
  const { failing, stale, unchecked } = queue(claims);
  return [...failing, ...stale, ...unchecked];
}

export function counts(claims: Claim[]): Record<Status, number> {
  const out: Record<Status, number> = { failing: 0, stale: 0, unchecked: 0, passing: 0 };
  for (const claim of claims) out[claim.status]++;
  return out;
}

/** The core's answer to a command claim in a vault that may not run commands (`claims.check`). */
export const refused = (error: string) => /commands are not allowed for this vault/i.test(error);
