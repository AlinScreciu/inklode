import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Search } from "lucide-react";
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { ViewProps } from "../../modules";
import { call, open } from "./index";
import { placeLabels, type LabelBox } from "./labels";

/** What `vault.graph` returns (crates/core/src/call.rs). */
interface Data {
  nodes: { path: string; links: number }[];
  edges: { from: string; to: string }[];
}

interface Node extends SimulationNodeDatum {
  path: string;
  /** The file name without `.md`: the label. */
  name: string;
  /** How many links the note has, in plus out. Sets the dot's size. */
  links: number;
  /** The notes it links to and those that link to it. */
  near: Set<Node>;
}

interface Edge {
  source: Node;
  target: Node;
}

/** Opacity of everything but the hovered note and its neighbours. */
const DIM = 0.2;
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 8;
/** Fitting the graph to the pane zooms in no further than this, so a small vault is not blown up. */
const FIT_ZOOM_MAX = 1.5;
/** Space kept free around the graph when it is fitted, in px. */
const FIT_MARGIN = 60;
/** A note has its label when its dot is at least this many px across half on screen, so zooming out leaves the labels of the most linked notes. */
const LABEL_MIN_RADIUS = 3;
/** The pointer has to move this many px with the button down before it is a drag and not a click. */
const DRAG_START = 4;

/**
 * Draws the note graph on `canvas` and handles the pointer. `marked` is the path of the note to mark,
 * `onOpen` is called with the path of a clicked note. Returns what the React component needs.
 */
