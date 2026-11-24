// Self-check for workspace.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import * as W from "./workspace.ts";

/** The layout as text: columns split by " | ", panes in a column by " / ", `*` on each pane's shown tab, `>` on the active pane. */
const show = (ws) =>
  ws.columns
    .map((c) =>
      c.panes
        .map((p) => (p.id === ws.active ? ">" : "") + p.tabs.map((t) => (t.path ?? "-") + (t.id === p.active ? "*" : "")).join(" "))
        .join(" / "),
    )
    .join(" | ");

assert.equal(show(W.EMPTY), ">-*");

// A plain open replaces the note in the active tab, and the tab keeps a history.
let ws = W.open(W.open(W.EMPTY, "a"), "b");
assert.equal(show(ws), ">b*");
assert.deepEqual(W.tab(ws).history, { stack: ["a", "b"], index: 1 });
assert.equal(W.tab(W.open(ws, "a", -1)).history.index, 0, "Back moves in the history");

// New tabs go after the active one. Each has its own history.
ws = W.addTab(ws, "c");
ws = W.addTab(ws);
assert.equal(show(ws), ">b c -*");
assert.deepEqual(W.tab(W.goto(ws, 2)).history.stack, ["c"]);
assert.equal(show(W.goto(ws, 9)), ">b c -*", "past the end is the last tab");
assert.equal(show(W.cycle(ws, 1)), ">b* c -", "next goes round");
assert.equal(show(W.cycle(W.cycle(ws, 1), -1)), ">b c -*");

// Closing the shown tab shows its neighbour; closed notes can be reopened, the last closed first.
ws = W.closeTab(W.goto(ws, 2));
assert.equal(show(ws), ">b -*");
ws = W.closeTab(W.goto(ws, 1));
assert.equal(show(ws), ">-*");
assert.deepEqual(ws.closed, ["c", "b"]);
ws = W.reopen(ws);
assert.equal(show(ws), ">- b*");
assert.equal(show(W.reopen(W.reopen(ws))), ">- b c*", "reopening with nothing left changes nothing");
assert.equal(show(W.closeOthers(ws)), ">b*");

// The last tab of the only pane leaves an empty tab.
assert.equal(show(W.closeTab(W.open(W.EMPTY, "a"))), ">-*");

// Splits: right adds a column, down adds a pane under the active one. The copy is active and has half the room.
ws = W.split(W.open(W.EMPTY, "a"), "right");
assert.equal(show(ws), "a* | >a*");
assert.deepEqual(ws.columns.map((c) => c.size), [0.5, 0.5]);
ws = W.split(W.open(ws, "b"), "down");
assert.equal(show(ws), "a* | b* / >b*");
assert.deepEqual(W.tab(ws).history.stack, ["a", "b"], "the copy keeps the history");
assert.equal(new Set(W.panes(ws).flatMap((p) => [p.id, ...p.tabs.map((t) => t.id)])).size, 6, "ids are unique");
assert.equal(show(W.focusNext(ws)), ">a* | b* / b*");
assert.equal(show(W.focusNext(ws, -1)), "a* | >b* / b*");
assert.deepEqual(W.resize(ws, 1, [3, 1]).columns[1].panes.map((p) => p.size), [3, 1]);
assert.deepEqual(W.resize(ws, null, [2, 1]).columns.map((c) => c.size), [2, 1]);

// The last tab of a pane that is not the only one closes the pane, and the pane before it takes over.
assert.equal(show(W.closeTab(ws)), "a* | >b*");
assert.equal(show(W.closePane(W.focusNext(ws))), ">b* / b*", "closing the first pane activates the next");
assert.equal(show(W.closePane(W.closePane(W.closePane(ws)))), ">-*");

// Moving a tab: inside a strip, to another pane, and out of a pane that then closes.
let m = W.addTab(W.addTab(W.open(W.EMPTY, "a"), "b"), "c");
const [a, b, c] = W.pane(m).tabs.map((t) => t.id);
assert.equal(show(W.moveTab(m, a, m.active, 3)), ">b c a*");
assert.equal(show(W.moveTab(m, c, m.active, 0)), ">c* a b");
assert.equal(show(W.moveTab(m, b, m.active, 1)), ">a b* c", "dropped where it is");
m = W.split(m, "right");
const right = m.active;
assert.equal(show(m), "a b c* | >c*");
m = W.moveTab(m, a, right, 0);
assert.equal(show(m), "b c* | >a* c");
m = W.moveTab(W.moveTab(m, b, right, 2), c, right, 0);
assert.equal(show(m), ">c* a c b", "the emptied pane and its column are gone");

