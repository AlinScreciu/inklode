// The chrome around the notes: the ribbon, a pane's header and status bar, and the two screens with no note.
// None of them keeps app state. Each button runs a command from the registry, so it does what the palette,
// the keys and MCP do. `PaneHeader` and `StatusBar` describe one pane, by props, so there can be several.

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronsDownUp,
  CodeXml,
  Columns2,
  Command,
  Copy,
  Ellipsis,
  FileSearch,
  FolderInput,
  FolderSearch,
  Hexagon,
  PanelLeft,
  PanelRight,
  Pencil,
  Rows2,
  Search,
  Settings as Gear,
  SquarePen,
  SquarePlus,
  Trash2,
  Vault,
  Waypoints,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { commands, keyLabel } from "../commands";
import { call } from "../core/client";
import type { RibbonButton } from "../modules";
import { below, Keys, Menu, type Icon, type MenuAt, type MenuItem } from "./Menu";

/** The key in force for a command, or undefined if it has none or is not registered. */
const keyOfCommand = (id: string) => commands.list().find((c) => c.id === id)?.key;

interface CommandButtonProps {
  /** The command a click runs. */
  command: string;
  /** The tooltip and accessible name. The command's key is added to the tooltip. */
  title: string;
  icon: Icon;
  /** Which side the tooltip opens on. "end" is below, lined up with the button's right edge. */
  tip?: "right" | "below" | "end";
  /** For a button that shows a state, e.g. source mode on. */
  pressed?: boolean;
  disabled?: boolean;
  params?: unknown;
  /** Drawn over the button's corner, e.g. a module's count (`RibbonButton.badge`). */
  children?: ReactNode;
}

/** An icon button that runs a command. */
export function CommandButton({ command, title, icon: IconOf, tip = "below", pressed, disabled, params, children }: CommandButtonProps) {
  const key = keyOfCommand(command);
  return (
    <button
      className={"icon-button tip-" + tip}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      data-command={command}
      data-tip={key ? `${title}  ${keyLabel(key)}` : title}
      onClick={() => void commands.run(command, params)}
    >
      <IconOf size={16} />
      {children}
    </button>
  );
}

/**
 * The icon rail at the window's left edge. `extra` are the buttons of the modules that are on; one with
 * `pressed` is for a panel of the right sidebar and shows whether that panel is on screen.
 */
export function Ribbon({ extra, hasVault }: { extra: (RibbonButton & { pressed?: boolean })[]; hasVault: boolean }) {
  return (
    <nav className="ribbon" aria-label="Ribbon">
      {hasVault && (
        <>
          <CommandButton tip="right" command="sidebar.toggle" title="Toggle sidebar" icon={PanelLeft} />
          <CommandButton tip="right" command="note.switch" title="Open note" icon={FileSearch} />
          <CommandButton tip="right" command="search.open" title="Search in all notes" icon={Search} />
          <CommandButton tip="right" command="note.new" title="New note" icon={SquarePen} />
          <CommandButton tip="right" command="palette.open" title="Command palette" icon={Command} />
          {extra.map((b) => (
            <CommandButton key={b.id} tip="right" command={b.command} title={b.title} icon={b.icon} pressed={b.pressed}>
              {b.badge && <b.badge />}
            </CommandButton>
          ))}
        </>
      )}
      <span className="ribbon-space" />
      <CommandButton tip="right" command="vault.open" title="Open another vault" icon={Vault} />
      <CommandButton tip="right" command="settings.open" title="Settings" icon={Gear} />
    </nav>
  );
}

/** The buttons in the sidebar's header. */
export function SidebarActions() {
  return (
    <div className="sidebar-actions">
      <CommandButton command="note.new" title="New note" icon={SquarePen} />
      <CommandButton command="tree.collapse" title="Collapse all folders" icon={ChevronsDownUp} />
      <CommandButton tip="end" command="search.open" title="Search in all notes" icon={Search} />
    </div>
  );
}

