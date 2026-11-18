// Draws a graph on a canvas, lays it out with d3-force and handles the pointer. Used by both graphs: the full
// one (View.tsx) and the local one (Local.tsx), through Pane.tsx.
//
// What costs what, which keeps a vault of thousands of notes smooth:
// - a display option (arrows, sizes, the text threshold, groups, the name filter) only paints again;
// - a force changes the running layout's numbers and warms it up, and no node is made again;
// - a filter that adds or removes nodes hands the layout the new set, where every node that was there keeps its place.

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { call } from "./index";
import { placeLabels, type LabelBox } from "./labels";
import { build, type Data, type Item, type Model, visible } from "./model";
import { colourOf, GROUP_COLOURS, type Options, shown as shownOptions, type Which } from "./options";

interface Node extends SimulationNodeDatum {
  item: Item;
  /** Its place in the model's items. */
  at: number;
  /** The name in lower case, for the name filter. */
  lower: string;
  /** How many of its links show: in the full graph those the filters let through, in the local graph those drawn. Sets the dot's size. */
  links: number;
  /** How many links it has in the layout. Sets how hard each pulls. */
  pulls: number;
  /** The nodes it is linked with, of those in the layout. */
  near: Set<Node>;
  /** The colour of its dot: its group's, else its kind's. */
  colour: string;
  /** How wide its label is in the label font, in px. 0 until measured. */
  labelWidth: number;
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
/** Space kept free around the graph when it is fitted, in px, or less in a narrow pane. */
const FIT_MARGIN = 60;
/**
 * With the text threshold at 0, a note has its label when its dot is at least this many px across half on
 * screen, so zooming out leaves the labels of the most linked notes. Each step of the threshold doubles it.
 */
const LABEL_MIN_RADIUS = 3;
/** A label fades in over the last part of the way to the threshold: at this share of it the label starts to show. */
const LABEL_FADE_FROM = 0.8;
/** The pointer has to move this many px with the button down before it is a drag and not a click. */
const DRAG_START = 4;
/** In a hidden window the layout is worked out in slices of this many ms, with a turn for everything else between two. */
const HIDDEN_SLICE = 100;
/** An arrowhead smaller than this on screen, in px, is not drawn: zoomed out, they would only be noise. */
const ARROW_MIN = 2.5;

/** The options that decide which nodes there are. A change of one gives the layout another set of nodes. */
const SHAPING = ["tags", "attachments", "existingOnly", "orphans", "depth"] as const;
const FORCES = ["centerForce", "repelForce", "linkForce", "linkDistance"] as const;

/**
 * Draws a graph on `canvas` and handles the pointer. `which` says whether it is the whole vault or the
 * surroundings of the note at `centre`; that note is marked. `onOpen` is called with the path of a clicked
 * note or file. Returns what the React component needs.
 */
export function createGraph(canvas: HTMLCanvasElement, which: Which, centre: string, initial: Options, onOpen: (path: string) => void) {
  const ctx = canvas.getContext("2d")!;
  let options = initial;
  let model: Model = { items: [], links: [] };
  /** A node for every item of the model, in that order, also for those no filter lets through: they keep their place. */
  let all: Node[] = [];
  /** What the filters leave: the nodes and edges the layout moves. */
  let laid: Node[] = [];
  let laidEdges: Edge[] = [];
  /** Of those, what the name filter leaves. Only these are drawn and can be pointed at. */
  let shown: Node[] = [];
  let shownEdges: Edge[] = [];
  let hovered: Node | null = null;
  /** The data the graph was last built from, as text, to tell whether a change in the vault changed the graph. */
  let built = "";
  /** A point of the graph is drawn at `point * k + (x, y)`, in CSS px from the canvas's top left. */
  const view = { x: 0, y: 0, k: 1 };
  /** Whether the view follows the layout so the whole graph stays in the pane. Off once a layout settled or the user moved the view. */
  let fit = true;
  let frame = 0;
  /** How many labels the last paint drew, for `ui_state`. */
  let labels = 0;
  /** Set by `destroy`, for a `load` that was still waiting for the core. */
  let destroyed = false;

  /** Colours, font and dot size, from the CSS variables in src/app.css. */
  const readLook = () => {
    const style = getComputedStyle(canvas);
    // A variable may be a `color-mix` of others. As the colour of an element it comes back worked out, which is what a canvas takes.
    const probe = canvas.parentElement!.appendChild(document.createElement("span"));
    const colour = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const look = {
      note: colour("--graph-node"),
      tag: colour("--graph-tag"),
      attachment: colour("--graph-attachment"),
      unresolved: colour("--graph-unresolved"),
      groups: Array.from({ length: GROUP_COLOURS }, (_, n) => colour(`--graph-group-${n + 1}`)),
      edge: colour("--graph-edge"),
      open: colour("--graph-open"),
      hover: colour("--graph-hover"),
      halo: colour("--graph-label-halo"),
      // `.graph canvas` sets these two from `--graph-label` and `--graph-label-size`, which gives the size in px.
      label: style.color,
      font: `${style.fontSize} ${style.fontFamily}`,
      fontSize: parseFloat(style.fontSize),
      size: parseFloat(style.getPropertyValue("--graph-node-size")) || 4,
    };
    probe.remove();
    return look;
  };
  let look = readLook();
  const radius = (node: Node) => look.size * options.nodeSize * (1 + Math.sqrt(node.links) / 2);

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
    for (const node of shown) {
      const [{ x = 0, y = 0 }, r] = [node, radius(node)];
      left = Math.min(left, x - r);
      right = Math.max(right, x + r);
      top = Math.min(top, y - r);
      bottom = Math.max(bottom, y + r);
    }
    const [width, height] = [canvas.clientWidth, canvas.clientHeight];
    const margin = Math.min(FIT_MARGIN, width * 0.15, height * 0.15);
    view.k = Math.max(ZOOM_MIN, Math.min(FIT_ZOOM_MAX, (width - 2 * margin) / (right - left || 1), (height - 2 * margin) / (bottom - top || 1)));
    view.x = width / 2 - (view.k * (left + right)) / 2;
    view.y = height / 2 - (view.k * (top + bottom)) / 2;
  };

