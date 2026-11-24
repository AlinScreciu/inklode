// Self-check for fileNames.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { isDrawn, isImage, isPdf, keptExtension, renameInitial, renameTarget } from "./fileNames.ts";

assert.equal(keptExtension("a/Note.md"), ".md");
assert.equal(keptExtension("Note.MD"), ".MD");
assert.equal(keptExtension("a/Plan.excalidraw.md"), ".excalidraw.md");
assert.equal(keptExtension("img/pic.png"), ".png");
assert.equal(keptExtension("archive.tar.gz"), ".gz");
assert.equal(keptExtension("v1.2/LICENSE"), "");
assert.equal(keptExtension(".hidden"), "");

// The prompt: a note and a drawing without their extension, any other file with it.
assert.equal(renameInitial("a/Note.md"), "a/Note");
assert.equal(renameInitial("a/Plan.excalidraw.md"), "a/Plan");
assert.equal(renameInitial("img/pic.png"), "img/pic.png");
assert.equal(renameInitial("LICENSE"), "LICENSE");

// A note stays a note, however the name was typed.
assert.equal(renameTarget("Note.md", "Other"), "Other.md");
assert.equal(renameTarget("Note.md", " /b/Other.md "), "b/Other.md");
assert.equal(renameTarget("Note.md", "v1.2"), "v1.2.md");
assert.equal(renameTarget("Note.MD", "Other"), "Other.MD");
// A drawing stays a drawing.
assert.equal(renameTarget("Plan.excalidraw.md", "Map"), "Map.excalidraw.md");
assert.equal(renameTarget("Plan.excalidraw.md", "a/Map.excalidraw.md"), "a/Map.excalidraw.md");
assert.equal(renameTarget("Plan.excalidraw.md", "Map.md"), "Map.excalidraw.md");
// Any other file is not made a note: `pic.png` never becomes `photo.png.md`.
assert.equal(renameTarget("pic.png", "photo.png"), "photo.png");
assert.equal(renameTarget("pic.png", "img/photo"), "img/photo.png");
assert.equal(renameTarget("pic.png", "photo.jpg"), "photo.jpg");
assert.equal(renameTarget("LICENSE", "COPYING"), "COPYING");
// What the prompt starts with, confirmed unchanged, is the file itself.
for (const path of ["a/Note.md", "a/Plan.excalidraw.md", "img/pic.png", "LICENSE", "doc.pdf"]) {
  assert.equal(renameTarget(path, renameInitial(path)), path);
}

assert.ok(isImage("a/pic.PNG") && isImage("x.jpeg") && isImage("x.svg"));
assert.ok(!isImage("doc.pdf") && !isImage("Note.md") && !isImage("png"));

assert.ok(isPdf("a/Doc.PDF") && !isPdf("pdf") && !isPdf("x.pdf.md"));
assert.ok(isDrawn("x.png") && isDrawn("x.pdf") && !isDrawn("x.md"));

console.log("file names: ok");
