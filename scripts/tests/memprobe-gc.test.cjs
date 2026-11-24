// D6 post-GC sample handshake (scripts/ci/image-queue-memprobe.cjs + scripts/ci/memprobe-gc.cjs). The probe writes
// its post-GC sample once and overwrites it with a plain sample 200 ms later; a validator that read late used to miss
// it and record a missing measurement (macOS Intel CI, #164 and #186). These tests reproduce that deterministically
// (waiting on the probe's own records, not on timing) and pin the acceptance rule: right request, right process, taken
// after the request, and a sample that never comes stays missing.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { matchGcSample, writeTrigger } = require("../ci/memprobe-gc.cjs");

const PROBE = path.join(__dirname, "..", "ci", "image-queue-memprobe.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } };
async function until(fn, ms = 5000, every = 20) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } }
// The real probe in a stand-in "serve.cjs" process (the probe only activates in a process with that name).
function startProbe(dir, out, { exposeGc = true } = {}) {
  fs.mkdirSync(path.join(dir, "srv"), { recursive: true });
  const serve = path.join(dir, "srv", "serve.cjs");
  fs.writeFileSync(serve, "setInterval(() => {}, 1000);\n");
  const args = [...(exposeGc ? ["--expose-gc"] : []), "--require", PROBE, serve];
  const child = spawn(process.execPath, args, { env: { ...process.env, USAP_IQ_MEMPROBE: out }, stdio: "ignore" });
  return child;
}
const stop = (child) => new Promise((r) => { if (child.exitCode !== null) return r(); child.once("exit", r); child.kill(); });

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-memprobe-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

test("rule: the right request, the right process, taken after the request; anything else is not yet", () => {
  const req = { id: "gc-ab12-3", pid: 100, requestedAt: 5000 };
  const g = { id: "gc-ab12-3", pid: 100, t: 5100, arrayBuffers: 7, heapUsed: 9 };
  assert.deepEqual(matchGcSample({ pid: 100, t: 5300, arrayBuffers: 999, lastGc: g }, req), { ...g, gcId: g.id }, "the retained post-GC sample, not the later plain one");
  assert.equal(matchGcSample({ pid: 100, t: 5300, lastGc: { ...g, id: "gc-ab12-2" } }, req), null, "previous cycle's sample");
  assert.equal(matchGcSample({ pid: 100, t: 5300, lastGc: { ...g, id: "gc-ff00-3" } }, req), null, "same sequence, another run's nonce");
  assert.equal(matchGcSample({ pid: 100, t: 5300, lastGc: { ...g, pid: 101 } }, req), null, "another server process");
  assert.equal(matchGcSample({ pid: 100, t: 5300, lastGc: { ...g, t: 4999 } }, req), null, "taken before the request (stale)");
  assert.equal(matchGcSample({ pid: 100, t: 5300 }, req), null, "no GC ran: nothing to accept");
  assert.equal(matchGcSample({ pid: 100, t: 5100, gcId: "gc-ab12-3", gcAvailable: false }, req), null, "a marked record without a GC is not a post-GC sample");
  assert.deepEqual(matchGcSample({ pid: 100, t: 5100, gcId: "gc-ab12-3", gcAvailable: true, arrayBuffers: 7 }, req).arrayBuffers, 7, "the marked record itself, read in time");
  assert.equal(matchGcSample({ pid: 101, t: 5100, gcId: "gc-ab12-3", gcAvailable: true }, req), null, "marked record from another process");
  assert.equal(matchGcSample(null, req), null);
  assert.equal(matchGcSample({ lastGc: g }, { ...req, id: "" }), null);
});

test("reproduction: a read after the probe's next plain tick misses the sample with the old rule and finds it with the new one", async () => {
  const out = path.join(dir, "late.json");
  const child = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable; }), "probe running");
    for (let k = 1; k <= 3; k += 1) {
      const id = `gc-late-${k}`; const requestedAt = Date.now();
      writeTrigger(`${out}.gc`, id);
      // wait until the GC-marked record has been written AND overwritten by a later plain tick (the CI miss)
      const marked = await until(() => { const p = read(out); return p && p.gcId === id ? p : null; }, 5000, 5);
      assert.ok(marked, "the probe answered");
      assert.ok(await until(() => { const p = read(out); return p && p.t > marked.t && p.gcId === undefined ? p : null; }), "overwritten by a plain tick");
      const late = read(out);
      assert.equal(late.gcId === id ? late : null, null, "old rule (gcId only): missed");
      const got = matchGcSample(late, { id, pid: child.pid, requestedAt });
      assert.ok(got && got.id === id && got.pid === child.pid && got.t >= requestedAt, `new rule: found (${JSON.stringify(got)})`);
      assert.equal(got.arrayBuffers, marked.arrayBuffers, "the same post-GC figures as the marked record");
    }
  } finally { await stop(child); }
});

