// Self-check for textDiff.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).
// `middle` is how an editor takes the text of another pane or of the disk, so a wrong answer would change a note.

import assert from "node:assert/strict";
import { fold, lineChanges, lineDiff, middle } from "./textDiff.ts";

const apply = (now, next) => {
  const { from, to, insert } = middle(now, next);
  assert.ok(0 <= from && from <= to && to <= now.length, `bad range ${from}..${to} for ${JSON.stringify([now, next])}`);
  return now.slice(0, from) + insert + now.slice(to);
};

// Inserts and deletes at the start, the end and next to equal characters.
const cases = [
  ["# A", "#A"],
  ["#A", "# A"],
  ["# Alpha", "#Alpha"],
  ["aa", "a"],
  ["a", "aa"],
  ["aaa", "aa"],
  ["abab", "ab"],
  ["ab", "abab"],
  ["", "x"],
  ["x", ""],
  ["", ""],
  ["same", "same"],
  ["abc", "xbc"],
  ["abc", "abx"],
  ["abc", "xyz"],
  ["a\n\nb", "a\nb"],
  ["line\n", "line"],
  ["é𝒳é", "é𝒳𝒳é"],
];
for (const [now, next] of cases) assert.equal(apply(now, next), next, JSON.stringify([now, next]));

// Every pair of short strings over two letters and a newline.
const words = [""];
for (let i = 0; i < words.length; i++) if (words[i].length < 5) for (const c of "ab\n") words.push(words[i] + c);
for (const now of words) for (const next of words) assert.equal(apply(now, next), next, JSON.stringify([now, next]));

// `lineChanges` gives the other text too, in ranges that are in order and do not touch, for the same pairs.
const applyLines = (now, next) => {
  let out = "";
  let at = 0;
  for (const { from, to, insert } of lineChanges(now, next)) {
    assert.ok(at <= from && from <= to && to <= now.length, `bad range ${from}..${to} for ${JSON.stringify([now, next])}`);
    out += now.slice(at, from) + insert;
    at = to;
  }
  return out + now.slice(at);
};
for (const [now, next] of cases) assert.equal(applyLines(now, next), next, JSON.stringify([now, next]));
for (const now of words) for (const next of words) assert.equal(applyLines(now, next), next, JSON.stringify([now, next]));
// One change per stretch, and the lines between two stretches are in none of them.
assert.deepEqual(lineChanges("a\nb\nc\nd\ne", "A\nb\nc\nd\nE\nf"), [
  { from: 0, to: 2, insert: "A\n" },
  { from: 7, to: 9, insert: "\nE\nf" },
]);
assert.deepEqual(lineChanges("a\nb\nc", "a\nnew\nb\nc"), [{ from: 2, to: 2, insert: "new\n" }]);
assert.deepEqual(lineChanges("same\n", "same\n"), []);

// A single typed or deleted character is a change of that one character.
assert.deepEqual(middle("# Alpha", "#Alpha"), { from: 1, to: 2, insert: "" });
assert.deepEqual(middle("#Alpha", "# Alpha"), { from: 1, to: 1, insert: " " });
assert.deepEqual(middle("same", "same"), { from: 4, to: 4, insert: "" });

// lineDiff: taking the lines that are not "add" gives the first text back, and those that are not "remove" the second,
// with the line numbers in step.
const check = (before, after) => {
  const lines = lineDiff(before, after);
  const side = (drop, number) => {
    const kept = lines.filter((line) => line.kind !== drop);
    kept.forEach((line, i) => assert.equal(line[number], i + 1, JSON.stringify([before, after])));
    return kept.map((line) => line.text).join("\n");
  };
  assert.equal(side("add", "before"), before, JSON.stringify([before, after]));
  assert.equal(side("remove", "after"), after, JSON.stringify([before, after]));
  return lines;
};
for (const before of words) for (const after of words) check(before, after);
const kinds = (before, after) => check(before, after).map((line) => line.kind[0] + line.text).join(" ");
assert.equal(kinds("a\nb\nc", "a\nb\nc"), "sa sb sc");
assert.equal(kinds("a\nb\nc", "a\nx\nc"), "sa rb ax sc");
assert.equal(kinds("a\nb\nc\nd", "a\nc\nd\ne"), "sa rb sc sd ae");
// The fewest changes: `b` and `d` stay, though they are not at the start or the end.
assert.equal(kinds("x\nb\nc\nd\ny", "p\nb\nq\nd\nr"), "rx ap sb rc aq sd ry ar");
assert.equal(kinds("", "a\nb"), "r aa ab");
assert.equal(kinds("a\n", "a"), "sa r");

// fold: unchanged runs become one row, with `context` lines left next to each change.
const numbered = (count, change) => Array.from({ length: count }, (_, i) => (change.includes(i + 1) ? `changed ${i + 1}` : `line ${i + 1}`)).join("\n");
const shape = (rows) => rows.map((row) => (row.kind === "fold" ? `[${row.lines.length}]` : row.kind[0])).join("");
const plain = numbered(20, []);
assert.equal(shape(fold(lineDiff(plain, numbered(20, [10])), 2)), "[7]ssrass[8]");
assert.equal(shape(fold(lineDiff(plain, numbered(20, [1, 20])), 2)), "rass[14]ssra");
// A run that folding would shorten by less than two lines stays open.
assert.equal(shape(fold(lineDiff(plain, numbered(20, [3, 9])), 2)), "ssrasssssrass[9]");
assert.equal(shape(fold(lineDiff(plain, plain), 2)), "[20]");
for (const rows of [fold(lineDiff(plain, numbered(20, [5, 6, 15])), 1), fold(lineDiff(plain, numbered(20, [2])), 0)]) {
  // Nothing is lost: opened again, the rows are the lines.
  assert.equal(rows.flatMap((row) => (row.kind === "fold" ? row.lines : [row])).filter((line) => line.kind !== "add").length, 20);
}

console.log(`textDiff: ok (${cases.length + words.length ** 2} pairs)`);
