// The graph's options: what they are, their defaults and ranges, how they are read from `.inklode/graph.json`,
// and the small query language of the colour groups. No React and no DOM, so `pnpm test:graph` checks it.

/** The two graphs. Each has its own options. */
export type Which = "full" | "local";

/** Notes that match `query` are drawn in colour `colour`, a number from 1 to `GROUP_COLOURS` (`--graph-group-<n>`). */
export interface Group {
  query: string;
  colour: number;
}

export interface Options {
  /** Filters. `filter`: only what has this text in its name shows, without case. */
  filter: string;
  /** Each tag is a node, linked with the notes that carry it. */
  tags: boolean;
  /** Files that are not notes (images, drawings) and that a note links to or embeds are nodes. */
  attachments: boolean;
  /** Off: a link target that reaches nothing is a node too. */
  existingOnly: boolean;
  /** Notes without any link show. */
  orphans: boolean;
  /** The first group a note matches gives its colour. */
  groups: Group[];
  /** Display. `arrows`: a link shows which way it points. */
  arrows: boolean;
  /** How far to zoom in before names show: each step up doubles the zoom a name needs. */
  textFade: number;
  /** Multiplies the dots' size. */
  nodeSize: number;
  /** Multiplies the lines' width. */
  linkThickness: number;
  /** Forces of the layout. `centerForce`: the pull to the middle. */
  centerForce: number;
  /** How hard nodes push each other away. */
  repelForce: number;
  /** How hard a link pulls its two ends to `linkDistance`, as a multiple of the usual. */
  linkForce: number;
  /** The length a link wants to have, in px at zoom 1. */
  linkDistance: number;
  /** The local graph only: how many links away from its note a note may be. */
  depth: number;
}

/** How many group colours the stylesheet has: `--graph-group-1` to `--graph-group-8` in src/app.css. */
export const GROUP_COLOURS = 8;
/** The colours' names, for the picker, in the order of the variables. */
export const COLOUR_NAMES = ["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"];

/** The graph as it was before it had options. */
export const DEFAULTS: Options = {
  filter: "",
  tags: false,
  attachments: false,
  existingOnly: true,
  orphans: true,
  groups: [],
  arrows: false,
  textFade: 0,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.06,
  repelForce: 220,
  linkForce: 1,
  linkDistance: 70,
  depth: 1,
};

/** The sliders: lowest and highest value and the step between two. */
export const RANGES = {
  textFade: { min: -3, max: 3, step: 0.1 },
  nodeSize: { min: 0.25, max: 4, step: 0.05 },
  linkThickness: { min: 0.25, max: 5, step: 0.05 },
  centerForce: { min: 0, max: 0.5, step: 0.01 },
  repelForce: { min: 0, max: 1000, step: 10 },
  linkForce: { min: 0, max: 2, step: 0.05 },
  linkDistance: { min: 10, max: 300, step: 5 },
  depth: { min: 1, max: 3, step: 1 },
} satisfies Partial<Record<keyof Options, { min: number; max: number; step: number }>>;

export type Slider = keyof typeof RANGES;
const TOGGLES = ["tags", "attachments", "existingOnly", "orphans", "arrows"] as const;

const isSlider = (key: string): key is Slider => key in RANGES;
const isToggle = (key: string): key is (typeof TOGGLES)[number] => (TOGGLES as readonly string[]).includes(key);

