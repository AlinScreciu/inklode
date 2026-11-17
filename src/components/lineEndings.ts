// The line ending of a note. The editor (CodeMirror) holds a text as lines and gives it back joined with "\n",
// so a note that has "\r\n" on disk would be written back whole with "\n" after the first keystroke. The editor
// remembers what the note had when it was read (`eolOf`), works on the "\n" form (`toLf`) and reports its text
// with the note's own ending again (`withEol`). Self-check: lineEndings.test.mjs.

export type Eol = "\n" | "\r\n";

/**
 * The line ending a text uses: "\r\n" when more of its lines end that way than with a bare "\n".
 * A text with both kinds is taken as all of the more common one, so an edit of it writes every line with that one.
 * A lone "\r" (classic Mac OS) is not counted: the editor reads it as a line end and it is written as the other kind.
 */
export function eolOf(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** `text` with every line ending as "\n", which is how the editor holds it. */
export const toLf = (text: string) => text.replace(/\r\n?/g, "\n");

/** A text in the "\n" form with `eol` as its line ending. */
export const withEol = (text: string, eol: Eol) => (eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
