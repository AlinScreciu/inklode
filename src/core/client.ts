// The only file that talks to the desktop shell. Everything else in the UI
// calls the functions exported here, so replacing Tauri means replacing this file.
//
// Opened in a plain browser (`pnpm dev`), it uses an in-memory vault instead,
// so the UI can be worked on and checked without the desktop app.

const inTauri = "__TAURI_INTERNALS__" in window;

/**
 * Sent by the core. `vault.changed` lists the vault-relative paths that changed on disk;
 * `config.changed` does the same for paths under `.inklode/`, which `vault.changed` never has.
 */
export interface CoreEvent {
  type: string;
  paths: string[];
}

/** Runs a core operation. The names and params are listed on `Core::call` in crates/core/src/call.rs. */
export async function call<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("core_call", { name, params });
  }
  if (import.meta.env.DEV) {
    const { mockCall } = await import("./mock");
    return mockCall(name, params) as T;
  }
  throw new Error("Inklode core is not available outside the desktop app");
}

/**
 * Subscribes to core events and returns a function that unsubscribes.
 * Outside the desktop app there are no events, except from the dev-only mock vault.
 */
export function onEvent(handler: (event: CoreEvent) => void): () => void {
  const subscribing: Promise<() => void> | null = inTauri
    ? import("@tauri-apps/api/event").then(({ listen }) =>
        listen<CoreEvent>("core-event", (e) => handler(e.payload)),
      )
    : import.meta.env.DEV
      ? import("./mock").then(({ mockOnEvent }) => mockOnEvent(handler))
      : null;
  return unsubscriber(subscribing);
}

/**
 * Answers requests the shell's MCP server sends to the window (`ui-request` events,
 * see src-tauri/src/mcp.rs). What `handler` returns is the answer; if it throws,
 * the message is. Returns a function that unsubscribes.
 * Outside the desktop app there is no MCP server and this does nothing.
 */
export function onUiRequest(handler: (kind: string, args: Record<string, unknown>) => unknown): () => void {
  if (!inTauri) return () => {};
  const subscribing = Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]).then(
    ([{ listen }, { invoke }]) =>
      listen<{ id: number; kind: string; args: Record<string, unknown> }>("ui-request", async ({ payload }) => {
        const { id, kind, args } = payload;
        try {
          await invoke("ui_reply", { id, result: (await handler(kind, args)) ?? null });
        } catch (e) {
          await invoke("ui_reply", { id, error: e instanceof Error ? e.message : String(e) });
        }
      }),
  );
  return unsubscriber(subscribing);
}

/**
 * Calls `handler` with a command id when an item of the app's menu bar is picked (src-tauri/src/menu.rs).
 * Returns a function that unsubscribes. A browser has no such menu.
 */
export function onMenuCommand(handler: (id: string) => void): () => void {
  if (!inTauri) return () => {};
  return unsubscriber(import("@tauri-apps/api/event").then(({ listen }) => listen<string>("menu-command", (e) => handler(e.payload))));
}

/**
 * Calls `handler` when the window is asked to close, and closes it only if that answers true: the place to
 * write what is unsaved, or to ask. Returns a function that unsubscribes. A browser tab closes without asking.
 */
export function onCloseRequested(handler: () => Promise<boolean>): () => void {
  if (!inTauri) return () => {};
  return unsubscriber(
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested(async (event) => {
        // A handler that throws must not leave a window that cannot be closed.
        if (!(await handler().catch(() => true))) event.preventDefault();
      }),
    ),
  );
}

/** Ends the app. The caller has saved what there was to save. */
export async function quitApp(): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("app_quit");
}

/**
 * Calls `handler` when the app's window went into or out of fullscreen, by the app or by the system's own
 * means (the green button, Ctrl+Cmd+F), with whether it now fills the screen. Returns a function that unsubscribes.
 */
