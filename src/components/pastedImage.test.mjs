// Self-check for pastedImage.ts, run by `pnpm test:editor` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { imageExtension, pastedImageName } from "./pastedImage.ts";

assert.equal(imageExtension("image/png"), "png");
assert.equal(imageExtension("IMAGE/JPEG"), "jpg");
assert.equal(imageExtension("text/plain"), null);
assert.equal(imageExtension(""), null);

// Local time, every part two digits, as Obsidian names it.
const at = new Date(2026, 0, 5, 7, 8, 9);
assert.equal(pastedImageName(at, "png"), "Pasted image 20260105070809.png");
assert.equal(pastedImageName(at, "png", 0), "Pasted image 20260105070809.png");
assert.equal(pastedImageName(at, "jpg", 2), "Pasted image 20260105070809 2.jpg");
assert.equal(pastedImageName(new Date(2026, 10, 23, 22, 56, 59), "png"), "Pasted image 20261123225659.png");

console.log("pastedImage: ok");
