// The text side of quick capture: which note takes the captures, and what a capture adds to that note.
// Plain functions with no I/O (self-check: append.test.mjs, `pnpm test:capture`).

/** The capture note of a vault that names none. */
export const DEFAULT_NOTE = "Inbox.md";

/**
 * The vault path of the capture note: `"capture": {"note": "path.md"}` in the vault's `.inklode/settings.json`,
 * whose text is `settings` (null when there is no such file). Without that key, or with a file that does not
 * parse, `Inbox.md` at the vault root.
 */
export function captureNote(settings: string | null): string {
  try {
    const note = (JSON.parse(settings ?? "{}") as { capture?: { note?: unknown } } | null)?.capture?.note;
    if (typeof note === "string" && note.trim()) return note.trim();
  } catch {
    // Not valid JSON: the app says so in its banner, and captures go to the default note meanwhile.
  }
  return DEFAULT_NOTE;
}

/**
 * A capture as one list item: `- ` before its first line, and its other lines indented under that, so they
 * stay part of the item. White space around the text and at line ends is dropped. Null for a text of white space only.
 */
export function item(text: string): string | null {
  const lines = text.trim().split(/\r\n?|\n/);
  if (lines[0] === "") return null;
  return lines.map((line, at) => (at === 0 ? `- ${line.trimEnd()}` : line.trim() ? `  ${line.trimEnd()}` : "")).join("\n");
}

/**
 * What a capture adds at the end of the capture note, whose text is `file` ("" for a note that is not there
 * yet): the item on a line of its own, with a line end after it. The text that is there is added to and never
 * changed, so a note that does not end with a line end gets one first, and blank lines at its end stay. The
 * line ends are the note's own (`\r\n` in a note that has them). Null when there is nothing to capture.
 */
export function addition(file: string, text: string): string | null {
  const entry = item(text);
  if (entry === null) return null;
  const newline = file.includes("\r\n") ? "\r\n" : "\n";
  return (file === "" || file.endsWith("\n") ? "" : newline) + entry.replace(/\n/g, newline) + newline;
}
