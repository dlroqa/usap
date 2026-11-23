// #175 legacy R3 observation (fixtures/r3-legacy-diag.cjs): message-only helper plus the precondition read the test
// asserts; these tests pin what it reports and how the precondition is read, not any verdict on the server.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeLegacyR3, imageRuntimeActive } = require("./fixtures/r3-legacy-diag.cjs");

const T = 80000;
const ready = { ready: true, running: true, settings: { model: "C:\\Users\\x\\models\\sd1-img-q4_0.gguf" }, port: 10086 };

test("precondition: the server's own rule (ready or running, with a model set); unreadable is not active", () => {
  assert.equal(imageRuntimeActive(ready), true);
  assert.equal(imageRuntimeActive({ ready: false, running: true, settings: { model: "m" } }), true, "running alone counts, as on the server");
  assert.equal(imageRuntimeActive({ ready: true, running: false, settings: { model: "" } }), false, "no model set");
  assert.equal(imageRuntimeActive({ ready: false, running: false, settings: { model: "m" } }), false);
  assert.equal(imageRuntimeActive(null), null);
  assert.notEqual(imageRuntimeActive(undefined), true);
});

test("legacy R3 observation: before/after state, the text answer and image engine identity in one line", () => {
  const s = describeLegacyR3({
    t0: T, image: { status: 200 },
    pre: { at: T + 810, status: { ready: false, running: false, settings: { model: "" } }, engines: [] },
    text: { status: 200, ms: 140, at: T + 812 },
    post: { at: T + 960, status: { ready: false, running: false, settings: {} }, llm: { ready: true, running: true }, engines: [{ label: "llm", pid: 41 }] },
    diag: [{ e: "start", pid: 7, t: T + 5 }, { e: "listening", pid: 7, t: T + 60 }, { e: "exit", pid: 7, t: T + 500, code: 3221225477 }, { e: "start", pid: 3, t: T - 9000 }],
    log: "[backend] exited with code 3221225477 at C:\\Users\\x\\y on 127.0.0.1:10086\n[chat] ignored\n[llm] listening",
  });
  assert.match(s, /^image load HTTP 200; before text load at 810 ms: image runtime active false \(ready false running false model set false\); engines none/);
  assert.match(s, /text load \(sent 812, 140 ms\): HTTP 200;/);
  assert.match(s, /after at 960 ms: image ready false running false model set false; text engine ready true running true; engines llm:41/);
  assert.match(s, /image engine processes 1: 7\[start@5 listening@60 exit 3221225477@500\]/, "records from before the block are left out");
  assert.match(s, /server engine lines backend exited with code 3221225477 at on \| llm listening$/);
});

test("legacy R3 observation: the expected case and missing records are said, not guessed", () => {
  const ok = describeLegacyR3({ t0: T, image: { status: 200 }, pre: { at: T + 805, status: ready, engines: [{ label: "image", pid: 7 }] },
    text: { status: 500, code: "ENGINE_START_FAILED", errorNamesImage: true, ms: 30, at: T + 806 }, post: { at: T + 840, status: ready, llm: { ready: false, running: false }, engines: [{ label: "image", pid: 7 }] }, diag: [] });
  assert.match(ok, /image runtime active true \(ready true running true model set true\); engines image:7/);
  assert.match(ok, /HTTP 500 code ENGINE_START_FAILED; error names the image model true/);
  const none = describeLegacyR3({});
  assert.match(none, /^image load HTTP \?; before text load at \? ms: image runtime active unknown \(backend-status unreadable\); engines unreadable; text load \(sent \?, \? ms\): client error \?; after at \? ms: image backend-status unreadable; /);
  assert.match(none, /llm-status unreadable; engines unreadable; image engine records: unavailable; server engine lines none$/);
  assert.match(describeLegacyR3({ t0: T, text: { error: "ECONNRESET", ms: 4, at: T } }), /text load \(sent 0, 4 ms\): client error ECONNRESET/);
});

test("legacy R3 observation: bounded, no paths, addresses or model names from settings", () => {
  const long = "[backend] " + "a/b C:\\x\\y 10.0.0.1:99 ".repeat(400);
  const s = describeLegacyR3({ t0: T, pre: { at: T, status: ready, engines: Array.from({ length: 30 }, (_, i) => ({ label: "image", pid: i })) },
    text: { status: 500, code: "x/../y", at: T, ms: 1 }, diag: Array.from({ length: 40 }, (_, i) => ({ e: "start", pid: i, t: T + i })), log: long.repeat(20) });
  assert.ok(s.length <= 2400);
  assert.doesNotMatch(s, /[\\/]|\b\d{1,3}(\.\d{1,3}){3}\b|Users|sd1-img/);
  assert.equal((s.match(/image:\d+/g) || []).length, 8, "at most 8 engines listed");
});
