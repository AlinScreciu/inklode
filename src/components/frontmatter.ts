// Reads simple YAML frontmatter for Live Preview's properties block (livePreview.ts): the keys and
// their values. It only reads; the text is never changed.

/** A piece of a line, as offsets into that line: `[from, to)`. */
export type Span = [number, number];

/** One line between the `---` lines. */
export interface PropLine {
  /** The key of a `key: value` line. A `- item` line under a key has none. */
  key?: Span;
  /** The values on the line: one for a scalar, one per item for `[a, b]`, none for a key whose list follows. */
  values: Span[];
  /** True when the values are items of a list, as in `[a, b]` or `- item`. */
  list: boolean;
}

const KEY = /^([A-Za-z0-9_][\w .-]*?)[ \t]*:(?:[ \t]+|$)/;
const ITEM = /^[ \t]+-[ \t]+/;
// What starts a YAML value this reader does not understand: block text, maps, anchors, tags, comments.
const NOT_SIMPLE = /^[|>{&*!#%@`]/;

/** The span of `text.slice(from, to)` without the spaces around it and without one pair of quotes. */
function value(text: string, from: number, to: number): Span | null {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  const quote = text[from];
  if (to - from >= 2 && (quote === '"' || quote === "'") && text[to - 1] === quote) {
    from++;
    to--;
  }
  const inner = text.slice(from, to);
  return from === to || /["'[\]{}]/.test(inner) || NOT_SIMPLE.test(inner) ? null : [from, to];
}

/**
 * The lines between the two `---` lines, read as `key: value`, `key: [a, b]` and `key:` with
 * `- item` lines under it. Null when a line is anything else (nested maps, block text, comments,
 * blank lines), so the caller shows the YAML as written.
 */
export function readFrontmatter(lines: readonly string[]): PropLine[] | null {
  const out: PropLine[] = [];
  /** Whether `- item` lines may follow: the last key had no value on its line. */
  let listOpen = false;
  for (const text of lines) {
    const item = ITEM.exec(text);
    if (item) {
      const span = value(text, item[0].length, text.length);
      if (!listOpen || !span) return null;
      out.push({ values: [span], list: true });
      continue;
    }
    const key = KEY.exec(text);
    if (!key) return null;
    const line: PropLine = { key: [0, key[1].length], values: [], list: false };
    const from = key[0].length;
    const rest = text.slice(from).trim();
    listOpen = rest === "";
    if (rest.startsWith("[") && rest.endsWith("]")) {
      line.list = true;
      let at = text.indexOf("[", from) + 1;
      const end = text.lastIndexOf("]");
      // `[]` is an empty list.
      if (text.slice(at, end).trim() !== "") {
        for (const part of text.slice(at, end).split(",")) {
          const span = value(text, at, at + part.length);
          if (!span) return null;
          line.values.push(span);
          at += part.length + 1;
        }
      }
    } else if (rest !== "") {
      const span = value(text, from, text.length);
      if (!span) return null;
      line.values.push(span);
    }
    out.push(line);
  }
  return out;
}

/** One row of the properties block: a key with all its values, wherever the YAML wrote them. */
export interface PropRow {
  key: string;
  values: string[];
  /** True when the key holds a list, so its values show as pills. */
  list: boolean;
}

/** `readFrontmatter` as rows: the `- item` lines under a key become that key's values. Null as there. */
export function readProps(lines: readonly string[]): PropRow[] | null {
  const props = readFrontmatter(lines);
  if (!props) return null;
  const rows: PropRow[] = [];
  props.forEach((prop, i) => {
    const values = prop.values.map(([from, to]) => lines[i].slice(from, to));
    if (prop.key) rows.push({ key: lines[i].slice(...prop.key), values, list: prop.list });
    else {
      const row = rows[rows.length - 1];
      row.values.push(...values);
      row.list = true;
    }
  });
  return rows;
}
