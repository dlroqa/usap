// Bench only (never merged): demonstrates --test-timeout on every CI platform. The first test fails after starting a
// polling loop it never stops (the #125 pattern), which without a timeout keeps this file's process alive forever.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
test("timeout demo: a failed assertion leaves a polling loop running", async () => {
  let running = true;
  (async () => { while (running) await new Promise((r) => setTimeout(r, 40)); })();
  assert.equal(409, 200, "deliberate failure");
  running = false; // never reached
});
test("timeout demo: a later test in the same file", () => {});
