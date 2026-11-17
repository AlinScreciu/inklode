// Self-check for the pure parts of appearance.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { accentColors, checkOption, contrast, DEFAULT_OPTIONS, hexRgb, readOptions } from "./appearance.ts";

// Settings: valid values are kept, anything else is the default.
assert.deepEqual(readOptions({}), DEFAULT_OPTIONS);
assert.deepEqual(
  readOptions({ appearance: "dark", accent: "#2f6fde", uiFontSize: 14, textFont: "Georgia, serif", lineWidth: 500, defaultMode: "nope" }),
  { ...DEFAULT_OPTIONS, appearance: "dark", accent: "#2f6fde", uiFontSize: 14, textFont: "Georgia, serif" },
);
assert.doesNotThrow(() => checkOption("accent", null));
assert.doesNotThrow(() => checkOption("textFontSize", 18));
assert.throws(() => checkOption("textFontSize", "18"), /10 to 32/);
assert.throws(() => checkOption("textFont", "x; } body { display: none"), /font family/);
assert.throws(() => checkOption("theme", "x"), /Unknown setting/);

// Colours.
assert.deepEqual(hexRgb("#fff"), [255, 255, 255]);
assert.deepEqual(hexRgb("#2F6fde"), [47, 111, 222]);
assert.equal(hexRgb("rebeccapurple"), null);
assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);

// A chosen accent is used as it is on light and lightened on dark, and its text reads on it either way.
assert.deepEqual(accentColors("#2f6fde", false), { accent: "#2f6fde", text: "#ffffff" });
for (const color of ["#2f6fde", "#0f8f85", "#2f9e44", "#d6336c", "#7c5cdb", "#ffe600", "#000000"]) {
  for (const dark of [false, true]) {
    const { accent, text } = accentColors(color, dark);
    assert.ok(contrast(hexRgb(accent), hexRgb(text)) >= 4.5, `${color} dark=${dark}: ${text} on ${accent}`);
  }
}
assert.deepEqual(accentColors("teal", true), { accent: "teal", text: "#ffffff" });

// The default theme's own colours (the :root blocks of app.css): text on its surface, as [name, text, surface, minimum].
const pairs = [
  ["dark text on editor", "#dcdde1", "#1f2024", 4.5],
  ["dark muted on editor", "#9a9ca5", "#1f2024", 4.5],
  ["dark muted on sidebar", "#9a9ca5", "#191a1e", 4.5],
  ["dark muted on elevated", "#9a9ca5", "#26282d", 4.5],
  // `--text-faint` is 78% muted mixed with the surface.
  ["dark faint on editor", "#7f8189", "#1f2024", 3],
  ["dark faint on sidebar", "#7e7f87", "#191a1e", 3],
  ["dark accent on editor", "#e8824a", "#1f2024", 4.5],
  ["dark accent text on accent", "#16130f", "#e8824a", 4.5],
  ["dark error on editor", "#f47067", "#1f2024", 4.5],
  ["light text on editor", "#26241f", "#fcfbf9", 4.5],
  ["light muted on editor", "#6b6860", "#fcfbf9", 4.5],
  ["light muted on sidebar", "#6b6860", "#f4f2ee", 4.5],
  ["light muted on ribbon", "#6b6860", "#eae8e4", 4.5],
  ["light faint on editor", "#8b8882", "#fcfbf9", 3],
  ["light faint on sidebar", "#8b8882", "#f4f2ee", 3],
  ["light accent on editor", "#b84a14", "#fcfbf9", 4.5],
  ["light accent on sidebar", "#b84a14", "#f4f2ee", 4.5],
  ["light accent text on accent", "#ffffff", "#b84a14", 4.5],
  ["light error on editor", "#c0262d", "#fcfbf9", 4.5],
];
for (const [name, text, surface, min] of pairs) {
  const ratio = contrast(hexRgb(text), hexRgb(surface));
  assert.ok(ratio >= min, `${name}: ${ratio.toFixed(2)} is under ${min}`);
}

console.log("appearance: ok");
