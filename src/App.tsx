import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FilePlus, FolderPlus, Shapes } from "lucide-react";
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { appearanceNow, applyOptions } from "./appearance";
import { commands, keyOf } from "./commands";
import type { EditorHandle, EditorPosition, Heading } from "./components/Editor";
import { canMove, DRAWING, FileTree, folderPaths, foldersOf, notePaths, parentOf, type Entry } from "./components/FileTree";
import { backlinksOf, Search } from "./components/Hits";
import { Confirm, Menu, type MenuAt } from "./components/Menu";
import { Palette } from "./components/Palette";
import { Settings, SETTINGS_SECTIONS, type SettingsSection } from "./components/Settings";
import { countText, fileActions, folderActions, Ribbon, SidebarActions, Welcome } from "./components/Shell";
import { UpdateNotice, useUpdates } from "./components/Updates";
import { drag, Outline, Panes, SidePanel, tabTitle, viewOf, type PaneHost } from "./components/Workspace";
import { isImage, renameInitial, renameTarget } from "./fileNames";
import { loadConfig, NO_CONFIG, setKey, setOption, setTheme, toggleModule, toggleSnippet } from "./config";
import * as nav from "./history";
import { modules, type ViewHandle } from "./modules";
import { Saves, type Issue } from "./saves";
import * as W from "./workspace";
import {
  appSettingsGet,
  appSettingsSet,
  mcpCopy,
  mcpTokenNew,
  call,
  onAppSettingsChanged,
  onCloseRequested,
  onEvent,
  onMenuCommand,
  onUiRequest,
  openExternal,
  pickFolder,
  quitApp,
  revealInFileManager,
  setZoom,
  updatesSet,
  type AppSettings,
} from "./core/client";
import * as uiDrive from "./uiDrive";

interface VaultInfo {
  root: string;
  name: string;
}

/**
 * Which centred box is showing: the command palette, the note switcher, a text prompt, the question before a
 * delete, or the settings screen. `arg` is what a prompt is about: the folder a new note goes in, or the path
 * of the note to rename or delete.
 */
type Dialog =
  | { kind: "commands" | "switcher" | "settings" }
  | { kind: "new" | "rename" | "delete"; arg: string }
  // The same three for a folder, and the list of folders to move a file or folder (`arg`) into.
  | { kind: "newFolder" | "renameFolder" | "deleteFolder" | "move"; arg: string }
  | null;

/** How long after the last keystroke an edited note is written to disk. */
const AUTOSAVE_MS = 800;
const LAST_VAULT_KEY = "inklode.lastVault";
const SIDEBAR_WIDTH_KEY = "inklode.sidebarWidth";
const SIDEBAR_WIDTH = { default: 260, min: 180, max: 520 };
// The right sidebar, which shows the outline: its width, and "1" while it is open.
const OUTLINE_WIDTH_KEY = "inklode.outlineWidth";
const OUTLINE_OPEN_KEY = "inklode.outlineOpen";
// Followed by the vault's folder: the id of the module panel that was open in the right sidebar of that vault, "" for none.
const RIGHT_PANEL_KEY = "inklode.rightPanel:";
// Followed by the vault's folder: the panes and tabs that were open in that vault (src/workspace.ts).
// shortcut: kept in this webview's localStorage, so the layout does not travel with the vault to another
// machine; keep it in the vault's `.inklode` folder if it should.
const WORKSPACE_KEY = "inklode.workspace:";
/** How long at least between two readings of the outline while typing or scrolling. */
const OUTLINE_MS = 40;
const NO_OUTLINE: { headings: Heading[] | null; current: number } = { headings: null, current: -1 };
/** How long after the last keystroke the status bar counts the words again. */
const COUNT_MS = 300;
/** `ui_state` reports at most this many characters of the editor's text. */
const UI_STATE_TEXT_MAX = 20_000;

/** The size the window is drawn at, 1 being normal. */
let zoom = 1;

/** Zooms the window in or out by `step`, within 50% to 300%; a step of 0 goes back to normal. */
function zoomBy(step: number) {
  zoom = step === 0 ? 1 : Math.min(3, Math.max(0.5, Math.round((zoom + step) * 10) / 10));
  void setZoom(zoom);
}

/** localStorage can be unavailable; remembering the last vault is a convenience, never required. */
function remember(path: string | null) {
  try {
    if (path) localStorage.setItem(LAST_VAULT_KEY, path);
    else localStorage.removeItem(LAST_VAULT_KEY);
  } catch {
    // ignore
  }
}

