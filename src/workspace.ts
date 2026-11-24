// What is open where: panes side by side and stacked, each with a strip of tabs. Plain data and pure
// functions (self-check: workspace.test.mjs); App.tsx keeps one Workspace and draws it.
//
// Opening a note always replaces the note in the active tab, also when another tab already shows that
// note: one rule, no searching for "the" tab of a note. A new tab is asked for (Cmd-click, "Open in new tab").
//
// shortcut: the layout is a row of columns, each a stack of panes, not a tree of splits. "Split right" adds
// a column and "split down" adds a pane to the column, so a pane cannot be split to the right inside one
// row of a column; make it a tree when that layout is wanted.

import * as nav from "./history.ts";

/** How a note shows: Live Preview, the Markdown as typed, or rendered and read-only. */
export type EditorMode = "live-preview" | "source" | "reading";

const EDITOR_MODES: readonly string[] = ["live-preview", "source", "reading"] satisfies EditorMode[];

export interface Tab {
  id: number;
  /** The note or drawing the tab shows, or null for an empty tab. */
  path: string | null;
  /** The type of a module view with no file of its own that covers the note, e.g. "graph". */
  page: string | null;
  /** Back and Forward of this tab. */
  history: nav.History;
  /** The editor mode of this tab, or null to follow the vault's default mode. */
  mode: EditorMode | null;
}

export interface Pane {
  id: number;
  tabs: Tab[];
  /** The id of the tab that shows. */
  active: number;
  /** Share of the column's height, relative to the other panes in it. */
  size: number;
}

export interface Column {
  panes: Pane[];
  /** Share of the width, relative to the other columns. */
  size: number;
}

export interface Workspace {
  columns: Column[];
  /** The id of the pane that commands act on. */
  active: number;
  /** Notes of closed tabs, the last closed last, for "reopen closed tab". */
  closed: string[];
  /** The next id to give out. Tabs and panes share the numbers. */
  next: number;
}

// shortcut: only this many closed tabs can be reopened
const MAX_CLOSED = 20;

const emptyTab = (id: number): Tab => ({ id, path: null, page: null, history: nav.NO_HISTORY, mode: null });

/** One pane with one empty tab. */
export const EMPTY: Workspace = {
  columns: [{ size: 1, panes: [{ id: 1, tabs: [emptyTab(2)], active: 2, size: 1 }] }],
  active: 1,
  closed: [],
  next: 3,
};

/** All panes, column by column, top to bottom. */
export const panes = (ws: Workspace): Pane[] => ws.columns.flatMap((c) => c.panes);

/** The active pane. */
export const pane = (ws: Workspace): Pane => panes(ws).find((p) => p.id === ws.active) ?? panes(ws)[0];

/** The tab a pane shows. */
export const shown = (p: Pane): Tab => p.tabs.find((t) => t.id === p.active) ?? p.tabs[0];

/** The active pane's tab: what "the open note" means. */
export const tab = (ws: Workspace): Tab => shown(pane(ws));

const mapPanes = (ws: Workspace, change: (p: Pane) => Pane): Workspace => ({
  ...ws,
  columns: ws.columns.map((c) => ({ ...c, panes: c.panes.map(change) })),
});

const mapTabs = (ws: Workspace, change: (t: Tab) => Tab): Workspace => mapPanes(ws, (p) => ({ ...p, tabs: p.tabs.map(change) }));

/** Changes the active tab. */
const edit = (ws: Workspace, change: (t: Tab) => Tab): Workspace => {
  const id = tab(ws).id;
  return mapTabs(ws, (t) => (t.id === id ? change(t) : t));
};

/** Shows a note in the active tab. `step` is set by Back (-1) and Forward (1): the note is then a place in the tab's history. */
export const open = (ws: Workspace, path: string, step?: number): Workspace =>
  edit(ws, (t) => ({ ...t, path, page: null, history: step ? nav.move(t.history, step) : nav.visit(t.history, path) }));