test("ownership: a sample left by an earlier server process or an earlier cycle is never accepted", async () => {
  const out = path.join(dir, "own.json");
  const a = startProbe(dir, out);
  let aPid, aLast;
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable; }));
    aPid = a.pid;
    writeTrigger(`${out}.gc`, "gc-run1-1");
    aLast = await until(() => { const p = read(out); return p && p.lastGc && p.lastGc.id === "gc-run1-1" ? p : null; });
    assert.ok(aLast);
  } finally { await stop(a); }
  // the file still holds server A's last sample; a request from the next server (B) with the same sequence number but
  // its own nonce, or even the same id, must not be satisfied by it
  const left = read(out);
  assert.equal(matchGcSample(left, { id: "gc-run1-1", pid: aPid + 1, requestedAt: Date.now() }), null, "another process's sample, even with the same id");
  assert.equal(matchGcSample(left, { id: "gc-run1-1", pid: aPid, requestedAt: Date.now() + 1 }), null, "same process, but taken before this request");
  assert.equal(matchGcSample(left, { id: "gc-run2-1", pid: aPid, requestedAt: 0 }), null, "another run's id");
  // a later cycle on the same server: the previous cycle's retained sample does not answer it
  const b = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.pid === b.pid; }));
    writeTrigger(`${out}.gc`, "gc-run2-1");
    const s1 = await until(() => matchGcSample(read(out), { id: "gc-run2-1", pid: b.pid, requestedAt: 0 }));
    assert.ok(s1);
    const req2 = { id: "gc-run2-2", pid: b.pid, requestedAt: Date.now() };
    assert.equal(matchGcSample(read(out), req2), null, "cycle 2 is not answered by cycle 1's sample");
    writeTrigger(`${out}.gc`, req2.id);
    const s2 = await until(() => matchGcSample(read(out), req2));
    assert.ok(s2 && s2.id === "gc-run2-2" && s2.t >= req2.requestedAt);
  } finally { await stop(b); }
});

test("negative control: without a GC (no --expose-gc) there is never a post-GC sample, so the request stays unanswered", async () => {
  const out = path.join(dir, "nogc.json");
  const child = startProbe(dir, out, { exposeGc: false });
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable === false; }));
    const req = { id: "gc-nogc-1", pid: child.pid, requestedAt: Date.now() };
    writeTrigger(`${out}.gc`, req.id);
    assert.ok(await until(() => { const p = read(out); return p && p.gcId === req.id; }), "the probe saw the request");
    assert.equal(await until(() => matchGcSample(read(out), req), 1500), null, "no sample: missing stays missing (the validator then records FAIL)");
    assert.equal(read(out).lastGc, undefined);
  } finally { await stop(child); }
});

test("trigger race (main caa546d, Windows): a request seen while still empty is not consumed as a generic one; it is answered once written", async () => {
  const out = path.join(dir, "race.json");
  const child = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable; }));
    // a non-atomic write: the file exists empty for longer than one probe tick, then the id is written
    const req = { id: "gc-race-1", pid: child.pid, requestedAt: Date.now() };
    const fd = fs.openSync(`${out}.gc`, "w");
    const seenEmpty = await until(() => { const p = read(out); return p && p.t > req.requestedAt + 250 ? p : null; });
    assert.ok(seenEmpty, "the probe ticked while the trigger was empty");
    assert.ok(fs.existsSync(`${out}.gc`), "the empty trigger was left in place");
    assert.notEqual((read(out).lastGc || {}).id, "gc", "not consumed as a generic request");
    fs.writeSync(fd, req.id); fs.closeSync(fd);
    assert.ok(await until(() => matchGcSample(read(out), req)), "answered once the id is there");
    // and the atomic writer leaves no temporary file behind
    writeTrigger(`${out}.gc`, "gc-race-2");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
    assert.ok(await until(() => matchGcSample(read(out), { id: "gc-race-2", pid: child.pid, requestedAt: 0 })));
  } finally { await stop(child); }
});