/** What can be done to the file at `path`: the items shared by the tree's context menu and a pane's "more" menu. */
export function fileActions(path: string): (MenuItem | "separator")[] {
  const run = (id: string) => () => void commands.run(id, { from: path, path });
  return [
    { label: "Open in new tab", icon: SquarePlus, onPick: () => void commands.run("tab.open", { path }) },
    "separator",
    { label: "Rename…", icon: Pencil, onPick: () => void commands.run("note.rename", { from: path }) },
    { label: "Move to…", icon: FolderInput, onPick: () => void commands.run("file.move", { from: path }) },
    { label: "Reveal in Finder", icon: FolderSearch, onPick: run("note.reveal") },
    { label: "Copy path", icon: Copy, onPick: run("note.copyPath") },
    "separator",
    { label: "Delete", icon: Trash2, danger: true, onPick: run("note.delete") },
  ];
}

/** The same for the folder at `path`, in the tree's context menu. */
export function folderActions(path: string): (MenuItem | "separator")[] {
  const run = (id: string, params: unknown) => () => void commands.run(id, params);
  return [
    { label: "Rename…", icon: Pencil, onPick: run("folder.rename", { from: path }) },
    { label: "Move to…", icon: FolderInput, onPick: run("file.move", { from: path }) },
    { label: "Reveal in Finder", icon: FolderSearch, onPick: run("note.reveal", { path }) },
    { label: "Copy path", icon: Copy, onPick: run("note.copyPath", { path }) },
    "separator",
    { label: "Delete", icon: Trash2, danger: true, onPick: run("folder.delete", { path }) },
  ];
}

interface PaneHeaderProps {
  /** The file the pane shows, or null when it shows something else. */
  path: string | null;
  /** What the pane shows when that is not a file, e.g. "Graph view". */
  title?: string;
  canBack: boolean;
  canForward: boolean;
  /** The editor's mode, or null when the pane does not show the Markdown editor. */
  mode: "source" | "live-preview" | null;
  /** Whether there are other panes, so this one can be closed. */
  canClose: boolean;
  /** Whether the outline is on screen in the right sidebar. Left out, the header has no button for it. */
  outline?: boolean;
}

/** What splits and closes the active pane: for the "more" menu of a pane and the menu of a tab, which make theirs active first. */
export function paneActions(canClose: boolean, params?: unknown): (MenuItem | "separator")[] {
  const item = (id: string, label: string, icon: Icon): MenuItem => ({ label, icon, onPick: () => void commands.run(id, params) });
  return [
    item("pane.splitRight", "Split right", Columns2),
    item("pane.splitDown", "Split down", Rows2),
    ...(canClose ? [item("pane.close", "Close pane", X)] : []),
  ];
}

/** The bar over a pane: Back and Forward, where the note is, the mode switch and the "more" menu. */
export function PaneHeader({ path, title, canBack, canForward, mode, canClose, outline }: PaneHeaderProps) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // A drawing is named as in the file tree, without `.excalidraw`.
  const parts = path?.replace(/(\.excalidraw)?\.md$/i, "").split("/") ?? [];
  const name = parts.pop();
  const graph = commands.list().find((c) => c.id === "graph.open");
  return (
    <header className="pane-header">
      <div className="pane-nav">
        <CommandButton command="nav.back" title="Back" icon={ArrowLeft} disabled={!canBack} />
        <CommandButton command="nav.forward" title="Forward" icon={ArrowRight} disabled={!canForward} />
      </div>
      {/* `pane-title` is the older name of this element, kept for snippets. */}
      <div className="pane-title breadcrumb" title={path ?? undefined}>
        {parts.map((folder, i) => (
          <span key={i} className="breadcrumb-folder">
            {folder}
            <span className="breadcrumb-slash">/</span>
          </span>
        ))}
        <span className="breadcrumb-name">{name ?? title}</span>
      </div>
      <div className="pane-actions">
        {mode && (
          <CommandButton
            command="editor.toggleSource"
            title={mode === "source" ? "Source mode: switch to Live Preview" : "Live Preview: switch to source mode"}
            icon={mode === "source" ? CodeXml : BookOpen}
            pressed={mode === "source"}
          />
        )}
        {path && (
          <button
            className="icon-button tip-end"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            data-tip="More"
            onClick={(e) => setMenu(below(e.currentTarget, true))}
          >
            <Ellipsis size={16} />
          </button>
        )}
        {outline !== undefined && (
          <CommandButton tip="end" command="outline.toggle" title="Toggle outline" icon={PanelRight} pressed={outline} />
        )}
      </div>
      {menu && path && (
        <Menu
          label={`More for ${name}`}
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            ...paneActions(canClose),
            "separator",
            ...(graph
              ? [{ label: graph.title, icon: Waypoints, shortcut: graph.key, onPick: () => void commands.run("graph.open") }, "separator" as const]
              : []),
            ...fileActions(path),
          ]}
        />
      )}
    </header>
  );
}

