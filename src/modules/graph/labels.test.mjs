// Self-check for labels.ts, run by `pnpm test:graph` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { placeLabels } from "./labels.ts";

const box = (left, top, rank) => ({ left, top, width: 100, height: 12, rank });

// Labels that do not touch are all drawn, the most important first.
assert.deepEqual(placeLabels([box(0, 0, 1), box(200, 0, 3), box(0, 40, 2)]), [1, 2, 0]);

// Of two that overlap, the one with the higher rank stays, wherever it is in the list.
assert.deepEqual(placeLabels([box(0, 0, 1), box(50, 5, 2)]), [1]);
assert.deepEqual(placeLabels([box(0, 0, 2), box(50, 5, 1)]), [0]);

// A label dropped for one that outranks it does not take space: the third fits where the second was.
assert.deepEqual(placeLabels([box(0, 0, 3), box(60, 0, 2), box(110, 0, 1)]), [0, 2]);

// Boxes that only touch count as overlapping, so labels keep a gap.
assert.deepEqual(placeLabels([box(0, 0, 2), box(100, 0, 1)]), [0]);

// A ball of 400 labels on one spot leaves one.
assert.equal(placeLabels(Array.from({ length: 400 }, (_, n) => box(n % 7, n % 5, n))).length, 1);

console.log("labels ok");
