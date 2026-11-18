// The graph module. "Open graph view" shows the vault's notes as dots and the links between them as lines.
// "Open local graph" shows, in the right sidebar, the active note and the notes within a few links of it.
// Each of the two has options (filters, colour groups, display, forces), kept per vault in `.inklode/graph.json`.
//
// This file, store.ts and options.ts are small and load when the module is switched on. The drawing and the
// layout library (d3-force) are in canvas.ts, which loads when a graph is first opened.

import { Share2, Waypoints } from "lucide-react";
import { lazy } from "react";
import type { AppApi } from "../../modules";
import { GROUP_COLOURS, shown, type Which } from "./options";
import { store } from "./store";

/** What the commands can do to a graph that is on screen. */
export interface Graph {
  /** Its entry in `ui_state` (`uiState` in canvas.ts has the fields), with `optionsOpen`. */
  uiState(): Record<string, unknown>;
  /** Zooms to that level, or without one so that the whole graph is in the pane. */
  zoom(level?: number): void;
  /** Opens or closes the options panel. */
  showOptions(open: boolean): void;
}

/** Set by Pane.tsx while a graph is showing. */
export const open: Record<Which, Graph | null> = { full: null, local: null };

/** Calls into the Rust core, for canvas.ts. Set when the module is switched on. */
export let call: AppApi["core"]["call"];

/** Opens a note, for the local graph, which is a panel and gets no `onOpen`. Set when the module is switched on. */
export let openNote: AppApi["notes"]["open"];

/** The id of the local graph's panel in the right sidebar. */
const LOCAL_PANEL = "graph-local";

const param = (params: unknown) => (params ?? {}) as Record<string, unknown>;

/** The graph a command is for: what `{graph}` says ("full" or "local"), else the full graph if it shows, else the local one if that shows. */
function target(params: unknown): Which {
  const { graph } = param(params);
  if (graph === "full" || graph === "local") return graph;
  if (graph !== undefined) throw new Error('graph is "full" or "local"');
  return open.full || !open.local ? "full" : "local";
}

/** The graph a command acts on, which has to be on screen. */
function showing(params: unknown): Graph {
  const which = target(params);
  const graph = open[which];
  if (!graph) throw new Error(which === "full" ? "Open the graph view first" : "Open the local graph first");
  return graph;
}

export function activate(app: AppApi) {
  call = app.core.call;
  openNote = app.notes.open;
  store.init(app.core.call);
  // The options of the vault that is open, read when the module is switched on and when files change, which is
  // also when another vault is opened. A command that changes an option waits for the reading that is under
  // way, so it changes the vault's options and not the defaults they are about to replace.
  let read = store.load().catch(console.error);
  app.notes.onChanged(() => void (read = store.load().catch(console.error)));

  app.views.register("graph", { component: lazy(() => import("./View")) });
  app.ui.registerPanel({ id: LOCAL_PANEL, title: "Local graph", component: lazy(() => import("./Local")) });
  app.ui.registerRibbon({ id: "graph", title: "Open graph view", icon: Waypoints, command: "graph.open" });
  app.ui.registerRibbon({ id: LOCAL_PANEL, title: "Open local graph", icon: Share2, command: "graph.local" });

  // `localGraph` in `ui_state`. `open`: whether the panel shows. While it does, what the full graph reports as
  // `graph` (`uiState` in canvas.ts), and `path` and `depth`: the note it is about and how far from it it reaches.
  // Closed: `options` only, as saved.
  app.ui.registerState(() => {
    const options = store.get("local");
    return { localGraph: { open: open.local !== null, ...(open.local?.uiState() ?? { path: null, options: shown("local", options) }), depth: options.depth } };
  });

  app.commands.register({ id: "graph.open", title: "Open graph view", key: "Mod+G", run: () => app.views.show("graph") });
  app.commands.register({
    id: "graph.local",
    title: "Open local graph",
    // Opens the local graph in the right sidebar, or closes it when it is open. `{open}` says which.
    run: (params) => app.ui.togglePanel(LOCAL_PANEL, param(params).open as boolean | undefined),
  });
  app.commands.register({
    id: "graph.options",
    title: "Graph: show or hide options",
    // `{open}`: whether the options panel of the graph shows. Without it, it opens. `{graph}` as for `graph.set`.
    run: (params) => showing(params).showOptions((param(params).open as boolean | undefined) ?? true),
  });
  app.commands.register({
    id: "graph.filter",
    title: "Graph: filter notes by name",
    // `{text}`: the text for the graph's name filter. Run without it, as from the palette, it opens the options,
    // where the filter field takes the keyboard. `{graph}` as for `graph.set`.
    run: async (params) => {
      const { text } = param(params);
      await read;
      if (typeof text === "string") store.set(target(params), "filter", text);
      else showing(params).showOptions(true);
    },
  });
  app.commands.register({
    id: "graph.set",
    title: "Graph: set an option",
    // `{option, value, graph?}`: sets one option (`Options` in options.ts has them all with what they mean, `RANGES`
    // the sliders' ends). `graph` is "full" or "local": without it, the full graph if it shows, else the local
    // one if that shows, else the full graph. The graph need not be open. From the palette, with no params, it
    // opens the options panel.
    run: async (params) => {
      const { option, value } = param(params);
      if (option === undefined) return showing(params).showOptions(true);
      if (typeof option !== "string") throw new Error("graph.set takes {option, value}");
      await read;
      store.set(target(params), option, value);
    },
  });
  app.commands.register({
    id: "graph.addGroup",
    title: "Graph: new colour group",
    // `{query?, colour?, graph?}`: adds a group at the end. `colour` is 1 to 8 (`--graph-group-<n>`); without it,
    // the next one after the last group's.
    run: async (params) => {
      await read;
      const { query = "", colour } = param(params);
      const groups = store.get(target(params)).groups;
      store.set(target(params), "groups", [...groups, { query, colour: colour ?? ((groups[groups.length - 1]?.colour ?? 0) % GROUP_COLOURS) + 1 }]);
    },
  });
  app.commands.register({
    id: "graph.removeGroup",
    title: "Graph: remove last colour group",
    // `{index?, graph?}`: removes the group at that position, from 0. Without it, the last one.
    run: async (params) => {
      await read;
      const groups = store.get(target(params)).groups;
      const { index = groups.length - 1 } = param(params);
      if (typeof index !== "number" || !groups[index]) throw new Error("The graph has no such group");
      store.set(target(params), "groups", groups.filter((_, at) => at !== index));
    },
  });
  app.commands.register({
    id: "graph.reset",
    title: "Graph: reset options to the defaults",
    // `{graph?}`: every option of that graph back to its default.
    run: async (params) => {
      await read;
      store.reset(target(params));
    },
  });
  app.commands.register({
    id: "graph.zoom",
    title: "Graph: zoom to fit",
    // `{zoom?, graph?}`: the zoom level (1 is the size the layout is made at) around the middle of the pane.
    // Without it, the whole graph is brought into the pane.
    run: (params) => {
      const { zoom } = param(params);
      if (zoom !== undefined && (typeof zoom !== "number" || !(zoom > 0))) throw new Error("zoom is a number above 0");
      showing(params).zoom(zoom as number | undefined);
    },
  });
}
