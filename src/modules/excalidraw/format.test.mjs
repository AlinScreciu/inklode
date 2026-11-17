// Self-check for format.ts, run by `pnpm test:excalidraw` (plain Node, which strips the types on import).
// The fixtures were written by the draw plugin's `excalidraw-write`: a diagram, and a deck of three frames.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deck as deckOf, fitSlide, parse, serialize, slides, slideshowData } from "./format.ts";
import { blocks } from "./notes.ts";
import { builds, exits, hidden, keyMessage, overlaps, stepFrom, withNotes } from "./slideshow.ts";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.excalidraw.md`, import.meta.url), "utf8");
const diagram = fixture("diagram");
const deck = fixture("deck");
// The deck with slideshow data in each frame's `customData.slideshow` (docs/slideshow-spec.md), written by hand:
// an explicit order (03, 01, 02), 02 excluded, notes, a deck name and a build step.
const sorted = fixture("deck-sorted");

for (const [name, text] of [
  ["diagram", diagram],
  ["deck", deck],
  ["deck-sorted", sorted],
]) {
  const drawing = parse(text);
  // The three parts are the whole file, and the middle one is the scene.
  assert.equal(drawing.before + text.slice(drawing.before.length, text.length - drawing.after.length) + drawing.after, text);
  assert.ok(drawing.before.startsWith("---\n\nexcalidraw-plugin: parsed\n"), `${name}: frontmatter`);
  assert.ok(drawing.before.endsWith("%%\n## Drawing\n```json\n"), `${name}: before`);
  assert.equal(drawing.after, "\n```\n%%", `${name}: after`);

  // Unchanged elements: everything outside the JSON comes back byte for byte, and the JSON holds the same scene.
  const again = serialize(drawing, drawing.scene.elements);
  const reread = parse(again);
  assert.equal(reread.before, drawing.before, `${name}: text before the scene`);
  assert.equal(reread.after, drawing.after, `${name}: text after the scene`);
  assert.deepEqual(reread.scene, drawing.scene, `${name}: scene`);
  assert.ok(!again.includes("compressed-json"), `${name}: uncompressed`);
  assert.ok(again.includes('```json\n{\n\t"type": "excalidraw",'), `${name}: plain JSON, indented with tabs`);
  assert.equal(serialize(reread, reread.scene.elements), again, `${name}: stable`);
}

// The diagram: two shapes in a frame, an arrow with a label, a free text; one shape has a link.
{
  const { scene } = parse(diagram);
  assert.deepEqual(scene.elements.map((e) => e.type).sort(), ["arrow", "ellipse", "frame", "rectangle", "text", "text", "text", "text"]);
}

// An edit elsewhere in the drawing leaves the slideshow data as it was, although the canvas hands the frames back.
{
  const { scene } = parse(sorted);
  const frames = scene.elements.filter((e) => e.type === "frame");
  const moved = scene.elements.map((e) => (e.type === "text" ? { ...e, x: e.x + 5 } : e));
  const saved = parse(serialize(parse(sorted), moved)).scene.elements.filter((e) => e.type === "frame");
  assert.deepEqual(saved.map((f) => f.customData), frames.map((f) => f.customData));
}

// Framing a slide: as large as fits, centred, never over the largest zoom.
{
  const slide = { x: 1440, y: 100, width: 1280, height: 720 };
  // Same shape as the viewport: it fills it.
  assert.deepEqual(fitSlide(slide, 640, 360), { zoom: 0.5, scrollX: -1440, scrollY: -100 });
  // A wider viewport: the height decides, and the slide is centred across.
  assert.deepEqual(fitSlide(slide, 2000, 720), { zoom: 1, scrollX: 360 - 1440, scrollY: -100 });
  // A taller viewport: the width decides.
  assert.deepEqual(fitSlide(slide, 1280, 1000), { zoom: 1, scrollX: -1440, scrollY: 140 - 100 });
  assert.equal(fitSlide({ x: 0, y: 0, width: 10, height: 10 }, 1000, 1000).zoom, 30);
}

