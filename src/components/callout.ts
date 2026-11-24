// Callouts as Obsidian writes them: a quote whose first line is `> [!type] Title`, with `-` or `+` after the
// `]` to make it foldable (folded or open at first). Plain data and functions (self-check: callout.test.mjs);
// livePreview.ts draws them.

/** The looks a callout can have. Every type Obsidian knows is one of these or an alias of one. */
export type CalloutKind =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";

const ALIASES: Record<string, CalloutKind> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

const svg = (shapes: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;

/** The icon of each kind, as SVG markup: Lucide's icons that Obsidian uses for them, copied so a widget can draw them as plain DOM. */
export const CALLOUT_ICONS: Record<CalloutKind, string> = {
  note: svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
  abstract: svg('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  todo: svg('<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>'),
  tip: svg('<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>'),
  success: svg('<path d="M20 6 9 17l-5-5"/>'),
  question: svg('<circle cx="12" cy="12" r="10"/><path d="M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5"/><path d="M12 17h.01"/>'),
  warning: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  failure: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  danger: svg('<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>'),
  bug: svg('<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>'),
  example: svg('<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>'),
  quote: svg('<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>'),
};

/** Lucide's "chevron-right": the fold mark of a foldable callout, turned down while it is open. */
export const FOLD_ICON = svg('<path d="m9 18 6-6-6-6"/>');

export interface CalloutHead {
  /** The type as written, in lower case: `warning`, `tldr`, `my-type`. */
  type: string;
  /** How it looks. A type Obsidian does not know looks like a note. */
  kind: CalloutKind;
  /** `-`: foldable and folded at first, `+`: foldable and open at first, empty: not foldable. */
  fold: "" | "+" | "-";
  /** The title as written, or empty when there is none and the type is the title. */
  title: string;
  /** Where the title starts in the text that was read: the length of `> [!type]- `. */
  titleAt: number;
}

const HEAD = /^>[ \t]*\[!([^\]]+)\]([+-]?)[ \t]*/;

/** Reads the first line of a quote, from its `>` on. Null when it is a plain quote. */
export function readCallout(text: string): CalloutHead | null {
  const match = HEAD.exec(text);
  if (!match) return null;
  const type = match[1].trim().toLowerCase();
  if (!type) return null;
  const kind = type in CALLOUT_ICONS ? (type as CalloutKind) : (ALIASES[type] ?? "note");
  return { type, kind, fold: match[2] as CalloutHead["fold"], title: text.slice(match[0].length).trimEnd(), titleAt: match[0].length };
}

/** The title of a callout written without one: its type with a capital, as Obsidian shows it. */
export const defaultTitle = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/** Whether a callout shows folded: as its `-` or `+` says, the other way round when its title was clicked. */
export const isFolded = (head: CalloutHead, flipped: boolean) => head.fold !== "" && (head.fold === "-") !== flipped;
