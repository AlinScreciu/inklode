// A graph with its options panel: the canvas, the button that opens the options, and the options. The full
// graph (View.tsx) and the local graph (Local.tsx) are both this, with their own options.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Plus, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { commands } from "../../commands";
import { createGraph, type GraphCanvas } from "./canvas";
import { open } from "./index";
import { COLOUR_NAMES, type Options, RANGES, type Slider, type Which } from "./options";
import { store } from "./store";

interface PaneProps {
  which: Which;
  /** The note the graph is about: the full graph marks it, the local graph shows what is around it. "" for none. */
  path: string;
  onOpen(path: string): void;
  /** A number that changes when files in the vault changed on disk. */
  refresh: number;
}

export function Pane({ which, path, onOpen, refresh }: PaneProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<GraphCanvas | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const options = useSyncExternalStore(store.subscribe, () => store.get(which));
  const [optionsOpen, setOptionsOpen] = useState(false);
  const panelId = useId();
  // The newest `onOpen`, for the graph, which is made once.
  const opener = useRef(onOpen);
  opener.current = onOpen;
  // The newest of what `ui_state` reports from here.
  const shows = useRef({ optionsOpen, path });
  shows.current = { optionsOpen, path };

  useEffect(() => {
    const made = createGraph(canvas.current!, which, path, store.get(which), (note) => opener.current(note));
    graph.current = made;
    const handle = {
      uiState: () => ({
        ...(which === "local" ? { path: shows.current.path || null } : {}),
        ...made.uiState(),
        optionsOpen: shows.current.optionsOpen,
      }),
      zoom: made.zoom,
      showOptions: setOptionsOpen,
    };
    open[which] = handle;
    return () => {
      made.destroy();
      graph.current = null;
      if (open[which] === handle) open[which] = null;
    };
    // `path`: the full graph marks the note that was open when it was opened, and the local one follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which]);

  useEffect(() => graph.current?.setOptions(options), [options]);

  // The local graph follows the active note.
  useEffect(() => {
    if (which === "local") graph.current?.setCentre(path);
  }, [which, path]);

  // On opening, and again whenever files in the vault changed: the options from the vault's file, then the graph.
  useEffect(() => {
    store
      .load()
      .then(() => graph.current?.load())
      .catch(console.error);
  }, [refresh]);

  // The panel opens with the keyboard in its first field, and closing it gives the keyboard back to the button.
  useEffect(() => {
    if (optionsOpen) panel.current?.querySelector<HTMLElement>("input")?.focus();
  }, [optionsOpen]);
  const close = () => {
    setOptionsOpen(false);
    toggle.current?.focus();
  };

  return (
    <div className={"graph is-" + which}>
      <canvas ref={canvas} role="img" aria-label={which === "local" ? "Graph of the links around this note" : "Graph of the vault's notes and links"} />
      {which === "local" && !path && <p className="graph-empty">Open a note to see what it links with.</p>}
      <button
        ref={toggle}
        className="icon-button tip-end graph-options-toggle"
        aria-label="Graph options"
        aria-expanded={optionsOpen}
        aria-controls={panelId}
        data-tip={optionsOpen ? undefined : "Graph options"}
        onClick={() => (optionsOpen ? close() : setOptionsOpen(true))}
      >
        <SlidersHorizontal size={16} />
      </button>
      {optionsOpen && (
        <div
          ref={panel}
          id={panelId}
          className="graph-options"
          role="group"
          aria-label="Graph options"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
        >
          <OptionsPanel which={which} options={options} onClose={close} />
        </div>
      )}
    </div>
  );
}

const LABELS: Record<Slider, string> = {
  depth: "Depth",
  textFade: "Text fade threshold",
  nodeSize: "Node size",
  linkThickness: "Link thickness",
  centerForce: "Centre force",
  repelForce: "Repel force",
  linkForce: "Link force",
  linkDistance: "Link distance",
};

/** The options of one graph. Every control runs a command, the same one `command_run` reaches. */
function OptionsPanel({ which, options, onClose }: { which: Which; options: Options; onClose(): void }) {
  /** The position of the group whose colours are laid out to pick from, or -1. */
  const [picking, setPicking] = useState(-1);
  const set = (option: keyof Options, value: unknown) => void commands.run("graph.set", { graph: which, option, value });

  const toggle = (option: "tags" | "attachments" | "existingOnly" | "orphans" | "arrows", label: string) => (
    <label className="graph-option">
      <span>{label}</span>
      <input type="checkbox" data-option={option} checked={options[option]} onChange={(e) => set(option, e.target.checked)} />
    </label>
  );
  const slider = (option: Slider) => {
    const { min, max, step } = RANGES[option];
    return (
      <label className="graph-option is-slider">
        <span>{LABELS[option]}</span>
        <output>{step < 1 ? options[option].toFixed(2) : options[option]}</output>
        <input
          type="range"
          data-option={option}
          min={min}
          max={max}
          step={step}
          value={options[option]}
          onChange={(e) => set(option, Number(e.target.value))}
        />
      </label>
    );
  };

  return (
    <>
      <header className="graph-options-header">
        <span className="graph-options-title">Graph options</span>
        <button
          className="icon-button tip-end"
          aria-label="Reset options to the defaults"
          data-tip="Reset to the defaults"
          onClick={() => void commands.run("graph.reset", { graph: which })}
        >
          <RotateCcw size={14} />
        </button>
        <button className="icon-button" aria-label="Close graph options" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <section aria-label="Filters">
        <h3>Filters</h3>
        <label className="graph-field">
          <Search size={14} />
          <input
            className="graph-filter"
            aria-label="Filter notes by name"
            placeholder="Filter notes by name"
            value={options.filter}
            onChange={(e) => set("filter", e.target.value)}
            spellCheck={false}
          />
        </label>
        {which === "local" && slider("depth")}
        {toggle("tags", "Tags")}
        {toggle("attachments", "Attachments")}
        {toggle("existingOnly", "Existing files only")}
        {toggle("orphans", "Orphans")}
      </section>

      <section aria-label="Groups">
        <h3>Groups</h3>
        {options.groups.map((group, index) => {
          const change = (to: Partial<typeof group>) => set("groups", options.groups.map((other, at) => (at === index ? { ...other, ...to } : other)));
          return (
            // The position is the key: a group has nothing else that stays the same while its query is typed.
            <div className="graph-group" key={index}>
              <button
                className="graph-swatch"
                style={{ background: `var(--graph-group-${group.colour})` }}
                aria-label={`Colour of group ${index + 1}: ${COLOUR_NAMES[group.colour - 1]}`}
                aria-expanded={picking === index}
                onClick={() => setPicking(picking === index ? -1 : index)}
              />
              <input
                className="graph-group-query"
                aria-label={`Query of group ${index + 1}`}
                placeholder="name, path:Folder or tag:name"
                value={group.query}
                onChange={(e) => change({ query: e.target.value })}
                spellCheck={false}
              />
              <button
                className="icon-button"
                aria-label={`Remove group ${index + 1}`}
                onClick={() => {
                  setPicking(-1);
                  void commands.run("graph.removeGroup", { graph: which, index });
                }}
              >
                <X size={14} />
              </button>
              {picking === index && (
                <div className="graph-colours" role="radiogroup" aria-label={`Colour of group ${index + 1}`}>
                  {COLOUR_NAMES.map((name, at) => (
                    <button
                      key={name}
                      className="graph-swatch"
                      role="radio"
                      aria-checked={group.colour === at + 1}
                      aria-label={name}
                      style={{ background: `var(--graph-group-${at + 1})` }}
                      onClick={() => {
                        change({ colour: at + 1 });
                        setPicking(-1);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <button className="button is-quiet graph-add-group" onClick={() => void commands.run("graph.addGroup", { graph: which })}>
          <Plus size={14} />
          New group
        </button>
        <p className="graph-hint">
          A word matches a note's name, <code>path:Folder</code> its folder, <code>tag:name</code> a tag. The first group that matches gives the colour.
        </p>
      </section>

      <section aria-label="Display">
        <h3>Display</h3>
        {toggle("arrows", "Arrows")}
        {slider("textFade")}
        {slider("nodeSize")}
        {slider("linkThickness")}
      </section>

      <section aria-label="Forces">
        <h3>Forces</h3>
        {slider("centerForce")}
        {slider("repelForce")}
        {slider("linkForce")}
        {slider("linkDistance")}
      </section>
    </>
  );
}