/** `value` as the value of option `key`, or an error that says what the option takes. A number outside its range is brought to the nearest end. */
export function valid<K extends keyof Options>(key: K, value: unknown): Options[K];
export function valid(key: string, value: unknown): unknown {
  if (key === "filter") {
    if (typeof value !== "string") throw new Error("filter takes a text");
    return value;
  }
  if (isToggle(key)) {
    if (typeof value !== "boolean") throw new Error(`${key} takes true or false`);
    return value;
  }
  if (isSlider(key)) {
    const { min, max } = RANGES[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} takes a number from ${min} to ${max}`);
    const within = Math.min(max, Math.max(min, value));
    return key === "depth" ? Math.round(within) : within;
  }
  if (key === "groups") {
    if (!Array.isArray(value)) throw new Error("groups takes a list of {query, colour}");
    return value.map((group: unknown, index) => {
      const { query, colour = (index % GROUP_COLOURS) + 1 } = (typeof group === "object" && group !== null ? group : {}) as Record<string, unknown>;
      if (typeof query !== "string") throw new Error("a group needs a query, a text");
      if (typeof colour !== "number" || !Number.isInteger(colour) || colour < 1 || colour > GROUP_COLOURS) {
        throw new Error(`a group's colour is a number from 1 to ${GROUP_COLOURS}`);
      }
      return { query, colour };
    });
  }
  throw new Error(`The graph has no option "${key}". It has: ${Object.keys(DEFAULTS).join(", ")}`);
}

/** The options an object from the file says, each one that is missing or not valid being the default. */
function read(saved: unknown): Options {
  const options = { ...DEFAULTS };
  if (typeof saved !== "object" || saved === null) return options;
  for (const key of Object.keys(DEFAULTS) as (keyof Options)[]) {
    try {
      if (key in saved) (options as Record<string, unknown>)[key] = valid(key, (saved as Record<string, unknown>)[key]);
    } catch {
      // Not a value this option takes: the default stays.
    }
  }
  return options;
}

/** The options of both graphs from the text of `.inklode/graph.json`. A missing file (null) or one that is not such JSON gives the defaults. */
export function parse(text: string | null): Record<Which, Options> {
  let data: unknown = null;
  try {
    data = text === null ? null : JSON.parse(text);
  } catch {
    // Not JSON: the defaults.
  }
  const of = (which: Which) => read(typeof data === "object" && data !== null ? (data as Record<string, unknown>)[which] : null);
  return { full: of("full"), local: of("local") };
}

/** The options as a graph shows and saves them: the full graph has no depth. */
export function shown(which: Which, options: Options): Partial<Options> {
  if (which === "local") return options;
  const { depth: _, ...rest } = options;
  return rest;
}

/** The text of `.inklode/graph.json` for these options. */
export function serialize(options: Record<Which, Options>): string {
  return JSON.stringify({ full: shown("full", options.full), local: shown("local", options.local) }, null, 2) + "\n";
}

/** What a group's query is matched against. */
export interface Subject {
  /** The file name without `.md`. */
  name: string;
  /** The path in the vault. */
  path: string;
  /** Without `#`. */
  tags: string[];
}

/**
 * Whether a group's query matches. A query is words separated by spaces, and all of them have to match,
 * without case:
 *
 * - `word`: the name contains it;
 * - `path:Folder/Sub`: the path starts with it, so the note is in that folder (or its name there starts so);
 * - `tag:name` or `tag:#name`: the note has that tag, or one under it (`name/sub`).
 *
 * A word with a space in it goes in quotes: `path:"My Folder"`, `"to do"`. An empty query matches nothing.
 */
export function matches(query: string, subject: Subject): boolean {
  const terms = [...query.matchAll(/(?:(path|tag):)?(?:"([^"]*)"?|(\S+))/gi)];
  if (terms.length === 0) return false;
  return terms.every(([, kind, quoted, bare]) => {
    const text = (quoted ?? bare).toLowerCase();
    if (kind?.toLowerCase() === "path") return subject.path.toLowerCase().startsWith(text.replace(/^\//, ""));
    if (kind?.toLowerCase() === "tag") {
      const tag = text.replace(/^#/, "");
      return subject.tags.some((has) => has.toLowerCase() === tag || has.toLowerCase().startsWith(tag + "/"));
    }
    return subject.name.toLowerCase().includes(text);
  });
}

/** The colour of the first group that matches, or 0 when none does. */
export function colourOf(groups: Group[], subject: Subject): number {
  return groups.find((group) => matches(group.query, subject))?.colour ?? 0;
}
