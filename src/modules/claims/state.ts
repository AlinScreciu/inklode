// What the claims module knows while it is on, for its panel, the marks in the editor and its commands: the
// claims as the core lists them, which one is being checked, what the last check of each said when it could
// not run, and whether the vault may run commands. Also the one rule that makes a check the user's own act.

import { commands } from "../../commands";
import { appSettingsGet } from "../../core/client";
import type { AppApi } from "../../modules";
import { polled } from "../polled";
import { type Claim, keyOf, pending } from "./claims";

/** Calls into the Rust core, and opens a note at a line. Set when the module is switched on. */
export const app: { call: AppApi["core"]["call"]; openNote: AppApi["notes"]["open"] } = {
  call: () => Promise.reject(new Error("The claims module is off")),
  openNote: () => {},
};

/** Every claim of the vault, by path and line. Only read here: the core runs nothing for this. */
export const claims = polled<Claim[]>([], () => app.call<Claim[]>("claims.list"));

export const state = {
  /** Whether the panel is on screen, said by Panel.tsx. */
  open: false,
  /** Whether the open vault may run commands (the app's setting, enforced by the core). */
  trusted: false,
  /** The claim being checked, as `path:line`, or null. One check runs at a time. */
  checking: null as string | null,
  /** Whether "Check all" is going through the queue, and whether it was told to stop. */
  all: false,
  stopping: false,
  /** By `path:line`: why the last check of a claim did not run. */
  errors: new Map<string, string>(),
};

// For React's `useSyncExternalStore` and the editor's marks: `version` changes when `state` changed.
const listeners = new Set<() => void>();
let version = 0;
export const live = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  version: () => version,
};
function changed() {
  version++;
  listeners.forEach((listener) => listener());
}

export function setOpen(open: boolean) {
  state.open = open;
}

/** Reads from the app's settings whether the open vault may run commands. */
export async function readTrust() {
  const trusted = (await appSettingsGet()).claims.trusted;
  if (trusted === state.trusted) return;
  state.trusted = trusted;
  // What was refused may run now, and the other way round.
  state.errors.clear();
  changed();
}

// Checks run on the user's own click or key press in the app, never on a timer and never for a script. The
// app's MCP tools `ui_click` and `ui_key` dispatch events from a script, which the browser marks as not
// trusted (`isTrusted` false), and MCP `command_run` refuses the ids of these commands (src-tauri/src/mcp.rs).
export const NOTICE = "Checks are run by the user in the app";

/** The last key or mouse event the window got: whether the system made it, and when. */
let input = { trusted: false, at: 0 };
const INPUT = ["keydown", "pointerdown", "mousedown", "click"] as const;
const seen = (event: Event) => {
  input = { trusted: event.isTrusted, at: performance.now() };
};

/** Starts and stops watching the window's input, for `byUser`. */
export function watchInput(on: boolean) {
  for (const type of INPUT) {
    if (on) window.addEventListener(type, seen, true);
    else window.removeEventListener(type, seen, true);
  }
}

/**
 * Throws unless a real key press or click by the user is what runs this now: the last input event of the
 * window was the system's and is under a second old. A command picked in the palette gets here from the
 * user's Enter or click; a script's event in between makes the last one a script's.
 */
// shortcut: a second is the time a command may take to get here from its click (the palette closes first);
// pass the event through `commands.run` if a script is ever found to slip into that second
export function byUser() {
  if (!input.trusted || performance.now() - input.at > 1000) throw new Error(NOTICE);
}

/**
 * Runs one of the module's commands from a button, for the click `event` when the user made it. The command
 * asks `byUser` again; here the click itself is asked.
 */
export function runByUser(event: { isTrusted: boolean }, id: string, params?: unknown) {
  if (!event.isTrusted) return commands.onError(new Error(NOTICE));
  void commands.run(id, params);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the evidence of a listed claim (the core's `claims.check`) and reads the list again. If the check
 * could not run, the reason is kept for the claim's row and thrown.
 */
export async function check(clicked: Claim) {
  if (state.checking) throw new Error("A check is running. It has to finish first.");
  // Set before the first wait, so a second click cannot start a second check.
  state.checking = keyOf(clicked);
  state.errors.delete(keyOf(clicked));
  changed();
  let key = keyOf(clicked);
  try {
    // What was typed and still waits goes to disk first: the core reads the claim from the file.
    await commands.execute("note.save");
    await claims.refresh();
    // Lines typed above the claim and saved just now moved it: it is the claim with that text and evidence.
    const same = claims.get().filter((c) => c.path === clicked.path && c.evidence === clicked.evidence && c.text === clicked.text);
    const claim = same.find((c) => c.line === clicked.line) ?? (same.length === 1 ? same[0] : null);
    if (!claim) throw new Error(`${clicked.path} changed since its claims were listed. The list is read again.`);
    key = keyOf(claim);
    if (key !== state.checking) {
      state.checking = key;
      changed();
    }
    await app.call<Claim>("claims.check", { path: claim.path, line: claim.line });
  } catch (e) {
    state.errors.set(key, message(e));
    throw e;
  } finally {
    state.checking = null;
    changed();
    await claims.refresh().catch(() => {});
  }
}

/** Checks every claim that is not passing, one after another in the queue's order, until done or `stopAll`. */
export async function checkAll() {
  if (state.all || state.checking) throw new Error("A check is running. It has to finish first.");
  state.all = true;
  state.stopping = false;
  changed();
  try {
    await claims.refresh();
    for (const claim of pending(claims.get())) {
      if (state.stopping) break;
      // A claim that could not be checked says so in its row, and the next one is checked.
      await check(claim).catch(() => {});
    }
  } finally {
    state.all = false;
    state.stopping = false;
    changed();
  }
}

/** Ends "Check all" after the check that is running. */
// shortcut: the running check is not ended, since the core has no way to end a command it started; add a
// `claims.cancel` to the core if a command that hangs has to be stopped from here
export function stopAll() {
  if (!state.all) return;
  state.stopping = true;
  changed();
}

/** Forgets what belonged to the module being on. */
export function reset() {
  state.checking = null;
  state.all = false;
  state.stopping = false;
  state.errors.clear();
  changed();
}
