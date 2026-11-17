// The command registry. Every action in the app is a command, and the palette,
// the keyboard shortcuts and (later) menus and MCP all run commands from here.

export interface Command {
  /** Stable id, `area.action`, e.g. `note.save`. */
  id: string;
  /** Shown in the palette. */
  title: string;
  /** Default shortcut, e.g. `Mod+Shift+P`. `Mod` is Cmd on macOS and Ctrl elsewhere. */
  key?: string;
  /**
   * True for a command no key ever runs, whatever keys.json says: a key bound by something else than the user
   * (the file is the vault's, and `key.set` runs over MCP) would make the user's next press of it run the command.
   */
  noKey?: boolean;
  run(params?: unknown): void | Promise<void>;
}

class Registry {
  private byId = new Map<string, Command>();

  /** Called when a command throws. The app sets this to show the error. */
  onError: (error: unknown) => void = console.error;

  /**
   * The vault's keys.json: command id to the key that replaces its default, or null for no key. A key in it
   * that is not `bindable` is not in force, and the command keeps its default.
   */
  keys: Record<string, string | null> = {};

  /** While set, the next key press goes here as a key string and runs no command. The settings screen records a key with it. */
  capture: ((key: string) => void) | null = null;

  /** Adds commands and returns a function that removes them again. */
  register(commands: Command[]): () => void {
    for (const c of commands) this.byId.set(c.id, c);
    return () => {
      for (const c of commands) if (this.byId.get(c.id) === c) this.byId.delete(c.id);
    };
  }

  /** The commands, each with the key in force: its default, or what `keys` says. */
  list(): Command[] {
    const set = (id: string) => id in this.keys && (this.keys[id] === null || bindable(this.keys[id]));
    return [...this.byId.values()].map((c) => (set(c.id) ? { ...c, key: this.keys[c.id] ?? undefined } : c));
  }

  /** Runs a command and throws if the id is unknown or the command fails. For callers that report the error themselves. */
  async execute(id: string, params?: unknown): Promise<void> {
    const command = this.byId.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    await command.run(params);
  }

  /** Runs a command for the user: a failure goes to `onError` and is not thrown. */
  async run(id: string, params?: unknown): Promise<void> {
    try {
      await this.execute(id, params);
    } catch (error) {
      this.onError(error);
    }
  }

  /** Runs the command bound to this key press, if any. Returns whether one ran. */
  handleKey(event: KeyboardEvent): boolean {
    const key = keyOf(event);
    if (this.capture) {
      event.preventDefault();
      event.stopPropagation();
      // A modifier on its own is the start of a combination, not the key.
      if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) this.capture(key);
      return true;
    }
    const command = this.list().find((c) => c.key === key && !c.noKey);
    if (!command) return false;
    event.preventDefault();
    // The key is the command's alone: the editor under the focus must not also act on it (Ctrl+T swaps letters there).
    event.stopPropagation();
    this.byKey = { id: command.id, at: performance.now() };
    void this.run(command.id);
    return true;
  }

  /** The command the last key press ran, and when. */
  private byKey = { id: "", at: 0 };

  /**
   * Runs a command picked in the app's menu bar. A key that is in the menu goes to the window first and to the
   * menu only when the window did not take it; should the system hand it to both, the command still runs once.
   */
  fromMenu(id: string): void {
    if (id === this.byKey.id && performance.now() - this.byKey.at < 300) return;
    void this.run(id);
  }
}

export const commands = new Registry();

/** The shortcut string for a key press, in the same form as `Command.key`. */
export function keyOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join("+");
}

/**
 * Whether keys.json may give this key to a command: only with `Mod` (Cmd or Ctrl) or `Alt` in it, or a function
 * key (`F1` to `F24`, also with Shift). The file is the vault's, and a vault from someone else must not be able to
 * make a letter, Enter or Escape run a command while the user types. The defaults in the code are not held to this.
 */
export function bindable(key: string): boolean {
  const parts = key.split("+");
  return parts.slice(0, -1).some((part) => part === "Mod" || part === "Alt") || /^F([1-9]|1\d|2[0-4])$/.test(parts[parts.length - 1]);
}

const isMac = () => navigator.platform.startsWith("Mac");

/** How a key name is shown, where its name is not what is printed on the key. */
const KEY_NAMES: Record<string, string> = {
  Shift: "⇧",
  Alt: "⌥",
  Enter: "↵",
  Escape: "esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  " ": "space",
};

/** `Mod+Shift+P` as the keys to show, one each: `["⌘", "⇧", "P"]` on macOS. */
export function keyParts(key: string): string[] {
  // A key that is itself "+" comes last, as an empty part after the separator.
  const parts = key.endsWith("++") || key === "+" ? [...key.slice(0, -1).split("+").filter(Boolean), "+"] : key.split("+");
  return parts.map((p) => (p === "Mod" ? (isMac() ? "⌘" : "Ctrl") : (KEY_NAMES[p] ?? p)));
}

/** `Mod+Shift+P` as shown to the user in running text: `⌘⇧P` on macOS. */
export function keyLabel(key: string): string {
  return keyParts(key).join(isMac() ? "" : "+");
}