/** Words and characters of a text, as the status bar shows them. */
// shortcut: counts the Markdown as typed, markup and frontmatter included; count the rendered text if the numbers must match a word processor
export function countText(text: string) {
  return { words: text.trim() ? text.trim().split(/\s+/).length : 0, characters: text.length };
}

interface StatusBarProps {
  path: string;
  /** Changes when files in the vault changed, so the backlink count is read again. */
  refresh: number;
  /** Null when the pane does not show text, e.g. a drawing. */
  counts: { words: number; characters: number } | null;
  mode: "source" | "live-preview" | null;
}

/** The quiet line under a pane: backlinks, words, characters and the editor's mode. */
export function StatusBar({ path, refresh, counts, mode }: StatusBarProps) {
  const [backlinks, setBacklinks] = useState<number | null>(null);
  useEffect(() => {
    let stale = false;
    call<unknown[]>("note.backlinks", { path }).then(
      (hits) => stale || setBacklinks(hits.length),
      () => stale || setBacklinks(null),
    );
    return () => {
      stale = true;
    };
  }, [path, refresh]);

  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  return (
    <footer className="status-bar">
      {backlinks !== null && (
        <button className="status-backlinks" title="Show or hide backlinks" disabled={backlinks === 0} onClick={() => void commands.run("backlinks.toggle")}>
          {plural(backlinks, "backlink")}
        </button>
      )}
      {counts && <span className="status-words">{plural(counts.words, "word")}</span>}
      {counts && <span className="status-characters">{plural(counts.characters, "character")}</span>}
      {mode && <span className="status-mode">{mode === "source" ? "Source" : "Live Preview"}</span>}
    </footer>
  );
}

/** A row of the start lists: what a command does, and its key. A click runs it. */
function Start({ command, icon: IconOf, children }: { command: string; icon: Icon; children: ReactNode }) {
  const key = keyOfCommand(command);
  return (
    <button className="start-item" onClick={() => void commands.run(command)}>
      <IconOf size={16} />
      <span>{children}</span>
      {key && <Keys k={key} />}
    </button>
  );
}

/** The pane with no note open. */
export function EmptyPane() {
  return (
    <div className="empty">
      <Hexagon className="empty-mark" size={40} strokeWidth={1.25} aria-hidden />
      <p className="empty-title">No note is open</p>
      <div className="start-list">
        <Start command="note.switch" icon={FileSearch}>
          Open a note
        </Start>
        <Start command="note.new" icon={SquarePen}>
          New note
        </Start>
        <Start command="search.open" icon={Search}>
          Search in all notes
        </Start>
        <Start command="palette.open" icon={Command}>
          Command palette
        </Start>
      </div>
    </div>
  );
}

/** The window with no vault open. */
export function Welcome({ error }: { error: string | null }) {
  return (
    <main className="welcome">
      <Hexagon className="welcome-mark" size={56} strokeWidth={1.25} aria-hidden />
      <h1>Inklode</h1>
      <p>Markdown notes in a folder you own.</p>
      <button className="button" onClick={() => void commands.run("vault.open")}>
        Open vault…
      </button>
      <p className="welcome-hint">A vault is any folder of Markdown files. Inklode adds a .inklode folder to it for settings.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