  const links = forceLink<Node, Edge>();
  const charge = forceManyBody<Node>();
  // A pull to the middle, so notes without links stay near the rest.
  const [pullX, pullY] = [forceX<Node>(), forceY<Node>()];
  /** Gives the forces the options' numbers. */
  const setForces = () => {
    links
      .distance(options.linkDistance)
      // A link pulls less the more links its ends have, as d3 does by default, times the option. Above 1 the layout would swing.
      .strength(({ source, target }) => Math.min(1, options.linkForce / Math.min(source.pulls, target.pulls)));
    charge.strength(-options.repelForce);
    pullX.strength(options.centerForce);
    pullY.strength(options.centerForce);
  };
  setForces();
  const simulation = forceSimulation<Node>()
    .force("link", links)
    .force("charge", charge)
    .force("x", pullX)
    .force("y", pullY)
    .on("tick", () => {
      if (fit) fitView();
      draw();
    })
    .on("end", () => {
      fit = false;
    })
    .stop();

  const moving = () => simulation.alpha() >= simulation.alphaMin();
  // The layout runs on animation frames, and a window that is covered or minimised gets none. There it is
  // worked out on a timer, a slice at a time, so the window still answers (`ui_state`, a note that opens)
  // while a vault of thousands of notes is laid out.
  let slice: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    slice = undefined;
    if (destroyed || !document.hidden) return run();
    const until = performance.now() + HIDDEN_SLICE;
    while (moving() && performance.now() < until) simulation.tick();
    if (fit) fitView();
    if (!moving()) fit = false;
    paint();
    run();
  };
  /** Keeps the layout going while it has not come to rest, the way the window's state asks for. */
  const run = () => {
    clearTimeout(slice);
    slice = undefined;
    if (destroyed || !moving()) return;
    if (!document.hidden) return void simulation.restart();
    simulation.stop();
    slice = setTimeout(step, 0);
  };
  document.addEventListener("visibilitychange", run);
  /** Makes the layout move again, from `alpha` (1 is a layout from scratch) or from where it is if that is warmer. */
  const heat = (alpha: number) => {
    simulation.alpha(Math.max(alpha, simulation.alpha()));
    run();
  };

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
    const at = hovered;
    const lit = (node: Node) => !at || node === at || at.near.has(node);

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
      ctx.lineWidth = options.linkThickness / view.k;
      ctx.stroke();
      // An arrowhead at the end the link points to, its tip on the dot's edge.
      const length = 5 + 2 * options.linkThickness;
      if (!options.arrows || length * view.k < ARROW_MIN) return;
      ctx.beginPath();
      for (const { source, target } of list) {
        const [dx, dy] = [target.x! - source.x!, target.y! - source.y!];
        const distance = Math.hypot(dx, dy);
        if (distance === 0) continue;
        const [ux, uy] = [dx / distance, dy / distance];
        const [tipX, tipY] = [target.x! - ux * radius(target), target.y! - uy * radius(target)];
        const [baseX, baseY] = [tipX - ux * length, tipY - uy * length];
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX - uy * length * 0.45, baseY + ux * length * 0.45);
        ctx.lineTo(baseX + uy * length * 0.45, baseY - ux * length * 0.45);
        ctx.closePath();
      }
      ctx.fillStyle = colour;
      ctx.fill();
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
    /** The dots of `list`, each colour in one go. A link target that reaches nothing is a ring: there is no note to fill it. */
    const dots = (list: Node[], alpha: number) => {
      const byColour = new Map<string, Node[]>();
      const missing: Node[] = [];
      for (const node of list) {
        if (node.item.kind === "unresolved") {
          missing.push(node);
          continue;
        }
        const same = byColour.get(node.colour);
        if (same) same.push(node);
        else byColour.set(node.colour, [node]);
      }
      for (const [colour, same] of byColour) fill(same, colour, alpha);
      if (!missing.length) return;
      fill(missing, look.halo, 1);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = look.unresolved;
      ctx.stroke();
    };
    if (at) {
      stroke(shownEdges.filter((e) => e.source !== at && e.target !== at), look.edge, DIM);
      stroke(shownEdges.filter((e) => e.source === at || e.target === at), look.hover, 1);
      dots(shown.filter((node) => !lit(node)), DIM);
      dots(shown.filter((node) => lit(node) && node !== at), 1);
      fill([at], look.hover, 1);
    } else {
      stroke(shownEdges, look.edge, 1);
      dots(shown, 1);
    }
    // The note the graph is about (the one that was open, or the local graph's own): in its own colour, with a ring.
    const mark = centre ? shown.find((node) => node.item.path === centre) : undefined;
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
    const strengths: number[] = [];
    const threshold = LABEL_MIN_RADIUS * 2 ** options.textFade;
    for (const node of shown) {
      const r = radius(node) * view.k;
      const near = at !== null && lit(node);
      // How much of the label shows: none under the threshold's start, all of it from the threshold on.
      const strength = near || node === mark ? 1 : Math.min(1, (r / threshold - LABEL_FADE_FROM) / (1 - LABEL_FADE_FROM));
      if (strength <= 0) continue;
      const [x, y] = [node.x! * view.k + view.x, node.y! * view.k + view.y + r + 5];
      if (x < -100 || x > width + 100 || y < -20 || y > height) continue;
      // Measuring text is slow, and a name's width only changes with the font.
      node.labelWidth ||= ctx.measureText(node.item.name).width;
      const rank = node.links + (node === at ? 3e9 : node === mark ? 2e9 : near ? 1e9 : 0);
      labelled.push(node);
      strengths.push(strength);
      let left = x - node.labelWidth / 2;
      // The local graph's pane is narrow: a label is moved in from the edge it would be cut at.
      if (which === "local" && node.labelWidth < width - 8) left = Math.min(Math.max(left, 4), width - 4 - node.labelWidth);
      boxes.push({ left, top: y, width: node.labelWidth, height: look.fontSize, rank });
    }
    const placed = placeLabels(boxes);
    for (const index of placed) {
      const [node, box] = [labelled[index], boxes[index]];
      ctx.globalAlpha = strengths[index] * (lit(node) ? 1 : DIM);
      ctx.strokeText(node.item.name, box.left + box.width / 2, box.top);
      ctx.fillText(node.item.name, box.left + box.width / 2, box.top);
    }
    labels = placed.length;
    ctx.globalAlpha = 1;
  }

  /** Works out which nodes and edges the name filter leaves of those in the layout. */
  const applyFilter = () => {
    const wanted = options.filter.trim().toLowerCase();
    shown = wanted ? laid.filter((node) => node.lower.includes(wanted)) : laid;
    const kept = new Set(shown);
    shownEdges = wanted ? laidEdges.filter((e) => kept.has(e.source) && kept.has(e.target)) : laidEdges;
    if (hovered && !kept.has(hovered)) hovered = null;
    if (fit) fitView();
    draw();
  };

  /** Gives every node its colour: that of the first group it matches, else that of its kind. */
  const colour = () => {
    for (const node of all) {
      // A tag and a missing note have no file to match a path or a name of a note against.
      const group = node.item.path ? colourOf(options.groups, node.item) : 0;
      node.colour = group ? look.groups[group - 1] : look[node.item.kind];
    }
  };

  /**
   * Hands the layout the nodes and edges the filters leave, and warms it up from `alpha`. A node that was in the
   * layout keeps its place. One that comes in starts next to a node it is linked with: in the full graph only
   * when it has no place yet, in the local one always, since its old place belongs to another neighbourhood.
   */
  const shape = (alpha: number) => {
    const local = which === "local" ? { path: centre || null, depth: options.depth } : undefined;
    const now = visible(model, options, local);
    const before = new Set(laid);
    laid = now.items.map((at) => all[at]);
    for (const node of all) {
      node.links = now.degree[node.at];
      node.pulls = 0;
      node.near = new Set();
    }
    laidEdges = now.links.map((at) => ({ source: all[model.links[at][0]], target: all[model.links[at][1]] }));
    for (const { source, target } of laidEdges) {
      source.near.add(target);
      target.near.add(source);
      source.pulls++;
      target.pulls++;
    }
    // A hub of the vault with one link in this neighbourhood is a small dot here.
    if (which === "local") for (const node of laid) node.links = node.pulls;
    if (before.size) {
      for (const node of laid) {
        if (before.has(node) || (which === "full" && node.x !== undefined)) continue;
        let anchor: Node | undefined;
        for (const other of node.near) if (before.has(other) && other.x !== undefined) anchor ??= other;
        // Around the anchor, each at another angle, so nodes that come in together do not start on one spot.
        // With no anchor the layout places it (it does that for a node without `x`).
        [node.x, node.y] = anchor ? [anchor.x! + 20 * Math.cos(node.at), anchor.y! + 20 * Math.sin(node.at)] : [undefined, undefined];
        node.vx = node.vy = undefined;
      }
    }
    hovered = hovered && laid.includes(hovered) ? hovered : null;
    // The local graph is small and changes whole: it is fitted to the pane again.
    if (which === "local") fit = true;
    simulation.nodes(laid);
    links.links(laidEdges);
    setForces();
    heat(alpha);
    applyFilter();
  };

  /** Fetches the graph and lays it out. Nodes that were there keep their place, and the view stays as it is. */
  async function load() {
    const data = await call<Data>("vault.graph");
    const text = JSON.stringify(data);
    if (destroyed || text === built) return;
    const first = built === "";
    built = text;
    const before = new Map(all.map((node) => [node.item.id, node]));
    model = build(data);
    all = model.items.map((item, at) => {
      const { x, y, vx, vy } = before.get(item.id) ?? {};
      return { item, at, lower: item.name.toLowerCase(), links: 0, pulls: 0, near: new Set<Node>(), colour: "", labelWidth: 0, x, y, vx, vy };
    });
    // The nodes of before are gone: what was laid out is found again by id, for `shape` to know what keeps its place.
    const now = new Map(all.map((node) => [node.item.id, node]));
    laid = laid.flatMap((node) => now.get(node.item.id) ?? []);
    hovered = (hovered && now.get(hovered.item.id)) ?? null;
    colour();
    // The first layout runs in full. After a change the graph only loosens enough to make room.
    shape(first ? 1 : 0.3);
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
    // Only what has a file opens on a click.
    canvas.style.cursor = node?.item.path ? "pointer" : "";
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
    // A tag and a link target that reaches nothing have no file to open.
    if (!moved && node.item.path) onOpen(node.item.path);
  };
  /** Zooms to `k` with the point at `x`, `y` of the canvas staying where it is. */
  const zoom = (k: number, x: number, y: number) => {
    fit = false;
    k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
    view.x = x - ((x - view.x) * k) / view.k;
    view.y = y - ((y - view.y) * k) / view.k;
    view.k = k;
    draw();
  };
  // The wheel zooms around the pointer. A pinch on a trackpad arrives as a wheel event with `ctrlKey`, in smaller steps.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const box = canvas.getBoundingClientRect();
    zoom(view.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - box.left, event.clientY - box.top);
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
    for (const node of all) node.labelWidth = 0;
    colour();
    draw();
  };
  const styles = new MutationObserver(restyle);
  styles.observe(document.head, { childList: true, subtree: true, characterData: true });
  styles.observe(document.documentElement, { attributes: true });
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", restyle);

  return {
    load,
    /** Takes the options as they are now and does what the change needs, and no more (the top of this file). */
    setOptions(next: Options) {
      const previous = options;
      options = next;
      const changed = (keys: readonly (keyof Options)[]) => keys.some((key) => previous[key] !== next[key]);
      if (changed(["groups"])) colour();
      if (changed(SHAPING.filter((key) => key !== "depth" || which === "local"))) {
        shape(0.3);
      } else if (changed(FORCES)) {
        setForces();
        // Warm enough that the effect shows at once.
        heat(0.5);
      }
      // Also draws, which is all a display option needs.
      applyFilter();
    },
    /** The local graph: shows the surroundings of another note. */
    setCentre(path: string) {
      if (path === centre) return;
      centre = path;
      if (which === "local" && built) shape(0.5);
      else draw();
    },
    /** Zooms to `k` around the middle of the pane, or without it so that the whole graph is in the pane. */
    zoom(k?: number) {
      if (k === undefined) {
        fitView();
        draw();
      } else zoom(k, canvas.clientWidth / 2, canvas.clientHeight / 2);
    },
    /**
     * For `ui_state`: how many nodes and edges show (what the filters leave), how many of each kind, the name
     * filter, the node under the pointer (a path, or a tag's or missing target's name), the zoom, how many
     * labels the last paint drew, whether the layout has come to rest, and the options.
     */
    uiState: () => ({
      nodes: shown.length,
      edges: shownEdges.length,
      kinds: Object.fromEntries((["note", "tag", "attachment", "unresolved"] as const).map((kind) => [kind, shown.filter((node) => node.item.kind === kind).length])),
      filter: options.filter,
      hovered: hovered ? hovered.item.path || hovered.item.name : null,
      zoom: view.k,
      labels,
      settled: simulation.alpha() < simulation.alphaMin(),
      options: shownOptions(which, options),
    }),
    destroy() {
      destroyed = true;
      simulation.stop();
      clearTimeout(slice);
      document.removeEventListener("visibilitychange", run);
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

export type GraphCanvas = ReturnType<typeof createGraph>;
