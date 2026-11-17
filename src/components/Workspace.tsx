// The panes and their tabs, drawn from the Workspace in src/workspace.ts, and the outline in the right
// sidebar. Like the shell, nothing here keeps app state: tabs and buttons run commands, and App.tsx
// holds the workspace, the notes' text and the editors.

import { CopyX, Plus, X } from "lucide-react";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../commands";
import { assetUrl } from "../core/client";
import { isImage } from "../fileNames";
import * as nav from "../history";
import { modules, type ViewFactory, type ViewHandle } from "../modules";
import type { Issue } from "../saves";
import * as W from "../workspace";
import { Editor, type EditorHandle, type EditorPosition, type Heading } from "./Editor";
import { Backlinks } from "./Hits";
import { Menu, type MenuAt } from "./Menu";
import { CommandButton, EmptyPane, PaneHeader, paneActions, StatusBar } from "./Shell";

/** A pane is never dragged narrower or lower than this, in px. */
const MIN_PANE = { width: 200, height: 120 };

/**
 * Follows the pointer from a button press until the button is let go: `onMove` gets how far it is
 * from where it went down. For the edges and dividers that resize things.
 */
export function drag(down: React.PointerEvent, onMove: (dx: number, dy: number) => void, onDone?: () => void) {
  down.preventDefault();
  const move = (e: PointerEvent) => onMove(e.clientX - down.clientX, e.clientY - down.clientY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onDone?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** The module view that shows the file at `path` in place of the editor, or why it cannot show this text (then the editor does). */
export function viewOf(path: string, text: string): { view?: { type: string; view: ViewFactory }; problem?: string } {
  const found = modules.viewFor(path);
  if (!found) return {};
  try {
    found.view.check?.(text);
    return { view: found };
  } catch (e) {
    return { problem: `${path} is shown as text: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The name of a module view with no file: the one it gives itself, or "Open graph view", the command that shows it, gives "Graph view". */
export const pageTitle = (page: string) =>
  modules.view(page)?.title ?? (commands.list().find((c) => c.id === `${page}.open`)?.title ?? page).replace(/^Open (.)/, (_, c: string) => c.toUpperCase());

/** What a tab is called in its strip. A drawing is named as in the file tree, without `.excalidraw`. */
export const tabTitle = (t: W.Tab) =>
  t.page && modules.view(t.page)
    ? pageTitle(t.page)
    : t.path
      ? t.path.slice(t.path.lastIndexOf("/") + 1).replace(/(\.excalidraw)?\.md$/i, "")
      : "New tab";

/** A tab is held and moved: it is dropped where the mark shows, in its own strip or another pane's. */
function dragTab(down: React.PointerEvent, tabId: number) {
  if (down.button !== 0 || (down.target as Element).closest(".tab-close")) return;
  let drop: { pane: number; index: number; mark: Element } | null = null;
  let dragging = false;
  const clear = () => {
    drop?.mark.classList.remove("is-drop-before", "is-drop-after");
    drop = null;
  };
  const move = (e: PointerEvent) => {
    // A press that barely moves is a click.
    if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 6) return;
    dragging = true;
    document.documentElement.classList.add("is-dragging-tab");
    clear();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const strip = under?.closest(".tab-strip");
    const tabs = [...(strip?.querySelectorAll(".tab") ?? [])];
    if (!strip || tabs.length === 0) return;
    // Over a tab: before or after it, by the half the pointer is in. Over the rest of the strip: at the end.
    const over = under?.closest(".tab");
    const box = over?.getBoundingClientRect();
    const after = !box || e.clientX > box.left + box.width / 2;
    const mark = over ?? tabs[tabs.length - 1];
    mark.classList.add(after ? "is-drop-after" : "is-drop-before");
    drop = { pane: Number(strip.closest<HTMLElement>(".pane")?.dataset.pane), index: over ? tabs.indexOf(over) + (after ? 1 : 0) : tabs.length, mark };
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.documentElement.classList.remove("is-dragging-tab");
    const to = drop;
    clear();
    if (to) void commands.run("tab.move", { tab: tabId, pane: to.pane, index: to.index });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** A pane's tabs. A click shows a tab, a middle click or its cross closes it, a right click opens its menu, and it can be dragged. */
function TabStrip({ pane, canClose }: { pane: W.Pane; canClose: boolean }) {
  const [menu, setMenu] = useState<{ tab: number; at: MenuAt } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // The tab that shows is scrolled into the strip when there are more tabs than fit.
  useEffect(() => {
    strip.current?.querySelector(".tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pane.active, pane.tabs.length]);
  const run = (id: string, tab: number) => void commands.run(id, { tab });
  return (
    <div className="tab-strip">
      <div className="tabs" role="tablist" aria-label="Tabs" ref={strip}>
        {pane.tabs.map((t) => {
          const title = tabTitle(t);
          return (
            <div
              key={t.id}
              className={"tab" + (t.id === pane.active ? " is-active" : "") + (menu?.tab === t.id ? " has-menu" : "")}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === pane.active}
              data-tab={t.id}
              title={t.page ? undefined : (t.path ?? undefined)}
              onClick={() => run("tab.goto", t.id)}
              onAuxClick={(e) => e.button === 1 && run("tab.close", t.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && run("tab.goto", t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tab: t.id, at: { x: e.clientX, y: e.clientY } });
              }}
              onPointerDown={(e) => dragTab(e, t.id)}
            >
              <span className="tab-title">{title}</span>
              <button
                className="tab-close"
                aria-label={`Close ${title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  run("tab.close", t.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <CommandButton tip="end" command="tab.new" title="New tab" icon={Plus} />
      {menu && (
        <Menu
          label="Tab"
          at={menu.at}
          onClose={() => setMenu(null)}
          items={[
            { label: "Close", icon: X, onPick: () => run("tab.close", menu.tab) },
            { label: "Close others", icon: CopyX, onPick: () => run("tab.closeOthers", menu.tab) },
            "separator",
            ...paneActions(canClose, { tab: menu.tab }),
          ]}
        />
      )}
    </div>
  );
}

/** What a pane needs from the app. The functions keep their identity, so panes do not draw again for them. */
export interface PaneHost {
  /** An edit, as the file's new text. */
  onEdit(path: string, content: string): void;
  /** A button of the banner about a note that could not be saved: see `resolveRef` in App.tsx. */
  resolve(path: string, how: "mine" | "theirs" | "retry" | "close"): void;
  /** Opens a note in the active tab. A pane is active by the time something in it is clicked. */
  open(path: string, line?: number): void;
  /** Makes a pane the active one. */
  focus(pane: number): void;
  /** The editor of a tab came or went (null). */
  editor(tab: number, path: string, handle: EditorHandle | null): void;
  /** The module view of a tab came or went (null). */
  view(tab: number, handle: ViewHandle | null): void;
  /** The text of a note as another pane's editor has it now, which can be newer than the file. */
  peer(tab: number, path: string): string | undefined;
  /** Where the cursor and scroll were when this tab last showed this note. */
  position(tab: number, path: string): EditorPosition | undefined;
  /** The text, cursor or scroll of a tab's editor changed. */
  onMove(tab: number): void;
  onProblem(message: string): void;
  dismissError(): void;
}

interface PaneProps {
  pane: W.Pane;
  /** Whether commands act on this pane. */
  active: boolean;
  /** Whether there are other panes. */
  canClose: boolean;
  /** Share of the column's height, as a `flex-grow`. */
  size: number;
  /** The text of the notes on screen to start an editor or a view from, by path. A note still being read is missing. */
  disk: Record<string, string>;
  /** The files on screen that could not be read as text. */
  noText: ReadonlySet<string>;
  /** What keeps a note from being saved, by path (src/saves.ts). */
  issues: Record<string, Issue>;
  counts: Record<string, { words: number; characters: number }>;
  vaultRoot: string;
  /** Whether the vault's default mode is source mode. */
  sourceDefault: boolean;
  /** The line to put the cursor on, when the note was opened at one. */
  jump?: { line: number };
  /** Counts changes to files in the vault. */
  changes: number;
  /** Changes when a module is switched on or off. */
  moduleVersion: number;
  /** The error banner's text, in the pane that shows it. */
  error: string | null;
  /** Whether the right sidebar is open, in the pane whose header has its button. */
  outline?: boolean;
  host: PaneHost;
}

/**
 * The banner over a note that could not be saved, with what the user can do about it. Nothing is written to
 * the note's file while it shows a choice; the text in the editor stays as typed.
 */
// shortcut: "Show both" lists the file's text under the banner, whole and read-only; show the differences
// (DiffView) when conflicts that the merge module cannot merge turn out to be common
function SaveIssue({ path, issue, host }: { path: string; issue: Issue; host: PaneHost }) {
  const [both, setBoth] = useState(false);
  const theirs = issue.kind === "conflict" ? issue.theirs : undefined;
  const button = (how: Parameters<PaneHost["resolve"]>[1], label: string, disabled = false) => (
    <button className="button is-quiet" disabled={disabled} onClick={() => host.resolve(path, how)}>
      {label}
    </button>
  );
  return (
    <div className="save-issue" role="alert" data-kind={issue.kind}>
      <div className="save-issue-row">
        <p className="save-issue-text">
          {issue.kind === "conflict"
            ? "This note was changed outside Inklode while you were editing it. Nothing is saved until you choose which text to keep."
            : issue.kind === "gone"
              ? "This note was moved or deleted outside Inklode. What you see here is not saved anywhere."
              : `Could not save this note: ${issue.message}. Your changes are kept here and saving is tried again.`}
        </p>
        {issue.kind === "conflict" && (
          <>
            {button("mine", "Keep mine", theirs === undefined)}
            {button("theirs", "Take theirs", theirs === undefined)}
            <button className="button is-quiet" disabled={theirs === undefined} aria-expanded={both} onClick={() => setBoth(!both)}>
              {both ? "Hide theirs" : "Show both"}
            </button>
          </>
        )}
        {issue.kind === "gone" && (
          <>
            {button("mine", "Save here again")}
            {button("close", "Close")}
          </>
        )}
        {issue.kind === "failed" && button("retry", "Try again")}
      </div>
      {both && theirs !== undefined && (
        <pre className="save-issue-theirs" tabIndex={0} aria-label="The text on disk">
          {theirs}
        </pre>
      )}
    </div>
  );
}

/**
 * What a pane shows for a file that is not text. A picture (`isImage`) is drawn, as large as fits. Any other
 * file, and a picture the window cannot draw, gets a line that says so and a button that shows it in Finder.
 */
function Attachment({ path, vaultRoot }: { path: string; vaultRoot: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(!isImage(path));
  useEffect(() => {
    if (failed) return;
    let stale = false;
    assetUrl(vaultRoot, path).then(
      (found) => stale || (found ? setUrl(found) : setFailed(true)),
      () => stale || setFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [path, vaultRoot, failed]);
  if (!failed) {
    return <div className="attachment is-image">{url && <img src={url} alt={path.slice(path.lastIndexOf("/") + 1)} onError={() => setFailed(true)} />}</div>;
  }
  return (
    <div className="attachment">
      <p className="attachment-text">Inklode cannot show this file.</p>
      <button className="button is-quiet" onClick={() => void commands.run("note.reveal", { path })}>
        Reveal in Finder
      </button>
    </div>
  );
}

/** One pane: its tabs, its header, and what its tab shows, which is a module's view, a note with its footer, a file that is not text, or the empty state. */
export function Pane({ pane, active, canClose, size, disk, noText, issues, counts, vaultRoot, sourceDefault, jump, changes, moduleVersion, error, outline, host }: PaneProps) {
  const tab = W.shown(pane);
  const { id, path } = tab;
  const paged = tab.page ? modules.view(tab.page) : undefined;
  const text = path === null ? undefined : disk[path];
  // A file the editor cannot show: a picture, or one that could not be read as text.
  const attachment = path !== null && !paged && (isImage(path) || noText.has(path));
  const { view: custom, problem } = useMemo(
    () => (path !== null && text !== undefined ? viewOf(path, text) : {}),
    // `moduleVersion`: what `viewOf` answers changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, text, moduleVersion],
  );
  useEffect(() => {
    if (problem) host.onProblem(problem);
  }, [problem, host]);

  const editorRef = useCallback((handle: EditorHandle | null) => host.editor(id, path ?? "", handle), [host, id, path]);
  const viewRef = useCallback((handle: ViewHandle | null) => host.view(id, handle), [host, id]);
  const onMove = useCallback(() => host.onMove(id), [host, id]);
  const source = tab.source ?? sourceDefault;
  const mode = source ? "source" : "live-preview";

  return (
    <section
      className={"pane" + (active ? " is-active" : "")}
      aria-label={tabTitle(tab)}
      data-pane={pane.id}
      style={{ flexGrow: size }}
      // Before the click or the focus does anything else, so a command it runs acts on this pane.
      onPointerDownCapture={() => host.focus(pane.id)}
      onFocusCapture={() => host.focus(pane.id)}
    >
      <TabStrip pane={pane} canClose={canClose} />
      <PaneHeader
        path={paged ? null : path}
        title={paged && tab.page ? pageTitle(tab.page) : ""}
        canBack={nav.peek(tab.history, -1) !== undefined}
        canForward={nav.peek(tab.history, 1) !== undefined}
        mode={path !== null && !paged && !custom && !attachment ? mode : null}
        canClose={canClose}
        outline={outline}
      />
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={host.dismissError}>Dismiss</button>
        </p>
      )}
      {path !== null && !paged && issues[path] && <SaveIssue key={path} path={path} issue={issues[path]} host={host} />}
      {paged ? (
        <Suspense>
          <paged.component key={id}ref={viewRef} path={path ?? ""} content="" onChange={host.onEdit} onOpen={host.open} refresh={changes} />
        </Suspense>
      ) : path === null ? (
        <EmptyPane />
      ) : attachment ? (
        <Attachment key={path} path={path} vaultRoot={vaultRoot} />
      ) : (
        // Nothing for the moment a note is being read.
        text !== undefined && (
          <>
            {custom ? (
              // The view's code loads on first use.
              <Suspense>
                <custom.view.component
                  key={`${id}:${path}`}
                  ref={viewRef}
                  path={path}
                  content={text}
                  onChange={host.onEdit}
                  onOpen={host.open}
                  refresh={changes}
                />
              </Suspense>
            ) : (
              <Editor
                key={`${id}:${path}`}
                ref={editorRef}
                path={path}
                // What was typed in this note and is not in the file yet, in another pane's editor or waiting to be saved.
                content={host.peer(id, path) ?? text}
                vaultRoot={vaultRoot}
                sourceMode={source}
                jump={jump}
                restore={host.position(id, path)}
                autoFocus={active}
                refresh={changes + moduleVersion}
                onChange={host.onEdit}
                onMove={onMove}
              />
            )}
            <Backlinks path={path} refresh={changes} onOpen={host.open} />
            <StatusBar path={path} refresh={changes} counts={custom ? null : (counts[path] ?? null)} mode={custom ? null : mode} />
          </>
        )
      )}
    </section>
  );
}

/** The line between two panes or two columns, to drag. `sizes` are the shares of all of them and `index` the one before the line. */
function Divider({ across, sizes, index, onResize }: { across: boolean; sizes: number[]; index: number; onResize(sizes: number[]): void }) {
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation={across ? "horizontal" : "vertical"}
      aria-label="Resize panes"
      onPointerDown={(down) => {
        const before = down.currentTarget.previousElementSibling!.getBoundingClientRect();
        const after = down.currentTarget.nextElementSibling!.getBoundingClientRect();
        const [first, both, min] = across
          ? [before.height, before.height + after.height, MIN_PANE.height]
          : [before.width, before.width + after.width, MIN_PANE.width];
        const share = sizes[index] + sizes[index + 1];
        drag(down, (dx, dy) => {
          const px = Math.max(min, Math.min(first + (across ? dy : dx), both - min));
          const next = [...sizes];
          next[index] = (share * px) / both;
          next[index + 1] = share - next[index];
          onResize(next);
        });
      }}
    />
  );
}

interface PanesProps extends Omit<PaneProps, "pane" | "active" | "canClose" | "size" | "jump" | "error" | "outline"> {
  workspace: W.Workspace;
  /** The line to go to, in the tab that was opened at one. */
  jump: { tab: number; line: number } | null;
  error: string | null;
  outlineOpen: boolean;
  /** New sizes for the columns, or for the panes of column `column`. */
  onResize(column: number | null, sizes: number[]): void;
}

/** All panes: columns side by side, each a stack of panes, with a line to drag between neighbours. */
export function Panes({ workspace, jump, error, outlineOpen, onResize, ...shared }: PanesProps) {
  const count = W.panes(workspace).length;
  // A size as `flex-grow`: its part of 100, because grows that add up to less than 1 would leave room unused.
  const grow = (size: number, all: { size: number }[]) => (100 * size) / all.reduce((sum, x) => sum + x.size, 0);
  // A column has no id of its own. Its key is the one its panes had in the last render, whichever of them
  // is left, so closing the top pane of a column does not make the editors of the panes under it anew.
  const keys = useRef(new Map<number, number>());
  const used = new Set<number>();
  const columnKeys = workspace.columns.map((column) => {
    const old = column.panes.map((p) => keys.current.get(p.id)).find((key) => key !== undefined && !used.has(key));
    const key = old ?? column.panes[0].id;
    used.add(key);
    return key;
  });
  keys.current = new Map(workspace.columns.flatMap((column, c) => column.panes.map((p) => [p.id, columnKeys[c]] as const)));
  return (
    <main className={"workspace" + (count > 1 ? " is-split" : "")}>
      {workspace.columns.map((column, c) => (
        <Fragment key={columnKeys[c]}>
          {c > 0 && <Divider across={false} sizes={workspace.columns.map((x) => x.size)} index={c - 1} onResize={(sizes) => onResize(null, sizes)} />}
          <div className="pane-column" style={{ flexGrow: grow(column.size, workspace.columns) }}>
            {column.panes.map((pane, p) => (
              <Fragment key={pane.id}>
                {p > 0 && <Divider across sizes={column.panes.map((x) => x.size)} index={p - 1} onResize={(sizes) => onResize(c, sizes)} />}
                <Pane
                  {...shared}
                  pane={pane}
                  active={pane.id === workspace.active}
                  canClose={count > 1}
                  size={grow(pane.size, column.panes)}
                  jump={jump?.tab === W.shown(pane).id ? jump : undefined}
                  error={pane.id === workspace.active ? error : null}
                  // The button for the right sidebar is in the header that touches it: the top pane of the last column.
                  outline={c === workspace.columns.length - 1 && p === 0 ? outlineOpen : undefined}
                />
              </Fragment>
            ))}
          </div>
        </Fragment>
      ))}
    </main>
  );
}

interface SidePanelProps {
  title: string;
  onClose(): void;
  /** The left edge was grabbed, to resize. */
  onResize(down: React.PointerEvent): void;
  children: React.ReactNode;
}

/** The right sidebar with a module's panel in it (`AppApi.ui.registerPanel`), which shows in place of the outline. */
export function SidePanel({ title, onClose, onResize, children }: SidePanelProps) {
  return (
    <aside className="sidebar is-right side-panel" aria-label={title}>
      <header className="sidebar-header">
        <span className="sidebar-title">{title}</span>
        <button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="sidebar-body">
        {/* The panel's code loads on first use. */}
        <Suspense>{children}</Suspense>
      </div>
      <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${title}`} onPointerDown={onResize} />
    </aside>
  );
}

interface OutlineProps {
  /** The headings of the active pane's note, or null when it does not show a note as text. */
  headings: Heading[] | null;
  /** The index of the heading the reader is in, or -1. */
  current: number;
  onPick(line: number): void;
  onClose(): void;
  /** The left edge was grabbed, to resize. */
  onResize(down: React.PointerEvent): void;
}

/** The right sidebar: the headings of the active pane's note. A click goes to the heading. */
export function Outline({ headings, current, onPick, onClose, onResize }: OutlineProps) {
  // Indented from the highest level the note uses, so a note that starts at `##` is not pushed in.
  const top = Math.min(...(headings ?? []).map((h) => h.level));
  return (
    <aside className="sidebar is-right outline" aria-label="Outline">
      <header className="sidebar-header">
        <span className="sidebar-title">Outline</span>
        <button className="icon-button" aria-label="Close Outline" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="sidebar-body">
        {headings?.length ? (
          <ul className="outline-list">
            {headings.map((h, i) => (
              <li key={i}>
                <button
                  className={"outline-item" + (i === current ? " is-current" : "")}
                  aria-current={i === current ? "location" : undefined}
                  data-line={h.line}
                  style={{ "--outline-level": h.level - top } as React.CSSProperties}
                  onClick={() => onPick(h.line)}
                >
                  {h.text || "Untitled"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="outline-empty">{headings ? "This note has no headings." : "The outline shows the headings of a note."}</p>
        )}
      </div>
      <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize outline" onPointerDown={onResize} />
    </aside>
  );
}
