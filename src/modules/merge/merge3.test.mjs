// Self-check for merge3.ts, run by `pnpm test:merge` (plain Node, which strips the types on import).
// A merged text is saved without asking, so a wrong one loses what one side wrote.

import assert from "node:assert/strict";
import { eolOf, toLf, withEol } from "../../components/lineEndings.ts";
import { merge3 } from "./merge3.ts";

const text = (...lines) => lines.join("\n");
const base = text("one", "two", "three", "four", "five", "six", "");

// Edits in different parts of the note: both are in the result, whichever side made which.
{
  const mine = text("one", "TWO", "three", "four", "five", "six", "");
  const theirs = text("one", "two", "three", "four", "FIVE", "six", "");
  const both = text("one", "TWO", "three", "four", "FIVE", "six", "");
  assert.equal(merge3(base, mine, theirs), both);
  assert.equal(merge3(base, theirs, mine), both);
}

// An insertion, a deletion and a replacement, each with a line of the base between it and the next.
{
  const mine = text("one", "new", "two", "three", "four", "five", "six", "");
  const theirs = text("one", "two", "three", "five", "SIX", "more", "");
  assert.equal(merge3(base, mine, theirs), text("one", "new", "two", "three", "five", "SIX", "more", ""));
}

// One side unchanged: the other side's text. Nothing changed: the base.
assert.equal(merge3(base, base, "x\n"), "x\n");
assert.equal(merge3(base, "x\n", base), "x\n");
assert.equal(merge3(base, base, base), base);
assert.equal(merge3(base, "", base), "");

// The same edit on both sides is taken once, also next to an edit only one side made elsewhere.
{
  const same = text("one", "TWO", "three", "four", "five", "six", "");
  assert.equal(merge3(base, same, same), same);
  const theirs = text("one", "TWO", "three", "four", "five", "six", "seven", "");
  assert.equal(merge3(base, same, theirs), theirs);
  assert.equal(merge3(base, theirs, same), theirs);
  // The same line inserted at the same spot.
  const added = text("one", "new", "two", "three", "four", "five", "six", "");
  assert.equal(merge3(base, added, added), added);
  // The same lines deleted.
  const cut = text("one", "four", "five", "six", "");
  assert.equal(merge3(base, cut, cut), cut);
}

// The same line edited differently: no merge.
assert.equal(merge3(base, text("one", "MINE", "three", "four", "five", "six", ""), text("one", "THEIRS", "three", "four", "five", "six", "")), null);
// One side's edit inside the other's larger one.
assert.equal(merge3(base, text("one", "TWO", "three", "four", "five", "six", ""), text("one", "2", "3", "four", "five", "six", "")), null);
// Lines next to each other.
assert.equal(merge3(base, text("one", "TWO", "three", "four", "five", "six", ""), text("one", "two", "THREE", "four", "five", "six", "")), null);
// Different insertions at the same spot: which comes first cannot be known.
assert.equal(merge3(base, text("one", "mine", "two", "three", "four", "five", "six", ""), text("one", "theirs", "two", "three", "four", "five", "six", "")), null);
// The same insertion at one spot and a different one beside it is not the same change.
assert.equal(merge3(base, text("one", "new", "two", "three", "four", "five", "six", ""), text("one", "new", "newer", "two", "three", "four", "five", "six", "")), null);
// An edit next to a deletion, on either side of it, and an edit of a deleted line.
{
  const cut = text("one", "two", "five", "six", "");
  assert.equal(merge3(base, text("one", "TWO", "three", "four", "five", "six", ""), cut), null);
  assert.equal(merge3(base, cut, text("one", "two", "three", "four", "FIVE", "six", "")), null);
  assert.equal(merge3(base, cut, text("one", "two", "THREE", "four", "five", "six", "")), null);
  // An insertion at the edge of a deletion.
  assert.equal(merge3(base, cut, text("one", "two", "new", "three", "four", "five", "six", "")), null);
  // With a line between them it merges.
  assert.equal(merge3(base, cut, text("ONE", "two", "three", "four", "five", "SIX", "")), text("ONE", "two", "five", "SIX", ""));
}

// Edits at the start and at the end of the text.
{
  const mine = text("ONE", "two", "three", "four", "five", "six", "");
  const theirs = text("one", "two", "three", "four", "five", "six", "seven", "");
  assert.equal(merge3(base, mine, theirs), text("ONE", "two", "three", "four", "five", "six", "seven", ""));
  // Lines put before the first line and after the last.
  assert.equal(merge3("a\nb\nc", "top\na\nb\nc", "a\nb\nc\nend"), "top\na\nb\nc\nend");
  assert.equal(merge3("a\nb\nc", "b\nc", "a\nb"), "b");
}

