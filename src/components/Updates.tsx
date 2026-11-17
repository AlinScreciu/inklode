// Updates of the app itself: the check for a newer version, and the notice at the bottom of the window that
// offers it. Nothing is downloaded until the user presses "Install and restart".

import { useCallback, useEffect, useRef, useState } from "react";
import { appSettingsGet, checkForUpdate, checksForUpdatesAtStart, restartApp, type AvailableUpdate } from "../core/client";

/** What the notice shows. Null: no notice. It is also `update` in the MCP tool `ui_state`. */
export type UpdateState =
  | { kind: "checking" }
  /** `version` is the running one. */
  | { kind: "latest"; version: string }
  /** The check itself failed. Only a check the user asked for says so. */
  | { kind: "error"; message: string }
  /** From here on `version` is the newer one. */
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string }
  | { kind: "failed"; version: string; message: string }
  /** Installed, but the app could not restart yet because a note could not be saved. */
  | { kind: "ready"; version: string }
  | null;

/** How long "You have the latest version" stays on screen. */
const LATEST_MS = 6000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The state of the notice and what its buttons do. `settle` writes what is unsaved and answers whether the app
 * may go (`settle` in App.tsx, which quitting uses too).
 *
 * When the app starts it checks once, quietly, if the app's `updates.auto` setting is on: a check that fails
 * (offline, no release yet) shows nothing. A build under `tauri dev` does not check by itself.
 */
export function useUpdates(settle: () => Promise<boolean>) {
  const [state, setState] = useState<UpdateState>(null);
  const shown = useRef<UpdateState>(null);
  const show = useCallback((next: UpdateState) => setState((shown.current = next)), []);
  const found = useRef<AvailableUpdate | null>(null);
  const settleNow = useRef(settle);
  settleNow.current = settle;

  /** Looks for a newer version. `quiet`: says something only if there is one. */
  const check = useCallback(
    async (quiet: boolean) => {
      // A check must not take the place of a download, or of an update that only waits for the restart.
      const busy = shown.current?.kind;
      if (busy === "checking" || busy === "downloading" || busy === "ready") return;
      if (!quiet) show({ kind: "checking" });
      try {
        const update = await checkForUpdate();
        found.current = update;
        if (update) show({ kind: "available", version: update.version });
        else if (!quiet) show({ kind: "latest", version: (await appSettingsGet()).updates.version });
      } catch (e) {
        if (!quiet) show({ kind: "error", message: message(e) });
      }
    },
    [show],
  );

  /** "Restart now": what was typed since the install is written first. */
  const restart = useCallback(async () => {
    if (await settleNow.current()) await restartApp();
  }, []);

  /** "Install and restart": writes what is unsaved, downloads and installs the update, and starts the app again. */
  const install = useCallback(async () => {
    const update = found.current;
    if (!update || shown.current?.kind === "downloading") return;
    if (!(await settleNow.current())) return;
    show({ kind: "downloading", version: update.version });
    try {
      await update.install();
    } catch (e) {
      show({ kind: "failed", version: update.version, message: message(e) });
      return;
    }
    show({ kind: "ready", version: update.version });
    await restart();
  }, [show, restart]);

  const dismiss = useCallback(() => show(null), [show]);

  useEffect(() => {
    if (!checksForUpdatesAtStart) return;
    void appSettingsGet().then(
      (settings) => {
        if (settings.updates.auto) void check(true);
      },
      () => {},
    );
  }, [check]);

  useEffect(() => {
    if (state?.kind !== "latest") return;
    const hiding = window.setTimeout(dismiss, LATEST_MS);
    return () => window.clearTimeout(hiding);
  }, [state, dismiss]);

  return { state, check, install, restart, dismiss };
}

/**
 * The notice: a line at the bottom of the window, like the merge module's, with buttons. It covers nothing
 * that is needed and the window stays usable under it.
 */
export function UpdateNotice({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { state, install, restart, dismiss } = updates;
  if (!state) return null;
  const button = (label: string, run: () => void, quiet = true) => (
    <button className={"button" + (quiet ? " is-quiet" : "")} onClick={run}>
      {label}
    </button>
  );
  const bad = state.kind === "error" || state.kind === "failed";
  return (
    <div className="notice update-notice" role={bad ? "alert" : "status"} data-kind={state.kind}>
      {state.kind === "checking" && <span>Checking for updates…</span>}
      {state.kind === "latest" && (
        <>
          <span>You have the latest version ({state.version})</span>
          {button("OK", dismiss)}
        </>
      )}
      {state.kind === "error" && (
        <>
          <span>Could not check for updates: {state.message}</span>
          {button("Close", dismiss)}
        </>
      )}
      {state.kind === "available" && (
        <>
          <span>Inklode {state.version} is available</span>
          {button("Install and restart", () => void install(), false)}
          {button("Later", dismiss)}
        </>
      )}
      {state.kind === "downloading" && <span>Downloading Inklode {state.version}…</span>}
      {state.kind === "failed" && (
        <>
          <span>
            Could not install Inklode {state.version}: {state.message}
          </span>
          {button("Try again", () => void install())}
          {button("Later", dismiss)}
        </>
      )}
      {state.kind === "ready" && (
        <>
          <span>Inklode {state.version} is installed and starts the next time you open the app.</span>
          {button("Restart now", () => void restart(), false)}
          {button("Later", dismiss)}
        </>
      )}
    </div>
  );
}
