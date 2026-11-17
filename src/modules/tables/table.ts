// Pipe tables (GFM) as text: finding them in a note, reading one into rows of cells, changing it
// and writing it back. No DOM and no CodeMirror, so `pnpm test:tables` checks it in plain Node.
//
// Reading is tolerant: a row may have fewer or more cells than the header. `format` always writes
// a regular table. A table that is only read is never written, so its text stays as it was.

export type Align = "left" | "center" | "right" | "none";

export interface Table {
  /** One per column of the delimiter row. */
  aligns: Align[];
  /**
   * `rows[0]` is the header. A cell is its text between the pipes, trimmed, as written: a pipe in it
   * is still `\|`. A row can be shorter or longer than the header.
   */
  rows: string[][];
}

/** The line under the header: `| --- | :-: |`, with at least one pipe. */
const DELIMITER = /^ {0,3}\|?([ \t]*:?-+:?[ \t]*\|)+([ \t]*:?-+:?[ \t]*)?$/;
/** A line that begins another block, so it is neither a header nor a row: a heading, a quote, a fence, a list item. */
const OTHER_BLOCK = /^ {0,3}(#{1,6}([ \t]|$)|>|`{3,}|~{3,}|[-*+][ \t]|\d{1,9}[.)][ \t])/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Where the cells of one row line are. `from` and `to` are the cell's text without the spaces
 * around it, `end` is its closing pipe or the end of the line. `\|` does not end a cell, also
 * inside inline code (GFM).
 */
export function cells(line: string): { from: number; to: number; end: number }[] {
  const out: { from: number; to: number; end: number }[] = [];
  const space = (i: number) => line[i] === " " || line[i] === "\t";
  let start = 0;
  while (space(start)) start++;
  if (line[start] === "|") start++;
  for (let i = start; i <= line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      i++;
    } else if (i === line.length || line[i] === "|") {
      let from = start;
      let to = i;
      while (from < to && space(from)) from++;
      while (to > from && space(to - 1)) to--;
      // What follows the last pipe is a cell only if something is written there.
      if (i === line.length && from === to && out.length > 0) break;
      // An empty cell is after its one space of padding, when it has any.
      if (from === to) from = to = Math.min(start + 1, i);
      out.push({ from, to, end: i });
      start = i + 1;
    }
  }
  return out;
}

const texts = (line: string) => cells(line).map((cell) => line.slice(cell.from, cell.to));

/**
 * The tables in a note, given its lines: each as the index of its header line and the index after
 * its last row. A table is a line with a pipe followed by a delimiter line with as many cells. It
 * may follow a paragraph directly. It ends at an empty line or at a line that begins another block.
 */
// shortcut: only tables at the top level of the note are found; one inside a list item or a quote
// stays text. Find them through the editor's syntax tree when those need editing in place.
export function findTables(lines: string[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = 0;
  // Frontmatter, as the editor reads it: without a closing line, the rest of the note.
  if (/^---\s*$/.test(lines[0] ?? "")) {
    i = 1;
    while (i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i])) i++;
    i++;
  }
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      // A fenced code block ends at a fence of the same character that is at least as long.
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      i++;
      while (i < lines.length && !close.test(lines[i])) i++;
      i++;
      continue;
    }
    const header = lines[i];
    const delimiter = lines[i + 1];
    if (
      delimiter === undefined ||
      !header.includes("|") ||
      !/^ {0,3}\S/.test(header) ||
      OTHER_BLOCK.test(header) ||
      !DELIMITER.test(delimiter) ||
      cells(header).length !== cells(delimiter).length
    ) {
      i++;
      continue;
    }
    let to = i + 2;
    while (to < lines.length && lines[to].trim() !== "" && !OTHER_BLOCK.test(lines[to])) to++;
    out.push({ from: i, to });
    i = to;
  }
  return out;
}

/** Reads the text of one table: its lines from the header to the last row, as `findTables` gives them. */
export function parse(text: string): Table {
  const lines = text.split("\n");
  const aligns = texts(lines[1]).map((mark): Align => {
    const left = mark.startsWith(":");
    const right = mark.endsWith(":");
    return left && right ? "center" : left ? "left" : right ? "right" : "none";
  });
  return { aligns, rows: [texts(lines[0]), ...lines.slice(2).map(texts)] };
}

/** How many columns the table shows: those of its longest row. */
export function columnCount(table: Table): number {
  return Math.max(table.aligns.length, ...table.rows.map((row) => row.length));
}

