// image-queue validator, "Default: imageQueue off" failure detail (scripts/ci/image-queue-observe.cjs). The verdict is
// pinned to the validator's earlier condition; only the detail is new.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyDefaultOff, defaultOffOk } = require("../ci/image-queue-observe.cjs");

const OFF = { ok: true, scheduler: { mode: "observe" }, limits: {}, engines: { image: { queue: { known: false } } } };
const ok = (json, status = 200) => ({ status, text: JSON.stringify(json), json });
const srv = { alive: true, upMs: 2500 };

test("default-off detail: each kind of observation is named", () => {
  assert.match(classifyDefaultOff({ status: 0, text: "client timeout", json: null }, 10003, srv).detail, /^observed: timeout; after 10003 ms \(timeout 10000 ms\); server process running, up 2500 ms$/);
  assert.match(classifyDefaultOff({ status: 0, text: "connect ECONNREFUSED 127.0.0.1:14985", json: null }, 3, { alive: false, upMs: 900 }).detail, /^observed: request error; after 3 ms .*; error ECONNREFUSED; server process exited/);
  assert.match(classifyDefaultOff({ status: 500, text: "<html>Internal C:\\Users\\x\\a.js /home/y/b.js</html>", json: null }, 40, srv).detail, /observed: invalid response; .*HTTP 500; body \d+ B; not a JSON object: "html Internal C: Users x a.js home y b.js html"/);
  assert.match(classifyDefaultOff(ok({ ok: true, limits: {}, engines: {} }), 40, srv).detail, /observed: missing measurement; .*keys ok,limits,engines; imageQueue key absent; limits.imageQueue absent; engines.image absent; image queue known absent/);
  assert.match(classifyDefaultOff(ok({ ...OFF, imageQueue: { mode: "on" } }), 40, srv).detail, /observed: state mismatch; .*imageQueue key present/);
  assert.match(classifyDefaultOff(ok({ ...OFF, engines: { image: { queue: { known: true } } } }), 40, srv).detail, /observed: state mismatch; .*image queue known true/);
  const good = classifyDefaultOff(ok(OFF), 12, srv);
  assert.equal(good.ok, true); assert.equal(good.kind, "as expected");
});

test("default-off verdict: identical to the validator's earlier condition; no failure ever passes", () => {
  const old = (r) => { const q = r.engines && r.engines.image && r.engines.image.queue; return !("imageQueue" in r) && !("imageQueue" in (r.limits || {})) && q && q.known === false; };
  const bodies = [OFF, {}, { engines: {} }, { ...OFF, imageQueue: {} }, { ...OFF, limits: { imageQueue: "on" } }, { ...OFF, engines: { image: { queue: { known: "false" } } } }, { ...OFF, engines: { image: { queue: {} } } }];
  for (const b of bodies) {
    assert.equal(defaultOffOk(b), Boolean(old(b)), JSON.stringify(b));
    assert.equal(classifyDefaultOff(ok(b), 1, srv).ok, Boolean(old(b)), JSON.stringify(b));
  }
  // The earlier code judged json || {}: a timeout, an error or a non-JSON answer failed, and still does.
  for (const res of [{ status: 0, text: "client timeout", json: null }, { status: 0, text: "socket hang up", json: null }, { status: 502, text: "bad", json: null }, null]) {
    assert.equal(classifyDefaultOff(res, 1, srv).ok, false);
  }
  // A non-200 answer whose body has the required state is judged as before (by its body), and named as invalid.
  const s = classifyDefaultOff(ok(OFF, 503), 1, srv);
  assert.equal(s.ok, Boolean(old(OFF))); assert.equal(s.kind, "invalid response");
});

test("default-off detail: bounded, no paths, key names only", () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k/${i}\\x`, i]));
  const d = classifyDefaultOff(ok(many), 1, srv).detail;
  assert.ok(d.length < 700, `bounded (${d.length})`);
  assert.match(d, /keys k0x,k1x,.*,\.\.\./);
  assert.doesNotMatch(d, /[\\/]/);
  assert.equal(classifyDefaultOff(null, 1, null).kind, "request error");
});