// A missing final newline is kept missing, and one side adding it is a change of the end only.
assert.equal(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC"), "A\nb\nC");
assert.equal(merge3("a\nb\nc", "A\nb\nc", "a\nb\nc\n"), "A\nb\nc\n");
assert.equal(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nc"), "A\nb\nc");
// Text added after a last line with no newline touches that line's end on the other side.
assert.equal(merge3("a\nb", "a\nb\n", "a\nb\nc"), null);
assert.equal(merge3("a\nb", "a\nb\n", "a\nb\n"), "a\nb\n");

// CRLF is left as it is: each line keeps the ending its side gave it, and no line gets another.
assert.equal(merge3("a\r\nb\r\nc\r\n", "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n"), "A\r\nb\r\nC\r\n");
assert.equal(merge3("a\r\nb\r\nc\r\n", "a\r\nb\r\nc\r\nd\n", "A\nb\r\nc\r\n"), "A\nb\r\nc\r\nd\n");
// A line whose ending alone changed is a changed line.
assert.equal(merge3("a\r\nb\r\n", "a\nb\r\n", "A\r\nb\r\n"), null);

// An empty base: both sides wrote into the same spot.
assert.equal(merge3("", "", ""), "");
assert.equal(merge3("", "mine", ""), "mine");
assert.equal(merge3("", "", "theirs\n"), "theirs\n");
assert.equal(merge3("", "same", "same"), "same");
assert.equal(merge3("", "mine", "theirs"), null);

// Repeated lines: an edit of each side lands on the line that side edited.
{
  const repeats = text("x", "x", "x", "x", "x", "");
  assert.equal(merge3(repeats, text("y", "x", "x", "x", "x", ""), text("x", "x", "x", "x", "z", "")), text("y", "x", "x", "x", "z", ""));
}

// Random large texts. A fixed seed, so a failure can be run again.
let seed = 12345;
const random = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
/** Lines out of few words, so many of them are equal and the comparison has choices to make. */
const randomLines = (count) => Array.from({ length: count }, () => "w" + random(40));
/** `lines` with about `edits` changes (replace, delete, insert) inside `from` up to `to` (not included). */
const edited = (lines, edits, from = 0, to = lines.length) => {
  const out = lines.slice(0, from);
  for (let i = from; i < to; i++) {
    const roll = random(Math.max(3, Math.floor(((to - from) * 3) / edits)));
    if (roll === 0) out.push("changed" + random(1000));
    else if (roll === 1) continue;
    else if (roll === 2) out.push(lines[i], "added" + random(1000));
    else out.push(lines[i]);
  }
  return out.concat(lines.slice(to));
};
for (let round = 0; round < 60; round++) {
  const lines = randomLines(200 + random(1800));
  const ending = random(2) ? "\n" : "";
  const b = lines.join("\n") + ending;
  const other = edited(lines, 1 + random(40)).join("\n") + (random(4) ? ending : "");
  // A side that changed nothing leaves the other side's text exactly.
  assert.equal(merge3(b, other, b), other, `round ${round}: mine alone`);
  assert.equal(merge3(b, b, other), other, `round ${round}: theirs alone`);
  assert.equal(merge3(b, other, other), other, `round ${round}: the same on both sides`);

  // Mine in the first part, theirs in the last, a stretch of numbered lines (no two alike) between them
  // untouched: the result is the two edited parts around that stretch.
  const middle = Array.from({ length: 5 }, (_, i) => `keep ${round} ${i}`);
  const head = randomLines(100 + random(400));
  const tail = randomLines(100 + random(400));
  const join = (h, t) => [...h, ...middle, ...t].join("\n");
  const mineHead = edited(head, 1 + random(20));
  const theirTail = edited(tail, 1 + random(20));
  assert.equal(merge3(join(head, tail), join(mineHead, tail), join(head, theirTail)), join(mineHead, theirTail), `round ${round}: two parts`);
  assert.equal(merge3(join(head, tail), join(head, theirTail), join(mineHead, tail)), join(mineHead, theirTail), `round ${round}: two parts, sides swapped`);
}

// Whatever two sides did to a short text: a merge that is given has every line each side added, and no line
// that a side deleted and the other left alone. (Checked on lines that are all different, where it can be told.)
for (let round = 0; round < 2000; round++) {
  const lines = Array.from({ length: 1 + random(12) }, (_, i) => `base ${i}`);
  const b = lines.join("\n");
  const mine = edited(lines, 1 + random(4));
  const theirs = edited(lines, 1 + random(4));
  const merged = merge3(b, mine.join("\n"), theirs.join("\n"));
  if (merged === null) continue;
  const got = merged.split("\n");
  const where = `round ${round}: ${JSON.stringify([lines, mine, theirs, got])}`;
  for (const side of [mine, theirs]) {
    for (const line of side) if (!lines.includes(line)) assert.ok(got.includes(line), `an added line is missing, ${where}`);
  }
  for (const line of lines) {
    assert.equal(got.includes(line), mine.includes(line) && theirs.includes(line), `a base line is wrongly kept or dropped, ${where}`);
  }
}

// A note with "\r\n" on disk, as the app merges it: the editor holds it with "\n" and reports the edit with the
// note's own ending (components/lineEndings.ts), so the three texts differ only where they were edited. An
// edit reported with "\n" would differ from the base in every line, and nothing could be merged.
{
  const disk = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n";
  const typed = withEol(toLf(disk).replace("two", "TWO"), eolOf(disk));
  const outside = disk.replace("five", "FIVE");
  assert.equal(merge3(disk, typed, outside), "one\r\nTWO\r\nthree\r\nfour\r\nFIVE\r\n");
  assert.equal(merge3(disk, toLf(disk).replace("two", "TWO"), outside), null);
}

console.log("merge3: ok");
