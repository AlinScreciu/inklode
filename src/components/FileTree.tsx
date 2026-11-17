import { ChevronRight, Shapes } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** One file or folder, as returned by the `vault.tree` call. Folders have `children`. */
export interface Entry {
  name: string;
  path: string;
  children?: Entry[];
}

/** The paths of all notes in the tree, folders left out. */
export function notePaths(entries: Entry[]): string[] {
  return entries.flatMap((e) => (e.children ? notePaths(e.children) : [e.path]));
}

/** The paths of all folders in the tree, each before the folders inside it. */
export function folderPaths(entries: Entry[]): string[] {
  return entries.flatMap((e) => (e.children ? [e.path, ...folderPaths(e.children)] : []));
}

/** The folders a path is in, outermost first: `a/b/c.md` gives `a` and `a/b`. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The folder a file or folder is in, "" for the vault root. */
export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

/** Whether `from` (a file or folder) can move into the folder `to`: not into itself, a folder inside it, or where it already is. */
export const canMove = (from: string, to: string) => to !== from && !to.startsWith(from + "/") && to !== parentOf(from);

export const DRAWING = /\.excalidraw\.md$/i;
/** How far the pointer moves with the button down before a press is a drag and not a click, in pixels. */
const DRAG_THRESHOLD = 5;
/** How long a dragged row stays over a closed folder before the folder opens. */
const EXPAND_MS = 600;
/** Dragging this close to the top or bottom edge of the list scrolls it, in pixels. */
const SCROLL_EDGE = 24;

interface Props {
  entries: Entry[];
  activePath: string | null;
  /** The paths of the folders that are open. */
  expanded: ReadonlySet<string>;
  /** The entry whose context menu is showing, if any. */
  menuPath: string | null;
  onToggle(path: string): void;
  /** A click on a file. `newTab`: with Cmd or Ctrl held, or the middle button. */
  onOpen(path: string, newTab: boolean): void;
  /** A right click on an entry, at this point of the window. */
  onMenu(entry: Entry, x: number, y: number): void;
  /** A row was dropped on a folder: move the file or folder `from` into the folder `to`, "" for the vault root. */
  onMove(from: string, to: string): void;
  /** F2 on a row. */
  onRename(path: string, folder: boolean): void;
}

/** The row being dragged, where the pointer is, and the folder it would land in: "" is the vault root, null nowhere. */
interface Drag {
  path: string;
  name: string;
  x: number;
  y: number;
  over: string | null;
}

/**
 * The vault's files and folders. A row is dragged onto a folder, or onto the empty space under the list for the
 * vault root, to move it. Arrow keys move between rows and open and close folders, Enter opens, F2 renames.
 */
