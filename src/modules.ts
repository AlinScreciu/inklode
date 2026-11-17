// Feature modules. A module adds commands, a view for a file type and embed renderers through
// `AppApi`, and can be switched off: `"modules": {"excalidraw": false}` in `.inklode/settings.json`
// (src/config.ts). The base app (editor, tree, links, search, palette, settings) is not a module.
//
// `AppApi` has the registration points that some module uses. Add one when a module needs it.

import { Facet, type Extension } from "@codemirror/state";
import type { ComponentType, Ref } from "react";
import { commands, type Command } from "./commands";
import { call } from "./core/client";

export interface Module {
  /** Stable id, the key in settings.json: `excalidraw`. */
  id: string;
  /** Shown in the settings screen. */
  title: string;
  /** Whether it is on in a vault whose settings do not mention it. */
  defaultEnabled: boolean;
  activate(app: AppApi): void | Promise<void>;
  /** For cleanup beyond what was registered through `AppApi`, which is removed by the registry. */
  deactivate?(): void;
}

export interface AppApi {
  commands: { register(command: Command): void };
  /**
   * A pane type that fills the main area in place of the Markdown editor. `register` adds one. It shows a file
   * when `files.registerExtension` maps files to it. `show` puts it up with no file of its own (the graph):
   * it then gets the path of the note it covers as `path`, or "" with none open, and "" as `content`,
   * and it stays until a note is opened. With `beside` it shows in a pane of its own next to the active pane,
   * which stays the active one, so the view can be about the note there. `hide` takes it off the screen.
   */
  views: { register(type: string, view: ViewFactory): void; show(type: string, beside?: boolean): void; hide(type: string): void };
  /** Files whose path ends in `ext` (e.g. `.excalidraw.md`) open in the view registered as `viewType`. */
  files: { registerExtension(ext: string, viewType: string): void };
  /**
   * A CodeMirror extension for the Markdown editor, in both of its modes. `livePreviewOn` (src/components/livePreview.ts)
   * says which, and the facet `notePath` which note the editor shows.
   */
  editor: { registerExtension(extension: Extension): void };
  /**
   * `registerState`: `read` gives entries for the MCP tool `ui_state`, e.g. `{table: …}`, each time the tool is called.
   * `registerRibbon`: a button in the icon rail at the window's left edge, which runs a command.
   * `registerPanel`: a panel for the right sidebar. `togglePanel` opens it, in place of the outline, or closes
   * it; `open` says which, and without it the panel flips.
   */
  ui: {
    registerState(read: () => Record<string, unknown>): void;
    registerRibbon(button: RibbonButton): void;
    registerPanel(panel: SidePanel): void;
    togglePanel(id: string, open?: boolean): void;
  };
  /** `![[target]]` in Live Preview is drawn by `render` when the target, with or without `.md`, ends in `ext`. */
  markdown: { registerEmbed(ext: string, render: EmbedRenderer): void };
  /**
   * `onSaved`: `listener` is called after the app wrote a note the user edited, with the text the file had
   * before and the text written. `onChanged`: it is called when files of the vault changed on disk, the app's
   * own writes included, and when another vault was opened. `open`: shows a note in the active tab, as a
   * click on it in the file tree does, at `line` (from 1) when given.
   */
  notes: {
    onSaved(listener: (path: string, before: string, after: string) => void): void;
    onChanged(listener: () => void): void;
    open(path: string, line?: number): void;
  };
  /** Calls into the Rust core. */
  core: { call: typeof call };
}

export interface RibbonButton {
  /** A button with the id of the module's panel (`SidePanel.id`) shows as pressed while that panel is on screen. */
  id: string;
  /** The tooltip and accessible name. The key of `command` is added to it. */
  title: string;
  /** An icon component, e.g. from lucide-react. */
  icon: ComponentType<{ size?: number | string }>;
  /** The id of the command a click runs. */
  command: string;
  /** Drawn on the button's corner, e.g. a count. It draws nothing when there is nothing to say. */
  badge?: ComponentType;
}

export interface SidePanel {
  id: string;
  /** The panel's heading. */
  title: string;
  component: ComponentType<PanelProps>;
}

export interface PanelProps {
  /** The note in the active pane's tab, also while a module's view covers it there, or null when it has none. */
  path: string | null;
  /** A number that changes when files in the vault changed on disk. */
  refresh: number;
}

/** The vault path of the note a Markdown editor shows, for a module's CodeMirror extension: `state.facet(notePath)`. */
export const notePath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

export interface ViewProps {
  ref?: Ref<ViewHandle>;
  path: string;
  /** The file's text on disk. It changes when the file changes on disk and the view has no unsaved edit. */
  content: string;
  /** Reports an edit as the file's new text. The app saves it the way it saves notes. */
  onChange(path: string, content: string): void;
  /** Opens a note in the main area. */
  onOpen(path: string): void;
  /** A number that changes when files in the vault changed on disk. */
  refresh: number;
}

