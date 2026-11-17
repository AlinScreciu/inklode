// Self-check for saves.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).
// These are the rules that decide whether a note's file is written, so a wrong one loses text.

import assert from "node:assert/strict";
import { Saves } from "./saves.ts";

/** A store with `a.md` read as "one". */
const open = () => {
  const s = new Saves();
  s.reset();
  assert.equal(s.disk("a.md", "one", s.stamp("a.md")), "take");
  return s;
};
const edit = (s, text) => assert.ok(s.edit(s.gen, "a.md", text));

// A note that is only read is never written.
{
  const s = open();
  assert.equal(s.begin("a.md"), null);
  assert.equal(s.dirty("a.md"), false);
  assert.deepEqual(s.unsaved(), []);
}

// An edit is written with the text it was made on as its base, and the written text is the next base.
{
  const s = open();
  edit(s, "two");
  assert.equal(s.text("a.md"), "two");
  const job = s.begin("a.md");
  assert.deepEqual([job.content, job.base], ["two", "one"]);
  // Still unsaved while the write is in flight, and no second write starts beside it.
  assert.ok(s.dirty("a.md"));
  edit(s, "three");
  assert.equal(s.begin("a.md"), null);
  assert.ok(s.done(job));
  const next = s.begin("a.md");
  assert.deepEqual([next.content, next.base], ["three", "two"]);
  assert.ok(s.done(next));
  assert.equal(s.dirty("a.md"), false);
  assert.equal(s.text("a.md"), undefined);
}

// A failed write keeps the edit, says why, and waits longer each time. A newer edit is not replaced by the failed one.
{
  const s = open();
  edit(s, "two");
  let job = s.begin("a.md");
  assert.ok(s.fail(job, false, "disk full"));
  assert.equal(s.text("a.md"), "two");
  assert.deepEqual(s.issue("a.md"), { kind: "failed", message: "disk full" });
  assert.deepEqual(s.unsaved(), ["a.md"]);
  assert.equal(s.retryIn("a.md", 800), 1600);
  job = s.begin("a.md");
  edit(s, "three");
  s.fail(job, false, "disk full");
  assert.equal(s.text("a.md"), "three");
  assert.equal(s.retryIn("a.md", 800), 3200);
  assert.equal(s.retryIn("a.md", 800, 2000), 2000);
  job = s.begin("a.md");
  assert.deepEqual([job.content, job.base], ["three", "one"]);
  s.done(job);
  assert.equal(s.issue("a.md"), undefined);
  assert.equal(s.retryIn("a.md", 800), 800);
}

// The file changed on disk while nothing was unsaved: its text is taken. The app's own write coming back is nothing new.
{
  const s = open();
  assert.equal(s.disk("a.md", "theirs", s.stamp("a.md")), "take");
  edit(s, "mine");
  s.done(s.begin("a.md"));
  assert.equal(s.disk("a.md", "mine", s.stamp("a.md")), "same");
}

// The file changed on disk under an unsaved edit: a conflict at once, nothing is written until the user chooses.
{
  const s = open();
  edit(s, "mine");
  assert.equal(s.disk("a.md", "theirs", s.stamp("a.md")), "conflict");
  assert.deepEqual(s.issue("a.md"), { kind: "conflict", theirs: "theirs" });
  assert.equal(s.autosaves("a.md"), false);
  assert.equal(s.begin("a.md"), null);
  // Typing goes on and is kept. Reading the same text again changes nothing, not even the issue object.
  edit(s, "mine 2");
  const issue = s.issue("a.md");
  assert.equal(s.disk("a.md", "theirs", s.stamp("a.md")), "conflict");
  assert.equal(s.issue("a.md"), issue);
  // Keep mine: written over the text that was just read, not over whatever is there by then.
  assert.ok(s.keepMine("a.md", "ignored"));
  const job = s.begin("a.md");
  assert.deepEqual([job.content, job.base], ["mine 2", "theirs"]);
}
{
  const s = open();
  edit(s, "mine");
  s.disk("a.md", "theirs", s.stamp("a.md"));
  assert.equal(s.takeTheirs("a.md"), "theirs");
  assert.equal(s.dirty("a.md"), false);
  assert.equal(s.issue("a.md"), undefined);
  // Undo in the editor brings the user's text back as an ordinary edit, on the new base.
  edit(s, "mine");
  assert.equal(s.begin("a.md").base, "theirs");
}

