// The options of the two graphs while the app runs, and their file in the vault: `.inklode/graph.json`,
// `{"full": {…}, "local": {…}}`, read and written through the core's `config.*` only.

import type { AppApi } from "../../modules";
import { DEFAULTS, type Options, parse, serialize, valid, type Which } from "./options";

const FILE = ".inklode/graph.json";
/** A change is written this long after the last one, in ms, so a slider that is dragged is one write. */
const SAVE_DELAY = 500;

let call: AppApi["core"]["call"];
let options = parse(null);
/** Counts the changes made here, so a read of the file that started before one does not undo it. */
let changes = 0;
/** The file's text as last read or written, null for no file. */
let onDisk: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function change(which: Which, next: Options) {
  options = { ...options, [which]: next };
  changes++;
  listeners.forEach((listener) => listener());
  clearTimeout(timer);
  // shortcut: a change made in the half second before another vault is opened is written to that vault;
  // write at once on a vault change if the app ever tells modules before it opens one.
  timer = setTimeout(() => {
    timer = undefined;
    const text = serialize(options);
    onDisk = text;
    call("config.write", { path: FILE, content: text }).catch(console.error);
  }, SAVE_DELAY);
}

export const store = {
  /** Called when the module is switched on. */
  init(core: AppApi["core"]["call"]) {
    call = core;
  },
  get: (which: Which) => options[which],
  /** For React's `useSyncExternalStore`. */
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Sets one option of one graph. Throws, saying what the option takes, when `value` is not that. */
  set(which: Which, key: string, value: unknown) {
    if (key === "depth" && which === "full") throw new Error("Only the local graph has a depth");
    const next = valid(key as keyof Options, value);
    if (JSON.stringify(next) !== JSON.stringify(options[which][key as keyof Options])) change(which, { ...options[which], [key]: next });
  },
  /** Puts every option of one graph back to its default. */
  reset(which: Which) {
    if (JSON.stringify(options[which]) !== JSON.stringify(DEFAULTS)) change(which, { ...DEFAULTS });
  },
  /** Reads the vault's file. Called when a graph opens and when files of the vault changed, which is also when another vault was opened. */
  async load() {
    const before = changes;
    const text = await call<{ content: string }>("config.read", { path: FILE }).then(
      (file) => file.content,
      () => null, // no file: the defaults
    );
    // What was changed here meanwhile, or waits to be written, is newer than the file.
    if (before !== changes || timer !== undefined || text === onDisk) return;
    onDisk = text;
    const read = parse(text);
    if (JSON.stringify(read) === JSON.stringify(options)) return;
    options = read;
    listeners.forEach((listener) => listener());
  },
};
