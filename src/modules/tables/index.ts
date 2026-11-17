// The tables module: pipe tables are shown as tables in Live Preview and edited in place
// (editor.ts), and commands change the structure of the table the cursor is in. The table text is
// read and written by table.ts.

import type { AppApi } from "../../modules";
import { current, extension, structure, tableAt, write } from "./editor";
import {
  addColumn,
  addRow,
  type Align,
  cellAt,
  cellOffset,
  columnCount,
  deleteColumn,
  deleteRow,
  emptyTable,
  format,
  moveColumn,
  moveRow,
  setAlign,
  type Table,
} from "./table";

const ALIGNS: Align[] = ["none", "left", "center", "right"];

/** The open editor, the table its cursor is in, and the cursor's cell. Throws if there is none. */
function target() {
  const view = current.view;
  if (!view) throw new Error("Open a note first");
  const head = view.state.selection.main.head;
  const found = tableAt(view.state, head);
  if (!found) throw new Error("Put the cursor in a table first");
  const { table } = found;
  return { view, found, table, ...cellAt(found.text, head - found.from), rows: table.rows.length, columns: columnCount(table) };
}

/** Writes the changed table as one undo step and puts the cursor in the cell at `row` and `column`. */
function change(at: ReturnType<typeof target>, table: Table, row: number, column: number) {
  write(at.view, at.found, table, row, column, { annotations: structure });
}

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export function activate(app: AppApi) {
  app.editor.registerExtension(extension);

  // `table` in `ui_state`: the cursor's cell and the table's size, with the header as row 0. Null outside a table.
  app.ui.registerState(() => {
    const state = current.view?.state;
    const head = state?.selection.main.head ?? 0;
    const found = state && tableAt(state, head);
    return {
      table: found ? { ...cellAt(found.text, head - found.from), rows: found.table.rows.length, columns: columnCount(found.table) } : null,
    };
  });

  app.commands.register({
    id: "table.addRow",
    title: "Table: add row below",
    // `{above: true}` adds it above the cursor's row.
    run: (params) => {
      const at = target();
      const row = param(params).above ? at.row : at.row + 1;
      if (row === 0) throw new Error("A row cannot go above the header");
      change(at, addRow(at.table, row), row, at.column);
    },
  });
  app.commands.register({
    id: "table.addColumn",
    title: "Table: add column right",
    // `{left: true}` adds it left of the cursor's column.
    run: (params) => {
      const at = target();
      const column = param(params).left ? at.column : at.column + 1;
      change(at, addColumn(at.table, column), at.row, column);
    },
  });
  app.commands.register({
    id: "table.deleteRow",
    title: "Table: delete row",
    run: () => {
      const at = target();
      if (at.row === 0) throw new Error("The header row cannot be deleted");
      change(at, deleteRow(at.table, at.row), Math.min(at.row, at.rows - 2), at.column);
    },
  });
  app.commands.register({
    id: "table.deleteColumn",
    title: "Table: delete column",
    run: () => {
      const at = target();
      if (at.columns === 1) throw new Error("The only column cannot be deleted");
      change(at, deleteColumn(at.table, at.column), at.row, Math.min(at.column, at.columns - 2));
    },
  });
  app.commands.register({
    id: "table.moveRow",
    title: "Table: move row down",
    // `{direction: "up"}` moves it up. The header stays where it is.
    run: (params) => {
      const at = target();
      const to = at.row + (param(params).direction === "up" ? -1 : 1);
      if (at.row === 0 || to < 1 || to >= at.rows) throw new Error("The row cannot move there");
      change(at, moveRow(at.table, at.row, to), to, at.column);
    },
  });
  app.commands.register({
    id: "table.moveColumn",
    title: "Table: move column right",
    // `{direction: "left"}` moves it left.
    run: (params) => {
      const at = target();
      const to = at.column + (param(params).direction === "left" ? -1 : 1);
      if (to < 0 || to >= at.columns) throw new Error("The column cannot move there");
      change(at, moveColumn(at.table, at.column, to), at.row, to);
    },
  });
  app.commands.register({
    id: "table.align",
    title: "Table: change column alignment",
    // `{align: "left" | "center" | "right" | "none"}`. Without it, the next of none, left, center, right.
    run: (params) => {
      const at = target();
      const now = at.table.aligns[at.column] ?? "none";
      const align = (param(params).align ?? ALIGNS[(ALIGNS.indexOf(now) + 1) % ALIGNS.length]) as Align;
      if (!ALIGNS.includes(align)) throw new Error("align is left, center, right or none");
      change(at, setAlign(at.table, at.column, align), at.row, at.column);
    },
  });
  app.commands.register({
    id: "table.new",
    title: "Table: insert table",
    // `{rows?, columns?}`: rows under the header (default 2) and columns (default 3).
    run: (params) => {
      const view = current.view;
      if (!view) throw new Error("Open a note first");
      const { rows = 2, columns = 3 } = param(params) as { rows?: number; columns?: number };
      if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(columns) || columns < 1) {
        throw new Error("rows is a whole number from 0 and columns one from 1");
      }
      const { doc, selection } = view.state;
      // On an empty line the table takes that line. Else it goes under the cursor's line, or under the table the cursor is in.
      const line = doc.lineAt(tableAt(view.state, selection.main.head)?.to ?? selection.main.head);
      const blank = (number: number) => number < 1 || number > doc.lines || doc.line(number).text.trim() === "";
      const empty = blank(line.number);
      // A table needs an empty line over it to stand apart from a paragraph, and one under it so the next line is not a row.
      const before = empty ? (blank(line.number - 1) ? "" : "\n") : "\n\n";
      const after = blank(line.number + 1) ? "" : "\n";
      const text = format(emptyTable(rows, columns));
      const from = empty ? line.from : line.to;
      view.dispatch({
        changes: { from, to: line.to, insert: before + text + after },
        selection: { anchor: from + before.length + cellOffset(text, 0, 0) },
        annotations: structure,
        scrollIntoView: true,
      });
    },
  });
}