function createGraph(canvas: HTMLCanvasElement, marked: string, onOpen: (path: string) => void) {
  const ctx = canvas.getContext("2d")!;
  let nodes: Node[] = [];
  let edges: Edge[] = [];
  /** The nodes that pass the filter, and the edges between them. Only these are drawn and can be pointed at. */
  let shown: Node[] = [];
  let shownEdges: Edge[] = [];
  let filter = "";
  let hovered: Node | null = null;
  /** The data the graph was last built from, as text, to tell whether a change in the vault changed the graph. */
  let built = "";
  /** A point of the graph is drawn at `point * k + (x, y)`, in CSS px from the canvas's top left. */
  const view = { x: 0, y: 0, k: 1 };
  /** Whether the view follows the layout so the whole graph stays in the pane. Off for good once the first layout settled or the user moved the view. */
  let fit = true;
  let frame = 0;
  /** Set by `destroy`, for a `load` that was still waiting for the core. */
  let destroyed = false;

  /** Colours, font and dot size, from the CSS variables in src/app.css. */
  const readLook = () => {
    const style = getComputedStyle(canvas);
    const variable = (name: string) => style.getPropertyValue(name).trim();
    return {
      node: variable("--graph-node"),
      edge: variable("--graph-edge"),
      open: variable("--graph-open"),
      hover: variable("--graph-hover"),
      halo: variable("--graph-label-halo"),
      // `.graph canvas` sets these two from `--graph-label` and `--graph-label-size`, which gives the size in px.
      label: style.color,
      font: `${style.fontSize} ${style.fontFamily}`,
      fontSize: parseFloat(style.fontSize),
      size: parseFloat(variable("--graph-node-size")) || 4,
    };
  };
  let look = readLook();
  const radius = (node: Node) => look.size * (1 + Math.sqrt(node.links) / 2);

  // A window that is covered or minimised gets no animation frames, but `ui_screenshot` still shows it,
  // so there the canvas is painted at once.
  const draw = () => {
    if (document.hidden) paint();
    else frame ||= requestAnimationFrame(paint);
  };

  /** Moves and zooms the view so every shown node is in the pane. */
  const fitView = () => {
    if (!shown.length) return;
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { x = 0, y = 0 } of shown) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    const [width, height] = [canvas.clientWidth, canvas.clientHeight];
    view.k = Math.max(
      ZOOM_MIN,
      Math.min(FIT_ZOOM_MAX, (width - 2 * FIT_MARGIN) / (right - left || 1), (height - 2 * FIT_MARGIN) / (bottom - top || 1)),
    );
    view.x = width / 2 - (view.k * (left + right)) / 2;
    view.y = height / 2 - (view.k * (top + bottom)) / 2;
  };

  const links = forceLink<Node, Edge>().distance(70);
  const simulation = forceSimulation<Node>()
    .force("link", links)
    .force("charge", forceManyBody().strength(-220))
    // A weak pull to the middle, so notes without links stay near the rest.
    .force("x", forceX().strength(0.06))
    .force("y", forceY().strength(0.06))
    .on("tick", () => {
      if (fit) fitView();
      draw();
    })
    .on("end", () => {
      fit = false;
    })
    .stop();

  function paint() {
    frame = 0;
    const [width, height, ratio] = [canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio];
    // Setting the size clears the canvas, so only when it changed.
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const lit = (node: Node) => !hovered || node === hovered || hovered.near.has(node);

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    // All lines of one colour are one path, and so are all dots: a few thousand are drawn in one go.
    const stroke = (list: Edge[], colour: string, alpha: number) => {
      ctx.beginPath();
      for (const { source, target } of list) {
        ctx.moveTo(source.x!, source.y!);
        ctx.lineTo(target.x!, target.y!);
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1 / view.k;
      ctx.stroke();
    };
    const fill = (list: Node[], colour: string, alpha: number) => {
      ctx.beginPath();
      for (const node of list) {
        ctx.moveTo(node.x! + radius(node), node.y!);
        ctx.arc(node.x!, node.y!, radius(node), 0, 2 * Math.PI);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      ctx.fill();
      // A thin ring in the background's colour, so a line stops short of the dot it leads to.
      ctx.strokeStyle = look.halo;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
    };
    if (hovered) {
      const at = hovered;
      stroke(shownEdges, look.edge, DIM);
      stroke(shownEdges.filter((e) => e.source === at || e.target === at), look.hover, 1);
      fill(shown.filter((node) => !lit(node)), look.node, DIM);
      fill(shown.filter((node) => lit(node) && node !== at), look.node, 1);
      fill([at], look.hover, 1);
    } else {
      stroke(shownEdges, look.edge, 1);
      fill(shown, look.node, 1);
    }
    // The note that was open when the graph was opened: in its own colour, with a ring.
    const mark = shown.find((node) => node.path === marked);
    if (mark) {
      fill([mark], look.open, lit(mark) ? 1 : DIM);
      ctx.beginPath();
      ctx.arc(mark.x!, mark.y!, radius(mark) + 3 / view.k, 0, 2 * Math.PI);
      ctx.strokeStyle = look.open;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
    }
    ctx.restore();

    // Labels, in screen px so the text keeps its size at every zoom.
    ctx.font = look.font;
    ctx.fillStyle = look.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Each label has an outline in the background's colour, so it reads over lines and dots.
    ctx.strokeStyle = look.halo;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    // A label is left out when it would cover one that matters more: the pointed-at note first, then the
    // marked one, then the pointed-at note's neighbours, then the notes with the most links.
    const labelled: Node[] = [];
    const boxes: LabelBox[] = [];
    for (const node of shown) {
      const r = radius(node) * view.k;
      const near = hovered !== null && lit(node);
      if (r < LABEL_MIN_RADIUS && !near && node !== mark) continue;
      const [x, y] = [node.x! * view.k + view.x, node.y! * view.k + view.y + r + 5];
      if (x < -100 || x > width + 100 || y < -20 || y > height) continue;
      const textWidth = ctx.measureText(node.name).width;
      const rank = node.links + (node === hovered ? 3e9 : node === mark ? 2e9 : near ? 1e9 : 0);
      labelled.push(node);
      boxes.push({ left: x - textWidth / 2, top: y, width: textWidth, height: look.fontSize, rank });
    }
    for (const index of placeLabels(boxes)) {
      const [node, box] = [labelled[index], boxes[index]];
      ctx.globalAlpha = lit(node) ? 1 : DIM;
      ctx.strokeText(node.name, box.left + box.width / 2, box.top);
      ctx.fillText(node.name, box.left + box.width / 2, box.top);
    }
    ctx.globalAlpha = 1;
  }

  /** Works out which nodes and edges the filter leaves. */
  const applyFilter = () => {
    const wanted = filter.trim().toLowerCase();
    shown = wanted ? nodes.filter((node) => node.name.toLowerCase().includes(wanted)) : nodes;
    const kept = new Set(shown);
    shownEdges = wanted ? edges.filter((e) => kept.has(e.source) && kept.has(e.target)) : edges;
    if (hovered && !kept.has(hovered)) hovered = null;
    if (fit) fitView();
    draw();
  };

  /** Fetches the graph and lays it out. Notes that were there keep their place, and the view stays as it is. */
  async function load() {
    const data = await call<Data>("vault.graph");
    const text = JSON.stringify(data);
    if (destroyed || text === built) return;
    const first = built === "";
    built = text;
    const before = new Map(nodes.map((node) => [node.path, node]));
    nodes = data.nodes.map(({ path, links }) => {
      const { x, y, vx, vy } = before.get(path) ?? {};
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      return { path, name, links, near: new Set<Node>(), x, y, vx, vy };
    });
    const byPath = new Map(nodes.map((node) => [node.path, node]));
    edges = data.edges.map(({ from, to }) => ({ source: byPath.get(from)!, target: byPath.get(to)! }));
    for (const { source, target } of edges) {
      source.near.add(target);
      target.near.add(source);
    }
    // A new note starts next to a note it is linked with, not at the far end of the layout.
    if (!first) {
      for (const node of nodes) {
        const anchor = node.x === undefined && [...node.near].find((other) => other.x !== undefined);
        if (anchor) [node.x, node.y] = [anchor.x! + 20, anchor.y! + 20];
      }
    }
    hovered = hovered && (byPath.get(hovered.path) ?? null);
    simulation.nodes(nodes);
    links.links(edges);
    // The first layout runs in full. After a change the graph only loosens enough to make room.
    simulation.alpha(first ? 1 : 0.3).restart();
    // The layout runs on animation frames too. In a hidden window it is worked out in one go.
    // shortcut: 300 steps at once block the window for a moment in a vault of thousands of notes;
    // do them in slices on a timer if that is ever noticed
    if (document.hidden) simulation.stop().tick(300);
    applyFilter();
  }

  /** The topmost shown node under a pointer event, if any. */
  const nodeAt = (event: MouseEvent): Node | null => {
    const box = canvas.getBoundingClientRect();
    const [x, y] = [(event.clientX - box.left - view.x) / view.k, (event.clientY - box.top - view.y) / view.k];
    // A little slack around small dots, so they can be hit.
    const slack = 3 / view.k;
    for (let i = shown.length - 1; i >= 0; i--) {
      const node = shown[i];
      if (Math.hypot(node.x! - x, node.y! - y) <= radius(node) + slack) return node;
    }
    return null;
  };

  const hover = (node: Node | null) => {
    if (node === hovered) return;
    hovered = node;
    canvas.style.cursor = node ? "pointer" : "";
    draw();
  };

  /** The press in progress: on a node (which a move drags and a release without a move opens) or on the background (a move pans). */
  let press: { node: Node | null; x: number; y: number; moved: boolean } | null = null;

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    press = { node: nodeAt(event), x: event.clientX, y: event.clientY, moved: false };
    hover(press.node);
    try {
      // Keeps the moves coming when the pointer leaves the window.
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know: events dispatched by `ui_drag` (src/uiDrive.ts). They need no capture.
    }
  };
  // Moves and the release are listened for on the window, so a drag goes on outside the canvas.
  const onMove = (event: PointerEvent) => {
    if (!press) return hover(event.target === canvas ? nodeAt(event) : null);
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_START) return;
    press.moved = true;
    fit = false;
    if (press.node) {
      const box = canvas.getBoundingClientRect();
      // `fx` and `fy` hold a node in place while the layout moves the others around it.
      press.node.fx = (event.clientX - box.left - view.x) / view.k;
      press.node.fy = (event.clientY - box.top - view.y) / view.k;
      simulation.alphaTarget(0.3).restart();
    } else {
      view.x += event.clientX - press.x;
      view.y += event.clientY - press.y;
      [press.x, press.y] = [event.clientX, event.clientY];
      draw();
    }
  };
  const onUp = () => {
    if (!press) return;
    const { node, moved } = press;
    press = null;
    if (!node) return;
    node.fx = node.fy = null;
    simulation.alphaTarget(0);
    if (!moved) onOpen(node.path);
  };
  // The wheel zooms around the pointer. A pinch on a trackpad arrives as a wheel event with `ctrlKey`, in smaller steps.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    fit = false;
    const box = canvas.getBoundingClientRect();
    const [x, y] = [event.clientX - box.left, event.clientY - box.top];
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002))));
    view.x = x - ((x - view.x) * k) / view.k;
    view.y = y - ((y - view.y) * k) / view.k;
    view.k = k;
    draw();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  const resized = new ResizeObserver(() => {
    if (fit) fitView();
    draw();
  });
  resized.observe(canvas);

  // The look changes when the vault's theme or snippets do (config.ts puts them in <style> elements at the end
  // of <head>) and when the app turns light or dark (`data-appearance` on <html>, or the system's setting while
  // that attribute is not there).
  const restyle = () => {
    look = readLook();
    draw();
  };
  const styles = new MutationObserver(restyle);
  styles.observe(document.head, { childList: true, subtree: true, characterData: true });
  styles.observe(document.documentElement, { attributes: true });
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", restyle);

  return {
    load,
    filter(text: string) {
      filter = text;
      applyFilter();
    },
    /** For `ui_state`: the notes and edges shown (those the filter leaves), the filter text, and the note under the pointer. */
    uiState: () => ({ nodes: shown.length, edges: shownEdges.length, filter, hovered: hovered?.path ?? null }),
    destroy() {
      destroyed = true;
      simulation.stop();
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      resized.disconnect();
      styles.disconnect();
      dark.removeEventListener("change", restyle);
    },
  };
}

