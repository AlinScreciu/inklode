// Self-check for formatting.ts, run by `pnpm test:editor` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { insertLink, toggleMark } from "./formatting.ts";

/**
 * Runs an edit on text written with the selection in it: `[` and `]` around it, or `|` for the cursor. Gives the
 * text after the edit written the same way.
 */
const run = (marked, edit) => {
  const cursor = marked.indexOf("|");
  const from = cursor >= 0 ? cursor : marked.indexOf("[");
  const to = cursor >= 0 ? cursor : marked.indexOf("]") - 1;
  const doc = marked.replace(/[|[\]]/g, (c, i) => (i === cursor || (cursor < 0 && (c === "[" || c === "]")) ? "" : c));
  const e = edit(doc, from, to);
  const after = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  const [a, b] = [Math.min(e.anchor, e.head), Math.max(e.anchor, e.head)];
  return a === b ? after.slice(0, a) + "|" + after.slice(a) : after.slice(0, a) + "[" + after.slice(a, b) + "]" + after.slice(b);
};
const bold = (doc, from, to) => toggleMark(doc, from, to, "**");
const italic = (doc, from, to) => toggleMark(doc, from, to, "*");

// Wrap, and unwrap again from either side of the marks.
assert.equal(run("a [word] b", bold), "a **[word]** b");
assert.equal(run("a **[word]** b", bold), "a [word] b");
assert.equal(run("a [**word**] b", bold), "a [word] b");
assert.equal(run("a [word] b", italic), "a *[word]* b");
assert.equal(run("a *[word]* b", italic), "a [word] b");
assert.equal(run("a [*word*] b", italic), "a [word] b");
// Bold is not italic, and three stars are both.
assert.equal(run("**[word]**", italic), "***[word]***");
assert.equal(run("[**word**]", italic), "*[**word**]*");
assert.equal(run("*[word]*", bold), "***[word]***");
assert.equal(run("***[word]***", italic), "**[word]**");
assert.equal(run("***[word]***", bold), "*[word]*");
// No selection: the pair with the cursor between, and the same key again takes an empty pair off.
assert.equal(run("a | b", bold), "a **|** b");
assert.equal(run("a **|** b", bold), "a | b");
assert.equal(run("a | b", italic), "a *|* b");
assert.equal(run("|", bold), "**|**");
// At the very start and end of the note.
assert.equal(run("**[x]**", bold), "[x]");
assert.equal(run("[x]", italic), "*[x]*");

// Links.
assert.equal(run("see [the docs] now", insertLink), "see [the docs](|) now");
assert.equal(run("see [https://example.com/a?b=1] now", insertLink), "see [|](https://example.com/a?b=1) now");
assert.equal(run("see [www.example.com] now", insertLink), "see [|](www.example.com) now");
assert.equal(run("see | now", insertLink), "see [|]() now");
assert.equal(run("[not a url: x]", insertLink), "[not a url: x](|)");

console.log("formatting: ok");
