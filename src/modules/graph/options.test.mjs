// Self-check for options.ts, run by `pnpm test:graph` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { colourOf, DEFAULTS, matches, parse, RANGES, serialize, shown, valid } from "./options.ts";

// No file, a file that is not JSON and JSON that is not an object all give the defaults for both graphs.
for (const text of [null, "", "{not json", "[1, 2]", '"text"', '{"full": 3, "local": []}']) {
  assert.deepEqual(parse(text), { full: DEFAULTS, local: DEFAULTS }, String(text));
}

// Each graph has its own options. A value that is not valid is the default, and the others are kept.
const read = parse(
  JSON.stringify({
    full: { tags: true, nodeSize: 2, repelForce: "strong", groups: [{ query: "tag:work", colour: 3 }], unknown: 1 },
    local: { depth: 2, arrows: true, orphans: "no", groups: [{ query: 5 }] },
  }),
);
assert.deepEqual(read.full, { ...DEFAULTS, tags: true, nodeSize: 2, groups: [{ query: "tag:work", colour: 3 }] });
assert.deepEqual(read.local, { ...DEFAULTS, depth: 2, arrows: true });

// What is written is read back the same, and the full graph's part has no depth.
assert.deepEqual(parse(serialize(read)), read);
assert.equal("depth" in JSON.parse(serialize(read)).full, false);
assert.equal(JSON.parse(serialize(read)).local.depth, 2);
assert.equal("depth" in shown("full", DEFAULTS), false);

// A slider's default is inside its range, and a number outside is brought to the nearest end.
for (const [key, { min, max }] of Object.entries(RANGES)) assert.ok(DEFAULTS[key] >= min && DEFAULTS[key] <= max, key);
assert.equal(valid("nodeSize", 99), RANGES.nodeSize.max);
assert.equal(valid("linkDistance", -5), RANGES.linkDistance.min);
assert.equal(valid("depth", 2.4), 2);
assert.equal(valid("tags", true), true);
assert.equal(valid("filter", "abc"), "abc");
// A group without a colour gets one by its position.
assert.deepEqual(valid("groups", [{ query: "a" }, { query: "b", colour: 8 }]), [{ query: "a", colour: 1 }, { query: "b", colour: 8 }]);
assert.throws(() => valid("tags", "yes"), /true or false/);
assert.throws(() => valid("nodeSize", "2"), /number from 0.25 to 4/);
assert.throws(() => valid("groups", [{ query: "a", colour: 9 }]), /1 to 8/);
assert.throws(() => valid("colour", 1), /no option "colour"/);

// The query of a group.
const note = { name: "Release plan", path: "Projects/Inklode/Release plan.md", tags: ["Work/urgent", "idea"] };
assert.ok(matches("release", note));
assert.ok(matches("PLAN release", note), "every word has to match, in any order and case");
assert.ok(!matches("release notes", note));
assert.ok(matches("path:Projects", note));
assert.ok(matches("path:projects/inklode/", note));
assert.ok(matches("path:/Projects", note));
assert.ok(!matches("path:Inklode", note), "a path is matched from its start");
assert.ok(matches("tag:idea", note));
assert.ok(matches("tag:#IDEA", note));
assert.ok(matches("tag:work", note), "a tag matches the tags under it");
assert.ok(!matches("tag:urgent", note));
assert.ok(!matches("tag:ide", note));
assert.ok(matches('"release plan" tag:idea path:Projects', note));
assert.ok(!matches('"plan release"', note));
assert.ok(matches('path:"Projects/Inklode/Release p"', note));
assert.ok(!matches("", note) && !matches("   ", note), "an empty query matches nothing");

// The first group that matches gives the colour, and 0 means none does.
const groups = [{ query: "tag:idea", colour: 4 }, { query: "release", colour: 2 }];
assert.equal(colourOf(groups, note), 4);
assert.equal(colourOf(groups, { ...note, tags: [] }), 2);
assert.equal(colourOf(groups, { name: "Other", path: "Other.md", tags: [] }), 0);

console.log("options ok");