export function onFullscreenChange(handler: (on: boolean) => void): () => void {
  if (!inTauri) {
    const changed = () => handler(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }
  // The window says nothing about fullscreen itself, but it is resized on the way in and on the way out.
  return unsubscriber(
    import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      let was = await win.isFullscreen();
      return win.onResized(async () => {
        const on = await win.isFullscreen();
        if (on !== was) handler((was = on));
      });
    }),
  );
}

/** Turns a subscription that is still being set up into a function that ends it. */
function unsubscriber(subscribing: Promise<() => void> | null): () => void {
  let stopped = false;
  let stop = () => {};
  subscribing
    ?.then((unsubscribe) => {
      // Subscribing is async, so the caller may already have unsubscribed.
      if (stopped) unsubscribe();
      else stop = unsubscribe;
    })
    .catch(console.error);
  return () => {
    stopped = true;
    stop();
  };
}

/** Asks the user for a folder. Returns its absolute path, or null if they cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "Open vault" });
    return typeof picked === "string" ? picked : null;
  }
  return "/mock/Demo vault";
}

/**
 * A URL the window can load for a file in the open vault, e.g. as an `<img src>`.
 * `path` is relative to the vault at `root`. Null where files cannot be loaded.
 */
export async function assetUrl(root: string, path: string): Promise<string | null> {
  if (inTauri) {
    // The shell serves these through the asset protocol, for files inside the open vault only (src-tauri/src/lib.rs).
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(`${root}/${path}`);
  }
  if (import.meta.env.DEV) {
    const { mockAsset } = await import("./mock");
    return mockAsset(path);
  }
  return null;
}

/** Opens a web address in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Shows a file or folder in the system's file manager (Finder), selected. `path` is absolute. */
export async function revealInFileManager(path: string): Promise<void> {
  if (!inTauri) throw new Error("Showing a file in Finder needs the desktop app");
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Whether the app's window fills the screen. In a plain browser: whether the page is in the browser's fullscreen. */
export async function isFullscreen(): Promise<boolean> {
  if (!inTauri) return document.fullscreenElement !== null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isFullscreen();
}

/**
 * Makes the app's window fill the screen, or puts it back. Resolves when asked for, not when the window has
 * finished changing size. A browser only allows it during a click or key press and otherwise leaves the page as it is.
 */
export async function setFullscreen(on: boolean): Promise<void> {
  if (inTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } else if (on) {
    await document.documentElement.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
}

/** The presenter window when it is a browser popup (`pnpm dev`). */
let popup: Window | null = null;

/**
 * Opens the presenter window of a slideshow: a second window that loads this UI at `#presenter`, where main.tsx
 * draws only the presenter view. In the desktop app the shell makes it (src-tauri/src/lib.rs: on another display
 * when there is one, and with no Tauri permission); in a browser it is a popup, which the browser only allows
 * during a click or key press. Already open, it comes to the front.
 */
export async function openPresenterWindow(): Promise<void> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("presenter_open");
  } else {
    popup = window.open(`${location.pathname}#presenter`, "inklode-presenter", "popup,width=1100,height=720");
    if (!popup) throw new Error("The browser blocked the presenter window");
  }
}

/**
 * Calls `handler` when the presenter window has closed, by the user or by `closePresenterWindow`. Returns a
 * function that unsubscribes. In a browser the popup says so itself, on the slideshow's own channel.
 */
export function onPresenterClosed(handler: () => void): () => void {
  if (!inTauri) return () => {};
  return unsubscriber(import("@tauri-apps/api/event").then(({ listen }) => listen("presenter-closed", handler)));
}

/** Closes the presenter window, if it is open. */
export async function closePresenterWindow(): Promise<void> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("presenter_close");
  } else {
    popup?.close();
    popup = null;
  }
}

/**
 * App-level settings, stored in the app's config folder and not in a vault, so a vault cannot switch on a server
 * or take a system-wide key.
 */
