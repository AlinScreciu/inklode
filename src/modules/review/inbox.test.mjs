// Self-check for inbox.ts, run by `pnpm test:review` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { follow, origin } from "./inbox.ts";

const entry = (path, commits = [], uncommitted = true) => ({ path, status: "changed", added: 1, removed: 0, commits, uncommitted });
const list = (...paths) => paths.map((path) => entry(path));

// The picked note stays picked while it waits.
assert.equal(follow(list("a", "b", "c"), list("a", "b"), "b"), "b");
assert.equal(follow(list("a"), list("a", "b"), null), null, "nothing was picked");
// Once it left the list, the note that took its place is picked: the next one, or the last.
assert.equal(follow(list("a", "b", "c"), list("a", "c"), "b"), "c");
assert.equal(follow(list("a", "b", "c"), list("a", "b"), "c"), "b");
assert.equal(follow(list("a"), [], "a"), null);
// A note that was never in the list (picked while the list was read) gives the first.
assert.equal(follow(list("a", "b"), list("a", "b"), "x"), "a");

const commit = (author, subject) => ({ rev: "0".repeat(40), author, date: "2026-03-01T10:00:00+02:00", subject });
assert.equal(origin(entry("a")), "not committed yet");
assert.equal(origin(entry("a", [commit("Bob", "tidy")], false)), "Bob: tidy");
assert.equal(origin(entry("a", [commit("Bob", "tidy")], true)), "Bob: tidy, and not committed changes");
assert.equal(origin(entry("a", [commit("Bob", "tidy"), commit("Ana", "first"), commit("Ana", "zero")], false)), "Bob: tidy (+2 more)");

console.log("review inbox: ok");
