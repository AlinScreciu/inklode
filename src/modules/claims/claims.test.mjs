// Self-check for claims.ts, run by `pnpm test:claims` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { counts, keyOf, locate, marker, pending, queue, refused } from "./claims.ts";

// The marker is the comment that ends the line; `from` and `to` are where it is in the line.
const line = "45 core tests pass. <!-- check: cargo test -p core @ ~/code/myproject -->";
assert.deepEqual(marker(line), { from: 20, to: line.length, evidence: "cargo test -p core @ ~/code/myproject" });
assert.equal(line.slice(marker(line).from), "<!-- check: cargo test -p core @ ~/code/myproject -->");
assert.deepEqual(marker("Docs are online. <!--check:https://tauri.app-->  "), { from: 17, to: 47, evidence: "https://tauri.app" });
assert.deepEqual(marker("<!-- check: file Notes/Spec.md -->"), { from: 0, to: 34, evidence: "file Notes/Spec.md" });
// The last comment of a line with two is the marker.
assert.equal(marker("a <!-- note --> b <!-- check: file a.md -->").from, 18);
assert.deepEqual(marker("a <!-- check: file a.md --> b <!-- check: file b.md -->"), { from: 30, to: 55, evidence: "file b.md" });

assert.equal(marker("No marker here."), null);
assert.equal(marker("An ordinary comment. <!-- todo: check this -->"), null);
assert.equal(marker("Text after it. <!-- check: file a.md --> more"), null);
assert.equal(marker("Names nothing. <!-- check: -->"), null);
assert.equal(marker("Not closed. <!-- check: file a.md"), null);

const claim = (path, n, status, checked = null, evidence = `file ${path}`) => ({ path, line: n, text: `claim ${n}`, evidence, kind: "file", status, checked, output: null });
const list = [
  claim("a.md", 3, "passing", "2026-11-01"),
  claim("a.md", 9, "stale", "2026-09-30"),
  claim("b.md", 2, "unchecked"),
  claim("b.md", 5, "failing", "2026-11-16"),
  claim("c.md", 1, "stale", "2026-03-02"),
  claim("c.md", 4, "stale", "2026-09-30"),
  claim("d.md", 7, "failing", "2026-11-02"),
];

assert.equal(keyOf(list[1]), "a.md:9");

// Failing and unchecked in the list's order, stale by the day of the check, the same day in the list's order.
const q = queue(list);
assert.deepEqual(q.failing.map(keyOf), ["b.md:5", "d.md:7"]);
assert.deepEqual(q.stale.map(keyOf), ["c.md:1", "a.md:9", "c.md:4"]);
assert.deepEqual(q.unchecked.map(keyOf), ["b.md:2"]);
assert.deepEqual(q.passing.map(keyOf), ["a.md:3"]);
assert.deepEqual(pending(list).map(keyOf), ["b.md:5", "d.md:7", "c.md:1", "a.md:9", "c.md:4", "b.md:2"]);
assert.deepEqual(counts(list), { failing: 2, stale: 3, unchecked: 1, passing: 1 });
assert.deepEqual(counts([]), { failing: 0, stale: 0, unchecked: 0, passing: 0 });
// The list itself is not reordered.
assert.equal(list[0].line, 3);

// The claim of a line of the editor: the one listed there, else the nearest with the same evidence, in that note only.
const two = [claim("a.md", 3, "passing", null, "file x.md"), claim("a.md", 9, "failing", null, "file y.md"), claim("a.md", 20, "stale", null, "file x.md"), claim("b.md", 5, "failing", null, "file z.md")];
assert.equal(locate(two, "a.md", 9, "file y.md"), two[1]);
assert.equal(locate(two, "a.md", 9, "something else"), two[1], "the line decides before the evidence");
assert.equal(locate(two, "a.md", 5, "file x.md"), two[0], "two lines were typed above it");
assert.equal(locate(two, "a.md", 18, "file x.md"), two[2]);
assert.equal(locate(two, "a.md", 5, "file z.md"), null, "another note's claim is not this line's");
assert.equal(locate(two, "c.md", 3, "file x.md"), null);
assert.equal(locate([], "a.md", 1, "file x.md"), null);

assert.equal(refused("commands are not allowed for this vault"), true);
assert.equal(refused("Error: commands are not allowed for this vault (a.md:3)"), true);
assert.equal(refused("a.md has no claim on line 3"), false);

console.log("claims: ok");