export interface ViewHandle {
  /** What the view shows, merged into the MCP tool `ui_state`. `dirty` is whether an edit is not on disk yet. */
  uiState(dirty: boolean): Record<string, unknown>;
}

export interface ViewFactory {
  component: ComponentType<ViewProps>;
  /** What its tab is called when it shows with no file. Without it, the title of the command `<type>.open`. */
  title?: string;
  /** Throws, saying why, if the view cannot show this text. The file then opens as plain Markdown with that message. */
  check?(content: string): void;
}

/**
 * Of the things a module has on screen (editors, drawings), the one in the active pane, else the only one, else
 * null. A module's commands act on that one. `element` gives where a thing is drawn.
 */
export function inActivePane<T>(items: Iterable<T>, element: (item: T) => Element | null | undefined): T | null {
  const all = [...items];
  // `pane is-active` is the class the active pane has (components/Workspace.tsx), set before a click in it does anything.
  return all.find((item) => element(item)?.closest(".pane.is-active")) ?? (all.length === 1 ? all[0] : null);
}

/** Draws the file at this vault path as an element to show in a note. */
export type EmbedRenderer = (path: string) => Promise<Element>;

/**
 * Every module the app has. `activate` is where a module's code is imported, so a module
 * that is off is never loaded, and its library sits in a chunk of its own.
 */
export const MODULES: Module[] = [
  {
    id: "excalidraw",
    title: "Excalidraw drawings",
    defaultEnabled: true,
    activate: async (app) => (await import("./modules/excalidraw")).activate(app),
  },
  {
    id: "graph",
    title: "Graph view",
    defaultEnabled: true,
    activate: async (app) => (await import("./modules/graph")).activate(app),
  },
  {
    id: "tables",
    title: "Tables",
    defaultEnabled: true,
    activate: async (app) => (await import("./modules/tables")).activate(app),
  },
  {
    id: "history",
    title: "Git history",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/history")).activate(app),
  },
  {
    id: "merge",
    title: "Merge changes made outside",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/merge")).activate(app),
    // Takes its merge function out of the save path again, which is not something `AppApi` registered.
    deactivate: () => void import("./modules/merge").then((merge) => merge.deactivate()),
  },
  {
    id: "review",
    title: "Review changes made by agents",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/review")).activate(app),
  },
  {
    id: "health",
    title: "Vault health: broken links, notes without links, stale notes",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/health")).activate(app),
  },
  {
    id: "tasks",
    title: "Open tasks across the vault",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/tasks")).activate(app),
  },
  {
    id: "capture",
    title: "Quick capture from a global hotkey",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/capture")).activate(app),
    // Unregisters the global hotkey and stops listening to the capture box, neither of which `AppApi` registered.
    deactivate: () => void import("./modules/capture").then((capture) => capture.deactivate()),
  },
  {
    id: "claims",
    title: "Claims: lines that name their evidence, and a queue to check them",
    defaultEnabled: false,
    activate: async (app) => (await import("./modules/claims")).activate(app),
    // Stops watching the window's input and closes a claim's popover, neither of which `AppApi` registered.
    deactivate: () => void import("./modules/claims").then((claims) => claims.deactivate()),
  },
];

/** Which modules are on, given `modules` from settings.json. An entry that is missing or not true/false means the module's default. */
export function moduleFlags(setting: unknown): Record<string, boolean> {
  const flags = (typeof setting === "object" && setting !== null ? setting : {}) as Record<string, unknown>;
  return Object.fromEntries(
    MODULES.map((m) => [m.id, typeof flags[m.id] === "boolean" ? (flags[m.id] as boolean) : m.defaultEnabled]),
  );
}

class Registry {
  /** The modules that are active, each with the function that takes out what it registered. */
  private active = new Map<string, () => void>();
  private views: { type: string; view: ViewFactory }[] = [];
  private extensions: { ext: string; type: string }[] = [];
  private embeds: { ext: string; render: EmbedRenderer }[] = [];
  private editorExtensions: Extension[] = [];
  private uiStates: (() => Record<string, unknown>)[] = [];
  private ribbonButtons: RibbonButton[] = [];
  private panels: SidePanel[] = [];
  /** The id of the panel that is open in the right sidebar. */
  private openPanel: string | null = null;
  private listeners = new Set<() => void>();
  private count = 0;
  /** One `apply` at a time, so two changes in a row end in the state the last one asked for. */
  private queue: Promise<void> = Promise.resolve();

  private savedListeners: ((path: string, before: string, after: string) => void)[] = [];
  private changeListeners: (() => void)[] = [];

  /** Called when a module asks for a view with no file (`AppApi.views.show`). The app sets this to show it. */
  onShow: (type: string, beside?: boolean) => void = () => {};
  /** Called when a module takes such a view off the screen (`AppApi.views.hide`). The app sets this too. */
  onHide: (type: string) => void = () => {};
  /** Called when a module opens a note (`AppApi.notes.open`). The app sets this too. */
  onOpen: (path: string, line?: number) => void = () => {};

