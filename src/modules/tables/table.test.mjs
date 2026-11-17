// Self-check for table.ts, run by `pnpm test:tables` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import {
  addColumn,
  addRow,
  cellAt,
  cellOffset,
  cells,
  columnCount,
  deleteColumn,
  deleteRow,
  emptyTable,
  escapeCell,
  findTables,
  format,
  moveColumn,
  moveRow,
  parse,
  setAlign,
  setCell,
  unescapeCell,
} from "./table.ts";

/** The text of each table in a note. */
const tablesIn = (note) => {
  const lines = note.split("\n");
  return findTables(lines).map(({ from, to }) => lines.slice(from, to).join("\n"));
};

// Alignment row variants.
{
  const table = parse("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |");
  assert.deepEqual(table.aligns, ["left", "center", "right", "none"]);
  assert.deepEqual(table.rows, [["a", "b", "c", "d"], ["1", "2", "3", "4"]]);
  // Without outer pipes, with spaces, with one dash.
  assert.deepEqual(parse("a | b\n:- | -:\n1 | 2").aligns, ["left", "right"]);
  assert.deepEqual(parse("a | b\n - | :-: \n1 | 2").aligns, ["none", "center"]);
  assert.deepEqual(parse("| a |\n| :---: |").aligns, ["center"]);
  for (const delimiter of ["|---|---|", "---|---", "| :-- | --: |", "|-|-|", "  | - | - |  ".trimEnd()]) {
    assert.equal(tablesIn(`| a | b |\n${delimiter}\n| 1 | 2 |`).length, 1, delimiter);
  }
  // Not delimiter rows: no pipe, a stray character, a cell count other than the header's.
  for (const delimiter of ["---", "| -x- | - |", "| = | = |", "| - |", "| - | - | - |", "| : | - |"]) {
    assert.deepEqual(tablesIn(`| a | b |\n${delimiter}\n| 1 | 2 |`), [], delimiter);
  }
}

// Escaped pipes, and pipes inside inline code: `\|` stays in the cell, a bare pipe ends it even in code (GFM).
{
  const table = parse("| a \\| b | `x \\| y` |\n| - | - |\n| `p | q` | [[Note\\|alias]] |");
  assert.deepEqual(table.rows[0], ["a \\| b", "`x \\| y`"]);
  assert.deepEqual(table.rows[1], ["`p", "q`", "[[Note\\|alias]]"]);
  assert.equal(unescapeCell("`x \\| y`"), "`x | y`");
  assert.equal(escapeCell("  a | b\n`c|d` "), "a \\| b `c\\|d`");
  assert.equal(unescapeCell(escapeCell("a | b")), "a | b");
  // Typed text that already has `\|` reads back as typed.
  assert.equal(unescapeCell(parse(`| ${escapeCell("a \\| b")} |\n| - |`).rows[0][0]), "a \\| b");
}

// Ragged rows: read as they are, shown and written with every row as long as the longest.
{
  const text = "| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n|\njust text";
  const table = parse(text);
  assert.deepEqual(table.rows.slice(1), [["1"], ["1", "2", "3", "4"], [""], ["just text"]]);
  assert.equal(columnCount(table), 4);
  assert.equal(
    format(table),
    [
      "| a         | b   | c   |     |",
      "| --------- | --- | --- | --- |",
      "| 1         |     |     |     |",
      "| 1         | 2   | 3   | 4   |",
      "|           |     |     |     |",
      "| just text |     |     |     |",
    ].join("\n"),
  );
}

// Where tables are.
{
  // Directly after a paragraph: the paragraph's last line is the header.
  assert.deepEqual(tablesIn("Some text\n| a | b |\n|---|---|\n| 1 | 2 |\n\nmore"), ["| a | b |\n|---|---|\n| 1 | 2 |"]);
  // Looks like a table, but has no delimiter row.
  assert.deepEqual(tablesIn("| a | b |\n| 1 | 2 |\n| 3 | 4 |"), []);
  assert.deepEqual(tablesIn("| a | b |"), []);
  assert.deepEqual(tablesIn("a\n---\nb | c"), []);
  // Inside a fenced code block, also a longer fence around a shorter one, and a fence that never closes.
  assert.deepEqual(tablesIn("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```"), []);
  assert.deepEqual(tablesIn("~~~~md\n~~~\n| a | b |\n|---|---|\n~~~\n| a | b |\n|---|---|\n~~~~"), []);
  assert.deepEqual(tablesIn("```\n| a | b |\n|---|---|"), []);
  // After the fence closes there can be one again.
  assert.deepEqual(tablesIn("```\n| a |\n| - |\n```\n| b |\n| - |"), ["| b |\n| - |"]);
  // In frontmatter, in a quote or list item, or indented as code: not a table.
  assert.deepEqual(tablesIn("---\na | b\n- | -\n---\n"), []);
  assert.deepEqual(tablesIn("> | a |\n> | - |"), []);
  assert.deepEqual(tablesIn("- a | b\n- | -"), []);
  assert.deepEqual(tablesIn("    | a |\n    | - |"), []);
  // It ends at an empty line or where another block begins; two tables in one note.
  assert.deepEqual(tablesIn("| a |\n| - |\n| 1 |\n# Heading\n\n| b |\n| - |\n\n| c |"), ["| a |\n| - |\n| 1 |", "| b |\n| - |"]);
  assert.deepEqual(findTables("x\n\n| a |\n| - |\n| 1 |\n".split("\n")), [{ from: 2, to: 5 }]);
}