// A conflict is merged only with a merge function set (the `merge` module): without one nothing changes.
{
  const s = open();
  edit(s, "mine");
  s.disk("a.md", "theirs", s.stamp("a.md"));
  const issue = s.issue("a.md");
  assert.equal(s.merged("a.md", "mine"), undefined);
  assert.equal(s.issue("a.md"), issue);
  assert.equal(s.begin("a.md"), null);
}
// With one: the merged text waits, to be written over the file's text as it was just read.
{
  const seen = [];
  Saves.merge = (...args) => (seen.push(args), "both");
  const s = open();
  // Not without a conflict, and not before the file's text is known (a refused write, not read yet).
  edit(s, "mine");
  assert.equal(s.merged("a.md", "mine"), undefined);
  s.fail(s.begin("a.md"), true, "changed on disk");
  assert.equal(s.merged("a.md", "mine"), undefined);
  s.disk("a.md", "theirs", s.stamp("a.md"));
  // Not when the editor has another text than the edit that waits.
  assert.equal(s.merged("a.md", "something else"), undefined);
  assert.deepEqual(seen, []);
  assert.equal(s.merged("a.md", "mine"), "both");
  assert.deepEqual(seen, [["one", "mine", "theirs", "a.md"]]);
  assert.equal(s.issue("a.md"), undefined);
  assert.equal(s.text("a.md"), "both");
  const job = s.begin("a.md");
  assert.deepEqual([job.content, job.base], ["both", "theirs"]);
  // The file changed once more before that write: refused, and merged again on what the last merge was made on.
  s.fail(job, true, "changed on disk");
  s.disk("a.md", "theirs 2", s.stamp("a.md"));
  assert.equal(s.merged("a.md", "both"), "both");
  assert.deepEqual(seen[1], ["theirs", "both", "theirs 2", "a.md"]);
  assert.equal(s.begin("a.md").base, "theirs 2");

  // The two sides overlap (null), or the merge throws: the conflict stays exactly as it was, for the user.
  for (const merge of [() => null, () => { throw new Error("broken"); }, () => undefined]) {
    Saves.merge = merge;
    const t = open();
    edit(t, "mine");
    t.disk("a.md", "theirs", t.stamp("a.md"));
    const issue = t.issue("a.md");
    assert.equal(t.merged("a.md", "mine"), undefined);
    assert.equal(t.issue("a.md"), issue);
    assert.equal(t.text("a.md"), "mine");
    assert.equal(t.begin("a.md"), null);
    assert.ok(t.keepMine("a.md", "mine"));
    assert.deepEqual([t.begin("a.md").content, t.begin("a.md")], ["mine", null]);
  }
  // A file that is gone is never merged: there is no text on the other side.
  Saves.merge = () => "both";
  const g = open();
  edit(g, "mine");
  g.gone("a.md", g.stamp("a.md"));
  assert.equal(g.merged("a.md", "mine"), undefined);
  assert.equal(g.issue("a.md").kind, "gone");
  Saves.merge = null;
}

// The core refuses a write (conflict): the edit waits, the file's text comes with the next read.
{
  const s = open();
  edit(s, "mine");
  const job = s.begin("a.md");
  assert.ok(s.fail(job, true, "changed on disk"));
  assert.deepEqual(s.issue("a.md"), { kind: "conflict" });
  assert.equal(s.begin("a.md"), null);
  assert.equal(s.keepMine("a.md", "x"), false);
  assert.equal(s.disk("a.md", "theirs", s.stamp("a.md")), "conflict");
  assert.equal(s.issue("a.md").theirs, "theirs");
  // The file is as it was again (the other program undid its change): the edit is saved after all.
  assert.equal(s.disk("a.md", "one", s.stamp("a.md")), "retry");
  assert.equal(s.begin("a.md").content, "mine");
}

