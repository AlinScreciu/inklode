// The claims module: notes that know if they are true. A claim is a line of a note that ends with an HTML
// comment naming its evidence, a command, a file or a web address:
//
//     45 core tests pass. <!-- check: cargo test -p core @ ~/code/myproject -->
//     The spec is in the vault. <!-- check: file Notes/Spec.md -->
//     Docs are online. <!-- check: https://tauri.app -->
//
// The core lists the claims with their status (`claims.list`) and runs the evidence of one when asked
// (`claims.check`); it keeps the results outside the vault, and nothing here writes them into a note. In the
// editor the marker is drawn as a mark of the status (editor.ts, popover.ts); "Show claims" opens the review
// queue in the right sidebar (Panel.tsx).
//
// A check runs only when the user presses Check or runs the command themselves: never when a note opens, never
// when the list is read again, never for a script's click (`byUser` in state.ts). A command claim runs only
// in a vault the user allowed to run commands, which the core enforces.
//
// This file, claims.ts, state.ts, editor.ts, popover.ts and ../editors.ts load when the module is switched on,
// Panel.tsx when the panel is first opened.

import { ShieldCheck } from "lucide-react";
import { createElement, lazy, useSyncExternalStore } from "react";
import { commands } from "../../commands";
import { claimsTrust } from "../../core/client";
import { type AppApi, notePath } from "../../modules";
import { currentView, extension as editors } from "../editors";
import { counts, locate, marker } from "./claims";
import { extension } from "./editor";
import { closePopover } from "./popover";
import { app, byUser, check, checkAll, claims, readTrust, reset, state, watchInput } from "./state";

/** The count on the ribbon button: the claims that are failing, stale or not checked. */
function Badge() {
  const { failing, stale, unchecked } = counts(useSyncExternalStore(claims.subscribe, claims.get));
  const count = failing + stale + unchecked;
  return count ? createElement("span", { className: "ribbon-badge", "aria-label": `${count} claims to check` }, count > 99 ? "99+" : count) : null;
}

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export function activate(api: AppApi) {
  app.call = api.core.call;
  app.openNote = api.notes.open;
  watchInput(true);
  api.editor.registerExtension([editors, extension]);
  api.ui.registerPanel({ id: "claims", title: "Claims", component: lazy(() => import("./Panel")) });
  api.ui.registerRibbon({ id: "claims", title: "Show claims", icon: ShieldCheck, command: "claims.open", badge: Badge });

  // The list follows the vault: a save, a write by another program, another vault, which has its own answer
  // to whether it may run commands. Reading the list checks nothing.
  const read = () => {
    void claims.refresh().catch(commands.onError);
    void readTrust().catch(commands.onError);
  };
  api.notes.onChanged(read);
  read();

  // `claims` in `ui_state`. `open`: whether the panel shows. `trusted`: whether the vault may run commands.
  // `counts`: how many claims have each status. `checking`: the claim being checked, as `path:line`, or null.
  api.ui.registerState(() => ({ claims: { open: state.open, trusted: state.trusted, counts: counts(claims.get()), checking: state.checking } }));

  api.commands.register({
    id: "claims.open",
    title: "Show claims",
    // Opens the panel, or closes it when it is open. `{open}` says which.
    run: async (params) => {
      api.ui.togglePanel("claims", param(params).open as boolean | undefined);
      await claims.refresh();
    },
  });
  api.commands.register({
    id: "claims.check",
    title: "Claims: check the claim on this line",
    noKey: true,
    // `{path, line}`: runs the evidence of the claim on that line of that note. The Check buttons run it.
    // Without them, the claim on the line the cursor is on. By the user only.
    run: async (params) => {
      byUser();
      let { path, line } = param(params);
      let evidence = "";
      if (params == null) {
        const view = currentView();
        const at = view?.state.doc.lineAt(view.state.selection.main.head);
        const found = at && marker(at.text);
        if (!view || !at || !found) throw new Error("There is no claim on this line");
        path = view.state.facet(notePath);
        line = at.number;
        evidence = found.evidence;
        // The list as it is now, for a claim typed or saved a moment ago.
        await claims.refresh();
      }
      if (typeof path !== "string" || typeof line !== "number") throw new Error("Check a claim in the claims panel, or with the cursor on its line");
      // From the cursor, the claim can be listed some lines off until the note is saved; from a button, it is on its line.
      const claim = params == null ? locate(claims.get(), path, line, evidence) : claims.get().find((c) => c.path === path && c.line === line);
      if (!claim) throw new Error(params == null ? "There is no claim on this line" : `${path} has no claim on line ${line}`);
      await check(claim);
    },
  });
  api.commands.register({
    id: "claims.checkAll",
    title: "Claims: check all that are not passing",
    noKey: true,
    // Checks the failing, stale and unchecked claims one after another. By the user only.
    run: () => {
      byUser();
      return checkAll();
    },
  });
  api.commands.register({
    id: "claims.trust",
    title: "Claims: allow this vault to run commands…",
    noKey: true,
    // `{trusted}`: whether command claims of the open vault may run when the user presses Check. It is saved
    // in the app's settings, not the vault's. Without it, opens the settings screen where the switch is. By
    // the user only.
    run: async (params) => {
      if (params == null) return commands.execute("settings.open", { section: "modules" });
      byUser();
      const { trusted } = param(params);
      if (typeof trusted !== "boolean") throw new Error("trusted must be true or false");
      await claimsTrust(trusted);
      await readTrust();
    },
  });
}

export function deactivate() {
  watchInput(false);
  closePopover();
  reset();
}
