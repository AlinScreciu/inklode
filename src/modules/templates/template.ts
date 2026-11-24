// What a template becomes in a note (index.ts): its `{{title}}`, `{{date}}` and `{{time}}` filled in, and its
// frontmatter merged with the note's. Pure functions: no React and no DOM (self-check: template.test.mjs).

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
const ordinal = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"));

/** The ISO 8601 week of `date` and the year that week belongs to: weeks start on Monday, week 1 has the year's first Thursday. */
function isoWeek(date: Date): { week: number; year: number } {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // The Thursday of this week decides the year.
  day.setDate(day.getDate() + 3 - ((day.getDay() + 6) % 7));
  const year = day.getFullYear();
  const first = new Date(year, 0, 4);
  const week = 1 + Math.round(((day.getTime() - first.getTime()) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
  return { week, year };
}

/** The day of the year, from 1. */
const dayOfYear = (date: Date) => Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86400000) + 1;

/** Moment.js tokens, longest first, and text in `[brackets]`, which is kept as it is. */
const TOKENS = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|Do|DDDD|DDD|DD|D|dddd|ddd|dd|d|E|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|A|a|WW|W|GGGG|X|x|ZZ|Z/g;

/**
 * `date` written with a Moment.js format, the one Obsidian's templates use: `YYYY-MM-DD`, `dddd, MMMM Do`, `HH:mm`.
 * English names, local time. Letters that are no token are kept, as Moment does.
 */
// shortcut: the English locale only, and Moment's locale weeks (`w`, `ww`, `gggg`) are not read; the ISO ones
// (`W`, `WW`, `GGGG`) are. Add a locale when a vault asks for its month names in another language
export function formatDate(date: Date, format: string): string {
  const hours = date.getHours();
  const offset = (colon: boolean) => {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes < 0 ? "-" : "+";
    return sign + pad(Math.floor(Math.abs(minutes) / 60)) + (colon ? ":" : "") + pad(Math.abs(minutes) % 60);
  };
  return format.replace(TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return pad(date.getFullYear() % 100);
      case "Q":
        return String(Math.floor(date.getMonth() / 3) + 1);
      case "MMMM":
        return MONTHS[date.getMonth()];
      case "MMM":
        return MONTHS[date.getMonth()].slice(0, 3);
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "Do":
        return ordinal(date.getDate());
      case "DDDD":
        return pad(dayOfYear(date), 3);
      case "DDD":
        return String(dayOfYear(date));
      case "DD":
        return pad(date.getDate());
      case "D":
        return String(date.getDate());
      case "dddd":
        return DAYS[date.getDay()];
      case "ddd":
        return DAYS[date.getDay()].slice(0, 3);
      case "dd":
        return DAYS[date.getDay()].slice(0, 2);
      case "d":
        return String(date.getDay());
      case "E":
        return String(((date.getDay() + 6) % 7) + 1);
      case "HH":
        return pad(hours);
      case "H":
        return String(hours);
      case "hh":
        return pad(hours % 12 || 12);
      case "h":
        return String(hours % 12 || 12);
      case "kk":
        return pad(hours || 24);
      case "k":
        return String(hours || 24);
      case "mm":
        return pad(date.getMinutes());
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "s":
        return String(date.getSeconds());
      case "SSS":
        return pad(date.getMilliseconds(), 3);
      case "A":
        return hours < 12 ? "AM" : "PM";
      case "a":
        return hours < 12 ? "am" : "pm";
      case "WW":
        return pad(isoWeek(date).week);
      case "W":
        return String(isoWeek(date).week);
      case "GGGG":
        return String(isoWeek(date).year);
      case "X":
        return String(Math.floor(date.getTime() / 1000));
      case "x":
        return String(date.getTime());
      case "ZZ":
        return offset(false);
      case "Z":
        return offset(true);
      default:
        return token;
    }
  });
}

/**
 * The template's text with its variables filled in, as Obsidian's core Templates plugin does: `{{title}}` is the
 * note's name, `{{date}}` the day as `YYYY-MM-DD`, `{{time}}` the time as `HH:mm`, and `{{date:FORMAT}}` and
 * `{{time:FORMAT}}` the moment `now` in a Moment.js format. Anything else in braces is left as it is.
 */
export function expand(template: string, { title, now }: { title: string; now: Date }): string {
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/g, (_, name: string, format: string | undefined) => {
    if (name === "title") return title;
    return formatDate(now, format?.trim() || (name === "date" ? "YYYY-MM-DD" : "HH:mm"));
  });
}

