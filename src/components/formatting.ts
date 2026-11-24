// Bold, italic and link for the editor's selection (the `editor.bold`, `editor.italic` and `editor.link` commands in
// App.tsx), without CodeMirror, so formatting.test.mjs can check them in Node. A plain string is a `Doc` too.

/** The note's text, or enough of it: CodeMirror's document, or a string in the self-check. */
export interface Doc {
  length: number;
  slice(from: number, to: number): string;
}

/** One replacement and the selection after it, in the text as it is after the replacement. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
}

/**
 * Bold (`**`) or italic (`*`) on or off for the selection `from`-`to`. Marks right around the selection, or at
 * the two ends of the selected text, are taken off; else the selection is wrapped in them. With nothing selected
 * the pair goes in with the cursor between, and Bold again right away takes the empty pair off. A run of three
 * stars is bold and italic, so either one can come off it; `**bold**` is not italic.
 */
export function toggleMark(doc: Doc, from: number, to: number, mark: "**" | "*"): Edit {
  const k = mark.length;
  const star = (at: number) => at >= 0 && at < doc.length && doc.slice(at, at + 1) === "*";
  const run = (at: number, step: 1 | -1, limit: number) => {
    let n = 0;
    while (n < 3 && n < limit && star(at + n * step)) n++;
    return n;
  };
  const marked = (n: number) => n === k || n === 3;
  const text = doc.slice(from, to);
  if (marked(Math.min(run(from - 1, -1, 3), run(to, 1, 3)))) {
    return { from: from - k, to: to + k, insert: text, anchor: from - k, head: to - k };
  }
  const half = Math.floor(text.length / 2);
  if (text.length >= 2 * k && marked(Math.min(run(from, 1, half), run(to - 1, -1, half)))) {
    const inner = text.slice(k, text.length - k);
    return { from, to, insert: inner, anchor: from, head: from + inner.length };
  }
  return { from, to, insert: mark + text + mark, anchor: from + k, head: to + k };
}

const URL = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+$/i;

/**
 * A Markdown link from the selection: selected text becomes `[text]()` with the cursor in the brackets of the URL,
 * a selected URL becomes `[](url)` with the cursor in the brackets of the text, and nothing selected gives `[]()`
 * with the cursor in the first brackets.
 */
export function insertLink(doc: Doc, from: number, to: number): Edit {
  const text = doc.slice(from, to);
  if (URL.test(text.trim())) {
    const insert = `[](${text.trim()})`;
    return { from, to, insert, anchor: from + 1, head: from + 1 };
  }
  const insert = `[${text}]()`;
  const at = text ? from + insert.length - 1 : from + 1;
  return { from, to, insert, anchor: at, head: at };
}
