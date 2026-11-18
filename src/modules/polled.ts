// A list a module reads from the core and reads again when the vault changed, kept for its panel, its ribbon
// count and `ui_state` (the health and tasks modules). And `quiet`, for a list that costs too much to read at
// every change.

export interface Polled<T> {
  /** For React's `useSyncExternalStore`, with `get`. */
  subscribe(listener: () => void): () => void;
  /** What was last read: the same object until the next reading. */
  get(): T;
  /** Reads again. Resolves when `get` gives the answer. */
  refresh(): Promise<void>;
}

/** What `quiet` waits with: the window's timers, or a test's. */
export interface Timers {
  set(run: () => void, ms: number): number;
  clear(timer: number): void;
}

/**
 * `run` once its calls have stopped for `ms`: every call starts the wait again, so a row of changes (typing
 * that is saved every second, an agent that writes twenty notes) is one run after the last of them. `now` runs
 * at once and drops a run that waits, which it covers; `cancel` only drops it.
 */
export function quiet(run: () => void, ms: number, timers: Timers = { set: (f, wait) => window.setTimeout(f, wait), clear: (timer) => window.clearTimeout(timer) }) {
  let timer: number | null = null;
  const drop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const later = () => {
    drop();
    timer = timers.set(() => {
      timer = null;
      run();
    }, ms);
  };
  return Object.assign(later, {
    cancel: drop,
    now() {
      drop();
      run();
    },
    /** Whether a run waits. */
    waiting: () => timer !== null,
  });
}

/** `initial` until the first reading; `read` asks the core. */
export function polled<T>(initial: T, read: () => Promise<T>): Polled<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  // One reading at a time, and at most one waiting: that one sees everything that happened before it starts.
  let running: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => value,
    refresh() {
      waiting ??= running
        .catch(() => {})
        .then(() => {
          waiting = null;
          return read();
        })
        .then((next) => {
          value = next;
          listeners.forEach((listener) => listener());
        });
      running = waiting;
      return waiting;
    },
  };
}
