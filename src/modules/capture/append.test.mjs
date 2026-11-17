// Self-check for append.ts, run by `pnpm test:capture` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { addition, captureNote, item } from "./append.ts";

/** The note's text after a capture. */
const after = (file, text) => file + addition(file, text);

// One line per capture, and exactly one line end between two of them.
assert.equal(after("", "buy milk"), "- buy milk\n", "a note that is not there yet");
assert.equal(after("- buy milk\n", "call Ana"), "- buy milk\n- call Ana\n");
assert.equal(after(after(after("", "one"), "two"), "three"), "- one\n- two\n- three\n");

// The text that is there stays as it is, byte for byte: the addition only ever comes after it.
assert.equal(after("# Inbox\n\ntext without a line end", "x"), "# Inbox\n\ntext without a line end\n- x\n");
assert.equal(after("# Inbox\n\n\n", "x"), "# Inbox\n\n\n- x\n", "blank lines at the end are the user's");
assert.equal(after("a  \n\tb\n", "x"), "a  \n\tb\n- x\n");
assert.equal(after("- one\r\n- two\r\n", "x\ny"), "- one\r\n- two\r\n- x\r\n  y\r\n", "a note with \\r\\n keeps them");
assert.equal(after("- one\r\n- two", "x"), "- one\r\n- two\r\n- x\r\n");

// White space around the text goes, also when the box sends \r\n.
assert.equal(item("  buy milk \n"), "- buy milk");
assert.equal(item("\n\n x\r\n"), "- x");
// More than one line: the others are indented under the bullet, so it stays one list item.
assert.equal(item("first\nsecond\nthird"), "- first\n  second\n  third");
assert.equal(item("first  \n  indented\t\n\nafter a blank line"), "- first\n    indented\n\n  after a blank line");
assert.equal(item("a\r\nb"), "- a\n  b");
// Nothing to capture.
for (const empty of ["", " ", "\n", " \n\t\r\n "]) {
  assert.equal(item(empty), null);
  assert.equal(addition("- one\n", empty), null);
}

// The capture note: what the vault's settings.json names, else Inbox.md at the root.
assert.equal(captureNote(null), "Inbox.md");
assert.equal(captureNote("{}"), "Inbox.md");
assert.equal(captureNote('{"capture": {"note": "Notes/Capture.md"}}'), "Notes/Capture.md");
assert.equal(captureNote('{"capture": {"note": " Daily/Log.md "}, "theme": "Sepia"}'), "Daily/Log.md");
for (const other of ['{"capture": {"note": ""}}', '{"capture": {"note": 3}}', '{"capture": "x.md"}', '{"capture": null}', "[]", "null", "{ not json"]) {
  assert.equal(captureNote(other), "Inbox.md", other);
}

console.log("capture append: ok");
