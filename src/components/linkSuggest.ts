// Wikilinks in the editor, without CodeMirror, so linkSuggest.test.mjs can check them in Node: what `[[` suggests
// (the link being typed, the files that match it best first, a note's headings) and where `[[note#Heading]]` and
// `[[note#^block]]` point in the note.

/** A link the cursor is in the middle of typing, found in the text of its line before the cursor. */
export interface LinkQuery {
  /** `![[`, which may name any file. `[[` names a note. */
  embed: boolean;
  /** Where the name starts in the text before the cursor: just after `[[`. */
  start: number;
  /** The name typed so far. */
  name: string;
  /** After a `#`: the heading typed so far and where it starts. Null while the name is typed. */
  heading: { start: number; text: string } | null;
}

/**
 * The link being typed when `before` (the line up to the cursor) ends in `[[name`, `![[name` or `[[name#heading`.
 * Null after an alias (`|`), in a block link (`#^`), after a second `#` and once the link is closed.
 */
export function linkQuery(before: string): LinkQuery | null {
  const m = /(!?)\[\[([^[\]|#]*)(?:#([^[\]|#]*))?$/.exec(before);
  if (!m) return null;
  const embed = m[1] === "!";
  const start = m.index + m[1].length + 2;
  if (m[3] === undefined) return { embed, start, name: m[2], heading: null };
  if (m[3].startsWith("^")) return null;
  return { embed, start, name: m[2], heading: { start: start + m[2].length + 1, text: m[3] } };
}

export interface FileSuggestion {
  path: string;
  /** What goes between `[[` and `]]`: the name, or the path when another file has the same name. */
  link: string;
  /** The name shown: a note's without `.md`, any other file's with its extension. */
  label: string;
  /** The folder, shown when another file has the same name ("/" for the vault root). Empty otherwise. */
  folder: string;
}

const NOTE = /\.md$/i;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(NOTE, "");

/**
 * How well `query` matches `text`, both in lower case: lower is better, null for no match. In order: the whole
 * text, its start, the start of a word in it, anywhere in it, and its letters in order with others between
 * (closer together is better).
 */
export function matchScore(text: string, query: string): number | null {
  if (!query || text === query) return 0;
  if (text.startsWith(query)) return 1;
  let at = text.indexOf(query);
  if (at < 0) {
    let i = 0;
    let first = -1;
    for (let j = 0; j < text.length && i < query.length; j++) {
      if (text[j] !== query[i]) continue;
      if (i === 0) first = j;
      i++;
      if (i === query.length) return 4 + (j + 1 - first - query.length) / text.length;
    }
    return null;
  }
  for (; at >= 0; at = text.indexOf(query, at + 1)) if (/[\s\-_./()]/.test(text[at - 1])) return 2;
  return 3;
}

/** The best matches for `query` among the vault's files, at most `limit`. `embed` offers every file, else notes only. */
export function suggestFiles(paths: string[], query: string, embed: boolean, limit = 50): FileSuggestion[] {
  const files = embed ? paths : paths.filter((p) => NOTE.test(p));
  const count = new Map<string, number>();
  for (const p of files) count.set(nameOf(p).toLowerCase(), (count.get(nameOf(p).toLowerCase()) ?? 0) + 1);
  const q = query.trim().toLowerCase();
  // A query with a slash is a path, matched against the whole path; else the name is matched.
  const byPath = q.includes("/");
  const ranked: { path: string; name: string; score: number }[] = [];
  for (const path of files) {
    const name = nameOf(path);
    const score = matchScore((byPath ? path.replace(NOTE, "") : name).toLowerCase(), q);
    if (score !== null) ranked.push({ path, name, score });
  }
  ranked.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.path.localeCompare(b.path));
  return ranked.slice(0, limit).map(({ path, name }) => {
    const twin = count.get(name.toLowerCase())! > 1;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    return { path, link: twin ? path.replace(NOTE, "") : name, label: name, folder: twin ? folder : "" };
  });
}

export interface Heading {
  level: number;
  text: string;
  /** 1-based. */
  line: number;
}

// shortcut: ATX headings (`# Title`) only, not Setext ones (a line underlined with `===`), and also those inside
// a quote or list item are left out; read the note's Markdown tree when such headings need links.
/** The headings of a note's text, in order, leaving out frontmatter and fenced code. */
export function headingsOf(text: string): Heading[] {
  const lines = text.split(/\r?\n/);
  const headings: Heading[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = null;
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m) headings.push({ level: m[1].length, text: (m[2] ?? "").trim(), line: i + 1 });
  }
  return headings;
}

/** A link's inner text in its parts: `note#A#B|alias` gives the name `note` and the subpath `A#B`. */
export function splitLink(link: string): { name: string; subpath: string } {
  const target = link.split("|")[0];
  const hash = target.indexOf("#");
  return hash < 0 ? { name: target.trim(), subpath: "" } : { name: target.slice(0, hash).trim(), subpath: target.slice(hash + 1).trim() };
}

const plain = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The 1-based line of `text` that a link's subpath points at, as Obsidian finds it: `^id` is the line that ends
 * in `^id`; any other is a heading, matched in any case, and of `A#B` the last part, `B`. Null when none is there.
 */
export function subpathLine(text: string, subpath: string): number | null {
  if (subpath.startsWith("^")) {
    const id = subpath.slice(1).trim();
    if (!id) return null;
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((line) => line.trimEnd().endsWith(`^${id}`) && /(^|\s)$/.test(line.trimEnd().slice(0, -id.length - 1)));
    return at < 0 ? null : at + 1;
  }
  const wanted = plain(subpath.split("#").filter((part) => part.trim()).pop() ?? "");
  if (!wanted) return null;
  return headingsOf(text).find((h) => plain(h.text) === wanted)?.line ?? null;
}