// An edit: a text made by Excalidraw (long id) bound to a new linked box, one text changed, one element deleted.
{
  const drawing = parse(diagram);
  const [first, ...rest] = drawing.scene.elements;
  assert.equal(first.type, "text");
  const longId = "Vq3x-T_9aKfLm0PzRw1Yb";
  const elements = [
    { ...first, text: "Weekly backup", originalText: "Weekly backup" },
    ...rest.map((e) => (e.type === "arrow" ? { ...e, isDeleted: true } : e)),
    { id: "box-made-in-inklode", type: "rectangle", link: "[[Second]]", boundElements: [{ type: "text", id: longId }] },
    { id: longId, type: "text", text: "New\ntext", originalText: "New text", containerId: "box-made-in-inklode" },
  ];
  const out = serialize(drawing, elements, { f1: { id: "f1" } });
  const saved = parse(out);

  assert.ok(out.startsWith(drawing.before.slice(0, drawing.before.indexOf("## Text Elements"))), "frontmatter and header kept");
  assert.ok(out.endsWith(drawing.after));
  assert.ok(!saved.scene.elements.some((e) => e.type === "arrow"), "deleted elements are not written");
  assert.deepEqual(saved.scene.files, { f1: { id: "f1" } });
  assert.deepEqual(saved.scene.appState, drawing.scene.appState);

  const text = saved.scene.elements.at(-1);
  assert.equal(text.id, "Vq3x-T_9", "a text's id is cut to 8 characters");
  assert.deepEqual(saved.scene.elements.at(-2).boundElements, [{ type: "text", id: "Vq3x-T_9" }], "and its container follows");
  assert.equal(saved.scene.elements[0].rawText, "Weekly backup", "rawText follows an edited text");
  assert.equal(saved.scene.elements[1].rawText, rest[0].rawText, "and stays on an untouched one");

  // The sections, as the Obsidian plugin reads them: `\s\^(.{8})[\n]+` for texts, `^(.{8}):\s*(.*)$` for links.
  const body = out.slice(out.indexOf("## Text Elements\n"), out.indexOf("%%\n## Drawing\n"));
  const ids = [...body.matchAll(/\s\^(.{8})[\n]+/g)].map((m) => m[1]);
  assert.deepEqual(ids, saved.scene.elements.filter((e) => e.type === "text").map((e) => e.id));
  assert.ok(body.includes("\nWeekly backup ^" + first.id + "\n\n"));
  assert.ok(!body.includes("Nightly backup"));
  assert.ok(body.includes("New text ^Vq3x-T_9\n\n"));
  assert.ok(body.endsWith("## Element Links\nkDwnu5NV: [[Home]]\n\nbox-made-in-inklode: [[Second]]\n\n"));
}

// Short text ids that start alike (`t1` and `t10` both pad to `t1000000`) each get an id of their own, and what
// points at a text follows it. An id that already has 8 characters is not changed.
{
  const file = (elements) =>
    "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n```json\n" + JSON.stringify({ type: "excalidraw", elements }) + "\n```\n%%\n";
  const texts = (ids) => ids.map((id) => ({ id, type: "text", text: `text of ${id}` }));
  const save = (elements) => parse(serialize(parse(file(elements)), elements)).scene.elements;
  for (const [ids, saved] of [
    [["t1", "t10", "t2", "t20"], ["t1000000", "t1000001", "t2000000", "t2000001"]],
    [["text-1", "text-10", "text-100"], ["text-101", "text-102", "text-100"]],
    [["label-1", "label-10", "label-11"], ["label-12", "label-10", "label-11"]],
    [["a", "a0", "a00"], ["a0000000", "a0000001", "a0000002"]],
    [["abcdefgh", "abcdefghi", "abcdefghij"], ["abcdefgh", "bcdefghi", "cdefghij"]],
  ]) {
    assert.deepEqual(save(texts(ids)).map((e) => e.id), saved, ids.join(" "));
  }
  // `t0000000` to `t0000009` are taken: the number takes one more character of the start.
  const taken = Array.from({ length: 10 }, (_, i) => "t000000" + i);
  assert.deepEqual(save(texts([...taken, "t"])).map((e) => e.id), [...taken, "t0000010"]);

  const bound = save([{ id: "box", type: "rectangle", boundElements: [{ type: "text", id: "t10" }] }, ...texts(["t1", "t10"])]);
  assert.deepEqual(bound[0].boundElements, [{ type: "text", id: "t1000001" }], "a container follows its own label");
  assert.equal(bound.find((e) => e.id === "t1000001").text, "text of t10");
  // A second save changes nothing more.
  assert.deepEqual(save(bound), bound);
}

// Text around the data is kept: own frontmatter, a commented data section, embedded files, a tail.
{
  const scene = '{\n\t"type": "excalidraw",\n\t"elements": [{"id": "abcdefgh", "type": "text", "text": "Hi"}]\n}';
  const text =
    "---\nexcalidraw-plugin: parsed\nmine: kept\n---\nIntro line.\n\n%%\n# Excalidraw Data\n\n## Text Elements\nOld ^abcdefgh\n\n" +
    "## Embedded Files\nf1: [[pic.png]]\n\n## Drawing\n```json\n" +
    scene +
    "\n```\n%%\n\nA tail the user wrote.\n";
  const out = serialize(parse(text), parse(text).scene.elements);
  assert.equal(out, text.replace("Old ^abcdefgh", "Hi ^abcdefgh").replace(scene, JSON.stringify(JSON.parse(scene), null, "\t")));

  // No `## Text Elements` section: none is added.
  const bare = "---\nexcalidraw-plugin: parsed\n---\n# Drawing\n```json\n" + scene + "\n```\n";
  assert.equal(serialize(parse(bare), []), bare.replace(scene, '{\n\t"type": "excalidraw",\n\t"elements": []\n}'));
}