/** Where a note's frontmatter is: the lines between its `---` lines, and the offset of the closing line. */
interface Frontmatter {
  /** The text between the two `---` lines, each line ending in "\n" (empty when there are none). */
  inner: string;
  /** Where the closing `---` line starts. */
  close: number;
  /** Where the text after the frontmatter starts. */
  end: number;
}

/** The frontmatter at the very start of `text`, as the editor reads it (a `---` line, up to the next `---` or `...`). */
export function frontmatterOf(text: string): Frontmatter | null {
  const open = /^---[ \t]*\n/.exec(text);
  if (!open) return null;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(text.slice(open[0].length));
  if (!close) return null;
  const at = open[0].length + close.index;
  return { inner: text.slice(open[0].length, at), close: at, end: at + close[0].length };
}

/** The top-level keys of frontmatter and the lines of each: the key's line and what is indented or listed under it. */
function entries(inner: string): { key: string | null; text: string }[] {
  const out: { key: string | null; text: string }[] = [];
  for (const line of inner.split(/(?<=\n)/)) {
    if (line === "") continue;
    const key = /^([^\s#:-][^:]*?)[ \t]*:(?:\s|$)/.exec(line)?.[1] ?? null;
    // An indented line, a `- item` or a comment belongs to the key above it.
    if (key === null && out.length > 0) out[out.length - 1].text += line;
    else out.push({ key, text: line });
  }
  return out;
}

/** One change to the note, in the offsets of the note before any change, as CodeMirror takes them. */
export interface Change {
  from: number;
  to: number;
  insert: string;
}

/**
 * What putting the (already expanded) `template` over `from`–`to` of `note` changes: the template's body goes
 * there, and its frontmatter goes to the top of the note. A note without frontmatter gets the template's; a note
 * with some gets the keys of the template's that it does not have, after its own. `cursor` is where the cursor
 * goes after the changes: at the end of the inserted body. A selection inside the note's frontmatter is replaced
 * by nothing and the body goes after the frontmatter.
 */
// shortcut: a key both have keeps the note's value, lists too (Obsidian adds the template's tags to the note's);
// merge the items of `tags` and `aliases` when templates are used to add tags to existing notes
export function insertTemplate(note: string, from: number, to: number, template: string): { changes: Change[]; cursor: number } {
  const theirs = frontmatterOf(template);
  if (!theirs) return { changes: [{ from, to, insert: template }], cursor: from + template.length };
  const body = template.slice(theirs.end);
  const mine = frontmatterOf(note);
  let top: Change;
  if (!mine) top = { from: 0, to: 0, insert: template.slice(0, theirs.end) + (theirs.end === template.length ? "\n" : "") };
  else {
    const have = new Set(entries(mine.inner).map((e) => e.key?.toLowerCase()));
    const added = entries(theirs.inner)
      .filter((e) => e.key !== null && !have.has(e.key.toLowerCase()))
      .map((e) => (e.text.endsWith("\n") ? e.text : e.text + "\n"))
      .join("");
    // A note whose frontmatter does not end its last line with "\n" cannot happen: the closing line follows it.
    top = { from: mine.close, to: mine.close, insert: added };
    // Not into the frontmatter: the body goes right after it.
    if (from < mine.end) from = to = Math.max(to, mine.end);
  }
  const changes = [top, { from, to, insert: body }].filter((c) => c.insert !== "" || c.from !== c.to);
  return { changes, cursor: from + body.length + (top.from <= from ? top.insert.length : 0) };
}

/** `text` after `changes`, which are in the offsets of `text` and in order. For the self-check and for a new note. */
export function applyChanges(text: string, changes: Change[]): string {
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}

/** The notes under `folder` in a list of vault paths, as `{path, name, hint}`: `hint` is the subfolder, if any. */
export function templatesIn(paths: readonly string[], folder: string): { path: string; name: string; hint: string }[] {
  const prefix = folder.replace(/^\/+|\/+$/g, "") + "/";
  return paths
    .filter((path) => path.startsWith(prefix) && /\.md$/i.test(path) && !/\.excalidraw\.md$/i.test(path))
    .map((path) => {
      const rest = path.slice(prefix.length);
      const slash = rest.lastIndexOf("/");
      return { path, name: rest.slice(slash + 1).replace(/\.md$/i, ""), hint: slash < 0 ? "" : rest.slice(0, slash) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
