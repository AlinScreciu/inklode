// Self-check for the built-in themes, run by `pnpm test:themes` (plain Node).
// A theme must set every colour the app writes out, in both appearances, or parts of the UI keep the default theme's look.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const read = (url) => readFileSync(url, "utf8");

/** The `:root` rules of a stylesheet, in order: `{ selectors, vars, from }`. */
const rootRules = (css, from) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(",").map((s) => s.trim()),
    vars: [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
    from,
  }));

const appRules = rootRules(read(new URL("../app.css", here)), "app");

/**
 * The variables in force on <html data-appearance="..."> with the app's rules and then a theme's: name to
 * `{ value, from }`. As in the browser, a selector with an attribute outranks plain `:root`, and later wins a tie.
 */
const cascade = (rules, appearance) => {
  const other = appearance === "light" ? "dark" : "light";
  const applying = rules.flatMap((rule) => {
    const selectors = rule.selectors.filter((s) => !s.includes(`data-appearance="${other}"`));
    return selectors.length ? [{ ...rule, weight: Math.max(...selectors.map((s) => s.split("[").length)) }] : [];
  });
  const result = new Map();
  for (const rule of applying.sort((a, b) => a.weight - b.weight))
    for (const [name, value] of rule.vars) result.set(name, { value, from: rule.from });
  return result;
};

// A colour the app writes out has to be set by a theme. One that the app derives (`var(--other)`, or a
// `color-mix` of variables) follows the theme without being set.
const writtenOut = (value) => /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(value);
// Black veils and shadows, which suit any theme of the same appearance, and the callout colours: fixed hues
// mixed with the theme's text, so a warning stays orange whatever the theme.
const MAY_INHERIT = new Set(["--backdrop", "--shadow-popover", "--shadow-dialog"]);
const mayInherit = (name) => MAY_INHERIT.has(name) || name.startsWith("--callout-");

/** WCAG contrast ratio of two `#rrggbb` colours. */
const contrast = (a, b) => {
  const luminance = (hex) => {
    assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is not #rrggbb`);
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const files = readdirSync(here).filter((name) => name.endsWith(".css"));
assert.ok(files.length > 0, "no themes found");
let colours = 0;

for (const file of files) {
  const css = read(new URL(file, here));
  const notice = css.match(/^\/\*[\s\S]*?\*\//)?.[0] ?? "";
  for (const part of ["License", "Copyright (c)", "https://", "port to Inklode"])
    assert.ok(notice.includes(part), `${file}: the comment at the top must be the licence notice (missing "${part}")`);

  for (const appearance of ["light", "dark"]) {
    const where = `${file} (${appearance})`;
    const required = [...cascade(appRules, appearance)]
      .filter(([name, { value }]) => writtenOut(value) && !mayInherit(name))
      .map(([name]) => name);
    assert.ok(required.includes("--bg") && required.includes("--text"), "app.css :root was not parsed");
    colours = required.length;

    const inForce = cascade([...appRules, ...rootRules(css, "theme")], appearance);
    assert.deepEqual(
      required.filter((name) => inForce.get(name).from !== "theme"),
      [],
      `${where}: colours the theme does not set, or sets in a rule the app's own outranks`,
    );

    const resolve = (name, depth = 0) => {
      const value = inForce.get(name)?.value;
      assert.ok(value !== undefined && depth < 20, `${where}: ${name} is not defined`);
      return value.replace(/var\((--[\w-]+)\)/g, (_, inner) => resolve(inner, depth + 1));
    };
    for (const name of inForce.keys()) resolve(name);

    for (const bg of ["--bg", "--bg-sidebar"]) {
      const text = contrast(resolve("--text"), resolve(bg));
      const muted = contrast(resolve("--text-muted"), resolve(bg));
      assert.ok(text >= 6, `${where}: --text on ${bg} has contrast ${text.toFixed(1)}, under 6`);
      assert.ok(muted >= 4, `${where}: --text-muted on ${bg} has contrast ${muted.toFixed(1)}, under 4`);
    }
  }
}

// The Catppuccin flavours differ in palette only.
const mappings = files.filter((name) => name.startsWith("Catppuccin")).map((name) => read(new URL(name, here)).split("Mapping.")[1]);
assert.ok(mappings.every((m) => m && m === mappings[0]), "Catppuccin*.css: the text from `Mapping.` on must be the same in all");

// docs/themes.md lists every variable of the app.
const docs = read(new URL("../../docs/themes.md", here));
const undocumented = appRules.flatMap((rule) => rule.vars.map(([name]) => name)).filter((name) => !docs.includes(`\`${name}\``));
assert.deepEqual([...new Set(undocumented)], [], "variables in app.css that docs/themes.md does not list");

console.log(`themes ok: ${files.length} themes, ${colours} written-out colours each, light and dark`);
