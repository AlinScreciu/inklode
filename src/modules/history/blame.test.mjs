// Self-check for blame.ts, run by `pnpm test:history` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { marks } from "./blame.ts";

const commit = (rev) => ({ rev, author: rev.toUpperCase(), date: "2026-03-01T10:00:00+02:00", subject: `commit ${rev}` });
const range = (from, to, rev) => ({ from, to, ...commit(rev) });
/** The marks as `from-to:rev`, with `?` for lines that are not committed. */
const short = (all) => all.map((m) => `${m.from}-${m.to}:${m.commit?.rev ?? "?"}`).join(" ");

const committed = "one\ntwo\nthree\nfour\nfive\n";
const ranges = [range(1, 1, "a"), range(2, 2, "b"), range(3, 4, "a"), range(5, 5, "c")];

// The text as committed: git's ranges. The empty line after the final newline has no mark.
assert.equal(short(marks(ranges, committed, committed)), "1-1:a 2-2:b 3-4:a 5-5:c");
// A changed line is not committed yet; the lines around it keep their commits.
assert.equal(short(marks(ranges, committed, "one\ntwo\nTHREE\nfour\nfive\n")), "1-1:a 2-2:b 3-3:? 4-4:a 5-5:c");
// New lines push the committed ones down. A deleted line leaves no mark, and the lines of one commit that
// come to be next to each other are one mark.
assert.equal(short(marks(ranges, committed, "zero\none\nthree\nfour\nfive\nsix\n")), "1-1:? 2-4:a 5-5:c 6-6:?");
// Two new lines are one mark too.
assert.equal(short(marks(ranges, committed, "one\nthree\nfour\nx\ny\n")), "1-3:a 4-5:?");
// Everything typed anew.
assert.equal(short(marks(ranges, committed, "all\nnew")), "1-2:?");
// No final newline in the commit and one typed now: the new empty last line is not committed.
assert.equal(short(marks([range(1, 1, "a")], "one", "one\n")), "1-1:a 2-2:?");
// The marks carry the commit's fields.
assert.deepEqual(marks([range(1, 1, "a")], "one", "one")[0].commit, range(1, 1, "a"));
assert.deepEqual(marks([], "", ""), []);

console.log("history blame: ok");
