// Self-check for frontmatter.ts, run by `pnpm test:frontmatter` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { readFrontmatter, readProps } from "./frontmatter.ts";

/** Each line as `[key, values, list]`, with the spans turned back into text. */
const read = (yaml) => {
  const lines = yaml.split("\n");
  const props = readFrontmatter(lines);
  return props && props.map((p, i) => [p.key ? lines[i].slice(...p.key) : null, p.values.map((v) => lines[i].slice(...v)), p.list]);
};

assert.deepEqual(read("tags: [demo, home]\naliases: [Start here]\nupdated: 2026-11-16"), [
  ["tags", ["demo", "home"], true],
  ["aliases", ["Start here"], true],
  ["updated", ["2026-11-16"], false],
]);

// A list under its key, quotes, an empty list, a key with no value, spaces around things.
assert.deepEqual(read('tags:\n  - a\n  - "b c"\ntitle: \'Hello: there\'\nempty: []\nnone:\nurl:   https://example.com/x  '), [
  ["tags", [], false],
  [null, ["a"], true],
  [null, ["b c"], true],
  ["title", ["Hello: there"], false],
  ["empty", [], true],
  ["none", [], false],
  ["url", ["https://example.com/x"], false],
]);
assert.deepEqual(read('repos: ["inklode", "vault"]'), [["repos", ["inklode", "vault"], true]]);
assert.deepEqual(read(""), null, "a blank line is not simple");

// Anything else is not simple: the caller shows the YAML as written.
for (const yaml of [
  "a:\n  b: 1", // nested map
  "text: |\n  line", // block text
  "# comment\na: 1",
  "a: 1\n\nb: 2", // blank line
  "- a", // item without a key
  "a: 1\n  - b", // item under a key that has a value
  "a: {b: 1}",
  'a: ["x, y", z]', // a comma inside quotes
  "a: [b, [c]]",
  "a: &anchor b",
  "just text",
]) {
  assert.equal(read(yaml), null, yaml);
}

// As rows: items under a key are that key's values.
assert.deepEqual(readProps(['tags:', '  - a', '  - "b c"', "status: draft", "repos: []"]), [
  { key: "tags", values: ["a", "b c"], list: true },
  { key: "status", values: ["draft"], list: false },
  { key: "repos", values: [], list: true },
]);
assert.equal(readProps(["a:", "  b: 1"]), null);

console.log("frontmatter ok");
