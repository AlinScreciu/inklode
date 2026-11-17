// Self-check for history.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { move, NO_HISTORY, peek, removed, renamed, visit } from "./history.ts";

let h = ["a", "b", "c"].reduce(visit, NO_HISTORY);
assert.deepEqual(h, { stack: ["a", "b", "c"], index: 2 });
assert.equal(visit(h, "c"), h, "opening the note that is open adds nothing");
assert.equal(peek(h, 1), undefined);
assert.equal(move(h, 1), h);

h = move(move(h, -1), -1);
assert.equal(h.index, 0);
assert.equal(peek(h, -1), undefined);
assert.equal(peek(h, 1), "b");

// Opening a note from the middle drops what was ahead.
assert.deepEqual(visit(move(h, 1), "d"), { stack: ["a", "b", "d"], index: 2 });

assert.deepEqual(renamed(h, "b", "B"), { stack: ["a", "B", "c"], index: 0 });

// Deleting: the current note stays current, and neighbours that are now the same note become one.
const back = { stack: ["a", "b", "a", "c"], index: 3 };
assert.deepEqual(removed(back, "b"), { stack: ["a", "c"], index: 1 });
assert.deepEqual(removed(back, "c"), { stack: ["a", "b", "a"], index: 2 });
assert.deepEqual(removed({ stack: ["a"], index: 0 }, "a"), { stack: [], index: -1 });

console.log("history: ok");