export interface AppSettings {
  mcp: { enabled: boolean; port: number };
  /** `envOverride` is the value of `INKLODE_MCP_PORT` when it overrides `mcp`. */
  mcpStatus: { running: boolean; port: number | null; error: string | null; envOverride: string | null };
  /**
   * `hotkey`: the global hotkey of quick capture (src/modules/capture), e.g. `Ctrl+Alt+Space`. `on`: whether
   * quick capture is on for the open vault, which is what switches the `capture` module; false with no vault open.
   */
  capture: { hotkey: string; on: boolean };
  /** Whether that hotkey is registered with the system now, and why it is not although the module is on. */
  captureStatus: { registered: boolean; error: string | null };
  /** Whether the open vault may run the commands its claims name (src/modules/claims). False with no vault open. */
  claims: { trusted: boolean };
  /** `auto`: whether the app looks for a newer version when it starts. `version` is the running app's. */
  updates: { auto: boolean; version: string };
}

/**
 * In a plain browser there is no MCP server and no global hotkey: the settings are kept in memory, `running`
 * mirrors `enabled`, and the hotkey is never registered.
 */
let browserMcp: AppSettings["mcp"] = { enabled: false, port: 7811 };
let browserCapture: AppSettings["capture"] = { hotkey: "Ctrl+Alt+Space", on: false };
let browserClaims: AppSettings["claims"] = { trusted: false };
let browserUpdates: AppSettings["updates"] = { auto: true, version: "0.0.0" };
const browserSettings = (): AppSettings => ({
  updates: browserUpdates,
  mcp: browserMcp,
  mcpStatus: { running: browserMcp.enabled, port: browserMcp.enabled ? browserMcp.port : null, error: null, envOverride: null },
  capture: browserCapture,
  captureStatus: { registered: false, error: null },
  claims: browserClaims,
});

export async function appSettingsGet(): Promise<AppSettings> {
  if (!inTauri) return browserSettings();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppSettings>("app_settings_get");
}

/**
 * Saves the settings, starts or stops the MCP server and moves the capture hotkey to match. `capture` left out
 * keeps the hotkey. Returns the state after that; a hotkey that could not be registered is in `captureStatus.error`.
 */
