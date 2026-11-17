// The graph module: "Open graph view" shows the vault's notes as dots and the links between them as lines.
//
// This file is small and loads when the module is switched on. The drawing and the layout library
// (d3-force) are in View.tsx, which loads when the graph is first opened.

import { Waypoints } from "lucide-react";
import { lazy } from "react";
import type { AppApi } from "../../modules";

/** What the commands can do to the graph that is showing. */
export interface Graph {
  /** Shows only the notes whose name contains `text`, without case. Empty text shows all. */
  filter(text: string): void;
}

/** Set by View.tsx while the graph is showing. */
export const open: { view: Graph | null } = { view: null };

/** Calls into the Rust core, for View.tsx. Set when the module is switched on. */
export let call: AppApi["core"]["call"];

export function activate(app: AppApi) {
  call = app.core.call;
  app.views.register("graph", { component: lazy(() => import("./View")) });
  app.commands.register({ id: "graph.open", title: "Open graph view", key: "Mod+G", run: () => app.views.show("graph") });
  app.ui.registerRibbon({ id: "graph", title: "Open graph view", icon: Waypoints, command: "graph.open" });
  app.commands.register({
    id: "graph.filter",
    title: "Graph: filter notes by name",
    // `{text}`: the text for the graph's filter field. Run without it, as from the palette, it focuses the field.
    run: (params) => {
      if (!open.view) throw new Error("Open the graph view first");
      const text = (params as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") open.view.filter(text);
      else document.querySelector<HTMLInputElement>(".graph-filter")?.focus();
    },
  });
}
