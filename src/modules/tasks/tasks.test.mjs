// Self-check for tasks.ts, run by `pnpm test:tasks` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { count, tick } from "./tasks.ts";

const note = "# Plan\n- [ ] first\n  * [ ] nested\n1. [ ]   spaced  \n- [ ]\n- [x] done\n";

// Only the space between the brackets changes.
assert.equal(tick(note, { line: 2, text: "first" }), note.replace("- [ ] first", "- [x] first"));
assert.equal(tick(note, { line: 3, text: "nested" }), note.replace("* [ ] nested", "* [x] nested"));
assert.equal(tick(note, { line: 4, text: "spaced" }), note.replace("1. [ ]   spaced  ", "1. [x]   spaced  "));
assert.equal(tick(note, { line: 5, text: "" }), note.replace("- [ ]\n", "- [x]\n"));
assert.equal(tick("- [ ] a\r\n+ [ ] b\r\n", { line: 2, text: "b" }), "- [ ] a\r\n+ [x] b\r\n", "CRLF line ends stay");
assert.equal(tick("2) [ ] last", { line: 1, text: "last" }), "2) [x] last", "no newline at the end");

// The note changed since the list was read: another text on that line, a ticked box, no such line, no list item.
assert.equal(tick(note, { line: 2, text: "nested" }), null);
assert.equal(tick(note, { line: 6, text: "done" }), null);
assert.equal(tick(note, { line: 1, text: "Plan" }), null);
assert.equal(tick(note, { line: 40, text: "first" }), null);
assert.equal(tick("-[ ] tight\n- [ ]tight\ntext - [ ] x\n", { line: 1, text: "tight" }), null);
assert.equal(tick("-[ ] tight\n- [ ]tight\ntext - [ ] x\n", { line: 2, text: "tight" }), null);

// A long line is in the list with its first 200 characters, an emoji counting as one.
const long = "😀" + "a".repeat(300);
assert.equal(tick(`- [ ] ${long}\n`, { line: 1, text: "😀" + "a".repeat(199) }), `- [x] ${long}\n`);

assert.equal(count([]), 0);
assert.equal(count([{ path: "a.md", tasks: [{ line: 1, text: "x" }, { line: 2, text: "y" }] }, { path: "b.md", tasks: [{ line: 9, text: "z" }] }]), 3);

console.log("tasks: ok");