  /** The app wrote a note the user edited: tells the modules that asked (`AppApi.notes.onSaved`). */
  saved(path: string, before: string, after: string) {
    for (const listener of [...this.savedListeners]) listener(path, before, after);
  }

  /** Files of the vault changed on disk, or another vault was opened: tells the modules that asked (`AppApi.notes.onChanged`). */
  vaultChanged() {
    for (const listener of [...this.changeListeners]) listener();
  }

  /** Activates and deactivates modules to match `flags` (module id to on or off). Resolves when they do. */
  apply(flags: Record<string, boolean>): Promise<void> {
    const run = this.queue.then(async () => {
      for (const module of MODULES) {
        const stop = this.active.get(module.id);
        if (flags[module.id] && !stop) await this.activate(module);
        else if (!flags[module.id] && stop) stop();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async activate(module: Module) {
    const undo: (() => void)[] = [];
    const add = <T>(list: T[], item: T) => {
      list.push(item);
      undo.push(() => void list.splice(list.indexOf(item), 1));
    };
    const stop = () => {
      module.deactivate?.();
      undo.forEach((remove) => remove());
      this.active.delete(module.id);
      this.changed();
    };
    try {
      await module.activate({
        commands: { register: (command) => void undo.push(commands.register([command])) },
        views: {
          register: (type, view) => add(this.views, { type, view }),
          show: (type, beside) => this.onShow(type, beside),
          hide: (type) => this.onHide(type),
        },
        files: { registerExtension: (ext, type) => add(this.extensions, { ext, type }) },
        editor: { registerExtension: (extension) => add(this.editorExtensions, extension) },
        ui: {
          registerState: (read) => add(this.uiStates, read),
          registerRibbon: (button) => add(this.ribbonButtons, button),
          registerPanel: (panel) => {
            add(this.panels, panel);
            // A module that is switched off takes its panel off the screen, and on again it starts closed.
            undo.push(() => void (this.openPanel === panel.id && (this.openPanel = null)));
          },
          togglePanel: (id, open) => this.togglePanel(id, open),
        },
        markdown: { registerEmbed: (ext, render) => add(this.embeds, { ext, render }) },
        notes: {
          onSaved: (listener) => add(this.savedListeners, listener),
          onChanged: (listener) => add(this.changeListeners, listener),
          open: (path, line) => this.onOpen(path, line),
        },
        core: { call },
      });
    } catch (e) {
      stop();
      throw e;
    }
    this.active.set(module.id, stop);
    this.changed();
  }

  private changed() {
    this.count++;
    this.listeners.forEach((listener) => listener());
  }

  /** For React's `useSyncExternalStore`: called when a module was activated or deactivated. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** A number that changes with every activation and deactivation. */
  version = () => this.count;

  /** The view a module registered for this file, if any. */
  viewFor(path: string): { type: string; view: ViewFactory } | undefined {
    const type = this.extensions.find((e) => path.endsWith(e.ext))?.type;
    return this.views.find((v) => v.type === type);
  }

  /** The view registered as `type`, if the module that has it is on. */
  view(type: string): ViewFactory | undefined {
    return this.views.find((v) => v.type === type)?.view;
  }

  /** The renderer a module registered for `![[target]]`, if any. `target` is the link without `#heading` and `|alias`. */
  embedFor(target: string): EmbedRenderer | undefined {
    const name = target.replace(/\.md$/i, "").toLowerCase();
    return this.embeds.find((e) => name.endsWith(e.ext))?.render;
  }

  /** The CodeMirror extensions of the active modules. The editor takes them again when `version` changes. */
  editorExtension(): Extension {
    return [...this.editorExtensions];
  }

  /**
   * The ribbon buttons of the active modules. The button of a module with a panel (same id) has `pressed`:
   * whether that panel is the one open in the right sidebar.
   */
  ribbon(): (RibbonButton & { pressed?: boolean })[] {
    return this.ribbonButtons.map((b) => (this.panels.some((p) => p.id === b.id) ? { ...b, pressed: this.openPanel === b.id } : b));
  }

  /**
   * Opens a module's panel in the right sidebar or closes it: what `open` says, else the other of the two.
   * A panel that no active module has is not opened.
   */
  togglePanel(id: string, open = this.openPanel !== id) {
    if (open === (this.openPanel === id)) return;
    if (open && !this.panels.some((p) => p.id === id)) return;
    this.openPanel = open ? id : null;
    // Not `changed`: no module came or went, so the notes on screen need no reload.
    this.listeners.forEach((listener) => listener());
  }

  /** For `useSyncExternalStore`, with `subscribe`: the id of the panel that is open in the right sidebar, or null. */
  panelId = () => this.openPanel;

  /** The panel that is open in the right sidebar, if any. */
  panel(): SidePanel | undefined {
    return this.panels.find((p) => p.id === this.openPanel);
  }

  /** What the active modules report for `ui_state`. */
  uiState(): Record<string, unknown> {
    return Object.assign({}, ...this.uiStates.map((read) => read()));
  }
}

export const modules = new Registry();
