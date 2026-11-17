// Self-check for lineEndings.ts, run by `pnpm test:editor` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { eolOf, toLf, withEol } from "./lineEndings.ts";

assert.equal(eolOf(""), "\n");
assert.equal(eolOf("one line"), "\n");
assert.equal(eolOf("a\nb\n"), "\n");
assert.equal(eolOf("a\r\nb\r\n"), "\r\n");
// Mixed: the more common one, and "\n" when they are as many.
assert.equal(eolOf("a\r\nb\r\nc\n"), "\r\n");
assert.equal(eolOf("a\r\nb\nc\n"), "\n");
assert.equal(eolOf("a\r\nb\n"), "\n");

assert.equal(toLf("a\r\nb\rc\nd"), "a\nb\nc\nd");

// What the editor does to a note: read, hold as "\n", one character typed, reported with the note's ending.
// Only the line that was typed in differs from the file.
for (const file of ["# Title\r\n\r\nfirst\r\nsecond\r\n", "# Title\n\nfirst\nsecond\n", "no newline at the end\r\nlast"]) {
  const eol = eolOf(file);
  const held = toLf(file);
  assert.ok(!held.includes("\r"));
  assert.equal(withEol(held, eol), file, "nothing typed: the same bytes");
  const typed = withEol(held.replace("last", "last!").replace("first", "first!"), eol);
  const [before, after] = [file.split("\n"), typed.split("\n")];
  assert.equal(after.length, before.length);
  assert.equal(after.filter((line, i) => line !== before[i]).length, 1, "one line changed");
}

console.log("line endings: ok");
