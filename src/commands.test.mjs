// Self-check for the key rule of commands.ts, run by `pnpm test:shell` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { bindable, commands } from "./commands.ts";

// keys.json may bind a key with Mod or Alt in it, and a function key.
for (const key of ["Mod+K", "Mod+Shift+P", "Alt+Enter", "Shift+Alt+ArrowUp", "Mod+Alt+X", "Mod++", "Mod+\\", "F1", "F12", "F24", "Shift+F5", "Mod+F5"]) {
  assert.equal(bindable(key), true, key);
}
// Not a key a person types with, on its own or with Shift.
for (const key of ["X", "Shift+X", "Enter", "Escape", " ", "Tab", "ArrowDown", "Backspace", "+", "Shift++", "F0", "F25", "F", "FX", "Mod", "Alt", "", "Shift+Mod", "mod+K"]) {
  assert.equal(bindable(key), false, JSON.stringify(key));
}

// A key from keys.json that is not bindable is not in force: the command keeps its default. Null still unbinds.
const ran = [];
const remove = commands.register([
  { id: "a", title: "A", key: "Mod+A", run: () => void ran.push("a") },
  { id: "b", title: "B", key: "Mod+B", run: () => void ran.push("b") },
  { id: "c", title: "C", run: () => void ran.push("c") },
  { id: "d", title: "D", key: "Mod+D", run: () => void ran.push("d") },
  // A default without a modifier is the code's own, and stays.
  { id: "e", title: "E", key: "Escape", run: () => void ran.push("e") },
]);
commands.keys = { a: "X", b: "Mod+Shift+B", c: "Enter", d: null, e: "Shift+E" };
const keys = Object.fromEntries(commands.list().map((c) => [c.id, c.key]));
assert.deepEqual(keys, { a: "Mod+A", b: "Mod+Shift+B", c: undefined, d: undefined, e: "Escape" });

const press = (key, mods = {}) => {
  const event = { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods, preventDefault() {}, stopPropagation() {} };
  return commands.handleKey(event);
};
assert.equal(press("x"), false);
assert.equal(press("Enter"), false);
assert.equal(press("a", { metaKey: true }), true);
assert.equal(press("b", { ctrlKey: true, shiftKey: true }), true);
assert.equal(press("d", { metaKey: true }), false);
await new Promise((done) => setTimeout(done, 0));
assert.deepEqual(ran, ["a", "b"]);
commands.keys = {};
remove();

console.log("commands: ok");