/** A copy in which every row has `columnCount` cells: short rows get empty cells, new columns no alignment. */
function regular(table: Table): Table {
  const columns = columnCount(table);
  const pad = <T>(list: T[], fill: T) => [...list, ...Array<T>(columns - list.length).fill(fill)];
  return { aligns: pad(table.aligns, "none"), rows: table.rows.map((row) => pad(row, "")) };
}

/**
 * The table as text, the way Obsidian's table editor writes it: one space around each cell and
 * every column as wide as its longest cell, at least three characters. No line break at the end.
 */
// shortcut: width is the number of UTF-16 units, so columns with CJK text or emoji do not line up
// in a monospace font; measure display width if that matters.
export function format(table: Table): string {
  const { aligns, rows } = regular(table);
  const widths = aligns.map((_, c) => Math.max(3, ...rows.map((row) => row[c].length)));
  const line = (row: string[]) => `| ${row.map((cell, c) => cell.padEnd(widths[c])).join(" | ")} |`;
  const rule = aligns.map(
    (align, c) =>
      (align === "left" || align === "center" ? ":" : "-") +
      "-".repeat(widths[c] - 2) +
      (align === "right" || align === "center" ? ":" : "-"),
  );
  return [line(rows[0]), line(rule), ...rows.slice(1).map(line)].join("\n");
}

/** The index of a row's line in the table's text: the delimiter line is between the header and the first row. */
const lineOf = (row: number) => (row === 0 ? 0 : row + 1);

/** The cell that offset `at` of the table's text is in. On the delimiter line it is the header's. */
export function cellAt(text: string, at: number): { row: number; column: number } {
  const lines = text.split("\n");
  let line = 0;
  let start = 0;
  while (line < lines.length - 1 && start + lines[line].length < at) start += lines[line++].length + 1;
  const found = cells(lines[line]);
  const column = found.findIndex((cell) => at - start <= cell.end);
  return { row: Math.max(0, line - 1), column: column < 0 ? found.length - 1 : column };
}

/** The offset in the table's text where a cell's text starts. For a cell its row does not have, the end of the row. */
export function cellOffset(text: string, row: number, column: number): number {
  const lines = text.split("\n");
  const line = lineOf(row);
  const start = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0);
  return start + (cells(lines[line])[column]?.from ?? lines[line].length);
}

/** A cell's text as shown for editing: its pipes without the backslash. */
export function unescapeCell(cell: string): string {
  return cell.replace(/\\\|/g, "|");
}

/** What was typed in a cell, as written in the file: one line, trimmed, every pipe escaped. */
export function escapeCell(typed: string): string {
  return typed.replace(/\s*[\r\n]+\s*/g, " ").trim().replace(/\|/g, "\\|");
}

// The changes below return a new regular table and leave the one given as it is.
// Rows and columns are counted from 0, and row 0 is the header.

/** An empty table with a header and `rows` more rows. */
export function emptyTable(rows: number, columns: number): Table {
  const row = () => Array<string>(columns).fill("");
  return { aligns: Array<Align>(columns).fill("none"), rows: Array.from({ length: rows + 1 }, row) };
}

export function setCell(table: Table, row: number, column: number, cell: string): Table {
  const next = regular(table);
  next.rows[row][column] = cell;
  return next;
}

/** Adds an empty row so that it is row `at`. */
export function addRow(table: Table, at: number): Table {
  const next = regular(table);
  next.rows.splice(at, 0, Array<string>(next.aligns.length).fill(""));
  return next;
}

/** Adds an empty column so that it is column `at`. */
export function addColumn(table: Table, at: number): Table {
  const next = regular(table);
  next.aligns.splice(at, 0, "none");
  for (const row of next.rows) row.splice(at, 0, "");
  return next;
}

export function deleteRow(table: Table, row: number): Table {
  const next = regular(table);
  next.rows.splice(row, 1);
  return next;
}

export function deleteColumn(table: Table, column: number): Table {
  const next = regular(table);
  next.aligns.splice(column, 1);
  for (const row of next.rows) row.splice(column, 1);
  return next;
}

/** Swaps two rows. */
export function moveRow(table: Table, row: number, to: number): Table {
  const next = regular(table);
  [next.rows[row], next.rows[to]] = [next.rows[to], next.rows[row]];
  return next;
}

/** Swaps two columns, with their alignment. */
export function moveColumn(table: Table, column: number, to: number): Table {
  const next = regular(table);
  for (const list of [next.aligns, ...next.rows] as string[][]) [list[column], list[to]] = [list[to], list[column]];
  return next;
}

export function setAlign(table: Table, column: number, align: Align): Table {
  const next = regular(table);
  next.aligns[column] = align;
  return next;
}