// Rename and delete reach every tab, every history and the closed list.
let r = W.closeTab(W.addTab(W.split(W.open(W.open(W.EMPTY, "a"), "b"), "right"), "a"));
assert.equal(show(r), "b* | >b*");
r = W.renamed(r, "b", "B");
assert.equal(show(r), "B* | >B*");
assert.deepEqual(W.panes(r).map((p) => W.shown(p).history.stack), [["a", "B"], ["a", "B"]]);
r = W.removed(W.renamed(r, "a", "A"), "A");
assert.deepEqual(r.closed, []);
assert.deepEqual(W.tab(r).history, { stack: ["B"], index: 0 });
assert.equal(show(W.removed(r, "B")), "-* | >-*", "a tab on a deleted note with nothing before it is left empty");
// A tab on a deleted note steps back to the note it showed before.
const stepped = W.removed(W.open(W.open(W.open(W.EMPTY, "a"), "b"), "c"), "c");
assert.equal(show(stepped), ">b*");
assert.deepEqual(W.tab(stepped).history, { stack: ["a", "b"], index: 1 });

// The editor mode is per tab, and kept through a restore; a page covers one tab.
let s = W.setMode(W.split(W.open(W.EMPTY, "a"), "right"), "reading");
assert.deepEqual(W.panes(s).map((p) => W.shown(p).mode), [null, "reading"]);
assert.equal(W.tab(W.resetMode(s)).mode, null);
assert.equal(W.tab(W.restore(JSON.parse(JSON.stringify(s)), () => true)).mode, "reading");
assert.equal(W.tab(W.restore(JSON.parse(JSON.stringify(W.setMode(s, "nonsense"))), () => true)).mode, null);
s = W.showPage(s, "graph");
assert.deepEqual(W.panes(s).map((p) => W.shown(p).page), [null, "graph"]);
assert.equal(W.tab(W.open(s, "b")).page, null, "opening a note uncovers it");

// Restore: through JSON and back it is the same layout; notes that are gone are dropped; junk gives EMPTY.
const saved = JSON.parse(JSON.stringify(W.resize(ws, null, [2, 1])));
const back = W.restore(saved, () => true);
assert.equal(show(back), show(ws));
assert.deepEqual(back.columns.map((c) => c.size), [2, 1]);
assert.deepEqual(W.tab(back).history, W.tab(ws).history);
assert.equal(show(W.addTab(back, "z")), "a* | b* / >b z*", "ids given out after a restore are new");
assert.equal(show(W.restore(saved, (p) => p !== "b")), ">a*");
assert.deepEqual(W.tab(W.restore(saved, (p) => p !== "a")).history, { stack: ["b"], index: 0 });
assert.equal(show(W.restore(saved, () => false)), ">-*");
for (const junk of [null, 5, "x", {}, { columns: [{ panes: [{ tabs: [] }] }] }, { columns: "no" }]) {
  assert.equal(W.restore(junk, () => true), W.EMPTY);
}
// A view shown beside the active pane gets a pane of its own to the right, once, and the active pane stays active.
let beside = W.showBeside(W.addTab(W.open(W.EMPTY, "a"), "b"), "diff");
assert.equal(show(beside), ">a b* | b*");
assert.equal(W.panes(beside)[1].tabs[0].page, "diff");
assert.equal(W.showBeside(beside, "diff"), beside, "it shows already");
// Hiding it closes that pane, and nothing is added to the tabs to reopen.
assert.equal(show(W.hidePage(beside, "diff")), ">a b*");
assert.deepEqual(W.hidePage(beside, "diff").closed, []);
// In the only pane the note under it comes back instead.
const only = W.hidePage(W.closePane(beside, W.panes(beside)[0].id), "diff");
assert.equal(show(only), ">b*");
assert.equal(W.tab(only).page, null);
assert.equal(W.hidePage(only, "diff"), only);

// An empty tab survives a restore.
assert.equal(show(W.restore(JSON.parse(JSON.stringify(W.addTab(W.open(W.EMPTY, "a")))), () => true)), ">a -*");

console.log("workspace: ok");
