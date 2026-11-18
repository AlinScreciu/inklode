// Self-check for polled.ts, run by `pnpm test:health` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { polled, quiet } from "./polled.ts";

// Timers by hand: `tick` lets time pass.
const clock = () => {
  let [now, next] = [0, 1];
  const waiting = new Map();
  return {
    timers: {
      set: (run, ms) => (waiting.set(next, { at: now + ms, run }), next++),
      clear: (timer) => void waiting.delete(timer),
    },
    tick(ms) {
      now += ms;
      for (const [timer, { at, run }] of [...waiting]) if (at <= now && waiting.delete(timer)) run();
    },
  };
};

// One run, after the calls stopped for the whole wait.
{
  const { timers, tick } = clock();
  let runs = 0;
  const later = quiet(() => runs++, 3000, timers);
  later();
  tick(2000);
  later();
  tick(2000);
  later();
  assert.equal(runs, 0);
  assert.equal(later.waiting(), true);
  tick(2999);
  assert.equal(runs, 0);
  tick(1);
  assert.equal(runs, 1);
  assert.equal(later.waiting(), false);
  tick(10000);
  assert.equal(runs, 1);
  // A change after that is a run of its own.
  later();
  tick(3000);
  assert.equal(runs, 2);
}

// `now` runs at once, and the run that waited is not made after it.
{
  const { timers, tick } = clock();
  let runs = 0;
  const later = quiet(() => runs++, 3000, timers);
  later();
  later.now();
  assert.equal(runs, 1);
  assert.equal(later.waiting(), false);
  tick(5000);
  assert.equal(runs, 1);
  later.now();
  assert.equal(runs, 2);
  // `cancel` drops the run that waits and makes none.
  later();
  later.cancel();
  assert.equal(later.waiting(), false);
  tick(5000);
  assert.equal(runs, 2);
}

// A polled list: one reading at a time, at most one more waits, and that one starts after the first is done.
{
  let [reads, value] = [0, "a"];
  const gates = [];
  const list = polled("", () => new Promise((done) => gates.push(() => (reads++, done(value)))));
  let told = 0;
  list.subscribe(() => told++);
  const turn = () => new Promise((done) => setTimeout(done));
  const first = list.refresh();
  await turn();
  assert.equal(gates.length, 1);
  // Asked twice while the first reading runs: one more reading, not two, and not before the first is done.
  const second = list.refresh();
  assert.equal(list.refresh(), second);
  assert.notEqual(second, first);
  await turn();
  assert.equal(gates.length, 1);
  value = "b";
  gates.shift()();
  await first;
  assert.equal(list.get(), "b");
  await turn();
  assert.equal(gates.length, 1);
  value = "c";
  gates.shift()();
  await second;
  assert.deepEqual([list.get(), reads, told], ["c", 2, 2]);
}

console.log("polled ok");