/** Adds a tab after the active one, in the active pane, and shows it. With no path it is empty. */
export function addTab(ws: Workspace, path: string | null = null): Workspace {
  const id = ws.next;
  const added = mapPanes({ ...ws, next: id + 1 }, (p) => {
    if (p.id !== pane(ws).id) return p;
    const at = p.tabs.findIndex((t) => t.id === p.active) + 1;
    return { ...p, tabs: [...p.tabs.slice(0, at), emptyTab(id), ...p.tabs.slice(at)], active: id };
  });
  return path ? open(added, path) : added;
}

/** Covers the active tab's note with a module view, or uncovers it with null. */
export const showPage = (ws: Workspace, page: string | null): Workspace =>
  tab(ws).page === page ? ws : edit(ws, (t) => ({ ...t, page }));

/**
 * Shows a module view in a pane of its own, right of the active pane, which stays the active one: the view
 * is about what that pane shows (a comparison with its note). Where the view shows already, nothing changes.
 */
export function showBeside(ws: Workspace, page: string): Workspace {
  if (panes(ws).some((p) => shown(p).page === page)) return ws;
  return focus(showPage(split(ws, "right"), page), ws.active);
}

/** Takes a module view off the screen: every tab that shows it closes, or is uncovered when it is in the only pane. */
export function hidePage(ws: Workspace, page: string): Workspace {
  for (const t of panes(ws).flatMap((p) => p.tabs)) {
    if (t.page !== page) continue;
    // Not a tab the user closed: it is not one to reopen.
    ws = panes(ws).length > 1 ? { ...closeTab(ws, t.id), closed: ws.closed } : mapTabs(ws, (x) => (x.id === t.id ? { ...x, page: null } : x));
  }
  return ws;
}

/** The editor mode of the active tab, or null for the vault's default. */
export const setMode = (ws: Workspace, mode: EditorMode | null): Workspace => edit(ws, (t) => ({ ...t, mode }));

/** Every tab follows the vault's default mode again. */
export const resetMode = (ws: Workspace): Workspace => mapTabs(ws, (t) => (t.mode === null ? t : { ...t, mode: null }));

/** Makes a pane the active one. */
export const focus = (ws: Workspace, paneId: number): Workspace =>
  ws.active === paneId || !panes(ws).some((p) => p.id === paneId) ? ws : { ...ws, active: paneId };

/** Makes the pane after the active one active (`step` -1: the one before), going round. */
export function focusNext(ws: Workspace, step = 1): Workspace {
  const all = panes(ws);
  return focus(ws, all[(all.indexOf(pane(ws)) + step + all.length) % all.length].id);
}

/** Shows a tab and makes its pane active. */
export const select = (ws: Workspace, tabId: number): Workspace => {
  const owner = panes(ws).find((p) => p.tabs.some((t) => t.id === tabId));
  if (!owner) return ws;
  return mapPanes({ ...ws, active: owner.id }, (p) => (p === owner ? { ...p, active: tabId } : p));
};

/** Shows the tab `step` places after the active one in its pane, going round. */
export function cycle(ws: Workspace, step: number): Workspace {
  const { tabs, active } = pane(ws);
  return select(ws, tabs[(tabs.findIndex((t) => t.id === active) + step + tabs.length) % tabs.length].id);
}

/** Shows the active pane's tab number `index`, from 1. Past the end it is the last tab. */
export const goto = (ws: Workspace, index: number): Workspace => {
  const { tabs } = pane(ws);
  return select(ws, tabs[Math.max(0, Math.min(index, tabs.length) - 1)].id);
};

const remember = (ws: Workspace, gone: Tab[]): string[] =>
  [...ws.closed, ...gone.flatMap((t) => (t.path ? [t.path] : []))].slice(-MAX_CLOSED);