/**
 * The graph view: every note of the vault as a dot, every link as a line. Shown with no file of its own
 * (`AppApi.views.show`), so `path` is the note that was open, which is marked.
 */
export default function View({ ref, path, onOpen, refresh }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<ReturnType<typeof createGraph> | null>(null);
  const [text, setText] = useState("");
  // The newest `onOpen`, for the graph, which is made once.
  const opener = useRef(onOpen);
  opener.current = onOpen;

  const filter = (value: string) => {
    setText(value);
    graph.current?.filter(value);
  };

  useEffect(() => {
    const made = createGraph(canvas.current!, path, (note) => opener.current(note));
    graph.current = made;
    const handle = { filter };
    open.view = handle;
    return () => {
      made.destroy();
      graph.current = null;
      if (open.view === handle) open.view = null;
    };
    // `path`: the note to mark is the one that was open when the graph was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On opening, and again whenever files in the vault changed.
  useEffect(() => {
    graph.current?.load().catch(console.error);
  }, [refresh]);

  useImperativeHandle(ref, () => ({ uiState: () => ({ graph: graph.current?.uiState() ?? null }) }), []);

  return (
    <div className="graph">
      <label className="graph-controls">
        <Search size={14} />
        <input
          className="graph-filter"
          placeholder="Filter notes by name"
          value={text}
          onChange={(e) => filter(e.target.value)}
          spellCheck={false}
        />
      </label>
      <canvas ref={canvas} />
    </div>
  );
}
