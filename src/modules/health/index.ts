// The health module: what in the vault needs looking after, as one list in the right sidebar.
// - Broken links: `[[links]]` and embeds that reach no note and no file, under the note they are in.
// - Notes without links: no link to another note and none from one.
// - Stale notes: a note whose frontmatter names code (`repos: [name]`) and a day (`updated: 2026-03-01`),
//   when a repository it names has commits after that day. The full rule is written out in
//   crates/core/src/health.rs.
// A click on a row opens the note, at the link for a broken link.
//
// All of it is the core's `vault.health`, which reads git and writes nothing. It is read again a few seconds
// after the vault last changed, when the panel is opened, and, while the panel shows, when the window gets
// the focus back.
//
// This file loads when the module is switched on, Panel.tsx when the panel is first opened.

import { HeartPulse } from "lucide-react";
import { createElement, lazy, useEffect, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import type { AppApi } from "../../modules";
import { polled, quiet } from "../polled";

/** What `vault.health` gives. */
export interface Health {
  /** By path, each with its links by line. `link` is the text between the brackets, `text` the line. */
  broken: { path: string; links: { line: number; link: string; text: string }[] }[];
  /** The paths of the notes without links. */
  orphans: string[];
  /** One per note and repository with newer commits: how many, and the newest (`date` a day, `rev` a short hash). */
  stale: { path: string; updated: string; repo: string; dir: string; commits: number; newest: { date: string; rev: string; subject: string } }[];
  /** What could not be checked for staleness. `repo` is null when the note has no valid `updated:`. */
  unchecked: { path: string; repo: string | null; reason: string }[];
}

/** Calls into the Rust core. Set when the module is switched on. */
let call: AppApi["core"]["call"];

export const health = polled<Health>({ broken: [], orphans: [], stale: [], unchecked: [] }, () => call<Health>("vault.health"));

/** Whether the panel is on screen, said by Panel.tsx. */
export const panel = { open: false };

/**
 * How long the vault has to be left alone before the report is read again. A report walks the folders
 * repositories are looked up in and asks git about every repository the notes name, and a save while typing
 * comes about every second: read at each one, it would never stop running.
 */
const QUIET_MS = 3000;
/** Reads the report: once the vault's changes stopped, or `now`. */
const read = quiet(() => void health.refresh().catch(commands.onError), QUIET_MS);

/** Opens a note at a line, for Panel.tsx. Set when the module is switched on. */
export let openNote: AppApi["notes"]["open"];

/** The count on the ribbon button: the broken links and the stale notes. Notes without links are not counted, they can be meant so. */
function Badge() {
  const { broken, stale } = useSyncExternalStore(health.subscribe, health.get);
  // A commit in a repository a note names changes no file of the vault, so no event tells of it: coming back
  // to the window reads again, while the panel shows. With the panel closed the count waits for the next
  // change in the vault, so that switching between the app and a terminal costs nothing.
  useEffect(() => {
    const again = () => {
      if (panel.open) read.now();
    };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  const count = broken.reduce((sum, note) => sum + note.links.length, 0) + stale.length;
  return count ? createElement("span", { className: "ribbon-badge", "aria-label": `${count} broken links and stale notes` }, count > 99 ? "99+" : count) : null;
}

export function activate(app: AppApi) {
  call = app.core.call;
  openNote = app.notes.open;
  app.ui.registerPanel({ id: "health", title: "Vault health", component: lazy(() => import("./Panel")) });
  app.ui.registerRibbon({ id: "health", title: "Show vault health", icon: HeartPulse, command: "health.open", badge: Badge });

  // The list follows the vault: a save, a write by another program, another vault.
  // shortcut: another vault is a change like any other, so for `QUIET_MS` after a vault is opened the panel
  // and the count are still the vault's before; read at once there if `AppApi` ever tells the two apart.
  app.notes.onChanged(read);
  read.now();

  // `health` in `ui_state`. `open`: whether the panel shows. `broken`, `orphans`, `stale`, `unchecked`: what
  // the panel lists, as the core's `vault.health` gives it.
  app.ui.registerState(() => ({ health: { open: panel.open, ...health.get() } }));

  app.commands.register({
    id: "health.open",
    title: "Show vault health",
    // Opens the panel, or closes it when it is open. `{open}` says which.
    run: async (params) => {
      app.ui.togglePanel("health", ((params ?? {}) as { open?: boolean }).open);
      // This reading covers the one that waits for the vault to be left alone.
      read.cancel();
      await health.refresh();
    },
  });
}