/** Closes a pane with its tabs. The only pane is left with one empty tab instead. */
export function closePane(ws: Workspace, paneId = ws.active): Workspace {
  const all = panes(ws);
  const gone = all.find((p) => p.id === paneId);
  if (!gone) return ws;
  const closed = remember(ws, gone.tabs);
  if (all.length === 1) {
    return { ...ws, closed, next: ws.next + 1, columns: [{ size: 1, panes: [{ ...gone, tabs: [emptyTab(ws.next)], active: ws.next }] }] };
  }
  const columns = ws.columns.map((c) => ({ ...c, panes: c.panes.filter((p) => p !== gone) })).filter((c) => c.panes.length > 0);
  // The pane before it takes over, or the one after the first.
  const at = all.indexOf(gone);
  const active = ws.active === paneId ? all[at === 0 ? 1 : at - 1].id : ws.active;
  return { ...ws, columns, closed, active };
}

/** Closes a tab. The pane goes with its last tab, except the only pane, which keeps one empty tab. */
export function closeTab(ws: Workspace, tabId = tab(ws).id): Workspace {
  const owner = panes(ws).find((p) => p.tabs.some((t) => t.id === tabId));
  if (!owner) return ws;
  if (owner.tabs.length === 1) return closePane(ws, owner.id);
  const at = owner.tabs.findIndex((t) => t.id === tabId);
  const tabs = owner.tabs.filter((t) => t.id !== tabId);
  // Closing the tab that shows puts its right neighbour in its place, or the left one at the end.
  const active = owner.active === tabId ? tabs[Math.min(at, tabs.length - 1)].id : owner.active;
  return mapPanes({ ...ws, closed: remember(ws, [owner.tabs[at]]) }, (p) => (p === owner ? { ...p, tabs, active } : p));
}

/** Closes every other tab of the pane a tab is in. */
export function closeOthers(ws: Workspace, tabId = tab(ws).id): Workspace {
  const owner = panes(ws).find((p) => p.tabs.some((t) => t.id === tabId));
  if (!owner || owner.tabs.length === 1) return ws;
  const gone = owner.tabs.filter((t) => t.id !== tabId);
  return mapPanes({ ...ws, closed: remember(ws, gone) }, (p) =>
    p === owner ? { ...p, tabs: p.tabs.filter((t) => t.id === tabId), active: tabId } : p,
  );
}

/** The note "reopen closed tab" would open, if any. */
export const lastClosed = (ws: Workspace): string | undefined => ws.closed[ws.closed.length - 1];

/** Opens the note of the tab closed last in a new tab. */
export function reopen(ws: Workspace): Workspace {
  const path = lastClosed(ws);
  return path ? addTab({ ...ws, closed: ws.closed.slice(0, -1) }, path) : ws;
}

/**
 * Opens what the active tab shows in a new pane, right of the active pane's column or under the active
 * pane, and makes it active. The new pane gets half of the room.
 */
export function split(ws: Workspace, direction: "right" | "down"): Workspace {
  const from = pane(ws);
  const copy: Pane = { id: ws.next, tabs: [{ ...tab(ws), id: ws.next + 1 }], active: ws.next + 1, size: 1 };
  const columns = ws.columns.flatMap((c): Column[] => {
    if (!c.panes.includes(from)) return [c];
    if (direction === "right") return [{ ...c, size: c.size / 2 }, { size: c.size / 2, panes: [copy] }];
    return [{ ...c, panes: c.panes.flatMap((p) => (p === from ? [{ ...p, size: p.size / 2 }, { ...copy, size: p.size / 2 }] : [p])) }];
  });
  return { ...ws, columns, active: copy.id, next: ws.next + 2 };
}

/**
 * Moves a tab to place `index` (from 0, counted before it is taken out) of a pane's strip, its own or another,
 * and shows it there. A pane left without tabs closes.
 */
export function moveTab(ws: Workspace, tabId: number, toPane: number, index: number): Workspace {
  const from = panes(ws).find((p) => p.tabs.some((t) => t.id === tabId));
  const to = panes(ws).find((p) => p.id === toPane);
  if (!from || !to) return ws;
  const moved = from.tabs.find((t) => t.id === tabId)!;
  const was = from.tabs.indexOf(moved);
  // In its own strip the places after it shift down by one once it is taken out.
  const at = from === to && index > was ? index - 1 : index;
  const without = (p: Pane): Pane => {
    const tabs = p.tabs.filter((t) => t !== moved);
    return { ...p, tabs, active: p.active === tabId && tabs.length ? tabs[Math.min(was, tabs.length - 1)].id : p.active };
  };
  const placed = mapPanes({ ...ws, active: to.id }, (p) => {
    const next = p === from ? without(p) : p;
    if (p !== to) return next;
    return { ...next, tabs: [...next.tabs.slice(0, at), moved, ...next.tabs.slice(at)], active: tabId };
  });
  const columns = placed.columns.map((c) => ({ ...c, panes: c.panes.filter((p) => p.tabs.length > 0) })).filter((c) => c.panes.length > 0);
  return { ...placed, columns };
}