// The file already has what was typed (the other program wrote the same): no conflict, nothing to write.
{
  const s = open();
  edit(s, "same");
  assert.equal(s.disk("a.md", "same", s.stamp("a.md")), "same");
  assert.equal(s.dirty("a.md"), false);
}

// A read that a write overtook says nothing: its text may be older than the write.
{
  const s = open();
  edit(s, "two");
  const before = s.stamp("a.md");
  const job = s.begin("a.md");
  assert.equal(s.disk("a.md", "one", s.stamp("a.md")), "stale");
  s.done(job);
  assert.equal(s.disk("a.md", "one", before), "stale");
  assert.equal(s.gone("a.md", before), false);
  assert.equal(s.issue("a.md"), undefined);
}

// The file is gone: nothing is written back until the user says so, and then it is made new.
{
  const s = open();
  assert.ok(s.gone("a.md", s.stamp("a.md")));
  assert.deepEqual(s.issue("a.md"), { kind: "gone" });
  edit(s, "typed after");
  assert.equal(s.begin("a.md"), null);
  assert.ok(s.keepMine("a.md", "unused"));
  const job = s.begin("a.md");
  assert.deepEqual([job.content, job.base], ["typed after", ""]);
  // With nothing typed, the editor's text is what is saved again.
  const t = open();
  t.gone("a.md", t.stamp("a.md"));
  assert.equal(t.takeTheirs("a.md"), undefined);
  t.keepMine("a.md", "one");
  assert.deepEqual([t.begin("a.md").content], ["one"]);
}

// Another vault: the edits of the last one are gone from the store, and its editors and writes report to nobody.
{
  const s = open();
  const old = s.gen;
  edit(s, "two");
  const job = s.begin("a.md");
  s.reset();
  assert.equal(s.edit(old, "a.md", "late keystroke"), false);
  assert.deepEqual(s.unsaved(), []);
  assert.equal(s.done(job), false);
  assert.equal(s.fail(job, false, "x"), false);
  assert.equal(s.text("a.md"), undefined);
}

// A note that was never read is not written: there is no base to check the file against.
{
  const s = new Saves();
  s.edit(s.gen, "b.md", "text");
  assert.equal(s.begin("b.md"), null);
  assert.equal(s.issue("b.md").kind, "failed");
}

// A rename by the app takes the edit and the base along; a delete drops them, and a write in flight is then nobody's.
{
  const s = open();
  edit(s, "two");
  s.gone("a.md", s.stamp("a.md"));
  s.move("a.md", "b.md");
  assert.equal(s.text("a.md"), undefined);
  const job = s.begin("b.md");
  assert.deepEqual([job.path, job.content, job.base], ["b.md", "two", "one"]);
  s.drop("b.md");
  assert.equal(s.done(job), false);
  assert.deepEqual(s.unsaved(), []);
  // A write in flight when the note moves: its text waits again at the new path, and the old job is nobody's.
  const t = open();
  edit(t, "two");
  const late = t.begin("a.md");
  t.move("a.md", "b.md");
  assert.equal(t.fail(late, true, "x"), false);
  assert.equal(t.begin("b.md").content, "two");
}

// Notes that left the screen are forgotten, but never one with an unsaved edit.
{
  const s = open();
  s.disk("b.md", "b", s.stamp("b.md"));
  edit(s, "two");
  s.prune([]);
  assert.equal(s.text("a.md"), "two");
  assert.equal(s.begin("a.md").base, "one");
  s.edit(s.gen, "b.md", "x");
  assert.equal(s.begin("b.md"), null);
}

console.log("saves: ok");