export async function appSettingsSet(settings: Pick<AppSettings, "mcp"> & { capture?: { hotkey: string } }): Promise<AppSettings> {
  if (!inTauri) {
    browserMcp = settings.mcp;
    browserCapture = { ...browserCapture, ...settings.capture };
    return browserSettings();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppSettings>("app_settings_set", { settings });
}

/**
 * Switches quick capture on or off for the open vault, in the app's settings: a vault's own settings file cannot,
 * because the module takes a system-wide key. Returns the settings after that.
 */
export async function captureSet(on: boolean): Promise<AppSettings> {
  if (!inTauri) {
    browserCapture = { ...browserCapture, on };
    return browserSettings();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppSettings>("capture_set", { on });
}

/**
 * Puts the token of the MCP server (`token`), or the `claude mcp add` line for `port` with the token in it
 * (`command`), on the clipboard. The shell does that itself: the token is never handed to the window, so nothing
 * that reads the window (the MCP tool `ui_state`, a screenshot) can show it.
 */
export async function mcpCopy(what: "token" | "command", port: number): Promise<void> {
  if (!inTauri) throw new Error("The MCP server and its token need the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mcp_copy", { what, port });
}

/** Replaces the token of the MCP server with a new one. Every client needs the new one from then on. */
export async function mcpTokenNew(): Promise<void> {
  if (!inTauri) throw new Error("The MCP server and its token need the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mcp_token_new");
}

/** Saves whether the app looks for a newer version when it starts, and returns the settings after that. */
export async function updatesSet(auto: boolean): Promise<AppSettings> {
  if (!inTauri) {
    browserUpdates = { ...browserUpdates, auto };
    return browserSettings();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppSettings>("updates_set", { auto });
}

/**
 * Whether this build looks for a newer version by itself when it starts. Not under `tauri dev` or in a browser:
 * a build from the working tree is not a release, and has nothing to be replaced by.
 */
export const checksForUpdatesAtStart = inTauri && !import.meta.env.DEV;

/** A newer version that `checkForUpdate` found. Nothing of it is downloaded until `install` is called. */
export interface AvailableUpdate {
  version: string;
  /**
   * Downloads the update, checks its signature against the public key built into the app (the shell does both,
   * and refuses an archive that does not match) and puts it in the place of the running app's files. The
   * version that runs stays the old one until `restartApp`.
   */
  install(): Promise<void>;
}

/**
 * Asks the release server (the `endpoints` in src-tauri/tauri.conf.json) whether a newer version than the running
 * one exists. One GET of a small JSON file; nothing about the user or the vault is sent. Null when the running
 * version is the latest. Throws when the server could not be asked. A browser has no updates.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!inTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  // The plugin rejects with a plain string.
  const update = await check({ timeout: 30_000 }).catch((e) => {
    throw new Error(e instanceof Error ? e.message : String(e));
  });
  if (!update) return null;
  return {
    version: update.version,
    install: () =>
      update.downloadAndInstall().catch((e) => {
        throw new Error(e instanceof Error ? e.message : String(e));
      }),
  };
}

/** Ends the app and starts it again, which is how an installed update comes into use. The caller has saved what there was to save. */
export async function restartApp(): Promise<void> {
  if (!inTauri) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/**
 * Calls `handler` when what `appSettingsGet` answers changed without `appSettingsSet`: the capture hotkey was
 * registered or unregistered. Returns a function that unsubscribes.
 */
export function onAppSettingsChanged(handler: () => void): () => void {
  if (!inTauri) return () => {};
  return unsubscriber(import("@tauri-apps/api/event").then(({ listen }) => listen("app-settings-changed", handler)));
}

// Quick capture (src/modules/capture; the shell's side is src-tauri/src/capture.rs). In a browser (`pnpm dev`)
// the box is a popup, which hands its text to the page that opened it over this channel.
const CAPTURE_CHANNEL = "inklode-capture";

/**
 * Says whether the `capture` module is running. The shell registers the global hotkey while it is and quick
 * capture is on for the open vault in the app's settings (`captureSet`), and unregisters it otherwise;
 * `appSettingsGet` says how that went. A browser has no global hotkey.
 */
export async function captureEnable(on: boolean): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("capture_enable", { on });
}

/** Shows the capture box, a small window of its own that draws only that (main.tsx, at `#capture`), and gives it the keyboard. */
export async function openCaptureWindow(): Promise<void> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("capture_open");
  } else if (!window.open(`${location.pathname}#capture`, "inklode-capture", "popup,width=560,height=112")) {
    throw new Error("The browser blocked the capture window");
  }
}

/** Calls `handler` with the text of each capture: what was in the box when Enter was pressed. Returns a function that unsubscribes. */
export function onCaptured(handler: (text: string) => void): () => void {
  if (!inTauri) {
    const channel = new BroadcastChannel(CAPTURE_CHANNEL);
    channel.onmessage = ({ data }: MessageEvent<string>) => handler(data);
    return () => channel.close();
  }
  return unsubscriber(import("@tauri-apps/api/event").then(({ listen }) => listen<string>("capture-text", (e) => handler(e.payload))));
}

/**
 * Called by the capture box when it is done: with the text to capture, or null when the user gave up. The box
 * goes away, and the app that was in front before it has the focus again.
 */
export async function captureDone(text: string | null): Promise<void> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("capture_done", { text });
  } else {
    if (text !== null) new BroadcastChannel(CAPTURE_CHANNEL).postMessage(text);
    window.close();
  }
}

/**
 * Says whether the open vault may run the commands its claims name when the user presses Check
 * (src/modules/claims). Kept in the app's settings per vault, not in the vault, so a vault cannot allow itself.
 */
export async function claimsTrust(trusted: boolean): Promise<void> {
  if (!inTauri) {
    browserClaims = { trusted };
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("claims_trust", { trusted });
}
