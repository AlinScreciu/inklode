// A list a module reads from the core and reads again when the vault changed, kept for its panel, its ribbon
// count and `ui_state` (the health and tasks modules).

export interface Polled<T> {
  /** For React's `useSyncExternalStore`, with `get`. */
  subscribe(listener: () => void): () => void;
  /** What was last read: the same object until the next reading. */
  get(): T;
  /** Reads again. Resolves when `get` gives the answer. */
  refresh(): Promise<void>;
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