// Notes as blocks to draw. Tags stay text: nothing in the notes becomes markup.
{
  assert.deepEqual(blocks("# Title\n\nSay **this** and *that*,\nthen `code` and [a link](https://x.y/z).\n\n- one\n- two **2**\n\n1. first\n2) second\n\n```\n<b>raw</b>\n```\n"), [
    { type: "heading", level: 1, spans: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      spans: [
        { type: "text", text: "Say " },
        { type: "strong", text: "this" },
        { type: "text", text: " and " },
        { type: "em", text: "that" },
        { type: "text", text: ",\nthen " },
        { type: "code", text: "code" },
        { type: "text", text: " and " },
        { type: "link", text: "a link", href: "https://x.y/z" },
        { type: "text", text: "." },
      ],
    },
    { type: "list", ordered: false, items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two " }, { type: "strong", text: "2" }]] },
    { type: "list", ordered: true, items: [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]] },
    { type: "code", text: "<b>raw</b>" },
  ]);
  const html = '<script>alert(1)</script> <img src=x onerror="alert(2)">';
  assert.deepEqual(blocks(html), [{ type: "paragraph", spans: [{ type: "text", text: html }] }]);
  assert.deepEqual(blocks("a_b_c 2 * 3 * 4"), [{ type: "paragraph", spans: [{ type: "text", text: "a_b_c 2 * 3 * 4" }] }]);
  assert.deepEqual(blocks("```\nnever closed"), [{ type: "code", text: "never closed" }]);
  assert.deepEqual(blocks("\n \n"), []);
}

// Files that are not opened as drawings. The message is shown to the user, so it says why.
assert.throws(() => parse(diagram.replace("```json\n", "```compressed-json\n")), /saved compressed/);
assert.throws(() => parse("# Just a note\n"), /no `## Drawing` json block/);
assert.throws(() => parse("## Drawing\n```json\n{\n"), /not closed/);
assert.throws(() => parse("## Drawing\n```json\n{ nope\n```\n"), /not valid JSON/);
assert.throws(() => parse("## Drawing\n```json\n[]\n```\n"), /not a JSON object/);

