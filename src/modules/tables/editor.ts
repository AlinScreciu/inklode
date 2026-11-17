// Tables in the editor. The extension finds the note's pipe tables (table.ts) and, in Live Preview,
// shows each one as a real table in place of its lines. A cell is edited where it is: with the
// focus it shows its raw Markdown, and every change is written to the document as a normal
// CodeMirror change that replaces the text of that one table, formatted. Source mode shows the text.
//
// The editor's cursor says which cell is meant: a cell that gets the focus puts the cursor at its
// place in the text, so the commands and `ui_state` work the same in both modes.
//
// Classes, styled in app.css: `md-table-block` (the box), `md-table-tools` (its buttons),
// `md-table-scroll` (scrolls a wide table sideways), and a plain `table` with `th` and `td`.

import { isolateHistory, redo, undo } from "@codemirror/commands";
import { Annotation, type EditorState, StateField, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { parser } from "@lezer/markdown";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  type LucideIcon,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
  RemoveFormatting,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash2,
} from "lucide-react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { commands } from "../../commands";
import { livePreviewOn, markdownSyntax } from "../../components/livePreview";
import { inActivePane } from "../../modules";
import { addRow, cellAt, cellOffset, columnCount, escapeCell, findTables, format, parse, setCell, type Table, unescapeCell } from "./table";

/** One table of the note: where its text is in the document, the text, and what it says. */
export interface Found {
  from: number;
  to: number;
  text: string;
  table: Table;
}

/** The editors on screen: one per pane that shows a note as text. */
const views = new Set<EditorView>();

/** The editor the commands act on: the active pane's, or the only one. Null while there is none. */
export const current = {
  get view(): EditorView | null {
    return inActivePane(views, (view) => view.dom);
  },
};

/** On a transaction after which the cell the cursor is in gets the focus. */
const toCell = Annotation.define<boolean>();

/** For a change to a table's structure: the cursor's cell gets the focus, and the change is an undo step of its own. */
export const structure = [toCell.of(true), isolateHistory.of("full")];

/** Height of a table row in px before it is measured, so the scrollbar is about right for tables not drawn yet. */
const ROW_HEIGHT = 34;

// shortcut: the whole note is read again on every change to find its tables, which is fast for
// notes of a few thousand lines; look only at the changed lines if typing in huge notes lags.
function scan(state: EditorState): { tables: Found[]; decorations: DecorationSet } {
  const tables = findTables(state.doc.toJSON()).map(({ from, to }): Found => {
    const start = state.doc.line(from + 1).from;
    const end = state.doc.line(to).to;
    const text = state.sliceDoc(start, end);
    return { from: start, to: end, text, table: parse(text) };
  });
  const widgets = tables.map((t) => Decoration.replace({ widget: new TableWidget(t.text, t.table), block: true }).range(t.from, t.to));
  return { tables, decorations: state.facet(livePreviewOn) ? Decoration.set(widgets) : Decoration.none };
}

