// The notes a pane has shown, for Back and Forward. Plain data and pure functions, so each pane can keep its own.

export interface History {
  /** Note paths, oldest first. */
  stack: string[];
  /** Where in `stack` the note on screen is, or -1 with none. */
  index: number;
}

export const NO_HISTORY: History = { stack: [], index: -1 };

// shortcut: nothing older than this is kept, raise it if anyone goes back further
const MAX = 100;

/** After opening `path` by any way other than Back and Forward: it goes after the current note, and what was ahead is dropped. */
export function visit(h: History, path: string): History {
  if (h.stack[h.index] === path) return h;
  const stack = [...h.stack.slice(0, h.index + 1), path].slice(-MAX);
  return { stack, index: stack.length - 1 };
}

/** The note `step` places away (-1 is Back, 1 is Forward), or undefined at the end. */
export const peek = (h: History, step: number): string | undefined => h.stack[h.index + step];

/** After going there. */
export const move = (h: History, step: number): History => (peek(h, step) === undefined ? h : { ...h, index: h.index + step });

/** After a rename: the note keeps its places under the new path. */
export const renamed = (h: History, from: string, to: string): History => ({
  ...h,
  stack: h.stack.map((p) => (p === from ? to : p)),
});

/** After a delete: the note is taken out, and the current note stays the current one where it can. */
export function removed(h: History, path: string): History {
  const stack: string[] = [];
  let index = -1;
  h.stack.forEach((p, i) => {
    // Also drops a note that would now come twice in a row.
    if (p !== path && p !== stack[stack.length - 1]) stack.push(p);
    if (i === h.index) index = stack.length - 1;
  });
  return { stack, index };
}