/** Sets the sizes of the columns, or of the panes of column `column`, in order. */
export function resize(ws: Workspace, column: number | null, sizes: number[]): Workspace {
  if (column === null) return { ...ws, columns: ws.columns.map((c, i) => ({ ...c, size: sizes[i] ?? c.size })) };
  return {
    ...ws,
    columns: ws.columns.map((c, i) => (i === column ? { ...c, panes: c.panes.map((p, n) => ({ ...p, size: sizes[n] ?? p.size })) } : c)),
  };
}

/** After a rename: every tab that shows the note, or has it in its history, follows it. */
export const renamed = (ws: Workspace, from: string, to: string): Workspace => ({
  ...mapTabs(ws, (t) => ({ ...t, path: t.path === from ? to : t.path, history: nav.renamed(t.history, from, to) })),
  closed: ws.closed.map((p) => (p === from ? to : p)),
});

/**
 * After a delete: the note leaves every history, and a tab that shows it steps back to the note it showed
 * before, or is left empty when there was none.
 */
export const removed = (ws: Workspace, path: string): Workspace => ({
  ...mapTabs(ws, (t) => {
    if (t.path !== path && !t.history.stack.includes(path)) return t;
    const history = nav.removed(t.history, path);
    return { ...t, path: t.path === path ? (history.stack[history.index] ?? null) : t.path, history };
  }),
  closed: ws.closed.filter((p) => p !== path),
});

/**
 * The workspace saved earlier (any JSON, as `JSON.parse` gave it), made valid for a vault: `exists` says
 * which notes are still there, and a tab on a note that is gone is dropped. Anything unusable gives EMPTY.
 */
export function restore(saved: unknown, exists: (path: string) => boolean): Workspace {
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((v) => typeof v === "object" && v !== null) : [];
  const size = (value: unknown) => (typeof value === "number" && value > 0 && Number.isFinite(value) ? value : 1);
  const from = (saved ?? {}) as Record<string, unknown>;
  let next = 1;
  let active = 0;
  const columns = list(from.columns)
    .map((c): Column => ({
      size: size(c.size),
      panes: list(c.panes)
        .map((p): Pane => {
          const id = next++;
          let showing = 0;
          const tabs = list(p.tabs)
            .filter((t) => t.path == null || (typeof t.path === "string" && exists(t.path)))
            .map((t): Tab => {
              const old = (t.history ?? {}) as Partial<nav.History>;
              const stack = Array.isArray(old.stack) ? old.stack.filter((s): s is string => typeof s === "string") : [];
              let history: nav.History = { stack, index: Math.max(-1, Math.min(Number(old.index) || 0, stack.length - 1)) };
              for (const gone of new Set(stack.filter((s) => !exists(s)))) history = nav.removed(history, gone);
              if (t.id === p.active) showing = next;
              return {
                id: next++,
                path: (t.path as string | null) ?? null,
                page: typeof t.page === "string" ? t.page : null,
                history,
                mode: EDITOR_MODES.includes(t.mode as string) ? (t.mode as EditorMode) : null,
              };
            });
          if (p.id === from.active) active = id;
          return { id, tabs, active: showing || (tabs[0]?.id ?? 0), size: size(p.size) };
        })
        .filter((p) => p.tabs.length > 0),
    }))
    .filter((c) => c.panes.length > 0);
  if (columns.length === 0) return EMPTY;
  return { columns, active: active && columns.some((c) => c.panes.some((p) => p.id === active)) ? active : columns[0].panes[0].id, closed: [], next };
}
