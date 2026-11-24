// Self-check for noteRender.ts, run by `pnpm test:pdf` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { renderNote, textOf } from "./noteRender.ts";

/** The tree as compact HTML-like text, attributes sorted, so expectations stay readable. */
const html = (parts) =>
  parts
    .map((p) => {
      if (typeof p === "string") return p;
      const attrs = Object.entries(p.attrs ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${v}"`))
        .join("");
      return `<${p.tag}${attrs}>${html(p.children ?? [])}</${p.tag}>`;
    })
    .join("");

const render = (text, name = "Note") => html(renderNote(text, name));

// The note's name is the title, unless the first heading says it; frontmatter is left out.
assert.equal(render("---\ntags: [a]\n---\nHello", "Plan"), '<h1 class="print-title">Plan</h1><p>Hello</p>');
assert.equal(render("# plan\n\nText", "Plan"), "<h1>plan</h1><p>Text</p>");
assert.equal(render("# Other\n", "Plan"), '<h1 class="print-title">Plan</h1><h1>Other</h1>');

const body = (text) => render(`# Note\n\n${text}`).slice("<h1>Note</h1>".length);

// Inline marks, entities, escapes, breaks, comments.
assert.equal(body("*a* **b** ~~c~~ `d*e` \\* &amp; &#x41; x<br>y <!-- check: ok -->"), "<p><em>a</em> <strong>b</strong> <del>c</del> <code>d*e</code> * & A x<br></br>y</p>");
// Links: web links keep their address, anything else is text; wikilinks show the alias or the target.
assert.equal(
  body('[site](https://e.com "t") [x](javascript:alert(1)) [[Other note|alias]] [[Plain]] <https://a.b> www.c.d'),
  '<p><a href="https://e.com">site</a> <span class="link">x</span> <span class="link">alias</span> <span class="link">Plain</span> <a href="https://a.b">https://a.b</a> <a href="https://www.c.d">www.c.d</a></p>',
);
// Images: Markdown ones keep their source, `![[…]]` of a picture names the file, of a note prints its name.
assert.equal(body("![cat](img/c.png) ![[d.png|200]] ![[Other]]"), '<p><img alt="cat" src="img/c.png"></img> <img alt="200" data-embed="d.png"></img> <span class="link">Other</span></p>');

// Blocks: quotes without their marks, lists with a start number, tasks, code with its language, rules, tables.
assert.equal(body("> a *b*\n> c"), "<blockquote><p>a <em>b</em>\n c</p></blockquote>");
assert.equal(body("3. x\n4. y"), '<ol start="3"><li><p>x</p></li><li><p>y</p></li></ol>');
assert.equal(
  body("- [x] done\n- [ ] open\n  - sub"),
  '<ul><li class="print-task is-done"><p><input checked disabled type="checkbox"></input> done</p></li><li class="print-task"><p><input disabled type="checkbox"></input> open</p><ul><li><p>sub</p></li></ul></li></ul>',
);
assert.equal(body("```js\nlet a = 1 < 2;\n```\n\n---"), '<pre data-language="js"><code>let a = 1 < 2;</code></pre><hr></hr>');
assert.equal(
  body("| a | b |\n|:-:|--:|\n| 1 | **2** |"),
  '<table><thead><tr><th style="text-align: center">a</th><th style="text-align: right">b</th></tr></thead><tbody><tr><td style="text-align: center">1</td><td style="text-align: right"><strong>2</strong></td></tr></tbody></table>',
);
// Raw HTML is shown as text, never as markup.
assert.equal(body("<div onclick=x>\nhi\n</div>"), '<pre class="html"><code><div onclick=x>\nhi\n</div></code></pre>');

assert.equal(textOf(renderNote("Some *text*", "N")), "NSome text");

console.log("print: ok");
