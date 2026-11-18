// What the graph is made of and which part of it shows: the notes, tags, attachments and unresolved link
// targets of `vault.graph` as one list of items with links between them, and the items the filters (and, for
// the local graph, the distance from its note) leave. No React and no DOM, so `pnpm test:graph` checks it.

/** What `vault.graph` returns (the table on `Core::call` in crates/core/src/call.rs). */
export interface Data {
  nodes: { path: string; links: number; tags?: string[] }[];
  edges: { from: string; to: string }[];
  unresolved: { name: string; from: number[] }[];
  attachments: { path: string; from: number[] }[];
}

export type Kind = "note" | "tag" | "attachment" | "unresolved";

export interface Item {
  /** Stays the same while the vault changes, so a node keeps its place: the kind and the path, tag or target. */
  id: string;
  kind: Kind;
  /** The label: a file name without `.md`, `#tag`, or a link target as written. */
  name: string;
  /** The file's path in the vault. Empty for a tag and an unresolved target, which have no file. */
  path: string;
  /** A note's tags, without `#`. */
  tags: string[];
}

export interface Model {
  items: Item[];
  /** Each link as two positions in `items`, from the item that has the link to the one it reaches. */
  links: [number, number][];
}

/** The filters that decide what shows (`Options` in options.ts has what each one means). */
export interface Filters {
  tags: boolean;
  attachments: boolean;
  existingOnly: boolean;
  orphans: boolean;
}

/** A drawing is a `.md` file to the core, and a picture to the reader: it counts as an attachment. */
const DRAWING = /\.excalidraw\.md$/i;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** The items and links of the whole vault. */
export function build(data: Data): Model {
  const items: Item[] = data.nodes.map(({ path, tags }) => {
    const kind = DRAWING.test(path) ? "attachment" : "note";
    return { id: `${kind}\n${path}`, kind, name: fileName(path), path, tags: tags ?? [] };
  });
  const at = new Map(data.nodes.map((node, index) => [node.path, index]));
  const links: [number, number][] = data.edges.map(({ from, to }) => [at.get(from)!, at.get(to)!]);
  const add = (item: Item, from: number[]) => {
    for (const note of from) links.push([note, items.length]);
    items.push(item);
  };
  for (const { path, from } of data.attachments) add({ id: `attachment\n${path}`, kind: "attachment", name: fileName(path), path, tags: [] }, from);
  for (const { name, from } of data.unresolved) add({ id: `unresolved\n${name.toLowerCase()}`, kind: "unresolved", name, path: "", tags: [] }, from);
  // One node per tag whatever its case, named as it is first written.
  const tags = new Map<string, { name: string; from: number[] }>();
  data.nodes.forEach(({ tags: has = [] }, note) => {
    for (const tag of has) {
      const entry = tags.get(tag.toLowerCase()) ?? { name: tag, from: [] };
      tags.set(tag.toLowerCase(), entry);
      entry.from.push(note);
    }
  });
  for (const [key, { name, from }] of tags) add({ id: `tag\n${key}`, kind: "tag", name: `#${name}`, path: "", tags: [] }, from);
  return { items, links };
}

export interface Visible {
  /** Positions in `Model.items` of what shows, in that order. */
  items: number[];
  /** Positions in `Model.links` of the links between them. */
  links: number[];
  /** For every item of the model: how many links it has among the kinds the filters let through. Sets a dot's size. */
  degree: Int32Array;
}

/**
 * What the filters leave. With `local`, only the item with that path and what is up to `depth` links away from
 * it, in either direction, through what the filters leave; that item shows whatever the filters say.
 */
export function visible(model: Model, filters: Filters, local?: { path: string | null; depth: number }): Visible {
  const { items, links } = model;
  const centre = local ? items.findIndex((item) => item.path !== "" && item.path === local.path) : -1;
  const allowed = (item: Item) =>
    item.kind === "note" ||
    (item.kind === "tag" && filters.tags) ||
    (item.kind === "attachment" && filters.attachments) ||
    (item.kind === "unresolved" && !filters.existingOnly);
  const on = items.map((item, index) => allowed(item) || index === centre);
  const degree = new Int32Array(items.length);
  let kept: number[] = [];
  links.forEach(([from, to], index) => {
    if (!on[from] || !on[to]) return;
    degree[from]++;
    degree[to]++;
    kept.push(index);
  });
  // Without a link: a note is an orphan, and anything else has nothing to say (a tag only a hidden drawing carries).
  let show = on.map((is, index) => is && (degree[index] > 0 || (items[index].kind === "note" && filters.orphans) || index === centre));

  if (local) {
    const near = new Array<boolean>(items.length).fill(false);
    if (centre >= 0) {
      const beside: number[][] = items.map(() => []);
      for (const index of kept) {
        const [from, to] = links[index];
        beside[from].push(to);
        beside[to].push(from);
      }
      near[centre] = true;
      let edge = [centre];
      for (let step = 0; step < local.depth; step++) {
        const next: number[] = [];
        for (const item of edge) {
          for (const other of beside[item]) {
            if (!near[other]) {
              near[other] = true;
              next.push(other);
            }
          }
        }
        edge = next;
      }
    }
    show = near;
    kept = kept.filter((index) => near[links[index][0]] && near[links[index][1]]);
  }
  return { items: show.flatMap((is, index) => (is ? [index] : [])), links: kept, degree };
}
