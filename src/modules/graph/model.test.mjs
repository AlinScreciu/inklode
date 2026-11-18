// Self-check for model.ts, run by `pnpm test:graph` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { build, visible } from "./model.ts";

// Hub links to a, b and a drawing; a links to c; c to d. Lone has no link. a and b carry tags, a embeds a
// picture and links to a note that does not exist.
const data = {
  nodes: [
    { path: "Hub.md", links: 3 },
    { path: "Lone.md", links: 0 },
    { path: "a.md", links: 2, tags: ["Work", "x/y"] },
    { path: "b.md", links: 1, tags: ["work"] },
    { path: "c.md", links: 2 },
    { path: "d.md", links: 1 },
    { path: "draw/Plan.excalidraw.md", links: 1 },
  ],
  edges: [
    { from: "Hub.md", to: "a.md" },
    { from: "Hub.md", to: "b.md" },
    { from: "Hub.md", to: "draw/Plan.excalidraw.md" },
    { from: "a.md", to: "c.md" },
    { from: "c.md", to: "d.md" },
  ],
  unresolved: [{ name: "Missing", from: [2] }],
  attachments: [{ path: "img/pic.png", from: [2] }],
};
const model = build(data);
const names = (shown) => shown.items.map((at) => model.items[at].name).sort();
const DEFAULT = { tags: false, attachments: false, existingOnly: true, orphans: true };

// A drawing is an attachment though it is a `.md` file, and tags that differ in case are one node.
assert.deepEqual(model.items.map((item) => [item.kind, item.name]), [
  ["note", "Hub"],
  ["note", "Lone"],
  ["note", "a"],
  ["note", "b"],
  ["note", "c"],
  ["note", "d"],
  ["attachment", "Plan.excalidraw"],
  ["attachment", "pic.png"],
  ["unresolved", "Missing"],
  ["tag", "#Work"],
  ["tag", "#x/y"],
]);
assert.equal(new Set(model.items.map((item) => item.id)).size, model.items.length);
assert.equal(model.links.length, 5 + 1 + 1 + 3);

// The defaults: the notes and the links between them.
const plain = visible(model, DEFAULT);
assert.deepEqual(names(plain), ["Hub", "Lone", "a", "b", "c", "d"]);
assert.equal(plain.links.length, 4);
// The size of a dot counts the links that show: Hub's link to the drawing does not.
assert.equal(plain.degree[0], 2);

// Each filter.
assert.deepEqual(names(visible(model, { ...DEFAULT, orphans: false })), ["Hub", "a", "b", "c", "d"]);
assert.deepEqual(names(visible(model, { ...DEFAULT, tags: true })), ["#Work", "#x/y", "Hub", "Lone", "a", "b", "c", "d"]);
assert.deepEqual(names(visible(model, { ...DEFAULT, attachments: true })), ["Hub", "Lone", "Plan.excalidraw", "a", "b", "c", "d", "pic.png"]);
assert.deepEqual(names(visible(model, { ...DEFAULT, existingOnly: false })), ["Hub", "Lone", "Missing", "a", "b", "c", "d"]);
const everything = visible(model, { tags: true, attachments: true, existingOnly: false, orphans: true });
assert.equal(everything.items.length, model.items.length);
assert.equal(everything.links.length, model.links.length);

// The local graph: the note and what is within `depth` links of it, whichever way a link points.
const around = (path, depth, filters = DEFAULT) => names(visible(model, filters, { path, depth }));
assert.deepEqual(around("a.md", 1), ["Hub", "a", "c"]);
assert.deepEqual(around("a.md", 2), ["Hub", "a", "b", "c", "d"]);
assert.deepEqual(around("d.md", 3), ["Hub", "a", "c", "d"]);
assert.equal(visible(model, DEFAULT, { path: "a.md", depth: 1 }).links.length, 2);
// Through a tag, when tags show: b carries the tag a carries.
assert.deepEqual(around("a.md", 1, { ...DEFAULT, tags: true }), ["#Work", "#x/y", "Hub", "a", "c"]);
assert.deepEqual(around("b.md", 2, { ...DEFAULT, tags: true }), ["#Work", "Hub", "a", "b"]);
// A note without links is alone in its graph, also with orphans hidden, and a drawing shows as the centre of its own.
assert.deepEqual(around("Lone.md", 3, { ...DEFAULT, orphans: false }), ["Lone"]);
assert.deepEqual(around("draw/Plan.excalidraw.md", 1), ["Hub", "Plan.excalidraw"]);
// No note, or a path the vault does not have: nothing.
assert.deepEqual(around(null, 2), []);
assert.deepEqual(around("nope.md", 2), []);

console.log("model ok");