const tables = StateField.define<{ tables: Found[]; decorations: DecorationSet }>({
  create: scan,
  // `reconfigured`: the editor changed between Live Preview and source mode.
  update: (value, tr) => (tr.docChanged || tr.reconfigured ? scan(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The table that has `pos` in its text or at its end. */
export function tableAt(state: EditorState, pos: number): Found | null {
  return state.field(tables, false)?.tables.find((t) => t.from <= pos && pos <= t.to) ?? null;
}

/**
 * Replaces a table's text with `table`, formatted, and puts the cursor in the cell at `row` and
 * `column`. Only the part of the text that differs is changed, so a typed letter is a small edit.
 */
export function write(view: EditorView, found: Found, table: Table, row: number, column: number, spec: TransactionSpec) {
  const text = format(table);
  if (text === found.text) return;
  let start = 0;
  while (text[start] === found.text[start]) start++;
  let end = text.length;
  let oldEnd = found.text.length;
  while (end > start && oldEnd > start && text[end - 1] === found.text[oldEnd - 1]) {
    end--;
    oldEnd--;
  }
  view.dispatch({
    changes: { from: found.from + start, to: found.from + oldEnd, insert: text.slice(start, end) },
    selection: { anchor: found.from + cellOffset(text, row, column) },
    ...spec,
  });
}

// Cells as elements.

type Cell = HTMLTableCellElement;

const cellOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<Cell>("td, th") : null);

/** Puts the caret at the start or the end of a cell's text. */
function caret(cell: Cell, start: boolean) {
  const selection = getSelection();
  selection?.selectAllChildren(cell);
  if (start) selection?.collapseToStart();
  else selection?.collapseToEnd();
}

/** Whether the caret is at this edge of the cell's text, with nothing selected. */
function caretAt(cell: Cell, edge: "start" | "end"): boolean {
  const selection = getSelection();
  if (!selection?.isCollapsed || !selection.focusNode) return false;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (edge === "start") range.setEnd(selection.focusNode, selection.focusOffset);
  else range.setStart(selection.focusNode, selection.focusOffset);
  return range.toString() === "";
}

/** Gives the focus to the cell at `row` and `column` of the table in `box`, with the caret at the end or the start of its text. */
function focusCell(box: Element, row: number, column: number, start = false) {
  const cell = box.querySelector("table")?.rows[row]?.cells[column];
  if (!cell) return;
  // Scrolls the cell into view too, down a long table and sideways in a wide one.
  if (cell !== document.activeElement) cell.focus();
  caret(cell, start);
}

/** The table a cell element belongs to and the cell's place in it. */
function locate(view: EditorView, cell: Cell): { found: Found; row: number; column: number } | null {
  const found = tableAt(view.state, view.posAtDOM(cell.closest(".md-table-block")!));
  return found && { found, row: (cell.parentElement as HTMLTableRowElement).rowIndex, column: cell.cellIndex };
}

/** After a cursor move by keys, an undo or a structure command: the cell the cursor is in gets the focus, and no cell has it when the cursor left the tables. */
function focusSelected(view: EditorView) {
  const { main } = view.state.selection;
  const found = main.empty ? tableAt(view.state, main.head) : null;
  if (!found) {
    if (view.contentDOM.contains(cellOf(document.activeElement))) view.focus();
    return;
  }
  const { row, column } = cellAt(found.text, main.head - found.from);
  // A table outside the part of the note that is drawn has no element, and gets no focus.
  const boxes = Array.from(view.contentDOM.querySelectorAll(".md-table-block"));
  const box = boxes.find((el) => view.posAtDOM(el) === found.from);
  if (box) focusCell(box, row, column);
}

/** Leaves the table: the cursor goes to the line under it (`by` 1) or over it (-1), and the editor gets the focus. */
function leave(view: EditorView, found: Found, by: -1 | 1) {
  if (by < 0 && found.from === 0) return;
  // shortcut: under a table that ends the note there is no line, so the cursor stays at the table's end
  view.dispatch({ selection: { anchor: by < 0 ? found.from - 1 : Math.min(found.to + 1, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
}

// Inline Markdown in a cell.

const inline = parser.configure(markdownSyntax);
type SyntaxNode = ReturnType<typeof inline.parse>["topNode"];
/** Text without any of these is shown as it is, without parsing it. */
const MARKUP = /[*_`~[\\<]|https?:/i;

function span(className: string, link?: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  if (link !== undefined) el.dataset.link = link;
  return el;
}

/**
 * Shows a cell's text with its inline Markdown rendered: emphasis, strikethrough, inline code,
 * links and wikilinks, with the classes Live Preview uses. A click on a link follows it.
 */
// shortcut: images and `![[embeds]]` in a cell show as their text; draw them like Live Preview does when wanted
function render(cell: Element, text: string) {
  cell.replaceChildren();
  if (!MARKUP.test(text)) return void cell.append(text);
  const walk = (node: SyntaxNode, into: Element) => {
    let at = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      into.append(text.slice(at, child.from));
      at = child.to;
      const inner = (el: HTMLElement) => walk(child, into.appendChild(el));
      switch (child.name) {
        case "EmphasisMark":
        case "StrikethroughMark":
          break;
        case "Emphasis":
          inner(span("tok-emphasis"));
          break;
        case "StrongEmphasis":
          inner(span("tok-strong"));
          break;
        case "Strikethrough":
          inner(span("tok-strikethrough"));
          break;
        case "Escape":
          into.append(text.slice(child.from + 1, child.to));
          break;
        case "InlineCode": {
          const marks = child.getChildren("CodeMark");
          into.appendChild(span("md-inline-code tok-monospace")).append(text.slice(marks[0].to, marks[marks.length - 1].from));
          break;
        }
        case "Wikilink": {
          // `[[target|alias]]` shows the alias.
          const target = text.slice(child.from + 2, child.to - 2);
          into.appendChild(span("md-link md-wikilink", target)).append(target.slice(target.indexOf("|") + 1));
          break;
        }
        case "Link": {
          const marks = child.getChildren("LinkMark");
          const url = child.getChild("URL");
          // `[text][ref]` and `[text]` have no URL of their own and stay as written.
          if (!url || marks.length < 2) inner(span(""));
          else render(into.appendChild(span("md-link md-external-link", text.slice(url.from, url.to))), text.slice(marks[0].to, marks[1].from));
          break;
        }
        case "URL": {
          const href = text.slice(child.from, child.to);
          into.appendChild(/^https?:/i.test(href) ? span("md-link md-external-link", href) : span("")).append(href);
          break;
        }
        default:
          walk(child, into);
      }
    }
    into.append(text.slice(at, node.to));
  };
  walk(inline.parse(text).topNode, cell);
}

// The table widget.

/**
 * The buttons over a table while one of its cells has the focus, in groups (rows, columns, alignment,
 * deleting): the icon, what it does, the command and its params, and for some a word next to the icon.
 */
const TOOLS: [LucideIcon, string, string, unknown?, string?][][] = [
  [
    [BetweenHorizontalEnd, "Add row above", "table.addRow", { above: true }],
    [BetweenHorizontalStart, "Add row below", "table.addRow"],
    [MoveUp, "Move row up", "table.moveRow", { direction: "up" }],
    [MoveDown, "Move row down", "table.moveRow", { direction: "down" }],
  ],
  [
    [BetweenVerticalEnd, "Add column left", "table.addColumn", { left: true }],
    [BetweenVerticalStart, "Add column right", "table.addColumn"],
    [MoveLeft, "Move column left", "table.moveColumn", { direction: "left" }],
    [MoveRight, "Move column right", "table.moveColumn", { direction: "right" }],
  ],
  [
    [TextAlignStart, "Align column left", "table.align", { align: "left" }],
    [TextAlignCenter, "Align column center", "table.align", { align: "center" }],
    [TextAlignEnd, "Align column right", "table.align", { align: "right" }],
    [RemoveFormatting, "No column alignment", "table.align", { align: "none" }],
  ],
  [
    [Trash2, "Delete row", "table.deleteRow", undefined, "Row"],
    [Trash2, "Delete column", "table.deleteColumn", undefined, "Column"],
  ],
];

/** The toolbar's content. A click is handled by the table's own listener, through `data-command`. */
const toolbar = TOOLS.map((group, i) =>
  createElement(
    "span",
    { key: i, className: "md-table-tools-group" },
    group.map(([icon, title, command, params, word]) =>
      createElement(
        "button",
        { key: title, title, "aria-label": title, tabIndex: -1, "data-command": command, "data-params": params && JSON.stringify(params) },
        createElement(icon, { size: 15, strokeWidth: 1.75 }),
        word,
      ),
    ),
  ),
);

/** The React root that draws each table's toolbar, to take it down with the table. */
const toolbars = new WeakMap<HTMLElement, Root>();

class TableWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly table: Table,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.text === this.text;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "md-table-block";
    const tools = box.appendChild(document.createElement("div"));
    tools.className = "md-table-tools";
    const root = createRoot(tools);
    root.render(toolbar);
    toolbars.set(box, root);
    const scroll = box.appendChild(document.createElement("div"));
    scroll.className = "md-table-scroll";
    const grid = scroll.appendChild(document.createElement("table"));
    grid.createTHead().insertRow();
    grid.createTBody();
    draw(box, this.table);
    listen(box, view);
    return box;
  }

  // The same table with other text keeps its element, so the cell being edited keeps the focus and its caret.
  updateDOM(box: HTMLElement) {
    draw(box, this.table);
    return true;
  }

  destroy(box: HTMLElement) {
    toolbars.get(box)?.unmount();
  }

  get estimatedHeight() {
    return this.table.rows.length * ROW_HEIGHT;
  }

  // The table handles its own events; to the editor it is one block.
  ignoreEvent() {
    return true;
  }
}

/** Makes the element show `table`, changing only the rows and cells that differ from what it shows. */
function draw(box: HTMLElement, table: Table) {
  const grid = box.querySelector("table")!;
  const body = grid.tBodies[0];
  const columns = columnCount(table);
  while (body.rows.length > table.rows.length - 1) body.deleteRow(-1);
  while (body.rows.length < table.rows.length - 1) body.insertRow();
  for (const row of Array.from(grid.rows)) {
    while (row.cells.length > columns) row.deleteCell(-1);
    while (row.cells.length < columns) {
      const cell = row.appendChild(document.createElement(row.rowIndex === 0 ? "th" : "td"));
      cell.contentEditable = "plaintext-only";
    }
    for (const cell of Array.from(row.cells)) {
      // A row can have fewer cells than the table has columns. Those show empty.
      const raw = table.rows[row.rowIndex][cell.cellIndex] ?? "";
      const align = table.aligns[cell.cellIndex] ?? "none";
      cell.style.textAlign = align === "none" ? "" : align;
      const shown = unescapeCell(raw);
      if (cell === document.activeElement) {
        // The cell being edited shows what was typed. It is replaced only when the document says
        // something else, as after an undo.
        if ((cell.textContent ?? "").trim() !== shown) {
          cell.textContent = shown;
          caret(cell, false);
        }
      } else if (cell.dataset.raw !== raw) {
        render(cell, shown);
      }
      cell.dataset.raw = raw;
    }
  }
}

function listen(box: HTMLElement, view: EditorView) {
  box.addEventListener("mousedown", (event) => {
    const target = event.target as Element;
    const cell = cellOf(target);
    // On a button or a border: the cell being edited keeps the focus. (Not on the box itself, which has the scrollbar of a wide table.)
    if (!cell) return void (target.closest("button, table") && event.preventDefault());
    if (event.button !== 0 || cell === document.activeElement) return;
    event.preventDefault();
    const link = event.shiftKey || event.altKey ? null : target.closest<HTMLElement>("[data-link]");
    if (link) return void commands.run("link.follow", { link: link.dataset.link });
    // With the focus the cell turns into its raw text, so the caret is placed after that, at the pointer.
    cell.focus();
    const at = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (at && cell.contains(at.startContainer)) getSelection()?.setBaseAndExtent(at.startContainer, at.startOffset, at.startContainer, at.startOffset);
    else caret(cell, false);
  });

  box.addEventListener("click", (event) => {
    const tool = (event.target as Element).closest<HTMLElement>("[data-command]");
    if (tool) void commands.run(tool.dataset.command!, tool.dataset.params && JSON.parse(tool.dataset.params));
  });

  box.addEventListener("focusin", (event) => {
    const cell = cellOf(event.target);
    const at = cell && locate(view, cell);
    if (!at) return;
    cell.textContent = unescapeCell(cell.dataset.raw ?? "");
    const pos = at.found.from + cellOffset(at.found.text, at.row, at.column);
    const { main } = view.state.selection;
    if (!main.empty || main.head !== pos) view.dispatch({ selection: { anchor: pos } });
  });

  box.addEventListener("focusout", (event) => {
    const cell = cellOf(event.target);
    if (cell) render(cell, unescapeCell(cell.dataset.raw ?? ""));
  });

  box.addEventListener("input", (event) => {
    const cell = cellOf(event.target);
    const at = cell && locate(view, cell);
    if (!at) return;
    // `escapeCell` makes pasted lines one line and writes `|` as `\|`.
    const typed = escapeCell(cell.textContent ?? "");
    write(view, at.found, setCell(at.found.table, at.row, at.column, typed), at.row, at.column, { userEvent: "input.type" });
  });

  box.addEventListener("keydown", (event) => {
    const cell = cellOf(event.target);
    const at = cell && !event.isComposing ? locate(view, cell) : null;
    if (!at) return;
    const { found, row, column } = at;
    const rows = found.table.rows.length;
    const columns = columnCount(found.table);
    /** The cells counted along the rows: Tab and the arrows left and right go through them in this order. */
    const index = row * columns + column;
    const go = (to: number, start = false) => {
      if (to >= 0 && to < rows * columns) focusCell(box, Math.floor(to / columns), to % columns, start);
    };
    const newRow = (inColumn: number) => write(view, found, addRow(found.table, rows), rows, inColumn, { annotations: structure });
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    // Undo and redo are the editor's, not the browser's own for the cell.
    if (mod && key === "z") (event.shiftKey ? redo : undo)(view);
    else if (mod && key === "y") redo(view);
    else if (mod || event.altKey) return;
    else if (key === "Tab") index + 1 === rows * columns && !event.shiftKey ? newRow(0) : go(index + (event.shiftKey ? -1 : 1));
    else if (key === "Enter") row + 1 === rows ? newRow(column) : go(index + columns);
    else if (key === "Escape") leave(view, found, 1);
    else if (event.shiftKey) return;
    // shortcut: up and down always change row, also in a cell whose text wraps onto several lines;
    // move inside the cell first when cells hold long text.
    else if (key === "ArrowUp") row === 0 ? leave(view, found, -1) : go(index - columns);
    else if (key === "ArrowDown") row + 1 === rows ? leave(view, found, 1) : go(index + columns);
    else if (key === "ArrowLeft" && caretAt(cell!, "start")) go(index - 1);
    else if (key === "ArrowRight" && caretAt(cell!, "end")) go(index + 1, true);
    else return;
    event.preventDefault();
  });
}

const focus = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      views.add(view);
    }

    update(update: ViewUpdate) {
      if (!update.state.facet(livePreviewOn)) return;
      const moved = update.transactions.some(
        (tr) =>
          tr.annotation(toCell) ||
          (tr.selection && ((tr.isUserEvent("select") && !tr.isUserEvent("select.pointer")) || tr.isUserEvent("undo") || tr.isUserEvent("redo"))),
      );
      // After this update, when the table's element shows the new text.
      if (moved) queueMicrotask(() => focusSelected(update.view));
    }

    destroy() {
      views.delete(this.view);
    }
  },
);

/**
 * Text typed with the cursor at the end of a table, or on the empty line right under one, would be
 * read as part of the table (a line under a table is a row of it). In Live Preview, where rows are
 * added in the table itself, an empty line goes in first, so the text starts a paragraph.
 */
const typeBelow = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (!state.facet(livePreviewOn) || from !== to) return false;
  const line = state.doc.lineAt(from);
  const lines = tableAt(state, from)?.to === from ? "\n\n" : line.length === 0 && line.from > 0 && tableAt(state, line.from - 1) ? "\n" : "";
  if (!lines) return false;
  view.dispatch({ changes: { from, insert: lines + text }, selection: { anchor: from + lines.length + text.length }, userEvent: "input.type" });
  return true;
});

/** What the tables module adds to the editor. */
export const extension = [tables, focus, typeBelow];