// The slideshow: the examples of docs/slideshow-spec.md, by their number there. Its expected results are copied
// from the document, not from what the code gives.
{
  const record = (fields) => ({ slideshow: { schemaVersion: 2, kind: "frame", ...fields } });
  const inOrder = (ids) => [...ids].sort();
  /** A step as the examples write them short: `advance` unless said, one `element` target per id unless given. */
  const step = (id, effect, targets, more = {}) => ({
    id,
    effect,
    trigger: "advance",
    targets: [targets].flat().map((t) => (typeof t === "string" ? { type: "element", id: t } : t)),
    ...more,
  });
  /** What each step of the slide acts on, as `{ stepId: sorted ids }`. */
  const acts = (steps) => Object.fromEntries(steps.map((b) => [b.step.id, inOrder(b.ids)]));
  /** The hidden elements after 0, 1, ... all steps. */
  const hiddenAt = (steps) => Array.from({ length: steps.length + 1 }, (_, done) => inOrder(hidden(steps, done)));
  const F = { id: "F", type: "frame", name: "Slide", x: 0, y: 0, width: 1280, height: 720 };

  // 1. Order and titles without records.
  {
    const elements = [
      { id: "f1", type: "frame", name: "2 Middle" },
      { id: "f2", type: "frame", name: "10 Late" },
      { id: "t1", type: "text" },
      { id: "f3", type: "frame", name: null },
      { id: "f4", type: "frame", name: "1 Start" },
      { id: "f5", type: "frame", name: "appendix" },
      { id: "f6", type: "frame", name: "Zebra", isDeleted: true },
      { id: "f7", type: "frame", name: "Zebra" },
      { id: "f8", type: "frame" },
      { id: "f9", type: "frame", name: "" },
    ];
    assert.deepEqual(
      deckOf(elements).map((s) => [s.frame.id, s.title]),
      [["f9", ""], ["f4", "1 Start"], ["f2", "10 Late"], ["f1", "2 Middle"], ["f3", "Frame 03"], ["f8", "Frame 07"], ["f7", "Zebra"], ["f5", "appendix"]],
    );
    assert.ok(deckOf(elements).every((s) => s.data === null));
    // The position is written with at least two digits.
    const many = Array.from({ length: 104 }, (_, i) => ({ id: `n${i}`, type: "frame" }));
    assert.deepEqual([2, 11, 103].map((i) => deckOf(many).find((s) => s.frame.id === `n${i}`).title), ["Frame 03", "Frame 12", "Frame 104"]);
  }

  // 2. Order with records.
  {
    const elements = [
      { id: "a", type: "frame", name: "Alpha", customData: record({ order: 2 }) },
      { id: "b", type: "frame", name: "Beta" },
      { id: "c", type: "frame", name: "Gamma", customData: record({ order: 0, excluded: true }) },
      { id: "d", type: "frame", name: "Delta", customData: record({ order: 2 }) },
      { id: "e", type: "frame", name: "Aardvark" },
      { id: "f", type: "frame", name: "Omega", customData: record({ order: 1 }) },
    ];
    assert.deepEqual(deckOf(elements).map((s) => s.title), ["Gamma", "Omega", "Alpha", "Delta", "Aardvark", "Beta"]);
    assert.deepEqual(slides(elements).map((s) => s.title), ["Omega", "Alpha", "Delta", "Aardvark", "Beta"]);
  }

  // 3. Invalid records count as none.
  {
    const elements = [
      { id: "a", type: "frame", name: "B ordered", customData: record({ order: 5, notes: "Hello" }) },
      { id: "b", type: "frame", name: "C no order", customData: record({ excluded: true, notes: "n" }) },
      {
        id: "c",
        type: "frame",
        name: "A bad step",
        customData: record({ order: 0, excluded: true, notes: "n", animation: { steps: [step("s1", "fade", "x"), step("s2", "spin", "x")] } }),
      },
      { id: "d", type: "frame", name: "D version", customData: { slideshow: { schemaVersion: 3, kind: "frame", order: 1 } } },
      { id: "e", type: "frame", name: "E float", customData: record({ order: 1.5 }) },
      { id: "g", type: "frame", name: "F string", customData: { slideshow: "yes" } },
    ];
    const shown = slides(elements);
    assert.deepEqual(shown.map((s) => s.title), ["B ordered", "A bad step", "C no order", "D version", "E float", "F string"]);
    assert.deepEqual(shown.map((s) => s.data), [{ schemaVersion: 2, kind: "frame", order: 5, notes: "Hello" }, null, null, null, null, null]);
  }

  // 4. Reading a record.
  {
    const read = (slideshow) => slideshowData({ id: "f", type: "frame", customData: { slideshow } });
    const stored = {
      schemaVersion: 2, kind: "frame", order: 3, excluded: false, notes: "  \n", deckName: "Talk", theme: "dark",
      animation: {
        loop: true,
        steps: [
          { id: "s1", effect: "slide", trigger: "after-delay", delayMs: 0, durationMs: 500, direction: "up", easing: "bounce",
            targets: [{ type: "element", id: "a", scope: "frame", pinned: true }, { type: "group", id: "g", scope: "viewport" }] },
          { id: "s2", effect: "zoom-out", trigger: "advance", targets: [{ type: "element", id: "a" }] },
        ],
      },
    };
    const before = JSON.stringify(stored);
    assert.deepEqual(read(stored), {
      schemaVersion: 2, kind: "frame", order: 3, excluded: false, deckName: "Talk",
      animation: {
        steps: [
          { id: "s1", targets: [{ type: "element", id: "a" }, { type: "group", id: "g", scope: "viewport" }],
            effect: "slide", trigger: "after-delay", delayMs: 0, durationMs: 500, direction: "up" },
          { id: "s2", targets: [{ type: "element", id: "a" }], effect: "zoom-out", trigger: "advance" },
        ],
      },
    });
    assert.equal(JSON.stringify(stored), before, "reading leaves the stored record alone");
    assert.deepEqual(read({ schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [] } }), { schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [] } });

    // No record: no `customData`, no key, or a value that is not a JSON object.
    assert.equal(slideshowData({ id: "f", type: "frame" }), null);
    assert.equal(slideshowData({ id: "f", type: "frame", customData: null }), null);
    assert.equal(slideshowData({ id: "f", type: "frame", customData: {} }), null);
    for (const value of ["yes", 5, null, []]) assert.equal(read(value), null);

    const invalidRecords = [
      { schemaVersion: 2, kind: "frame", order: -1 },
      { schemaVersion: 2, kind: "frame", order: "0" },
      { schemaVersion: 2, kind: "path", order: 0 },
      { schemaVersion: 2, kind: "frame", order: 0, excluded: null },
      { schemaVersion: 2, kind: "frame", order: 0, notes: 5 },
      { schemaVersion: 2, kind: "frame", order: 0, animation: null },
      { schemaVersion: 2, kind: "frame", order: 0, animation: {} },
      { schemaVersion: 2, kind: "frame", order: 0, animation: [] },
      [],
      // From the table of fields, not listed in the example.
      { kind: "frame", order: 0 },
      { schemaVersion: 2, order: 0 },
      { schemaVersion: 2, kind: "frame" },
      { schemaVersion: "2", kind: "frame", order: 0 },
      { schemaVersion: 2, kind: "frame", order: 0, deckName: 1 },
      { schemaVersion: 2, kind: "frame", order: 0, excluded: "true" },
    ];
    for (const value of invalidRecords) assert.equal(read(value), null, JSON.stringify(value));

    const x = [{ type: "element", id: "x" }];
    const invalidSteps = [
      { id: "", targets: x, effect: "fade", trigger: "advance" },
      { id: "s1", targets: [], effect: "fade", trigger: "advance" },
      { id: "s1", targets: [{ type: "frame", id: "x" }], effect: "fade", trigger: "advance" },
      { id: "s1", targets: [{ type: "element" }], effect: "fade", trigger: "advance" },
      { id: "s1", targets: x, effect: "spin", trigger: "advance" },
      { id: "s1", targets: x, effect: "fade", trigger: "click" },
      { id: "s1", targets: x, effect: "fade", trigger: "advance", delayMs: -1 },
      { id: "s1", targets: x, effect: "fade", trigger: "advance", durationMs: "350" },
      { id: "s1", targets: x, effect: "fade", trigger: "advance", direction: "north" },
      { id: "s1", targets: x, effect: "fade", trigger: "advance", direction: null },
      "step",
      null,
      // From the tables of a step and a target, not listed in the example.
      { targets: x, effect: "fade", trigger: "advance" },
      { id: "s1", effect: "fade", trigger: "advance" },
      { id: "s1", targets: x, trigger: "advance" },
      { id: "s1", targets: x, effect: "fade" },
      { id: "s1", targets: x, effect: "fade", trigger: "advance", durationMs: Infinity },
      { id: "s1", targets: [{ type: "element", id: "" }], effect: "fade", trigger: "advance" },
      { id: "s1", targets: ["x"], effect: "fade", trigger: "advance" },
      // A direction is checked whatever the effect.
      { id: "s1", targets: x, effect: "appear", trigger: "advance", direction: "north" },
    ];
    const valid = { id: "ok", targets: x, effect: "fade", trigger: "advance" };
    assert.ok(read({ schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [valid] } }));
    for (const bad of invalidSteps) {
      assert.equal(read({ schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [bad] } }), null, JSON.stringify(bad));
      assert.equal(read({ schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [valid, bad, valid] } }), null, JSON.stringify(bad));
    }
    // Allowed: a direction on an effect that does not use it, and a `scope` that is not `viewport`.
    assert.deepEqual(read({ schemaVersion: 2, kind: "frame", order: 0, animation: { steps: [{ ...valid, direction: "down", targets: [{ type: "group", id: "g", scope: "page" }] }] } }).animation.steps, [
      { id: "ok", targets: [{ type: "group", id: "g" }], effect: "fade", trigger: "advance", direction: "down" },
    ]);
  }

  assert.deepEqual(["appear", "fade", "slide", "zoom", "disappear", "fade-out", "slide-out", "zoom-out"].map(exits), [false, false, false, false, true, true, true, true]);

  const five = [
    { id: "box", type: "rectangle", x: 100, y: 100, width: 200, height: 100, boundElements: [{ type: "text", id: "label" }, { type: "arrow", id: "arrow" }] },
    { id: "label", type: "text", x: 150, y: 130, width: 100, height: 25, containerId: "box" },
    { id: "arrow", type: "arrow", x: 300, y: 150, width: 200, height: 0, boundElements: [{ type: "text", id: "alabel" }] },
    { id: "alabel", type: "text", x: 380, y: 140, width: 40, height: 20, containerId: "arrow" },
    { id: "free", type: "text", x: 600, y: 100, width: 100, height: 25 },
  ];

  // 5. A text and its shape are one.
  {
    const steps = builds(F, [step("s1", "appear", "label"), step("s2", "fade", "arrow")], [F, ...five]);
    assert.deepEqual(acts(steps), { s1: ["box", "label"], s2: ["alabel", "arrow"] });
    assert.deepEqual(hiddenAt(steps), [["alabel", "arrow", "box", "label"], ["alabel", "arrow"], []]);
    assert.deepEqual(acts(builds(F, [step("s1", "appear", "box")], [F, ...five])), { s1: ["box", "label"] });
  }

  // 6. Exits. Undoing a step is the state one step earlier, so the two Backward rows are the list read back.
  {
    const steps = builds(F, [step("s1", "fade-out", "free"), step("s2", "slide-out", "box", { direction: "right" })], [F, ...five]);
    assert.deepEqual(acts(steps), { s1: ["free"], s2: ["box", "label"] });
    assert.deepEqual(hiddenAt(steps), [[], ["free"], ["box", "free", "label"]]);
  }

  // 7. An element in several steps.
  {
    const steps = builds(
      F,
      [step("s1", "appear", "box"), step("s2", "fade", "free"), step("s3", "disappear", "box"), step("s4", "zoom", ["box", "free"]), step("s5", "fade-out", "free")],
      [F, ...five],
    );
    assert.deepEqual(hiddenAt(steps), [["box", "free", "label"], ["free"], [], ["box", "label"], [], ["free"]]);
    // `free` is shown before `s4` and takes part in it anyway.
    assert.deepEqual(acts(steps).s4, ["box", "free", "label"]);
    // The first step decides the start.
    assert.deepEqual(hiddenAt(builds(F, [step("s1", "disappear", "free"), step("s2", "appear", "free")], [F, ...five])), [[], ["free"], []]);
  }

  // 8. Groups, and targets that are gone.
  {
    const elements = [
      F,
      { id: "box", type: "rectangle", x: 100, y: 100, width: 200, height: 100, boundElements: [{ type: "text", id: "label" }] },
      { id: "label", type: "text", x: 150, y: 130, width: 100, height: 25, containerId: "box" },
      { id: "g1", type: "ellipse", x: 200, y: 400, width: 50, height: 50, groupIds: ["grp", "outer"] },
      { id: "g2", type: "ellipse", x: 300, y: 400, width: 50, height: 50, groupIds: ["grp"], boundElements: [{ type: "text", id: "g2t" }] },
      { id: "g2t", type: "text", x: 310, y: 415, width: 30, height: 20, containerId: "g2", groupIds: ["grp"] },
      { id: "g3", type: "ellipse", x: 2000, y: 400, width: 50, height: 50, groupIds: ["grp"] },
      { id: "g4", type: "ellipse", x: 400, y: 400, width: 50, height: 50, groupIds: ["grp"], isDeleted: true },
      { id: "away", type: "rectangle", x: 3000, y: 0, width: 50, height: 50 },
    ];
    const given = [
      step("s1", "fade", { type: "group", id: "grp" }),
      step("s2", "appear", "away"),
      step("s3", "zoom", { type: "group", id: "nobody" }),
      step("s4", "appear", ["gone", "box"]),
      step("s5", "appear", "F"),
      step("s6", "appear", "g4"),
    ];
    const steps = builds(F, given, elements);
    assert.deepEqual(acts(steps), { s1: ["g1", "g2", "g2t"], s4: ["box", "label"] });
    assert.deepEqual(steps.map((b) => b.step), [given[0], given[3]]);
    assert.deepEqual(hiddenAt(steps), [["box", "g1", "g2", "g2t", "label"], ["box", "label"], []]);
    // Forward twice builds the slide, the third leaves it (it is the last slide of a deck of one here).
    assert.deepEqual(stepFrom({ slide: 0, done: 0, total: steps.length }, 1, 1), { slide: 0, done: 1 });
    assert.deepEqual(stepFrom({ slide: 0, done: 1, total: steps.length }, 1, 1), { slide: 0, done: 2 });
    assert.equal(stepFrom({ slide: 0, done: 2, total: steps.length }, 1, 1), null);
    assert.deepEqual(stepFrom({ slide: 0, done: 2, total: steps.length }, 2, 1), { slide: 1, done: 0 });
  }

  // 9. Viewport scope.
  {
    const elements = [
      F,
      { id: "near", type: "rectangle", x: 1340, y: 100, width: 50, height: 50 },
      { id: "far", type: "rectangle", x: 1500, y: 100, width: 50, height: 50 },
      { id: "above", type: "rectangle", x: 100, y: -400, width: 50, height: 50 },
      { id: "grazes", type: "rectangle", x: 1408, y: 300, width: 50, height: 50 },
    ];
    const wide = (id) => ({ type: "element", id, scope: "viewport" });
    const given = [step("s1", "appear", "near"), step("s2", "appear", wide("near")), step("s3", "appear", wide("far")), step("s4", "appear", wide("above")), step("s5", "appear", wide("grazes"))];
    const stepsIn = (viewport) => builds(F, given, elements, viewport).map((b) => b.step.id);
    assert.deepEqual(stepsIn(undefined), ["s2", "s5"]);
    assert.deepEqual(stepsIn({ width: 1920, height: 1080 }), ["s2", "s5"]);
    assert.deepEqual(stepsIn({ width: 1000, height: 1000 }), ["s2", "s4", "s5"]);
    assert.deepEqual(stepsIn({ width: 2560, height: 1080 }), ["s2", "s3", "s5"]);
    // The grown rectangle ends at x 1408 and y 792: one further is outside it.
    const past = [F, { id: "right", type: "rectangle", x: 1409, y: 300, width: 50, height: 50 }, { id: "below", type: "rectangle", x: 100, y: 793, width: 50, height: 50 }, { id: "at", type: "rectangle", x: 100, y: 792, width: 50, height: 50 }];
    assert.deepEqual(builds(F, [step("r", "appear", wide("right")), step("b", "appear", wide("below")), step("a", "appear", wide("at"))], past).map((b) => b.step.id), ["a"]);
  }

  // 10. Edges, turned elements, and a unit half on the slide.
  {
    const elements = [
      F,
      { id: "edge", type: "rectangle", x: 1280, y: 720, width: 40, height: 40 },
      { id: "off", type: "rectangle", x: 1281, y: 100, width: 40, height: 40 },
      { id: "tall", type: "rectangle", x: -30, y: 300, width: 10, height: 100 },
      { id: "turned", type: "rectangle", x: -30, y: 300, width: 10, height: 100, angle: 1.5707963267948966 },
      { id: "flipped", type: "line", x: 1300, y: 200, width: -40, height: 10 },
      { id: "oc", type: "rectangle", x: 1270, y: 480, width: 300, height: 60, boundElements: [{ type: "text", id: "ot" }] },
      { id: "ot", type: "text", x: 1400, y: 500, width: 50, height: 20, containerId: "oc" },
    ];
    const given = [step("s1", "appear", "edge"), step("s2", "appear", "off"), step("s3", "appear", "tall"), step("s4", "appear", "turned"), step("s5", "appear", "flipped"), step("s6", "appear", "ot")];
    assert.deepEqual(acts(builds(F, given, elements)), { s1: ["edge"], s4: ["turned"], s5: ["flipped"], s6: ["oc", "ot"] });
    const on = (id) => overlaps(elements.find((e) => e.id === id), F);
    assert.deepEqual(["edge", "off", "tall", "turned", "flipped", "oc", "ot"].map(on), [true, false, false, true, true, true, false]);
    // `overlaps` does not look at the id: the frame's own box touches its rectangle.
    assert.ok(overlaps(F, F));
  }

  // 11. Timed steps: what the rules give without a clock. The waits and the times are checked in the running app.
  {
    const given = [
      step("s1", "fade", "box"),
      step("s2", "appear", "free", { trigger: "after-delay", delayMs: 500 }),
      step("s3", "fade", "arrow", { trigger: "after-delay", durationMs: 200 }),
      step("s4", "disappear", "box"),
    ];
    const steps = builds(F, given, [F, ...five]);
    assert.deepEqual(acts(steps), { s1: ["box", "label"], s2: ["free"], s3: ["alabel", "arrow"], s4: ["box", "label"] });
    assert.deepEqual(hiddenAt(steps), [["alabel", "arrow", "box", "free", "label"], ["alabel", "arrow", "free"], ["alabel", "arrow"], [], ["box", "label"]]);
    // The defaults are not written into what is read: they are applied when the step plays.
    const read = slideshowData({ ...F, customData: record({ order: 0, animation: { steps: given } }) }).animation.steps;
    assert.deepEqual(read.map((s) => [s.trigger, s.delayMs, s.durationMs]), [["advance", undefined, undefined], ["after-delay", 500, undefined], ["after-delay", undefined, 200], ["advance", undefined, undefined]]);
  }

  // 12. Moving through a deck.
  {
    for (const [now, by, to] of [
      [{ slide: 0, done: 0, total: 2 }, 1, { slide: 0, done: 1 }],
      [{ slide: 0, done: 1, total: 2 }, 1, { slide: 0, done: 2 }],
      [{ slide: 0, done: 2, total: 2 }, 1, { slide: 1, done: 0 }],
      [{ slide: 1, done: 0, total: 0 }, 1, { slide: 2, done: 0 }],
      [{ slide: 2, done: 0, total: 1 }, 1, { slide: 2, done: 1 }],
      [{ slide: 2, done: 0, total: 0 }, 1, null],
      [{ slide: 1, done: 2, total: 2 }, -1, { slide: 1, done: 1 }],
      [{ slide: 0, done: 1, total: 2 }, -1, { slide: 0, done: 0 }],
      [{ slide: 1, done: 0, total: 2 }, -1, { slide: 0, done: "all" }],
      [{ slide: 0, done: 0, total: 2 }, -1, null],
    ]) {
      assert.deepEqual(stepFrom(now, 3, by), to, JSON.stringify([now, by]));
    }

    // The table of inputs, with the keys read as the windows read them: a deck of two slides, the first with two steps.
    const totals = [2, 0];
    let at = { slide: 0, done: 0 };
    const press = (key) => {
      const message = keyMessage(key);
      if (message.type === "exit") at = null;
      else if (message.type === "goto") at = { slide: message.index === "last" ? totals.length - 1 : at.slide, done: 0 };
      else {
        const to = stepFrom({ ...at, total: totals[at.slide] }, totals.length, message.by);
        at = to && { slide: to.slide, done: to.done === "all" ? totals[to.slide] : to.done };
      }
      return at;
    };
    for (const [key, to] of [
      ["ArrowRight", { slide: 0, done: 1 }],
      [" ", { slide: 0, done: 2 }],
      ["PageDown", { slide: 1, done: 0 }],
      ["ArrowLeft", { slide: 0, done: 2 }],
      ["ArrowUp", { slide: 0, done: 1 }],
      ["Home", { slide: 0, done: 0 }],
      ["End", { slide: 1, done: 0 }],
      ["Home", { slide: 1, done: 0 }],
      ["ArrowRight", null],
    ]) {
      assert.deepEqual(press(key), to, key);
    }
    at = { slide: 0, done: 0 };
    assert.equal(press("ArrowLeft"), null, "Left arrow at the start ends the slideshow");
    assert.deepEqual([keyMessage("Escape"), keyMessage("Backspace")], [{ type: "exit" }, { type: "exit" }]);
    assert.deepEqual([keyMessage("ArrowDown"), keyMessage("PageUp")], [{ type: "step", by: 1 }, { type: "step", by: -1 }]);
    // F is the drawing's window's own key, and the rest are nobody's.
    for (const key of ["f", "F", "Delete", "Enter", "a", "Tab"]) assert.equal(keyMessage(key), null, key);
  }

  // 13. Saving notes.
  {
    const frames = [
      { id: "f3", type: "frame", name: "03 How", customData: { drawKey: "how" } },
      { id: "t", type: "text" },
      { id: "f1", type: "frame", name: "01 Title" },
      { id: "f2", type: "frame", name: "02 Why", customData: { drawKey: "why" } },
    ];
    const notes = "Say **why**.\n\n- one\n- two";
    const written = withNotes(frames, "f2", notes);
    const expected = {
      f1: { slideshow: { schemaVersion: 2, kind: "frame", order: 0 } },
      f2: { drawKey: "why", slideshow: { schemaVersion: 2, kind: "frame", order: 1, notes } },
      f3: { drawKey: "how", slideshow: { schemaVersion: 2, kind: "frame", order: 2 } },
    };
    assert.deepEqual(Object.fromEntries(written), expected);
    // The order of the fields is part of what is written.
    for (const id of ["f1", "f2", "f3"]) assert.equal(JSON.stringify(written.get(id)), JSON.stringify(expected[id]), id);
    assert.equal(frames[3].customData.slideshow, undefined, "the elements given are not changed");

    const saved = frames.map((e) => (written.has(e.id) ? { ...e, customData: written.get(e.id) } : e));
    assert.equal(withNotes(saved, "f2", notes), null);
    assert.equal(withNotes(saved, "f1", ""), null);
    assert.deepEqual(withNotes(saved, "f2", " ").get("f2"), { drawKey: "why", slideshow: { schemaVersion: 2, kind: "frame", order: 1 } });
    assert.throws(() => withNotes(saved, "nope", "x"), /no longer in the drawing/);
    assert.throws(() => withNotes(saved, "t", "x"), /no longer in the drawing/);

    // A deck with records of every kind.
    const n = { schemaVersion: 2, kind: "frame", order: 0, notes: "Keep me", extra: 1,
      animation: { steps: [{ id: "s1", targets: [{ type: "element", id: "a" }], effect: "spin", trigger: "advance" }] } };
    const k = { schemaVersion: 2, kind: "frame", order: 1, extra: { a: 1 }, notes: "Old", deckName: "Talk",
      animation: { loop: true, steps: [{ id: "s1", targets: [{ type: "element", id: "a", pin: true }], effect: "fade", trigger: "advance", easing: "bounce" }] } };
    const b = { schemaVersion: 2, kind: "frame", order: 2, notes: " ", later: [1] };
    const kinds = [
      { id: "n", type: "frame", name: "A newer", customData: { slideshow: n } },
      { id: "k", type: "frame", name: "B known", customData: { slideshow: k } },
      { id: "b", type: "frame", name: "C blank", customData: { slideshow: b } },
      { id: "p", type: "frame", name: "D plain" },
    ];
    const before = JSON.stringify(kinds);
    assert.deepEqual(deckOf(kinds).map((s) => s.frame.id), ["k", "b", "n", "p"]);
    /** What a save writes, as the JSON text of each frame's record, so the order of the fields counts. */
    const save = (id, text) => {
      const out = withNotes(kinds, id, text);
      return out && Object.fromEntries([...out].map(([frame, customData]) => [frame, JSON.stringify(customData.slideshow)]));
    };
    const json = JSON.stringify;
    const bWritten = json({ schemaVersion: 2, kind: "frame", order: 1, notes: " ", later: [1], deckName: "Talk" });
    const pBare = json({ schemaVersion: 2, kind: "frame", order: 3, deckName: "Talk" });

    assert.deepEqual(save("p", "New"), {
      k: json({ ...k, order: 0 }),
      b: bWritten,
      p: json({ schemaVersion: 2, kind: "frame", order: 3, deckName: "Talk", notes: "New" }),
    });
    assert.deepEqual(save("k", "New"), { k: json({ ...k, order: 0, notes: "New" }), b: bWritten, p: pBare });
    const { notes: _, ...kBare } = k;
    assert.deepEqual(save("k", ""), { k: json({ ...kBare, order: 0 }), b: bWritten, p: pBare });
    assert.deepEqual(save("n", "New"), { n: json({ ...n, notes: "New" }), k: json({ ...k, order: 0 }), b: bWritten, p: pBare });
    assert.equal(save("n", "Keep me"), null);
    assert.equal(save("b", "  "), null);
    assert.equal(JSON.stringify(kinds), before, "the elements given are not changed");

    // The rows of the table that the example has no frame for: an invalid record's notes removed, and a stored
    // value that is not a JSON object, on the target and on another frame.
    const { notes: __, ...nBare } = n;
    assert.equal(save("n", " ").n, json(nBare));
    const odd = [
      { id: "s", type: "frame", name: "A", customData: { keep: 1, slideshow: "yes" } },
      { id: "z", type: "frame", name: "B", customData: { slideshow: null } },
    ];
    assert.deepEqual(Object.fromEntries(withNotes(odd, "s", "Hi")), {
      s: { keep: 1, slideshow: { schemaVersion: 2, kind: "frame", order: 0, notes: "Hi" } },
      z: { slideshow: { schemaVersion: 2, kind: "frame", order: 1 } },
    });
    assert.deepEqual(Object.fromEntries(withNotes(odd, "z", "Hi")), { z: { slideshow: { schemaVersion: 2, kind: "frame", order: 1, notes: "Hi" } } });

    // The deck's name is the first in the element list, not in the deck.
    const named = [
      { id: "x", type: "frame", name: "X", customData: record({ order: 1, deckName: "By list" }) },
      { id: "y", type: "frame", name: "Y", customData: record({ order: 0, deckName: "By deck" }) },
      { id: "w", type: "frame", name: "W" },
    ];
    assert.equal(withNotes(named, "w", "Hi").get("w").slideshow.deckName, "By list");
    assert.equal(withNotes(named, "w", "Hi").get("y").slideshow.deckName, "By deck");
  }

  // The fixture deck with records (see the top of this file): ordered 03, 01, 02 with 02 excluded, and one build.
  {
    const elements = parse(sorted).scene.elements;
    assert.deepEqual(deckOf(elements).map((s) => s.title.slice(0, 2)), ["03", "01", "02"]);
    assert.deepEqual(slides(elements).map((s) => s.title.slice(0, 2)), ["03", "01"]);
    const title = slides(elements)[1];
    assert.equal(builds(title.frame, title.data.animation.steps, elements).length, 1);
    // Saving notes numbers the frames as the deck has them, and keeps the build.
    const written = withNotes(elements, title.frame.id, "Hi");
    assert.deepEqual([...written.values()].map((c) => c.slideshow.order), [0, 1, 2]);
    assert.deepEqual(written.get(title.frame.id).slideshow.animation, title.frame.customData.slideshow.animation);
  }
}

console.log("excalidraw format: ok");

// A drawing with "\r\n" line endings opens, and a save writes "\r\n" on every line again.
{
  const crlf = diagram.replace(/\n/g, "\r\n");
  const drawing = parse(crlf);
  assert.deepEqual(drawing.scene, parse(diagram).scene);
  const saved = serialize(drawing, drawing.scene.elements);
  assert.ok(!/[^\r]\n/.test(saved), "a bare \\n in a CRLF drawing");
  assert.deepEqual(parse(saved).scene, drawing.scene);
}
