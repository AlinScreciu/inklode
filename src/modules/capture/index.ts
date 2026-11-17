// The capture module: quick capture from a global hotkey. With Inklode running, also in the background, the
// hotkey brings up a small box; Enter appends its text to the vault's capture note as one list item and the
// box goes away, Escape gives up. "Quick capture" (`capture.open`, the ribbon button) opens the same box.
//
// The hotkey and the box's window are the shell's (src-tauri/src/capture.rs). The hotkey is an app-level
// setting, not the vault's, and so is whether this module is on for a vault (`toggleModule` in src/config.ts):
// the hotkey is registered only while it is. The box (Box.tsx) only hands
// its text over; the appending is here, in the main window, because only here is it known whether the
// capture note is open with text that is not on disk yet:
// - open in an editor: the item is an edit at the end of the editor's text, like a typed one (Undo takes it
//   back), and it is saved the way every edit is, so what was typed there and not saved yet stays;
// - not open: the note is read and written with the text that was read as `base`, which the core refuses if
//   the file changed meanwhile; then it is read again.
//
// This file, append.ts and ../editors.ts load when the module is switched on, Box.tsx in the box's own window.

import { isolateHistory } from "@codemirror/commands";
import { PenLine } from "lucide-react";
import { commands } from "../../commands";
import { SETTINGS_FILE } from "../../config";
import { appSettingsGet, appSettingsSet, captureEnable, onAppSettingsChanged, onCaptured, openCaptureWindow, type AppSettings } from "../../core/client";
import type { AppApi } from "../../modules";
import { extension, viewFor } from "../editors";
import { addition, captureNote } from "./append";

/** How often a write is tried when the note keeps changing on disk between the read and the write. */
const TRIES = 5;

/** Calls into the Rust core. Set when the module is switched on. */
let call: AppApi["core"]["call"];
/** Captures appended since the module was switched on, and the note the last one went to. */
let count = 0;
let last: string | null = null;
/** The hotkey and whether it is registered, as the shell last said. Null until it did. */
let hotkey: Pick<AppSettings, "capture" | "captureStatus"> | null = null;
/** Ends what `activate` subscribed to. */
let stop: (() => void)[] = [];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Appends one capture to the capture note. Does nothing for a text of white space only. */
async function append(text: string) {
  if (addition("", text) === null) return;
  const settings = await call<{ content: string }>("config.read", { path: SETTINGS_FILE }).then((file) => file.content, () => null);
  const path = captureNote(settings);
  // What was typed and still waits goes to disk first, so no write of it lands after this one.
  await commands.execute("note.save");
  const view = viewFor(path);
  if (view) {
    // An edit like any typed one, in one undo step: the editor reports it, and the app saves it as it saves typing.
    const now = view.state.doc.toString();
    view.dispatch({ changes: { from: now.length, insert: addition(now, text)! }, annotations: isolateHistory.of("full") });
    await commands.execute("note.save");
  } else {
    for (let tries = 1; ; tries++) {
      const file = await call<{ content: string }>("note.read", { path }).then(
        (note) => note.content,
        (e) => {
          // A note that is not there yet is made by the write: the core takes a missing file as empty.
          if (/no such file|not found|os error 2\b/i.test(message(e))) return "";
          throw e;
        },
      );
      try {
        await call("note.write", { path, content: file + addition(file, text)!, base: file });
        break;
      } catch (e) {
        // Another program wrote the note between the read and the write: nothing was written, so again.
        if (tries >= TRIES || !message(e).includes("changed on disk since it was read")) throw e;
      }
    }
  }
  count++;
  last = path;
}

// One capture at a time, in the order they were made: each is added to the text the one before it left.
let queue: Promise<void> = Promise.resolve();
function capture(text: string): Promise<void> {
  const run = queue.then(() => append(text));
  queue = run.catch(() => {});
  return run;
}

async function readHotkey() {
  const { capture, captureStatus } = await appSettingsGet();
  hotkey = { capture, captureStatus };
}

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export async function activate(app: AppApi) {
  call = app.core.call;
  count = 0;
  last = null;
  app.editor.registerExtension(extension);
  app.ui.registerRibbon({ id: "capture", title: "Quick capture", icon: PenLine, command: "capture.open" });
  stop = [
    // The box is gone by now, so a capture that could not be written is said in the main window, with its
    // text: that is the only copy.
    onCaptured((text) => void capture(text).catch((e) => commands.onError(new Error(`Not captured (${message(e)}): ${text}`)))),
    onAppSettingsChanged(() => void readHotkey().catch(() => {})),
  ];
  // Registers the hotkey. If the system refuses it, the settings screen and `ui_state` say why.
  await captureEnable(true);
  await readHotkey();

  // `capture` in `ui_state`. `hotkey`: the global hotkey, as in the app's settings. `registered`: whether the
  // system has it registered for Inklode now. `error`: why not, or null. `count`: the captures appended since
  // the module was switched on. `last`: the path of the note the last one went to, null before the first.
  app.ui.registerState(() => ({
    capture: { hotkey: hotkey?.capture.hotkey ?? null, registered: hotkey?.captureStatus.registered ?? false, error: hotkey?.captureStatus.error ?? null, count, last },
  }));

  app.commands.register({
    id: "capture.open",
    title: "Quick capture",
    // Shows the capture box. `{text}`: appends that text to the capture note without the box.
    run: (params) => {
      const { text } = param(params);
      if (text === undefined) return openCaptureWindow();
      if (typeof text !== "string") throw new Error("text must be text");
      return capture(text);
    },
  });
  app.commands.register({
    id: "capture.hotkey",
    title: "Set capture hotkey…",
    // `{key}`: the global hotkey, as modifiers and one key, e.g. "Ctrl+Alt+Space" or "Cmd+Shift+K". It is
    // saved in the app's settings, not the vault's. Fails if it is not a key combination or the system does
    // not register it: it is saved all the same, no hotkey is registered, and the settings screen shows why.
    run: async (params) => {
      const { key } = param(params);
      if (params == null) return commands.execute("settings.open", { section: "modules" });
      if (typeof key !== "string") throw new Error("key must be text, e.g. Ctrl+Alt+Space");
      const { mcp } = await appSettingsGet();
      const { capture, captureStatus } = await appSettingsSet({ mcp, capture: { hotkey: key } });
      hotkey = { capture, captureStatus };
      if (captureStatus.error) throw new Error(captureStatus.error);
    },
  });
}

export function deactivate() {
  stop.forEach((end) => end());
  stop = [];
  hotkey = null;
  // The hotkey is the open vault's only while it has the module on.
  void captureEnable(false).catch(commands.onError);
}