function lastVault(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

/** A value kept from last time, or null. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore: it is then not remembered
  }
}

/** The width a sidebar was dragged to, of the left one or the right one by `key`. */
function savedSidebarWidth(key: string): number {
  const width = Number(stored(key));
  return width >= SIDEBAR_WIDTH.min && width <= SIDEBAR_WIDTH.max ? width : SIDEBAR_WIDTH.default;
}

/** The panes and tabs that were open in the vault at `root`, without the notes that are not in `entries` any more. */
function savedWorkspace(root: string, entries: Entry[]): W.Workspace {
  const notes = new Set(notePaths(entries));
  try {
    return W.restore(JSON.parse(stored(WORKSPACE_KEY + root) ?? "null"), (path) => notes.has(path));
  } catch {
    return W.EMPTY;
  }
}

/** Puts text on the clipboard. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The webview refuses the clipboard API without a real click (e.g. a command run over MCP).
    const field = document.createElement("textarea");
    field.value = text;
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("The clipboard is not available");
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether a read failed because the file is not text (the core reads notes as UTF-8): a PDF, a zip, a note in another encoding. */
const notText = (e: unknown) => /valid UTF-8/i.test(message(e));

/** What the user typed in a prompt, as a vault-relative note path ending in `.md`. */
function notePath(input: string): string {
  const path = input.trim().replace(/^\/+/, "");
  return /\.md$/i.test(path) ? path : path + ".md";
}

/** What the user typed in a prompt, as a vault-relative folder path. */
const folderPath = (input?: string) => input?.trim().replace(/^\/+|\/+$/g, "");

/** The port the `claude mcp add` line names: the one the MCP server runs on, else the one in the settings. */
const mcpPort = async () => {
  const { mcp, mcpStatus } = await appSettingsGet();
  return mcpStatus.port ?? mcp.port;
};

export default function App() {
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  // What is open where: the panes, their tabs, and each tab's note, history and mode (src/workspace.ts).
  // `ws` is the truth and is set first, so a command that runs right after a click reads the pane that
  // click made active; the state draws it. "The open note" everywhere below is the active pane's tab.
  const [workspace, setWorkspace] = useState(W.EMPTY);
  const ws = useRef(workspace);
  const apply = useCallback((change: (ws: W.Workspace) => W.Workspace) => {
    const next = change(ws.current);
    if (next === ws.current) return;
    ws.current = next;
    setWorkspace(next);
  }, []);
  const openPath = () => W.tab(ws.current).path;
  // Counts the vaults opened, so the panes of one vault are never reused for the next.
  const [opened, setOpened] = useState(0);
  // The text of each note on screen, by path, for an editor or a view to start from: as last read from disk
  // or written to it, and for a module's view as last edited. What is typed lives in the editors and in `saves`.
  const [disk, setDisk] = useState<Record<string, string>>({});
  // The files on screen that could not be read as text. Their panes say so instead of showing an editor.
  const [noText, setNoText] = useState<ReadonlySet<string>>(new Set());
  // The tab that was opened at a line, and the line. A new object each time, so the editor jumps again.
  const [jump, setJump] = useState<{ tab: number; line: number } | null>(null);
  // The editors and module views on screen, by tab id, and where the cursor and scroll were in tabs that were left.
  const editors = useRef(new Map<number, { path: string; handle: EditorHandle }>());
  const views = useRef(new Map<number, ViewHandle>());
  const positions = useRef(new Map<number, { path: string; at: EditorPosition }>());
  // The right sidebar and what it shows: the headings of the active tab's note.
  const [outlineOpen, setOutlineOpen] = useState(() => stored(OUTLINE_OPEN_KEY) === "1");
  const [outlineWidth, setOutlineWidth] = useState(() => savedSidebarWidth(OUTLINE_WIDTH_KEY));
  const [outline, setOutline] = useState(NO_OUTLINE);
  const outlining = useRef(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => savedSidebarWidth(SIDEBAR_WIDTH_KEY));
  const [searching, setSearching] = useState(false);
  // The folders that are open in the file tree, by path.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The file tree's context menu: the entry it is for and where it opened.
  const [treeMenu, setTreeMenu] = useState<{ entry: Entry; at: MenuAt } | null>(null);
  // The vault's `defaultMode`. A tab follows it until it is toggled, and again when the setting changes.
  const [modeDefault, setModeDefault] = useState<W.EditorMode>("live-preview");
  const defaultMode = useRef<string | null>(null);
  // Words and characters of each note on screen, by path, for the status bars. Counted a moment after typing stops.
  const [counts, setCounts] = useState<Record<string, { words: number; characters: number }>>({});
  const counting = useRef(new Map<string, number>());
  const [error, setError] = useState<string | null>(null);
  // Counts `vault.changed` events. Backlinks and search results refetch when it changes.
  const [changes, setChanges] = useState(0);
  // The open vault's `.inklode` config (src/config.ts). Its key overrides go to the registry on every render.
  const [config, setConfig] = useState(NO_CONFIG);
  commands.keys = config.keys;
  // The banner text about config files that do not parse, so it can be taken down once they do.
  const configError = useRef<string | null>(null);
  // App-level settings, fetched when the settings screen opens.
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

  const notes = useMemo(() => notePaths(tree), [tree]);
  const folders = useMemo(() => folderPaths(tree), [tree]);
  // Changes when a module is switched on or off (src/modules.ts), so the app renders again with or without its views.
  const moduleVersion = useSyncExternalStore(modules.subscribe, modules.version);
  // A module's panel that is open in the right sidebar (`AppApi.ui.registerPanel`). It shows in place of the outline.
  const panelId = useSyncExternalStore(modules.subscribe, modules.panelId);
  const sidePanel = modules.panel();
  // Which one is open is remembered per vault, and opened again when the vault is (`openVault`).
  const vaultRoot = vault?.root;
  useEffect(() => {
    if (vaultRoot) store(RIGHT_PANEL_KEY + vaultRoot, panelId ?? "");
  }, [vaultRoot, panelId]);
  // A module asks for its view with no file of its own, e.g. "graph" (`AppApi.views.show`): it covers the
  // active tab's note until a note is opened in that tab. Or, asked for beside, it gets a pane of its own
  // next to the active one, until the module hides it.
  modules.onShow = (type, beside) => apply((w) => (beside ? W.showBeside(w, type) : W.showPage(w, type)));
  modules.onHide = (type) => apply((w) => W.hidePage(w, type));

  // What is not on disk yet and the rules for writing it (src/saves.ts): the edit of each note that waits,
  // the text each was read with, and what went wrong. Only notes that were actually edited are ever written,
  // so opening a note never touches the file. `issues` draws what is wrong, by path, in the panes.
  const saves = useRef<Saves>(null as never);
  saves.current ??= new Saves();
  const [issues, setIssues] = useState<Record<string, Issue>>({});
  // The autosave timer of each note with an edit that waits, and the write of each note that has one in flight.
  const timers = useRef(new Map<string, number>());
  const flights = useRef(new Map<string, Promise<void>>());
  // A rename that is running. Writes wait for it, so none goes to a path the file is just leaving.
  const renaming = useRef<Promise<unknown>>(Promise.resolve());
  // While another vault is being opened no pane is drawn, so nothing can be typed that belongs to neither vault.
  const [switching, setSwitching] = useState(false);
  // The question before unsaved text is given up, and what gets the answer.
  const [asking, setAsking] = useState<{ title: string; message: string; answer(discard: boolean): void } | null>(null);
  const answer = useRef<((discard: boolean) => void) | null>(null);

  /** Draws what is wrong with the notes' saving, when that changed. */
  const showIssues = useCallback(() => {
    const next = saves.current.issues();
    setIssues((old) => {
      const paths = Object.keys(next);
      return paths.length === Object.keys(old).length && paths.every((path) => old[path] === next[path]) ? old : next;
    });
  }, []);

  /** Keeps the text of a note to show: the file's, or what was typed. With `shown`, only if the note is still on screen. */
  const took = useCallback((path: string, content: string, shown = false) => {
    setDisk((all) => ((shown && !(path in all)) || all[path] === content ? all : { ...all, [path]: content }));
    window.clearTimeout(counting.current.get(path));
    setCounts((all) => ({ ...all, [path]: countText(content) }));
  }, []);

  // `reload` and `flush` call each other: a refused write reads the file, and a read can free a write.
  const reloadRef = useRef((_path: string) => {});

  /**
   * Writes the edit of one note that waits, after the write of it that is in flight, if any. Never rejects:
   * a write that fails leaves the edit waiting and shows why in the note's pane.
   */
  const flush = useCallback(
    async (path: string): Promise<void> => {
      await renaming.current;
      const running = flights.current.get(path);
      if (running) return running.then(() => flush(path));
      const job = saves.current.begin(path);
      if (!job) return showIssues();
      window.clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      const flight = call("note.write", { path, content: job.content, base: job.base })
        .then(
          () => {
            // An editor that comes up for this note from now on starts from the written text.
            if (!saves.current.done(job)) return;
            took(path, job.content, true);
            // For modules that tell the user's own edits from those made outside (`AppApi.notes.onSaved`).
            modules.saved(path, job.base, job.content);
          },
          (e) => {
            const conflict = message(e).startsWith("changed on disk since it was read");
            // The core's message starts with the file's full path, which the pane already names.
            const why = message(e);
            const named = why.lastIndexOf(path + ": ");
            if (!saves.current.fail(job, conflict, named < 0 ? why : why.slice(named + path.length + 2))) return;
            // Refused because the file is not what the edit was made on: the read fetches what it is now, for
            // the banner. Any other failure is tried again, after a longer wait each time.
            if (conflict) reloadRef.current(path);
            else arm(path, saves.current.retryIn(path, AUTOSAVE_MS));
          },
        )
        .finally(() => {
          flights.current.delete(path);
          showIssues();
        });
      flights.current.set(path, flight);
      return flight;
    },
    // `arm` is defined below and never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [took, showIssues],
  );

  /** Writes the edits that are waiting, of one note or of all, and waits for the writes in flight. Never rejects. */
  const save = useCallback(
    async (only?: string) => {
      await Promise.all((only === undefined ? saves.current.unsaved() : [only]).map(flush));
    },
    [flush],
  );

  /** Saves a note after `ms`, in place of the timer it had. */
  const arm = useCallback(
    (path: string, ms = AUTOSAVE_MS) => {
      window.clearTimeout(timers.current.get(path));
      timers.current.set(path, window.setTimeout(() => void flush(path), ms));
    },
    [flush],
  );

  /** An edit from an editor or a module's view of the vault `gen`, as the note's whole new text. */
  const onEdit = useCallback(
    (gen: number, path: string, content: string) => {
      // Not from an editor that is on its way out (its vault was closed, its note renamed or deleted): that
      // text has no file any more, and saved under its old path it would make one, or replace another vault's.
      if (!W.panes(ws.current).some((p) => W.shown(p).path === path)) return;
      if (!saves.current.edit(gen, path, content)) return;
      if (saves.current.autosaves(path)) arm(path);
      // The same note in another pane shows the edit at once, so there is one text per note however many
      // editors show it. An editor takes this as a reload, not as an edit of its own, and the one that was
      // typed in already has the text. A module's view takes it as its `content`.
      for (const other of editors.current.values()) if (other.path === path) other.handle.setContent(content);
      if (modules.viewFor(path)) took(path, content, true);
      else {
        window.clearTimeout(counting.current.get(path));
        counting.current.set(
          path,
          window.setTimeout(() => setCounts((all) => ({ ...all, [path]: countText(content) })), COUNT_MS),
        );
      }
    },
    [arm, took],
  );

  /**
   * The file of a note was read, with `stamp` taken before the read (`Saves.stamp`). `opening`: the note is
   * coming on screen. Its text goes to the editors unless something is unsaved, and then a file that changed
   * meanwhile is a conflict, shown in the pane.
   */
  const seen = useCallback(
    (path: string, content: string, stamp: number, opening = false) => {
      const what = saves.current.disk(path, content, stamp);
      if (what === "take") for (const editor of editors.current.values()) if (editor.path === path) editor.handle.setContent(content);
      if (what === "retry") arm(path, 0);
      // With the `merge` module on, a conflict whose two sides changed different parts of the note is merged
      // instead of shown (`Saves.merged`). Only a note that is text in editors which all show the edit that
      // waits: the merged text goes into each as an edit Undo takes back, and is saved from there. Not a
      // module's view (a drawing), whose file is not text to merge by lines.
      const mine = saves.current.text(path);
      const shown = [...editors.current.values()].filter((editor) => editor.path === path);
      if (what === "conflict" && Saves.merge && mine !== undefined && !modules.viewFor(path) && shown.length > 0 && shown.every((editor) => editor.handle.snapshot()?.text === mine)) {
        const merged = saves.current.merged(path, mine);
        if (merged !== undefined) {
          for (const editor of shown) editor.handle.merge(merged);
          arm(path, 0);
        }
      }
      // A module's view gets the text as its `content`, and what `check` says about it may change.
      if (opening || what === "take") took(path, saves.current.text(path) ?? content, !opening);
      showIssues();
    },
    [arm, took, showIssues],
  );

  /** Asks whether unsaved text may be given up. One question at a time: a new one answers the old one with no. */
  const ask = useCallback((title: string, message: string) => {
    answer.current?.(false);
    return new Promise<boolean>((resolve) => {
      answer.current = (discard) => {
        answer.current = null;
        setAsking(null);
        resolve(discard);
      };
      setAsking({ title, message, answer: answer.current });
    });
  }, []);

  /**
   * Before something that would leave unsaved text behind (closing tabs, another vault, quitting): saves
   * everything, and if a note of `paths` (all, if left out) still could not be saved, asks whether to give
   * its changes up. True when nothing unsaved is left of them; false when the user wants to stay.
   */
  const settle = useCallback(
    async (paths?: string[]) => {
      for (;;) {
        await save();
        const left = saves.current.unsaved().filter((path) => !paths || paths.includes(path));
        if (left.length === 0) return true;
        const stuck = left.filter((path) => saves.current.issue(path));
        // Typed during the save: saved in the next round.
        if (stuck.length === 0) continue;
        const name = (path: string) => `“${path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "")}”`;
        const issue = saves.current.issue(stuck[0])!;
        const why =
          issue.kind === "failed" ? issue.message : issue.kind === "gone" ? "the file was moved or deleted outside Inklode" : "the file was changed outside Inklode";
        const discard = await ask(
          `Could not save ${name(stuck[0])}${stuck.length > 1 ? ` and ${stuck.length - 1} more` : ""}: discard changes?`,
          `What you typed there is not on disk (${why}). Cancel to go back to it.`,
        );
        if (!discard) return false;
        for (const path of stuck) {
          window.clearTimeout(timers.current.get(path));
          timers.current.delete(path);
          saves.current.drop(path);
        }
        showIssues();
      }
    },
    [save, ask, showIssues],
  );

  // Updates of the app itself (components/Updates.tsx): the check when the app starts, and the notice that offers one.
  const updates = useUpdates(settle);
  const checkForUpdates = updates.check;

  /**
   * Shows a note in the active tab, or with `newTab` in a new tab of the active pane. Throws if it cannot be read.
   * `step` is set by Back (-1) and Forward (1): the note is then a place in the tab's history, not a new entry.
   */
  const loadNote = useCallback(
    async (path: string, line?: number, step?: number, newTab = false) => {
      await save();
      const { gen } = saves.current;
      const stamp = saves.current.stamp(path);
      // A picture is not read: its pane draws it from the file. Any other file that is not text opens too, and
      // its pane says that it cannot be shown. Only a file that cannot be read at all is an error.
      const content = isImage(path)
        ? null
        : await call<{ content: string }>("note.read", { path }).then(
            (read) => read.content,
            (e) => {
              if (!notText(e)) throw e;
              return null;
            },
          );
      // Another vault was opened meanwhile: this text is not of it.
      if (gen !== saves.current.gen) return;
      apply((w) => (newTab ? W.addTab(w, path) : W.open(w, path, step)));
      if (content === null) setNoText((all) => (all.has(path) || isImage(path) ? all : new Set(all).add(path)));
      else seen(path, content, stamp, true);
      setJump(line ? { tab: W.tab(ws.current).id, line } : null);
      // The folders the note is in open, so it shows in the tree.
      setExpanded((open) => new Set([...open, ...foldersOf(path)]));
      setError(null);
    },
    [save, apply, seen],
  );

  /** `loadNote` for clicks: a failure goes to the error banner. */
  const openNote = useCallback(
    (path: string, line?: number, newTab = false) => loadNote(path, line, undefined, newTab).catch((e) => setError(message(e))),
    [loadNote],
  );
  // A module opens a note, e.g. from a list in its panel (`AppApi.notes.open`).
  modules.onOpen = openNote;

  /**
   * A change to the panes and tabs that is not opening a note. What is waiting is saved first, as when
   * switching notes, and the focus goes to the editor of the tab that is now the active one.
   */
  const change = useCallback(
    async (next: (ws: W.Workspace) => W.Workspace) => {
      // The notes no tab would have any more. One that cannot be saved is not closed without a question.
      const tabPaths = (w: W.Workspace) => W.panes(w).flatMap((p) => p.tabs.flatMap((t) => t.path ?? []));
      const kept = tabPaths(next(ws.current));
      if (!(await settle(tabPaths(ws.current).filter((path) => !kept.includes(path))))) return;
      setJump(null);
      apply(next);
      // An editor that is on screen already. One that comes up for the active tab takes the focus itself.
      editors.current.get(W.tab(ws.current).id)?.handle.focus();
    },
    [settle, apply],
  );

  // The notes on screen: what each pane's tab shows.
  const visible = [...new Set(W.panes(workspace).flatMap((p) => W.shown(p).path ?? []))];
  const reading = useRef(new Set<string>());
  // Reads the notes that came on screen without `loadNote` (a tab that was switched to, a split, a restored
  // layout), and forgets the text of those that left, so that coming back to one reads its file again.
  useEffect(() => {
    // Not while another vault is being opened: these are the last vault's notes, and a read would be answered by the next one.
    if (switching) return;
    setDisk((all) => {
      const kept = Object.entries(all).filter(([path]) => visible.includes(path));
      return kept.length === Object.keys(all).length ? all : Object.fromEntries(kept);
    });
    setNoText((all) => {
      const kept = [...all].filter((path) => visible.includes(path));
      return kept.length === all.size ? all : new Set(kept);
    });
    // Also what `ws` shows by now: a note that was opened since this render keeps the text it was just read with.
    saves.current.prune([...visible, ...W.panes(ws.current).flatMap((p) => W.shown(p).path ?? [])]);
    showIssues();
    for (const path of visible) {
      if (path in disk || reading.current.has(path) || isImage(path) || noText.has(path)) continue;
      reading.current.add(path);
      const { gen } = saves.current;
      let stamp = 0;
      save(path)
        .then(() => {
          stamp = saves.current.stamp(path);
          return call<{ content: string }>("note.read", { path });
        })
        .then(
          ({ content }) => {
            if (gen === saves.current.gen) seen(path, content, stamp, true);
          },
          (e) => {
            if (gen !== saves.current.gen) return;
            if (notText(e)) return setNoText((all) => new Set(all).add(path));
            // The note is gone: the tabs that show it go back a note or are left empty, without a word.
            // Unless it has text that was never saved: that is shown, with the banner that says the file is gone.
            const unsaved = saves.current.text(path);
            if (unsaved === undefined) return apply((w) => W.removed(w, path));
            saves.current.gone(path, stamp);
            took(path, unsaved);
            showIssues();
          },
        )
        .finally(() => reading.current.delete(path));
    }
    // `visible` is a new array each time; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.join("\n"), disk, noText, save, seen, took, apply, switching]);

  // The panes and tabs are remembered per vault.
  useEffect(() => {
    if (vault) store(WORKSPACE_KEY + vault.root, JSON.stringify({ ...workspace, closed: [] }));
  }, [vault, workspace]);

  const refreshTree = useCallback(async () => {
    const entries = await call<Entry[]>("vault.tree");
    setTree(entries);
    return entries;
  }, []);

  /** Reads the vault's config again and applies it. `reset` forgets the previous vault's. */
  const reloadConfig = useCallback(async (reset = false) => {
    const next = await loadConfig(reset);
    if (!next) return;
    setConfig(next);
    const problems = Object.entries(next.broken)
      .map(([path, why]) => `${path} is not valid JSON: ${why}`)
      .join(". ");
    const before = configError.current;
    configError.current = problems || null;
    setError((shown) => problems || (shown === before ? null : shown));
    if (next.options.defaultMode !== defaultMode.current) {
      // The setting was changed: every tab follows it. Not when a vault opens, so restored tabs keep their mode.
      if (defaultMode.current !== null) apply(W.resetMode);
      defaultMode.current = next.options.defaultMode;
      setModeDefault(next.options.defaultMode);
    }
    // Loads the modules that are on and takes out those that are off.
    await modules.apply(next.modules);
  }, [apply]);

  /** Ends what belongs to the vault that is open: no edit of it is kept, saved or taken from here on, and the panes are made anew. */
  const cutOff = useCallback(() => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
    setOpened(saves.current.reset());
    setIssues({});
    setDisk({});
    setNoText(new Set());
  }, []);

  const openVault = useCallback(
    async (path: string) => {
      // Everything of the open vault is on disk first, or given up by the user.
      if (!(await settle())) return;
      // `vault.open` keeps the core busy while it reads the vault, and a write sent meanwhile would run after
      // it, in the new vault. So from here, with no await in between, the old editors are cut off and taken
      // off the screen: nothing typed now can be saved anywhere.
      cutOff();
      setSwitching(true);
      let info: VaultInfo & { watchError?: string | null };
      let entries: Entry[];
      let panel: string | null;
      try {
        info = await call("vault.open", { path });
        entries = await refreshTree();
        // Read before the vault is set: from then on what the sidebar shows is stored under this vault.
        panel = stored(RIGHT_PANEL_KEY + info.root);
      } catch (e) {
        // The vault that was open still is, and its panes come back.
        cutOff();
        setSwitching(false);
        throw e;
      }
      // Again: what was read or reported while the core was switching is of neither vault for sure.
      cutOff();
      setSwitching(false);
      // The vault and its panes are set together, so the panes of the last vault are never saved as this one's.
      const restored = savedWorkspace(info.root, entries);
      ws.current = restored;
      setWorkspace(restored);
      setVault(info);
      setJump(null);
      positions.current.clear();
      // Without the watcher a change made by another program shows only when the note is saved or opened again.
      setError(info.watchError ? `Changes made outside Inklode will not show until a note is reopened: ${info.watchError}` : null);
      setExpanded(new Set(foldersOf(W.tab(restored).path ?? "")));
      defaultMode.current = null;
      remember(path);
      // A config that cannot be read must not stop the vault from opening.
      await reloadConfig(true).catch((e) => setError(message(e)));
      // The right sidebar shows the module panel it showed in this vault last time. The modules are loaded by
      // now; a panel whose module is off here is not opened (`togglePanel`), and the last vault's is not kept.
      const open = modules.panelId();
      if (open !== null && open !== panel) modules.togglePanel(open, false);
      if (panel) modules.togglePanel(panel, true);
      // A module that stays on from the last vault has that vault's data.
      modules.vaultChanged();
    },
    [settle, cutOff, refreshTree, reloadConfig],
  );

  const followLink = useCallback(
    async (link: string, newTab = false) => {
      const from = openPath();
      if (!from) return;
      const { path } = await call<{ path: string | null }>("note.resolve", { link, from });
      if (path) await openNote(path, undefined, newTab);
      else setError(`No note named ${link.split(/[#|]/)[0].trim()}`);
    },
    [openNote],
  );

  /** Reads the outline of the active tab's editor, a moment later, so typing and scrolling read it once in a while. */
  const readOutline = useCallback(() => {
    if (outlining.current) return;
    outlining.current = window.setTimeout(() => {
      outlining.current = 0;
      const tab = W.tab(ws.current);
      const editor = editors.current.get(tab.id);
      const next = editor && editor.path === tab.path && !tab.page ? editor.handle.outline() : NO_OUTLINE;
      setOutline((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    }, OUTLINE_MS);
  }, []);
  // The outline follows the active pane and its tab.
  const activeTab = W.tab(workspace);
  useEffect(readOutline, [readOutline, activeTab.id, activeTab.path, activeTab.page]);

  // What the panes call (components/Workspace.tsx). One object for good, so the panes do not draw again for it.
  const host = useMemo<PaneHost>(
    () => ({
      // The editors of these panes belong to the vault that is open now. After another one is opened, what
      // they still report is told apart by this number and dropped.
      onEdit: (path, content) => onEdit(opened, path, content),
      resolve: (path, how) => void resolveRef.current(path, how),
      open: (path, line) => void openNote(path, line),
      focus: (pane) => apply((w) => W.focus(w, pane)),
      editor(tab, path, handle) {
        const old = editors.current.get(tab);
        if (handle) editors.current.set(tab, { path, handle });
        else if (old) {
          // The tab is left: where it was is kept for when it shows again.
          const at = old.handle.position();
          if (at) positions.current.set(tab, { path: old.path, at });
          editors.current.delete(tab);
        }
        readOutline();
      },
      view: (tab, handle) => void (handle ? views.current.set(tab, handle) : views.current.delete(tab)),
      peer(tab, path) {
        for (const [id, other] of editors.current) if (id !== tab && other.path === path) return other.handle.snapshot()?.text;
        // No other editor has it, but an edit may still be waiting or on its way to disk (the editor that made
        // it was just taken down, as when its tab moves to another pane).
        return saves.current.text(path);
      },
      position(tab, path) {
        const kept = positions.current.get(tab);
        return kept?.path === path ? kept.at : undefined;
      },
      onMove: readOutline,
      onProblem: setError,
      dismissError: () => setError(null),
    }),
    [onEdit, opened, openNote, apply, readOutline],
  );

  /** The text a note has on screen: its editor's, or what a module's view last reported or was given. */
  const textOf = (path: string) => {
    for (const editor of editors.current.values()) if (editor.path === path) return editor.handle.snapshot()?.text;
    return saves.current.text(path) ?? disk[path];
  };

  /**
   * A button of the banner a pane shows when a note could not be saved (`SaveIssue` in components/Workspace.tsx).
   * - "mine": the user's text replaces the file as it was last read, or makes the file again if it is gone.
   * - "theirs": the file's text replaces the user's, which Undo in the editor brings back.
   * - "retry": tries the failed save again now.
   * - "close": the note is gone and the user lets it go: its tabs step back or empty, as after a delete.
   */
  // The banner shows only for a conflict the `merge` module did not merge (see `seen`), or with that module off.
  const resolveRef = useRef(async (_path: string, _how: "mine" | "theirs" | "retry" | "close") => {});
  resolveRef.current = async (path, how) => {
    if (how === "mine") {
      const mine = textOf(path);
      if (mine === undefined || !saves.current.keepMine(path, mine)) return;
    } else if (how === "theirs") {
      const theirs = saves.current.takeTheirs(path);
      if (theirs === undefined) return;
      window.clearTimeout(timers.current.get(path));
      for (const editor of editors.current.values()) if (editor.path === path) editor.handle.setContent(theirs, true);
      took(path, theirs, true);
    } else if (how === "close") {
      window.clearTimeout(timers.current.get(path));
      saves.current.drop(path);
      apply((w) => W.removed(w, path));
    }
    showIssues();
    if (how !== "close") await save(path);
  };

  useEffect(() => {
    commands.onError = (e) => setError(message(e));
    // "New note…" and "Rename note…" open a prompt, and the prompt runs the same command again with the text.
    const typed = (params: unknown) => (params as { path?: string } | undefined)?.path;
    /** The note a command is about: `{path}` if given, else the open note. */
    const target = (params: unknown, what: string) => {
      const path = typed(params) ?? openPath();
      if (!path) throw new Error(`Open a note to ${what} it`);
      return path;
    };
    const settings = (section?: unknown) => {
      if (SETTINGS_SECTIONS.some((s) => s.id === section)) setSettingsSection(section as SettingsSection);
      setDialog({ kind: "settings" });
    };
    // The commands below need params. Run without any, as from the palette, they open the settings screen.
    // With params they change a file in `.inklode`, then load it, so the change is in force when the command returns.
    const vaultConfig =
      (section: SettingsSection, change: (params: Record<string, unknown>) => Promise<void>) => async (params?: unknown) => {
      if (params == null) return settings(section);
      if (!vault) throw new Error("Open a vault first");
      await change(params as Record<string, unknown>);
      await reloadConfig();
    };
    const name = (params: Record<string, unknown>) => {
      if (typeof params.name !== "string") throw new Error("name is missing");
      return params.name;
    };
    /**
     * Before a delete: the edits that are waiting must not write the files back, and a write that is already
     * on its way lands before the delete, not after it.
     */
    const dropEdits = async (paths: string[]) => {
      for (const path of paths) {
        window.clearTimeout(timers.current.get(path));
        timers.current.delete(path);
        saves.current.drop(path);
      }
      await Promise.all(flights.current.values());
    };
    // The tab commands take `{tab}`, an id from `ui_state.panes`, and act on the active tab without it.
    const tabOf = (params: unknown) => (params as { tab?: number } | undefined)?.tab;
    /** Opens what the active tab shows, or the tab `{tab}`, in a new pane beside or under its pane. */
    const split = async (direction: "right" | "down", params: unknown) => {
      const tab = tabOf(params);
      await change((w) => (tab === undefined ? w : W.select(w, tab)));
      const from = W.tab(ws.current);
      const at = editors.current.get(from.id)?.handle.position();
      apply((w) => W.split(w, direction));
      // The copy starts where the original is.
      if (from.path && at) positions.current.set(W.tab(ws.current).id, { path: from.path, at });
    };
    /** The files in the folder `path`, or the file `path` itself. */
    const filesAt = (path: string) => notes.filter((p) => p === path || p.startsWith(path + "/"));
    /** The folder a folder command is about: `given`, else the folder the open note is in. */
    const folderFor = (given: string | undefined, what: string) => {
      const path = given ?? parentOf(openPath() ?? "");
      if (!path) throw new Error(`Open a note in a folder to ${what} that folder, or use the folder's menu in the file tree`);
      return path;
    };
    /** Moves the file or folder `from` to the path `to`. The history, the open folders and the open note follow. */
    const moveTo = async (from: string, to: string) => {
      if (to === from) return;
      const moving = filesAt(from);
      const now = (path: string) => to + path.slice(from.length);
      // Every write is on disk before the files move, and none starts until they have: `flush` waits for
      // `renaming`. A write to the old path after the move would make the old file again.
      await save();
      let failed: unknown;
      let moved = false;
      const rename = (async () => {
        // `own`: the user did this here, so what it changes does not wait in the review inbox.
        await call(folders.includes(from) ? "folder.rename" : "note.rename", { from, to, own: true }).catch((e) => (failed = e));
        const entries = await call<Entry[]>("vault.tree");
        setTree(entries);
        // The core moves first and rewrites links after, so when it fails the move may still be done.
        moved = !failed || ![...notePaths(entries), ...folderPaths(entries)].includes(from);
        if (!moved) return;
        // Every tab that shows a moved note, or has it in its history, follows it.
        for (const path of moving) {
          apply((w) => W.renamed(w, path, now(path)));
          // What was typed while the file was moving, or could not be saved before, goes with the file to
          // its new path, with the text the file was read with.
          const timer = timers.current.get(path);
          window.clearTimeout(timer);
          timers.current.delete(path);
          saves.current.move(path, now(path));
          if (saves.current.text(now(path)) !== undefined) arm(now(path));
        }
      })();
      renaming.current = rename.catch(() => {});
      await rename;
      if (moved) {
        showIssues();
        setExpanded((open) => new Set([...open].map((p) => (p === from || p.startsWith(from + "/") ? now(p) : p))));
        // Read here, so the open note's text is on screen when the command returns.
        const open = openPath();
        if (open && moving.some((path) => now(path) === open)) await openNote(open);
      }
      if (failed) throw failed;
    };
    return commands.register([
      {
        id: "vault.open",
        title: "Open vault…",
        // `{path}` opens that folder without the dialog, for MCP.
        run: async (params) => {
          const path = typed(params) ?? (await pickFolder());
          if (path) await openVault(path);
        },
      },
      { id: "note.switch", title: "Open note…", key: "Mod+O", run: () => setDialog({ kind: "switcher" }) },
      {
        id: "note.new",
        title: "New note…",
        key: "Mod+N",
        // `{path}` makes that note. `{folder}` opens the prompt with the folder filled in.
        run: async (params) => {
          const input = typed(params);
          if (!input) return setDialog({ kind: "new", arg: String((params as { folder?: string } | undefined)?.folder ?? "") });
          const path = notePath(input);
          // The core makes the file only if nothing has the path, whatever the tree here knows: a file that is
          // there is never emptied.
          const taken = await call("note.create", { path, content: "", own: true }).then(
            () => false,
            (e) => {
              if (!message(e).startsWith("already exists")) throw e;
              return true;
            },
          );
          const entries = await refreshTree();
          if (!taken) return openNote(path);
          // The note that has the name is opened, under the name the disk has for it (another case, or
          // another Unicode form of the same letters).
          const fold = (p: string) => p.normalize("NFC").toLowerCase();
          const existing = notePaths(entries).find((p) => fold(p) === fold(path));
          if (!existing) throw new Error(`${path} already exists`);
          await loadNote(existing);
          setError(`${existing} already exists, so it was opened instead of making a new note.`);
        },
      },
      {
        id: "note.rename",
        title: "Rename note…",
        // `{from?, path?}`: `from` is the file, the open note if left out. Without `path`, the new name, it asks for
        // it. `path` may leave out the extension `from` has (src/fileNames.ts).
        run: async (params) => {
          const from = (params as { from?: string } | undefined)?.from ?? openPath();
          if (!from) throw new Error("Open a note to rename it");
          const input = typed(params);
          if (!input) return setDialog({ kind: "rename", arg: from });
          // The file keeps its extension: a drawing stays a drawing, and a picture does not become a note.
          await moveTo(from, renameTarget(from, input));
        },
      },
      {
        id: "file.move",
        title: "Move file to…",
        // `{from?, to?}`: moves the file or folder `from`, the open note if left out, into the folder `to`, "" for
        // the vault root. Links that would break are rewritten. Without `to` it asks for the folder.
        run: async (params) => {
          const { from = openPath(), to } = (params ?? {}) as { from?: string | null; to?: string };
          if (!from) throw new Error("Open a note to move it");
          if (to === undefined) return setDialog({ kind: "move", arg: from });
          await moveTo(from, (to && folderPath(to) + "/") + from.slice(from.lastIndexOf("/") + 1));
        },
      },
      {
        id: "folder.new",
        title: "New folder…",
        // `{path}` makes that folder. `{folder}` opens the prompt with the folder it goes in filled in.
        run: async (params) => {
          const path = folderPath(typed(params));
          if (!path) return setDialog({ kind: "newFolder", arg: String((params as { folder?: string } | undefined)?.folder ?? "") });
          await call("folder.new", { path });
          await refreshTree();
          // The folders it is in open, so it shows in the tree.
          setExpanded((open) => new Set([...open, ...foldersOf(path)]));
        },
      },
      {
        id: "folder.rename",
        title: "Rename folder…",
        // `{from?, path?}`: `from` is the folder, the one the open note is in if left out. Without `path`, the new
        // path, it asks for it. Everything in the folder moves with it.
        run: async (params) => {
          const from = folderFor((params as { from?: string } | undefined)?.from, "rename");
          const to = folderPath(typed(params));
          if (!to) return setDialog({ kind: "renameFolder", arg: from });
          await moveTo(from, to);
        },
      },
      {
        id: "folder.delete",
        title: "Delete folder…",
        // `{path?, confirmed?}`: the folder the open note is in if `path` is left out. It asks first unless
        // `confirmed` is true. The folder moves whole to `.trash/` in the vault.
        run: async (params) => {
          const path = folderFor(typed(params), "delete");
          if ((params as { confirmed?: boolean } | undefined)?.confirmed !== true) return setDialog({ kind: "deleteFolder", arg: path });
          const gone = filesAt(path);
          await dropEdits(gone);
          await call("folder.delete", { path, own: true });
          for (const file of gone) apply((w) => W.removed(w, file));
          // Again, for what was typed while the folder was on its way to the trash.
          await dropEdits(gone);
          showIssues();
          await refreshTree();
        },
      },
      {
        id: "note.delete",
        title: "Delete note…",
        // `{path?, confirmed?}`: the open note if `path` is left out. It asks first unless `confirmed` is true.
        // The file moves to `.trash/` in the vault; nothing is removed from the disk.
        run: async (params) => {
          const path = target(params, "delete");
          if ((params as { confirmed?: boolean } | undefined)?.confirmed !== true) return setDialog({ kind: "delete", arg: path });
          await dropEdits([path]);
          await call("note.delete", { path, own: true });
          // Every tab that shows it goes back to the note it showed before, or is left empty.
          apply((w) => W.removed(w, path));
          // Again, for what was typed while the file was on its way to the trash.
          await dropEdits([path]);
          showIssues();
          await refreshTree();
        },
      },
      {
        id: "note.reveal",
        title: "Reveal note in Finder",
        // `{path?}`: a file or folder of the vault, the open note if left out.
        run: (params) => {
          if (!vault) throw new Error("Open a vault first");
          return revealInFileManager(`${vault.root}/${target(params, "reveal")}`);
        },
      },
      {
        id: "note.copyPath",
        title: "Copy note path",
        // `{path?}`: copies the absolute path of that file or folder, the open note if left out.
        run: (params) => {
          if (!vault) throw new Error("Open a vault first");
          return copyText(`${vault.root}/${target(params, "copy the path of")}`);
        },
      },
      {
        id: "nav.back",
        title: "Back",
        key: "Mod+[",
        run: async () => {
          const path = nav.peek(W.tab(ws.current).history, -1);
          if (path) await loadNote(path, undefined, -1);
        },
      },
      {
        id: "nav.forward",
        title: "Forward",
        key: "Mod+]",
        run: async () => {
          const path = nav.peek(W.tab(ws.current).history, 1);
          if (path) await loadNote(path, undefined, 1);
        },
      },
      {
        id: "link.follow",
        title: "Follow link under cursor",
        key: "Alt+Enter",
        // `{link?, newTab?}`: `link` follows that link instead (a click in Live Preview, or MCP), from the open
        // note. `newTab` opens the note in a new tab (Cmd-click and middle click).
        run: (params) => {
          const { link: given, newTab } = (params ?? {}) as { link?: string; newTab?: boolean };
          const link = given ?? editors.current.get(W.tab(ws.current).id)?.handle.link();
          if (!link) return;
          // shortcut: a URL that is not http(s) (`[text](Note.md)`, `mailto:`) is looked up as a note name,
          // as written; decode it and resolve relative paths when Markdown-style note links matter
          return /^https?:/i.test(link) ? openExternal(link) : followLink(link, newTab);
        },
      },
      { id: "tab.new", title: "New tab", key: "Mod+T", run: () => change((w) => W.addTab(w)) },
      {
        id: "tab.open",
        title: "Open note in new tab",
        // `{path?}`: the open note if left out, which gives a second tab on it.
        run: (params) => loadNote(target(params, "open"), undefined, undefined, true),
      },
      // Closing the last tab of a pane closes the pane; the only pane keeps one empty tab.
      { id: "tab.close", title: "Close tab", key: "Mod+W", run: (params) => change((w) => W.closeTab(w, tabOf(params))) },
      { id: "tab.closeOthers", title: "Close other tabs", run: (params) => change((w) => W.closeOthers(w, tabOf(params))) },
      // Ctrl+Tab: `Mod` is also Cmd, but macOS keeps Cmd+Tab for itself.
      { id: "tab.next", title: "Next tab", key: "Mod+Tab", run: () => change((w) => W.cycle(w, 1)) },
      { id: "tab.prev", title: "Previous tab", key: "Mod+Shift+Tab", run: () => change((w) => W.cycle(w, -1)) },
      {
        id: "tab.goto",
        title: "Go to first tab",
        // `{index}`: the active pane's tab with that number, from 1, the last tab if there are fewer. Cmd+1 to
        // Cmd+9 run it (see the key handler below). `{tab}`: the tab with that id, in whatever pane it is.
        run: (params) => {
          const { index = 1, tab } = (params ?? {}) as { index?: number; tab?: number };
          return change((w) => (tab === undefined ? W.goto(w, Number(index) || 1) : W.select(w, tab)));
        },
      },
      {
        id: "tab.reopen",
        title: "Reopen closed tab",
        key: "Mod+Shift+T",
        // A note that was deleted since is not reopened: its tab is dropped when it cannot be read.
        run: () => change(W.reopen),
      },
      {
        id: "tab.move",
        title: "Move tab to next pane",
        // `{tab?, pane?, index?}`: the tab with that id (the active one) goes to the pane with that id (the next
        // one) at place `index` of its strip, from 0 (the end). A drag of a tab runs this.
        run: (params) => {
          const { tab, pane, index } = (params ?? {}) as { tab?: number; pane?: number; index?: number };
          return change((w) => {
            const to = W.panes(w).find((p) => p.id === (pane ?? W.focusNext(w).active));
            return to ? W.moveTab(w, tab ?? W.tab(w).id, to.id, index ?? to.tabs.length) : w;
          });
        },
      },
      // `{tab?}`: split with what that tab shows.
      { id: "pane.splitRight", title: "Split right", run: (params) => split("right", params) },
      { id: "pane.splitDown", title: "Split down", run: (params) => split("down", params) },
      {
        id: "pane.close",
        title: "Close pane",
        // `{pane?}`: the pane with that id, the active one if left out. Its tabs go with it.
        run: (params) => change((w) => W.closePane(w, (params as { pane?: number } | undefined)?.pane)),
      },
      { id: "pane.focusNext", title: "Focus next pane", run: () => change((w) => W.focusNext(w)) },
      {
        id: "outline.toggle",
        title: "Toggle outline",
        key: "Mod+Shift+O",
        // Acts on what is on screen. While a module's panel covers the outline, it closes that panel and shows
        // the outline, whether or not the outline was open under it. Flipping only the flag there changed
        // nothing on screen, and showed or hid the outline later, when the panel was closed.
        run: () => {
          const covering = modules.panelId();
          if (covering !== null) modules.togglePanel(covering, false);
          setOutlineOpen((open) => {
            const next = covering !== null || !open;
            store(OUTLINE_OPEN_KEY, next ? "1" : "0");
            return next;
          });
        },
      },
      { id: "tree.collapse", title: "Collapse all folders", run: () => setExpanded(new Set()) },
      { id: "note.save", title: "Save note", key: "Mod+S", run: () => save() },
      // The two choices of the banner over a note that was changed or removed outside the app, for the keyboard
      // and for MCP. `{path?}`: the open note if left out. They do nothing for a note without that banner.
      { id: "conflict.keepMine", title: "Conflict: keep my text", run: (params) => resolveRef.current(target(params, "save"), "mine") },
      { id: "conflict.takeTheirs", title: "Conflict: take the text on disk", run: (params) => resolveRef.current(target(params, "reload"), "theirs") },
      {
        id: "app.quit",
        title: "Quit Inklode",
        // The menu's Quit runs this (src-tauri/src/menu.rs), so what was typed is on disk before the app goes.
        run: async () => {
          if (await settle()) await quitApp();
        },
      },
      // Also in the app's menu (src-tauri/src/menu.rs). The answer, or why there is none, shows in the notice
      // at the bottom of the window. Installing is not a command: only the notice's button does that.
      { id: "app.checkForUpdates", title: "Check for updates…", run: () => checkForUpdates(false) },
      {
        id: "updates.set",
        title: "Set update check at start…",
        // `{auto}`: whether the app looks for a newer version when it starts. It is the app's setting, not the vault's.
        run: async (params) => {
          const { auto } = (params ?? {}) as { auto?: unknown };
          if (typeof auto !== "boolean") return settings("about");
          setAppSettings(await updatesSet(auto));
        },
      },
      {
        id: "search.open",
        title: "Search in all notes",
        key: "Mod+Shift+F",
        run: () => {
          setSidebarOpen(true);
          setSearching(true);
          // Already showing: the box does not remount, so focus it by hand.
          document.querySelector<HTMLInputElement>(".search-input")?.focus();
        },
      },
      {
        id: "note.find",
        title: "Find in this note",
        key: "Mod+F",
        run: () => {
          const editor = document.querySelector<HTMLElement>(".pane.is-active .cm-editor") ?? document.querySelector<HTMLElement>(".cm-editor");
          const view = editor && EditorView.findFromDOM(editor);
          if (!view) throw new Error("Open a note first");
          openSearchPanel(view);
        },
      },
      { id: "palette.open", title: "Command palette", key: "Mod+P", run: () => setDialog({ kind: "commands" }) },
      { id: "sidebar.toggle", title: "Toggle sidebar", key: "Mod+\\", run: () => setSidebarOpen((open) => !open) },
      // The whole window, in steps of 10% from 50% to 300%. Not kept when the app is closed.
      { id: "view.zoomIn", title: "Zoom in", key: "Mod+=", run: () => zoomBy(0.1) },
      { id: "view.zoomOut", title: "Zoom out", key: "Mod+-", run: () => zoomBy(-0.1) },
      { id: "view.zoomReset", title: "Reset zoom", key: "Mod+0", run: () => zoomBy(0) },
      {
        id: "editor.toggleSource",
        title: "Toggle source mode",
        key: "Mod+E",
        // Of the active tab. Each tab has its own mode. From the reading view it goes to source mode too.
        run: () => apply((w) => W.setMode(w, (W.tab(w).mode ?? modeDefault) === "source" ? "live-preview" : "source")),
      },
      {
        id: "editor.toggleReading",
        title: "Toggle reading view",
        key: "Mod+Shift+E",
        // Of the active tab. Back from it to the vault's default mode, or to Live Preview when that is the reading view.
        run: () =>
          apply((w) => W.setMode(w, (W.tab(w).mode ?? modeDefault) !== "reading" ? "reading" : modeDefault === "reading" ? "live-preview" : modeDefault)),
      },
      {
        id: "settings.open",
        title: "Settings",
        key: "Mod+,",
        // `{section}`: one of the ids in SETTINGS_SECTIONS, e.g. "hotkeys". Left out, the section shown last.
        run: (params) => settings((params as { section?: string } | undefined)?.section),
      },
      {
        id: "settings.set",
        title: "Change a setting…",
        // `{key, value}`: one of the options of src/appearance.ts in the vault's settings.json, e.g.
        // `{key: "accent", value: "#2f6fde"}`. A null value removes the key, which is the default.
        run: vaultConfig("appearance", ({ key, value }) => setOption(String(key), value ?? null)),
      },
      {
        id: "appearance.set",
        title: "Set light or dark appearance…",
        // `{mode}`: "system", "light" or "dark".
        run: vaultConfig("appearance", ({ mode }) => setOption("appearance", mode)),
      },
      {
        id: "theme.set",
        title: "Set theme…",
        // `{name}`: a theme in `.inklode/themes`. Null or left out is the default theme.
        run: vaultConfig("appearance", (params) => setTheme(params.name == null ? null : name(params))),
      },
      {
        id: "snippet.toggle",
        title: "Toggle snippet…",
        // `{name, on?}`: without `on`, flips it.
        run: vaultConfig("appearance", (params) => toggleSnippet(name(params), params.on == null ? undefined : Boolean(params.on))),
      },
      {
        id: "module.toggle",
        title: "Toggle module…",
        // `{id, on?}`: without `on`, flips it.
        run: vaultConfig("modules", ({ id, on }) => toggleModule(String(id), on == null ? undefined : Boolean(on))),
      },
      {
        id: "key.set",
        title: "Set key…",
        // `{id, key}`: null unbinds the command, no `key` at all restores its default.
        run: vaultConfig("hotkeys", ({ id, key }) => {
          if (key != null && typeof key !== "string") throw new Error("key must be text or null");
          return setKey(String(id), key);
        }),
      },
      {
        id: "mcp.set",
        title: "Set MCP server…",
        // `{enabled?, port?}`: what is left out stays as it is.
        run: async (params) => {
          if (params == null) return settings("mcp");
          const { enabled, port } = params as { enabled?: boolean; port?: number };
          if (port != null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
            throw new Error("The port must be a whole number from 1 to 65535");
          }
          const { mcp } = await appSettingsGet();
          const result = await appSettingsSet({ mcp: { enabled: enabled ?? mcp.enabled, port: port ?? mcp.port } });
          setAppSettings(result);
          // The setting is saved, but the server could not start (e.g. the port is taken).
          if (!result.mcpStatus.running && result.mcpStatus.error) throw new Error(result.mcpStatus.error);
        },
      },
      // The three below are the buttons of the MCP section of the settings screen. The token goes from the shell
      // to the clipboard and is never in the window, so none of them returns it.
      {
        id: "mcp.copyToken",
        title: "Copy MCP token",
        noKey: true,
        run: async () => mcpCopy("token", await mcpPort()),
      },
      {
        id: "mcp.copyCommand",
        title: "Copy the `claude mcp add` line for the MCP server",
        noKey: true,
        run: async () => mcpCopy("command", await mcpPort()),
      },
      {
        id: "mcp.newToken",
        title: "New MCP token",
        // Clients that have the old token are refused from then on.
        noKey: true,
        run: () => mcpTokenNew(),
      },
    ]);
  }, [openVault, openNote, loadNote, refreshTree, save, settle, arm, showIssues, notes, folders, modeDefault, vault, reloadConfig, apply, change, followLink]);

  const inSettings = dialog?.kind === "settings";
  useEffect(() => {
    if (!inSettings) return;
    const read = () => void appSettingsGet().then(setAppSettings, (e) => setError(message(e)));
    read();
    // Read again when the capture hotkey was registered or unregistered, e.g. by the module's switch on this screen.
    return onAppSettingsChanged(read);
  }, [inSettings]);

  // Light or dark before any vault's settings are read, and from then on following the system.
  useEffect(() => applyOptions(), []);

  // A window that is covered or minimised gets no frames, so a transition or animation started there
  // stays at its first frame (a dialog fading in stays invisible) and screenshots taken over MCP show it.
  // While the page is hidden, `is-hidden` on <html> switches both off (app.css).
  useEffect(() => {
    const update = () => document.documentElement.classList.toggle("is-hidden", document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  /** The sidebar's edge was grabbed: it follows the pointer until the button is let go. */
  // The same for both sidebars: the left one grows to the right, the right one (`towards` -1) to the left.
  const resizeSidebar = (from: number, towards: 1 | -1, set: (width: number) => void, key: string) => (down: React.PointerEvent) => {
    let width = from;
    drag(
      down,
      (dx) => set((width = Math.min(Math.max(from + towards * dx, SIDEBAR_WIDTH.min), SIDEBAR_WIDTH.max))),
      () => store(key, String(width)),
    );
  };

  useEffect(() => {
    // Capture phase, so shortcuts work while the editor has focus.
    const onKey = (e: KeyboardEvent) => {
      if (commands.handleKey(e)) return;
      // Cmd+1 to Cmd+9 show the active pane's tab with that number, unless the key is bound to a command.
      const digit = /^Mod\+([1-9])$/.exec(keyOf(e))?.[1];
      if (!digit) return;
      e.preventDefault();
      e.stopPropagation();
      void commands.run("tab.goto", { index: Number(digit) });
    };
    window.addEventListener("keydown", onKey, true);
    // The menu bar's items run commands too (src-tauri/src/menu.rs).
    const offMenu = onMenuCommand((id) => commands.fromMenu(id));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      offMenu();
    };
  }, []);

  // Reopen the vault from last time. If it has moved or been deleted, forget it.
  useEffect(() => {
    const path = lastVault();
    if (path) openVault(path).catch(() => remember(null));
  }, [openVault]);

  useEffect(() => {
    // The window is asked to close (its button, "Close Window"): what was typed is written first, and it
    // stays open if something could not be saved and the user wants to go back to it.
    const offClose = onCloseRequested(settle);
    // Leaving the window for another program saves at once, so that program finds the files as the editors
    // have them, and little is unsaved if the app is ended from outside.
    // shortcut: a quit that does not go through the menu or the window (Quit from the Dock, a shutdown, a
    // crash) ends the app without asking, and what was typed in the last 800 ms is lost; answer
    // `applicationShouldTerminate` in the shell if that matters.
    const onBlur = () => void save();
    window.addEventListener("blur", onBlur);
    return () => {
      offClose();
      window.removeEventListener("blur", onBlur);
    };
  }, [settle, save]);

  /** Whether a note has an edit that is not on disk yet. */
  const dirty = (path: string) => saves.current.dirty(path);
  /** The notes on screen now, for handlers that outlive renders. */
  const onScreen = () => [...new Set(W.panes(ws.current).flatMap((p) => W.shown(p).path ?? []))];

  /**
   * Reads a note that is on screen and shows it as it is on disk now, in every pane that has it, but never
   * over edits that are not on disk yet: then a file that changed is a conflict, and a file that is gone is
   * said to be gone, both in the note's panes, and nothing is written until the user chose.
   */
  const reload = useCallback(
    (path: string) => {
      const { gen } = saves.current;
      const stamp = saves.current.stamp(path);
      call<{ content: string }>("note.read", { path }).then(
        ({ content }) => {
          // After the app's own save the text is what the store has and nothing happens.
          if (gen === saves.current.gen) seen(path, content, stamp);
        },
        (e) => {
          // Deleted, renamed or moved by another program. The editor keeps its text, and saving it is the user's choice.
          if (gen !== saves.current.gen || !/no such file|not found|os error 2\b/i.test(message(e))) return;
          if (saves.current.gone(path, stamp)) window.clearTimeout(timers.current.get(path));
          showIssues();
        },
      );
    },
    [seen, showIssues],
  );
  reloadRef.current = reload;

  // Files changed on disk, by another program or by this app's own writes.
  useEffect(
    () =>
      onEvent((event) => {
        // Something under `.inklode/` changed: a settings file or the CSS of a theme or snippet.
        if (event.type === "config.changed") return void reloadConfig().catch((e) => setError(message(e)));
        if (event.type !== "vault.changed") return;
        setChanges((n) => n + 1);
        modules.vaultChanged();
        refreshTree().catch((e) => setError(message(e)));
        for (const path of onScreen()) if (event.paths.includes(path)) reload(path);
      }),
    [refreshTree, reloadConfig, reload],
  );

  // A module was switched on or off: a file on screen may now belong to another view, which starts from the
  // text it was opened with. Save what the old view had and show the files as they are on disk.
  useEffect(() => {
    save().then(() => onScreen().forEach(reload), (e) => setError(message(e)));
  }, [moduleVersion, save, reload]);

  // What is on screen, for the MCP tool `ui_state`. Reassigned on every render so it reads current state.
  const uiState = useRef(() => ({}));
  uiState.current = () => {
    // The top-level fields about a note (`note`, `view`, `text`, `history`…) are about the active pane's tab.
    const tab = W.tab(ws.current);
    const note = tab.path;
    const viewType = (t: W.Tab, text?: string) => {
      if (t.page && modules.view(t.page)) return t.page;
      if (!t.path) return null;
      if (isImage(t.path)) return "image";
      if (noText.has(t.path)) return "file";
      return (text === undefined ? modules.viewFor(t.path) : viewOf(t.path, text).view)?.type ?? "markdown";
    };
    const view = viewType(tab, note === null ? undefined : disk[note]);
    const editor = editors.current.get(tab.id);
    const shown = view === "markdown" && editor?.path === note ? editor.handle.snapshot() : null;
    // Open folders, backlinks and search results are state inside their components,
    // so those three are read from what the components rendered (`data-path`, `data-line`).
    const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
    const hits = (selector: string) =>
      all(selector).map((el) => ({
        path: el.dataset.path,
        line: Number(el.dataset.line),
        text: el.querySelector(".hit-text")?.textContent ?? "",
      }));
    return {
      vault: vault?.name ?? null,
      vaultRoot: vault?.root ?? null,
      note,
      // What the active tab shows: "markdown" is the editor, "image" a picture, "file" a file that is not text
      // (the pane says it cannot be shown), anything else a module's view: "excalidraw" for a drawing, "graph"
      // for the graph, which covers the note.
      view,
      // Every pane, column by column from the left and top to bottom in a column (`column` and `row` from 0),
      // with its tabs in strip order. A tab's `view` is as above, and `active` marks the tab its pane shows.
      // The ids are what the tab and pane commands take as `{tab}` and `{pane}`.
      panes: ws.current.columns.flatMap((c, column) =>
        c.panes.map((p, row) => ({
          id: p.id,
          active: p.id === ws.current.active,
          column,
          row,
          tabs: p.tabs.map((t) => ({
            id: t.id,
            path: t.path,
            view: viewType(t),
            title: tabTitle(t),
            active: t.id === p.active,
            // Whether the note has text that is not on disk yet, and what keeps it from being saved, which the
            // pane shows in a banner: `conflict` is "changed" (the file has another text now) or "gone" (it
            // was moved or deleted), `saveError` why the last write failed. Null when all is well.
            dirty: t.path !== null && dirty(t.path),
            ...((issue?: Issue) => ({
              conflict: issue?.kind === "conflict" ? "changed" : issue?.kind === "gone" ? "gone" : null,
              saveError: issue?.kind === "failed" ? issue.message : null,
            }))(t.path === null ? undefined : saves.current.issue(t.path)),
          })),
        })),
      ),
      activePane: ws.current.active,
      // The right sidebar. `open`: whether the outline is on screen, so false while a module's panel covers it.
      // `headings` are those of the active tab's note, `{level, text, line}` each, or null when it does not
      // show a note as text; `current` is the heading the cursor is in, or null before the first.
      outline: { open: outlineOpen && !sidePanel, width: outlineWidth, headings: outline.headings, current: outline.headings?.[outline.current] ?? null },
      // What the right sidebar shows: "outline", the id of a module's panel that is open over it ("history"), or null.
      rightSidebar: sidePanel?.id ?? (outlineOpen ? "outline" : null),
      // From the Excalidraw view when the active tab shows a drawing (`uiState` in modules/excalidraw/View.tsx
      // has every field). `drawing`: `{elements, frames, dirty, canvas, faded, notesPanel}`, `frames` being the
      // frame names in slide order. `slideshow`, while presenting: `{index, count, frame, title, fullscreen,
      // transitioning, build, presenter}`, `index` from 0.
      drawing: null,
      slideshow: null,
      // From the graph view: `{nodes, edges, kinds, filter, hovered, zoom, labels, settled, options, optionsOpen}`
      // (`uiState` in modules/graph/canvas.ts has every field).
      graph: null,
      // From the graph module: the local graph in the right sidebar, `{open, path, depth, options, …}`
      // (modules/graph/index.ts has every field). Null with the module off.
      localGraph: null,
      ...views.current.get(tab.id)?.uiState(note !== null && dirty(note)),
      // From the tables module: `{row, column, rows, columns}`, the cell the editor's cursor is in (row 0 is the
      // header) and the table's size. Null outside a table.
      table: null,
      // From the history module: `{open, path, revisions, selected, diff, blame, blameRanges}` (modules/history/index.ts
      // has every field). Null with the module off.
      gitHistory: null,
      // From the review module: `{open, repository, entries, selected, diff}`, the inbox of notes changed since
      // the user last looked (modules/review/index.ts has every field). Null with the module off.
      review: null,
      // From the merge module: `{count, last}`, how many conflicts it merged since it was switched on and the
      // path of the last note it did that for (null before the first). Null with the module off.
      merge: null,
      // The notice about an update of the app (`UpdateState` in components/Updates.tsx): `{kind, version?, message?}`
      // with `kind` one of checking, latest, error, available, downloading, failed, ready. Null with no notice.
      update: updates.state,
      ...modules.uiState(),
      // Module id to whether it is on.
      modules: config.modules,
      text: shown ? shown.text.slice(0, UI_STATE_TEXT_MAX) : null,
      textTruncated: shown ? shown.text.length > UI_STATE_TEXT_MAX : false,
      cursorLine: shown?.line ?? null,
      // `live-preview`, `source` or `reading`.
      editorMode: tab.mode ?? modeDefault,
      // The open note's text as the status bar counts it: `{words, characters}`. Null with no note or a view that is not text.
      counts: note !== null && view === "markdown" ? (counts[note] ?? null) : null,
      // Back and Forward of the active tab: the notes it has shown, oldest first, and which of them is on screen.
      history: tab.history,
      sidebarOpen: vault !== null && sidebarOpen,
      sidebarWidth,
      searchOpen: vault !== null && sidebarOpen && searching,
      searchQuery: document.querySelector<HTMLInputElement>(".search-input")?.value ?? null,
      // Which centred box is open: "commands" is the palette, "settings" the settings screen, "delete" the question
      // before a delete, the others are the switcher and the text prompts. `dialogArg`: the path "rename" and "delete" are about.
      // "discard" is the question before unsaved text is given up; it is over the others.
      dialog: asking ? "discard" : (dialog?.kind ?? null),
      dialogArg: dialog && "arg" in dialog ? dialog.arg : null,
      // The section the settings screen shows, or would show.
      settingsSection,
      // The popup menu that is open (a context menu, a "more" menu, a select's list): its name and item labels.
      menu: all(".menu").map((el) => ({
        label: el.getAttribute("aria-label"),
        items: [...el.querySelectorAll(".menu-label")].map((item) => item.textContent),
      }))[0] ?? null,
      // `appearance` is "light" or "dark", what is on screen. `options` are the settings behind it and the other
      // look options (src/appearance.ts), where `options.appearance` can also be "system".
      appearance: appearanceNow(),
      options: config.options,
      // From the vault's `.inklode` folder: the theme's name or null, the snippets that are on, and keys.json.
      theme: config.theme,
      snippets: config.snippets,
      keys: config.keys,
      tree: all(".tree-item").map((el) => {
        const path = el.dataset.path ?? "";
        const expanded = el.getAttribute("aria-expanded");
        return { name: path.slice(path.lastIndexOf("/") + 1), path, ...(expanded && { expanded: expanded === "true" }) };
      }),
      // While a row of the file tree is dragged: its name, where the pointer is, and the folder it would land
      // in ("" is the vault root, null nowhere). Null when nothing is dragged.
      treeDrag: all(".tree-ghost").map((el) => ({
        name: el.textContent,
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        over: document.querySelector(".tree-root.is-drop-target")
          ? ""
          : (document.querySelector<HTMLElement>(".tree-item.is-drop-target")?.dataset.path ?? null),
      }))[0] ?? null,
      // How far the file tree is scrolled, in pixels.
      treeScroll: document.querySelector(".sidebar-body")?.scrollTop ?? null,
      // Of the active pane's note. Every pane with a note has its own footer.
      backlinks: backlinksOf(document.querySelector(".pane.is-active .backlinks")),
      // Whether the backlinks list shows (it starts hidden). Null when no note is open.
      backlinksOpen: ((el) => (el ? !el.hidden : null))(document.querySelector<HTMLElement>(".pane.is-active .backlinks")),
      searchResults: hits(".sidebar .hit"),
      error,
      // False while the window is covered or minimised. Transitions and animations are off then, so a screenshot shows the end state.
      windowVisible: !document.hidden,
      // The size `ui_click` and `ui_drag` coordinates are in. A `ui_screenshot` pixel is 1/devicePixelRatio of that.
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    };
  };

  // Requests from the app's MCP server. The kinds are the tool names in src-tauri/src/mcp.rs.
  useEffect(
    () =>
      onUiRequest(async (kind, args) => {
        switch (kind) {
          case "command_list":
            return commands.list().map(({ id, title, key }) => ({ id, title, key }));
          case "command_run":
            return commands.execute(String(args.id), args.params);
          case "ui_open":
            return loadNote(String(args.path), typeof args.line === "number" ? args.line : undefined);
          case "ui_state":
            return uiState.current();
          case "ui_click":
            return uiDrive.click(args);
          case "ui_drag":
            return uiDrive.drag(args);
          case "ui_key":
            return uiDrive.key(args);
          default:
            throw new Error(`Unknown UI request: ${kind}`);
        }
      }),
    [loadNote],
  );

  const closeDialog = () => setDialog(null);
  const dialogs = (
    <>
      {dialog?.kind === "commands" && (
        <Palette
          label="Run a command"
          action="run"
          items={commands
            .list()
            .filter((c) => c.id !== "palette.open")
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((c) => ({ id: c.id, title: c.title, shortcut: c.key }))}
          onPick={(id) => void commands.run(id)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "switcher" && (
        <Palette
          label="Open a note"
          action="open"
          items={notes.map((path) => {
            const slash = path.lastIndexOf("/");
            // A drawing is listed as in the file tree: its name without `.excalidraw`, with the drawing icon.
            const drawing = DRAWING.test(path);
            return {
              id: path,
              title: path.slice(slash + 1).replace(drawing ? DRAWING : /\.md$/, ""),
              hint: path.slice(0, Math.max(slash, 0)),
              icon: drawing ? <Shapes size={14} aria-label="Drawing" /> : undefined,
            };
          })}
          onPick={(path) => void openNote(path)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "new" && (
        <Palette
          label="New note: name or Folder/Name"
          action="create"
          initial={dialog.arg && dialog.arg + "/"}
          onPick={(path) => void commands.run("note.new", { path })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "rename" && (
        <Palette
          label="Rename note: new name or Folder/Name"
          action="rename"
          initial={renameInitial(dialog.arg)}
          onPick={(path) => void commands.run("note.rename", { from: dialog.arg, path })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "delete" && (
        <Confirm
          title={`Delete “${dialog.arg.slice(dialog.arg.lastIndexOf("/") + 1).replace(/\.md$/, "")}”?`}
          message="It moves to the .trash folder in this vault, where you can get it back. Links to it stay as they are."
          action="Move to trash"
          danger
          onConfirm={() => {
            closeDialog();
            void commands.run("note.delete", { path: dialog.arg, confirmed: true });
          }}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "newFolder" && (
        <Palette
          label="New folder: name or Folder/Name"
          action="create"
          initial={dialog.arg && dialog.arg + "/"}
          onPick={(path) => void commands.run("folder.new", { path })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "renameFolder" && (
        <Palette
          label="Rename folder: new name or Folder/Name"
          action="rename"
          initial={dialog.arg}
          onPick={(path) => void commands.run("folder.rename", { from: dialog.arg, path })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "move" && (
        <Palette
          label={`Move “${dialog.arg.slice(dialog.arg.lastIndexOf("/") + 1).replace(/\.md$/, "")}” to a folder`}
          action="move here"
          items={["", ...folders]
            .filter((to) => canMove(dialog.arg, to))
            .map((to) => ({ id: to, title: to || "/", hint: to ? undefined : "Vault root" }))}
          onPick={(to) => void commands.run("file.move", { from: dialog.arg, to })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "deleteFolder" &&
        (() => {
          const inside = notes.filter((p) => p.startsWith(dialog.arg + "/"));
          const count = inside.filter((p) => /\.md$/i.test(p)).length;
          const other = inside.length - count;
          const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
          return (
            <Confirm
              title={`Delete the folder “${dialog.arg.slice(dialog.arg.lastIndexOf("/") + 1)}”?`}
              message={`The folder moves to the .trash folder in this vault with everything in it: ${plural(count, "note")}${other ? ` and ${plural(other, "other file")}` : ""}. You can get it back from there. Links to its notes stay as they are.`}
              action="Move to trash"
              danger
              onConfirm={() => {
                closeDialog();
                void commands.run("folder.delete", { path: dialog.arg, confirmed: true });
              }}
              onCancel={closeDialog}
            />
          );
        })()}
      <UpdateNotice updates={updates} />
      {asking && (
        <Confirm
          title={asking.title}
          message={asking.message}
          action="Discard changes"
          danger
          onConfirm={() => asking.answer(true)}
          onCancel={() => asking.answer(false)}
        />
      )}
      {dialog?.kind === "settings" && (
        <Settings
          config={vault && config}
          app={appSettings}
          vaultRoot={vault?.root ?? null}
          section={settingsSection}
          onSection={setSettingsSection}
          onClose={closeDialog}
        />
      )}
    </>
  );

  if (!vault) {
    return (
      <div className="app">
        <Ribbon extra={[]} hasVault={false} />
        <Welcome error={error} />
        {dialogs}
      </div>
    );
  }

  const fileTree = (
    <FileTree
      entries={tree}
      activePath={activeTab.path}
      expanded={expanded}
      menuPath={treeMenu?.entry.path ?? null}
      onToggle={(path) =>
        setExpanded((open) => {
          const next = new Set(open);
          if (!next.delete(path)) next.add(path);
          return next;
        })
      }
      onOpen={(path, newTab) => void openNote(path, undefined, newTab)}
      onMenu={(entry, x, y) => setTreeMenu({ entry, at: { x, y } })}
      onMove={(from, to) => void commands.run("file.move", { from, to })}
      onRename={(path, folder) => void commands.run(folder ? "folder.rename" : "note.rename", { from: path })}
    />
  );
  /** The folder a new note made from this tree entry goes in: the folder itself, or the one the file is in. */
  const folderOf = (entry: Entry) => (entry.children ? entry.path : entry.path.slice(0, Math.max(entry.path.lastIndexOf("/"), 0)));

  return (
    <div className="app" style={{ "--sidebar-width": `${sidebarWidth}px`, "--right-sidebar-width": `${outlineWidth}px` } as React.CSSProperties}>
      <Ribbon extra={modules.ribbon()} hasVault />
      {sidebarOpen && (
        <aside className="sidebar">
          <header className="sidebar-header">
            <span className="sidebar-title" title={vault.root}>
              {vault.name}
            </span>
            <SidebarActions />
          </header>
          <div className="sidebar-body">
            {searching ? (
              <Search refresh={changes} onOpen={openNote} onClose={() => setSearching(false)}>
                {fileTree}
              </Search>
            ) : (
              fileTree
            )}
          </div>
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={resizeSidebar(sidebarWidth, 1, setSidebarWidth, SIDEBAR_WIDTH_KEY)}
          />
        </aside>
      )}
      {/* The panes with their tabs, then the right sidebar (components/Workspace.tsx). */}
      {switching ? (
        <main className="workspace" />
      ) : (
      <Panes
        key={opened}
        workspace={workspace}
        disk={disk}
        noText={noText}
        issues={issues}
        counts={counts}
        vaultRoot={vault.root}
        modeDefault={modeDefault}
        jump={jump}
        changes={changes}
        moduleVersion={moduleVersion}
        error={error}
        outlineOpen={outlineOpen && !sidePanel}
        host={host}
        onResize={(column, sizes) => apply((w) => W.resize(w, column, sizes))}
      />
      )}
      {sidePanel ? (
        <SidePanel
          title={sidePanel.title}
          onClose={() => modules.togglePanel(sidePanel.id, false)}
          onResize={resizeSidebar(outlineWidth, -1, setOutlineWidth, OUTLINE_WIDTH_KEY)}
        >
          {/* Also the note under a module's view: a view shown beside a note (a comparison) is about that note. */}
          <sidePanel.component path={activeTab.path} refresh={changes} />
        </SidePanel>
      ) : outlineOpen && (
        <Outline
          headings={outline.headings}
          current={outline.current}
          onPick={(line) => editors.current.get(W.tab(ws.current).id)?.handle.reveal(line)}
          onClose={() => void commands.run("outline.toggle")}
          onResize={resizeSidebar(outlineWidth, -1, setOutlineWidth, OUTLINE_WIDTH_KEY)}
        />
      )}
      {treeMenu && (
        <Menu
          label={treeMenu.entry.path}
          at={treeMenu.at}
          onClose={() => setTreeMenu(null)}
          items={[
            {
              label: "New note here",
              icon: FilePlus,
              onPick: () => void commands.run("note.new", { folder: folderOf(treeMenu.entry) }),
            },
            {
              label: "New folder…",
              icon: FolderPlus,
              onPick: () => void commands.run("folder.new", { folder: folderOf(treeMenu.entry) }),
            },
            "separator",
            ...(treeMenu.entry.children ? folderActions(treeMenu.entry.path) : fileActions(treeMenu.entry.path)),
          ]}
        />
      )}
      {dialogs}
    </div>
  );
}
