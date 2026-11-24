// Self-check for template.ts, run by `pnpm test:templates` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { applyChanges, expand, formatDate, frontmatterOf, insertTemplate, templatesIn } from "./template.ts";

// Tuesday 5 March 2024, 09:07:03.042 local time.
const at = new Date(2024, 2, 5, 9, 7, 3, 42);

assert.equal(formatDate(at, "YYYY-MM-DD"), "2024-03-05");
assert.equal(formatDate(at, "HH:mm"), "09:07");
assert.equal(formatDate(at, "YY M D H m s SSS"), "24 3 5 9 7 3 042");
assert.equal(formatDate(at, "dddd, MMMM Do YYYY"), "Tuesday, March 5th 2024");
assert.equal(formatDate(at, "ddd MMM dd d E"), "Tue Mar Tu 2 2");
assert.equal(formatDate(at, "hh:mm A, h a"), "09:07 AM, 9 am");
assert.equal(formatDate(new Date(2024, 2, 5, 0, 30), "h A kk"), "12 AM 24");
assert.equal(formatDate(new Date(2024, 2, 5, 15, 0), "hh A"), "03 PM");
assert.equal(formatDate(at, "DDD DDDD Q"), "65 065 1");
// Text in brackets and letters that are no token are kept.
assert.equal(formatDate(at, "[Week] W, [day] D"), "Week 10, day 5");
assert.equal(formatDate(at, "YYYY/MM/DD - [at] HH:mm"), "2024/03/05 - at 09:07");
// ISO weeks: 1 January 2021 is a Friday, in week 53 of 2020; 31 December 2024 is in week 1 of 2025.
assert.equal(formatDate(new Date(2021, 0, 1), "GGGG-[W]WW"), "2020-W53");
assert.equal(formatDate(new Date(2024, 11, 31), "GGGG-[W]WW"), "2025-W01");
assert.equal(formatDate(new Date(2024, 0, 1), "GGGG-[W]WW"), "2024-W01");
assert.equal(formatDate(new Date(2024, 0, 3), "Do"), "3rd");
assert.equal(formatDate(new Date(2024, 0, 11), "Do"), "11th");
assert.equal(formatDate(new Date(2024, 0, 22), "Do"), "22nd");

const vars = { title: "Plan", now: at };
assert.equal(expand("# {{title}}\n{{date}} {{time}}", vars), "# Plan\n2024-03-05 09:07");
assert.equal(expand("{{date:dddd}} {{time:h:mm a}} {{ date : YYYY }}", vars), "Tuesday 9:07 am 2024");
assert.equal(expand("{{other}} {{title:x}} {title}", vars), "{{other}} Plan {title}");

assert.deepEqual(frontmatterOf("---\na: 1\n---\nbody"), { inner: "a: 1\n", close: 9, end: 13 });
assert.equal(frontmatterOf("text\n---\na: 1\n---\n"), null);
assert.equal(frontmatterOf("---\nnever closed"), null);

/** The note after putting `template` at the `|` in `note` (or over `«…»`), with `|` where the cursor ends. */
const insert = (note, template) => {
  const selected = /«(.*)»/s.exec(note);
  const from = selected ? selected.index : note.indexOf("|");
  const end = selected ? from + selected[1].length : from;
  const clean = selected ? note.replace(/[«»]/g, "") : note.replace("|", "");
  const { changes, cursor } = insertTemplate(clean, from, end, template);
  const out = applyChanges(clean, changes);
  return out.slice(0, cursor) + "|" + out.slice(cursor);
};

// No frontmatter in the template: the text goes at the cursor, over a selection.
assert.equal(insert("a | b", "X"), "a X| b");
assert.equal(insert("a «sel» b", "X"), "a X| b");
// A note without frontmatter gets the template's at its top, and the body at the cursor.
assert.equal(insert("Text\n|", "---\ntags: [t]\n---\n## Log\n"), "---\ntags: [t]\n---\nText\n## Log\n|");
assert.equal(insert("|", "---\na: 1\n---\nBody"), "---\na: 1\n---\nBody|");
assert.equal(insert("|", "---\na: 1\n---"), "---\na: 1\n---\n|");
// A note with frontmatter gets the keys it does not have, after its own, with what is under them; its own win.
assert.equal(
  insert("---\ntags: [mine]\ntitle: Mine\n---\nText |", "---\ntags: [theirs]\nstatus: draft   # a comment\nrepos:\n  - a\n  - b\n---\nmore"),
  "---\ntags: [mine]\ntitle: Mine\nstatus: draft   # a comment\nrepos:\n  - a\n  - b\n---\nText more|",
);
// Nothing new to add: the frontmatter is left alone.
assert.equal(insert("---\na: 1\n---\n|", "---\nA: 2\n---\nx"), "---\na: 1\n---\nx|");
// The cursor in the note's frontmatter: the body goes after it.
assert.equal(insert("---\na: |1\n---\nText", "---\nb: 2\n---\nx"), "---\na: 1\nb: 2\n---\nx|Text");

const paths = ["_templates/Task.md", "_templates/daily/Day.md", "_templates/Map.excalidraw.md", "_templates/pic.png", "_templatesX/No.md", "Notes/A.md"];
assert.deepEqual(templatesIn(paths, "_templates"), [
  { path: "_templates/daily/Day.md", name: "Day", hint: "daily" },
  { path: "_templates/Task.md", name: "Task", hint: "" },
]);
assert.deepEqual(templatesIn(paths, "/_templates/").length, 2);

console.log("templates: ok");
