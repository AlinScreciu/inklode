// Self-check for callout.ts, run by `pnpm test:editor` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { CALLOUT_ICONS, defaultTitle, isFolded, readCallout } from "./callout.ts";

// The type, its look, the fold sign and the title.
assert.deepEqual(readCallout("> [!warning] Mind the gap"), { type: "warning", kind: "warning", fold: "", title: "Mind the gap", titleAt: 13 });
assert.deepEqual(readCallout(">[!NOTE]"), { type: "note", kind: "note", fold: "", title: "", titleAt: 8 });
assert.deepEqual(readCallout("> [!tip]-  Folded  "), { type: "tip", kind: "tip", fold: "-", title: "Folded", titleAt: 11 });
assert.equal(readCallout("> [!faq]+").fold, "+");

// Aliases look like the type they stand for; a type Obsidian does not know looks like a note.
const looks = {
  summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success",
  help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure",
  error: "danger", cite: "quote", bug: "bug", example: "example", todo: "todo", info: "info", "my-own": "note",
};
for (const [type, kind] of Object.entries(looks)) {
  const head = readCallout(`> [!${type.toUpperCase()}] x`);
  assert.equal(head.kind, kind, type);
  assert.equal(head.type, type, "the type keeps its own name");
}
for (const kind of Object.keys(CALLOUT_ICONS)) assert.equal(readCallout(`> [!${kind}]`).kind, kind);

// Plain quotes, and markup that is not a callout head.
for (const text of ["> just a quote", "> [note] x", "> [!] x", "[!note] no quote mark", "> text [!note]"]) assert.equal(readCallout(text), null, text);

assert.equal(defaultTitle("warning"), "Warning");
assert.equal(defaultTitle("tldr"), "Tldr");

// Folding: as written, flipped by a click, never for a callout without a sign.
const head = (fold) => ({ type: "note", kind: "note", fold, title: "", titleAt: 0 });
assert.equal(isFolded(head("-"), false), true);
assert.equal(isFolded(head("-"), true), false);
assert.equal(isFolded(head("+"), false), false);
assert.equal(isFolded(head("+"), true), true);
assert.equal(isFolded(head(""), true), false);

console.log("callout ok");