// Dragging is done with pointer events, not HTML drag and drop: Tauri's own file-drop handler (`dragDropEnabled`,
// on by default) takes the `drop` events of the webview, and pointer events are what the MCP tool `ui_drag` sends.
export function FileTree(props: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const root = useRef<HTMLUListElement>(null);
  // The newest props, for the listeners of a drag, which outlive renders.
  const latest = useRef(props);
  latest.current = props;
  // True for a moment after a drag ends, so the click that follows a release on the row it started on does nothing.
  const dragged = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (down: React.PointerEvent) => {
    const row = (down.target as Element).closest<HTMLElement>(".tree-item");
    if (!row || down.button !== 0) return;
    const path = row.dataset.path ?? "";
    const start = { x: down.clientX, y: down.clientY };
    let dragging = false;
    let over: string | null = null;
    // The closed folder under the pointer, which opens if the pointer stays.
    let hover: { path: string; timer: number } | null = null;
    const hoverOn = (folder: string | null) => {
      if ((hover?.path ?? null) === folder) return;
      if (hover) window.clearTimeout(hover.timer);
      hover = folder === null ? null : { path: folder, timer: window.setTimeout(() => latest.current.onToggle(folder), EXPAND_MS) };
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const at = under?.closest<HTMLElement>(".tree-item");
      const atPath = at?.dataset.path ?? "";
      const atFolder = at?.classList.contains("tree-folder") ?? false;
      const list = root.current?.closest(".sidebar-body");
      // A file's row stands for the folder the file is in. Empty space is the vault root: under the rows, and
      // the padding around the list, which is there even when the rows fill the sidebar.
      const empty = root.current?.contains(under) || (under !== null && under === list);
      const folder = at ? (atFolder ? atPath : parentOf(atPath)) : empty ? "" : null;
      over = folder !== null && canMove(path, folder) ? folder : null;
      hoverOn(atFolder && atPath !== path && !latest.current.expanded.has(atPath) ? atPath : null);
      // shortcut: scrolls only while the pointer moves; scroll on a timer if long trees make holding still at the edge common
      if (list) {
        const box = list.getBoundingClientRect();
        if (e.clientY < box.top + SCROLL_EDGE) list.scrollTop -= SCROLL_EDGE / 2;
        else if (e.clientY > box.bottom - SCROLL_EDGE) list.scrollTop += SCROLL_EDGE / 2;
      }
      setDrag({ path, name: row.textContent ?? "", x: e.clientX, y: e.clientY, over });
    };
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      stop.current = null;
      hoverOn(null);
      if (!dragging) return;
      dragged.current = true;
      window.setTimeout(() => (dragged.current = false));
      setDrag(null);
      if (drop && over !== null) latest.current.onMove(path, over);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragging) return;
      // So Escape does not also close what is behind the drag.
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    stop.current = onCancel;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>(".tree-item") ?? [])];
    const index = rows.indexOf(e.target as HTMLElement);
    if (index < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const path = rows[index].dataset.path ?? "";
    const folder = rows[index].classList.contains("tree-folder");
    const open = folder && props.expanded.has(path);
    if (e.key === "ArrowDown") rows[index + 1]?.focus();
    else if (e.key === "ArrowUp") rows[index - 1]?.focus();
    // Right opens a folder, then goes into it. Left closes it, then goes to the folder it is in.
    else if (e.key === "ArrowRight" && folder) open ? rows[index + 1]?.focus() : props.onToggle(path);
    else if (e.key === "ArrowLeft") open ? props.onToggle(path) : rows.find((r) => r.dataset.path === parentOf(path))?.focus();
    else if (e.key === "F2") props.onRename(path, folder);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <ul
        ref={root}
        className={"tree tree-root" + (drag ? " is-dragging" : "") + (drag?.over === "" ? " is-drop-target" : "")}
        onPointerDown={onPointerDown}
        onClickCapture={(e) => dragged.current && e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <Rows {...props} drag={drag} />
      </ul>
      {drag && (
        <div className="tree-ghost" style={{ left: drag.x, top: drag.y }}>
          {drag.name}
        </div>
      )}
    </>
  );
}

/** The rows of one folder, each folder followed by its own rows when it is open. */
function Rows(props: Props & { drag: Drag | null }) {
  const { entries, activePath, expanded, menuPath, drag, onToggle, onOpen, onMenu } = props;
  return entries.map((entry) => {
    const open = expanded.has(entry.path);
    const drawing = DRAWING.test(entry.name);
    const menu = {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        onMenu(entry, e.clientX, e.clientY);
      },
    };
    const state =
      (entry.path === activePath ? " is-active" : "") +
      (entry.path === menuPath ? " has-menu" : "") +
      (entry.path === drag?.path ? " is-dragged" : "") +
      (entry.children && entry.path === drag?.over ? " is-drop-target" : "");
    return entry.children ? (
      <li key={entry.path}>
        <button
          className={"tree-item tree-folder" + state}
          data-path={entry.path}
          aria-expanded={open}
          onClick={() => onToggle(entry.path)}
          {...menu}
        >
          <span className="tree-arrow">
            <ChevronRight size={14} />
          </span>
          <span className="tree-name">{entry.name}</span>
        </button>
        {open && (
          <ul className="tree">
            <Rows {...props} entries={entry.children} />
          </ul>
        )}
      </li>
    ) : (
      <li key={entry.path}>
        <button
          className={"tree-item tree-file" + (drawing ? " tree-drawing" : "") + state}
          data-path={entry.path}
          aria-current={entry.path === activePath ? "page" : undefined}
          onClick={(e) => onOpen(entry.path, e.metaKey || e.ctrlKey)}
          onAuxClick={(e) => e.button === 1 && onOpen(entry.path, true)}
          {...menu}
        >
          {/* The same slot a folder's arrow is in, so names line up. Only a drawing has something in it. */}
          <span className="tree-arrow tree-kind">{drawing && <Shapes size={13} aria-label="Drawing" />}</span>
          <span className="tree-name">{entry.name.replace(drawing ? DRAWING : /\.md$/, "")}</span>
        </button>
      </li>
    );
  });
}