test("writeTrigger: complete publication by same-folder rename; bounded retry only for Windows sharing errors; no leftover file", () => {
  const { GC_ID } = require("../ci/memprobe-gc.cjs");
  const fakeFs = (failures, code = "EPERM") => {
    const files = new Map(); let left = failures; const calls = [];
    return { files, calls,
      writeFileSync: (f, d) => { files.set(f, String(d)); calls.push(["write", f]); },
      renameSync: (a, b) => { calls.push(["rename", a, b]); if (left > 0) { left -= 1; const e = new Error(code); e.code = code; throw e; } files.set(b, files.get(a)); files.delete(a); },
      unlinkSync: (f) => { calls.push(["unlink", f]); files.delete(f); } };
  };
  const target = path.join("x", "probe.json.gc");
  const ok = fakeFs(2);
  assert.equal(writeTrigger(target, "gc-ab-1", { fs: ok, waitMs: 1 }), 2, "two EPERM, then the rename succeeded");
  assert.equal(ok.files.get(target), "gc-ab-1"); assert.equal(ok.files.size, 1, "no temporary file left");
  const [, tmp] = ok.calls[0]; assert.equal(path.dirname(tmp), path.dirname(target), "the temporary file is in the same folder (same filesystem)");
  const stuck = fakeFs(1000, "EBUSY");
  assert.throws(() => writeTrigger(target, "gc-ab-2", { fs: stuck, retries: 5, waitMs: 1 }), /EBUSY/, "bounded: gives up and raises");
  assert.equal(stuck.files.size, 0, "temporary file removed after giving up"); assert.equal(stuck.calls.filter((c) => c[0] === "rename").length, 6);
  const other = fakeFs(1, "ENOENT");
  assert.throws(() => writeTrigger(target, "gc-ab-3", { fs: other, waitMs: 1 }), /ENOENT/, "other errors are not retried");
  assert.equal(other.calls.filter((c) => c[0] === "rename").length, 1); assert.equal(other.files.size, 0);
  for (const bad of ["", "has space", "x".repeat(129), "a/b", "id\n"]) assert.throws(() => writeTrigger(target, bad, { fs: fakeFs(0) }), /invalid GC request id/, JSON.stringify(bad));
  assert.ok(GC_ID.test("gc-0123abcd-8") && GC_ID.test("x".repeat(128)));
});

test("probe: a malformed request is removed unanswered (no GC, no sample); a valid request after it is answered", async () => {
  const out = path.join(dir, "bad.json");
  const child = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable; }));
    fs.writeFileSync(`${out}.tmp-bad`, "bad id with spaces"); fs.renameSync(`${out}.tmp-bad`, `${out}.gc`);
    assert.ok(await until(() => !fs.existsSync(`${out}.gc`)), "removed");
    await sleep(300);
    const p = read(out);
    assert.equal(p.lastGc, undefined, "no GC ran for it"); assert.equal(p.gcId, undefined);
    const req = { id: "gc-bad-2", pid: child.pid, requestedAt: Date.now() };
    writeTrigger(`${out}.gc`, req.id);
    assert.ok(await until(() => matchGcSample(read(out), req)));
  } finally { await stop(child); }
});

test("probe: a request left empty is never consumed and its wait ends as missing; the next valid request replaces it and is answered", async () => {
  const out = path.join(dir, "empty.json");
  const child = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable; }));
    fs.writeFileSync(`${out}.gc`, ""); // a writer that never completes
    const req1 = { id: "gc-empty-1", pid: child.pid, requestedAt: Date.now() };
    assert.equal(await until(() => matchGcSample(read(out), req1), 1000), null, "missing (the validator's bounded wait then records FAIL)");
    assert.ok(fs.existsSync(`${out}.gc`), "the empty request is still there, not consumed");
    const req2 = { id: "gc-empty-2", pid: child.pid, requestedAt: Date.now() };
    writeTrigger(`${out}.gc`, req2.id);
    assert.ok(await until(() => matchGcSample(read(out), req2)), "answered after the atomic replacement");
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("empty.json.gc.") && f.endsWith(".tmp")).length, 0, "no temporary file left");
  } finally { await stop(child); }
});