// An untouched table is unchanged: its text is never produced from the parsed table, and every
// cell is found at its place in the original text.
{
  const text = "|a|b  |\n|-|:-:|\n| 1 |   2|\n|  | x \\| y |";
  const note = `Intro\n\n${text}\n\nOutro\n`;
  assert.deepEqual(tablesIn(note), [text]);
  const table = parse(text);
  const lines = text.split("\n");
  table.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const at = cellOffset(text, r, c);
      assert.equal(text.slice(at, at + cell.length), cell, `cell ${r},${c}`);
      assert.deepEqual(cellAt(text, at), { row: r, column: c });
      assert.deepEqual(cellAt(text, at + cell.length), { row: r, column: c });
    }),
  );
  assert.equal(lines.join("\n"), text);
  // The delimiter line counts as the header row.
  assert.deepEqual(cellAt(text, lines[0].length + 1 + "|-|:".length), { row: 0, column: 1 });
  // A table that format wrote reads back the same and formats to itself.
  const written = format(table);
  assert.equal(written, "| a   | b      |\n| --- | :----: |\n| 1   | 2      |\n|     | x \\| y |");
  assert.deepEqual(parse(written), table);
  assert.equal(format(parse(written)), written);
  assert.deepEqual(tablesIn(written), [written]);
}

// Cells of one row line.
{
  const line = "|  a | b\\|c |   |";
  assert.deepEqual(cells(line).map((c) => line.slice(c.from, c.to)), ["a", "b\\|c", ""]);
  assert.deepEqual(cells("a |").length, 1);
  assert.deepEqual(cells("| a | b").length, 2);
  assert.deepEqual(cells("|").length, 1);
}

// Changes: each gives a regular table and leaves the one it was given alone.
{
  const table = parse("| a | b | c |\n| :- | - | -: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |");
  const before = JSON.stringify(table);
  const rows = (t) => t.rows.map((row) => row.join(""));
  assert.deepEqual(rows(setCell(table, 1, 1, "x")), ["abc", "1x3", "456"]);
  assert.deepEqual(rows(addRow(table, 1)), ["abc", "", "123", "456"]);
  assert.deepEqual(rows(addRow(table, 3)), ["abc", "123", "456", ""]);
  assert.equal(addRow(table, 3).rows[3].length, 3);
  assert.deepEqual(rows(deleteRow(table, 1)), ["abc", "456"]);
  assert.deepEqual(rows(moveRow(table, 1, 2)), ["abc", "456", "123"]);
  assert.deepEqual(rows(addColumn(table, 1)), ["abc", "123", "456"]);
  assert.deepEqual(addColumn(table, 1).rows[0], ["a", "", "b", "c"]);
  assert.deepEqual(addColumn(table, 1).aligns, ["left", "none", "none", "right"]);
  assert.deepEqual(rows(deleteColumn(table, 0)), ["bc", "23", "56"]);
  assert.deepEqual(deleteColumn(table, 0).aligns, ["none", "right"]);
  assert.deepEqual(rows(moveColumn(table, 0, 1)), ["bac", "213", "546"]);
  assert.deepEqual(moveColumn(table, 0, 1).aligns, ["none", "left", "right"]);
  assert.deepEqual(setAlign(table, 1, "center").aligns, ["left", "center", "right"]);
  assert.equal(JSON.stringify(table), before);
  assert.equal(format(emptyTable(2, 3)), "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |");
  assert.deepEqual(tablesIn(format(emptyTable(2, 3))).length, 1);
  // The cursor place in an empty cell is after its padding.
  assert.equal(cellOffset(format(emptyTable(1, 2)), 1, 1), "|     |     |\n| --- | --- |\n|     | ".length);
}

console.log("tables format: ok");
