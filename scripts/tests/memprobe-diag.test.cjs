// Controls for the D6 probe diagnostics (fixtures/memprobe-diag.cjs, messages only): each situation the Windows
// reproduction failure could be in reads differently, the observer's read() still returns exactly what the tests'
// read() returned, and the real probe (with USAP_IQ_MEMPROBE_DIAG=1 only) notes when a marked record was published
// and when a later record replaced it. No verdict of any other test depends on this file.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { observer, describeProbeWait, describeSeen, MAX_SEEN } = require("./fixtures/memprobe-diag.cjs");

const PROBE = path.join(__dirname, "..", "ci", "image-queue-memprobe.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-memdiag-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

const REQ = { id: "gc-c-1", requestedAt: 1000 };
const rel = (t) => Math.round(t - REQ.requestedAt);
// Feed records through the real observer.read() (a real file per record), as the reproduction test does.
function feed(records, file = path.join(dir, `r-${Math.random().toString(16).slice(2)}.json`)) {
  const o = observer();
  for (const r of records) { fs.writeFileSync(file, JSON.stringify(r)); o.read(file); }
  return o;
}
const plain = (t, lastGc) => ({ t, pid: 7, ...(lastGc ? { lastGc: { id: lastGc, t: t - 1 } } : {}) });
const marked = (t, id, pid = 7) => ({ t, pid, gcId: id, lastGc: { id, t } });

test("reader view: marked record seen and accepted", () => {
  const s = describeSeen(feed([plain(900), marked(1192, "gc-c-1"), marked(1192, "gc-c-1"), plain(1392, "gc-c-1")]), REQ, 7, rel);
  assert.match(s, /this request's marked record was seen/);
  assert.match(s, /192 read -?\d+\.\.-?\d+ x2 ACCEPTED/);
});

test("reader view: never visible (only plain records, the later ones already carrying this GC)", () => {
  const s = describeSeen(feed([plain(900), plain(1100), plain(1392, "gc-c-1")]), REQ, 7, rel);
  assert.match(s, /no marked record was ever visible to the reader/);
  assert.match(s, /392 read .* plain lastGc gc-c-1/);
  assert.doesNotMatch(s, /ACCEPTED/);
});

test("reader view: seen but not accepted (another request's marked record; another process)", () => {
  const a = describeSeen(feed([marked(1192, "gc-c-0")]), REQ, 7, rel);
  assert.match(a, /only other requests' marked records were seen/);
  assert.match(a, /rejected: marked for gc-c-0/);
  const b = describeSeen(feed([marked(1192, "gc-c-1", 8)]), REQ, 7, rel);
  assert.match(b, /rejected: other process/);
});

test("reader view: a pause between reads is reported with where it started", async () => {
  const f = path.join(dir, "gap.json"); fs.writeFileSync(f, JSON.stringify(plain(900)));
  const o = observer(); o.read(f); await sleep(120); o.read(f);
  const s = describeSeen(o, { ...REQ, requestedAt: o.firstAt }, 7, (t) => Math.round(t - o.firstAt));
  const gap = Number(/largest gap between reads (\d+) ms from 0/.exec(s)[1]);
  assert.ok(gap >= 100, s);
});

test("reader view: bounded (at most MAX_SEEN listed, the rest counted); ids outside the id rule are not printed", () => {
  const recs = Array.from({ length: MAX_SEEN + 5 }, (_, i) => plain(1000 + i * 200));
  const s = describeSeen(feed(recs), REQ, 7, rel);
  assert.match(s, new RegExp(`distinct records ${MAX_SEEN} \\(\\+5 more\\)`));
  const t = describeSeen(feed([marked(1192, "C:\\Users\\x y")]), REQ, 7, rel);
  assert.doesNotMatch(t, /Users/);
});

test("observer.read() returns what the tests' read() returned: record, null for missing and for partial", () => {
  const f = path.join(dir, "same.json"); const o = observer();
  fs.writeFileSync(f, JSON.stringify(plain(5))); assert.deepEqual(o.read(f), plain(5));
  fs.writeFileSync(f, "{\"t\":"); assert.equal(o.read(f), null);
  assert.equal(o.read(path.join(dir, "absent.json")), null);
  assert.equal(o.ok, 1); assert.equal(o.parse, 1); assert.equal(o.missing, 1);
});

test("real probe (diag on): publication and replacement of the marked record are noted in order and printed", async (t) => {
  const out = path.join(dir, "probe.json");
  fs.mkdirSync(path.join(dir, "srv"), { recursive: true });
  const serve = path.join(dir, "srv", "serve.cjs"); fs.writeFileSync(serve, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, ["--expose-gc", "--require", PROBE, serve], { env: { ...process.env, USAP_IQ_MEMPROBE: out, USAP_IQ_MEMPROBE_DIAG: "1" }, stdio: "ignore" });
  const read = () => { try { return JSON.parse(fs.readFileSync(out, "utf8")); } catch (_) { return null; } };
  try {
    for (let i = 0; i < 250 && !(read() || {}).gcAvailable; i += 1) await sleep(20);
    const requestedAt = Date.now();
    fs.writeFileSync(`${out}.tmp-req`, "gc-c-9"); fs.renameSync(`${out}.tmp-req`, `${out}.gc`);
    const obs = observer(); let ev = [];
    for (let i = 0; i < 300; i += 1) { const p = obs.read(out); ev = (p && p.diag && p.diag.events) || []; if (ev.some(([, k]) => k === "replaced-marked")) break; await sleep(10); }
    const kinds = ev.map(([, k, x]) => `${k}:${x && x.id ? x.id : x}`).filter((k) => /gc-c-9/.test(k));
    assert.deepEqual(kinds.map((k) => k.split(":")[0]), ["request", "gc", "published-marked", "replaced-marked"]);
    const line = describeProbeWait({ req: { id: "gc-c-9", requestedAt }, obs, child, recordFile: out });
    t.diagnostic(`control line: ${line}`);
    assert.match(line, /published-marked gc-c-9; -?\d+ replaced-marked gc-c-9/);
    assert.match(line, /reader view \(this request's marked record was seen\)/);
  } finally { await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once("exit", r); child.kill(); }); }
});
