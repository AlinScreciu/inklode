// Self-check for pdfScale.ts, run by `pnpm test:pdf` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { canvasRatio, fitZoom, fromBase64, MAX_ZOOM, MIN_ZOOM, zoomStep } from "./pdfScale.ts";

assert.equal(zoomStep(1, 1), 1.25);
assert.equal(zoomStep(1.25, -1), 1);
assert.equal(zoomStep(1, -1), 0.8);
assert.equal(zoomStep(MAX_ZOOM, 1), MAX_ZOOM);
assert.equal(zoomStep(MIN_ZOOM, -1), MIN_ZOOM);

// An A4 page (595 pt) in a pane 800 px wide: 768 px of page.
assert.ok(Math.abs(fitZoom(800, 595) * 595 * (96 / 72) - 768) < 1e-9);
assert.equal(fitZoom(4000, 595), 2);
assert.equal(fitZoom(10, 595), MIN_ZOOM);
assert.equal(fitZoom(0, 595), 1);

assert.equal(canvasRatio(800, 1100, 2), 2);
// 4000 by 4000 CSS px at 2x would be 64 million pixels: brought down to 16 million.
assert.equal(canvasRatio(4000, 4000, 2), 1);

assert.deepEqual([...fromBase64("JVBERv8A")], [0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);

console.log("pdf scale: ok");
