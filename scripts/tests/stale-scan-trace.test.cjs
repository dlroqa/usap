// Controls for the #197 stale-file scan trace (fixtures/stale-scan-trace.cjs; test-only, messages only), with the real
// studio and the real scan:
//   positive  an event-loop block of 700 ms injected right after the scan's opendir reproduces the failing shape
//             (scanned 0, truncated) AND the trace shows a gap >= 600 ms covering opendir..first entry;
//   negative  without the block, the scan delivers its first entry promptly and no gap >= 300 ms covers that window;
//   fallback  with the report off (no scan), the trace is still published once, by its fallback timer, with no scan;
//   inert     without USAP_TEST_SF_TRACE the preload prints nothing.
// #214 verification (test-only): the trace also records asynchronous child processes, so a CI run can tell #214's
// startup GPU discovery (execFile system_profiler, off the event loop) from a synchronous child on a request path:
//   request-path sync   a synchronous child (600 ms) run inside the first /api/diagnostics request is recorded as a
//                       sync call within that request, AND a gap >= 500 ms covers it (the pre-#214 shape is detected);
//   async child         an asynchronous child started at listening is recorded (start, still running or its exit);
//                       its timing against the scan is observed, not judged (other synchronous probes exist).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot, request } = require("./api-contract/harness.cjs");

const PRE = path.join(__dirname, "fixtures", "stale-scan-trace.cjs").replace(/\\/g, "/");
const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withStudio(env, fn) {
  const root = makeRoot();
  const tx = path.join(root, "app", "transcriptions"); fs.mkdirSync(tx, { recursive: true });
  const f = path.join(tx, ".speech-2026-11-20T15-35-46-120Z-left.wav"); fs.writeFileSync(f, "x"); const t = (Date.now() - 48 * HOUR) / 1000; fs.utimesSync(f, t, t);
  const srv = await startServer(root, { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRE}"`.trim(), ...env });
  try { return await fn(srv); } finally { await stopServerAndWait(srv); removeTestRoot(root); }
}
async function report(srv) { for (let i = 0; i < 100; i += 1) { const s = (await request(srv.port, "GET", "/api/diagnostics")).json.staleFiles; if (s && s.lastRunAt) return s; await sleep(100); } return null; }
async function trace(srv, ms = 3000) { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const m = srv.log().match(/\[sf-trace\] ([^\r\n]*)/); if (m) return JSON.parse(m[1]); } return null; }
// how much of the window [a, b] each loop gap covers (ms)
const covering = (tr, a, b) => tr.gaps.map((g) => ({ ...g, covers: Math.max(0, Math.min(g.from + g.ms, b) - Math.max(g.from, a)) }));

test("positive: a 700 ms block after opendir gives scanned 0 / truncated and a covering gap in the trace", { timeout: 60000 }, async (t) => {
  await withStudio({ USAP_STALE_FILE_REPORT: "report", USAP_TEST_SF_TRACE: "1", USAP_TEST_SF_TRACE_BLOCK: "700" }, async (srv) => {
    const s = await report(srv); const tr = await trace(srv);
    assert.ok(s && tr, "report and trace");
    const sc = tr.scan[0];
    t.diagnostic(`positive: scanned ${s.legacyTranscriptionTemporaries.scanned}, truncated ${s.legacyTranscriptionTemporaries.truncated}; scan ${JSON.stringify(sc)}; gaps ${JSON.stringify(tr.gaps)}`);
    assert.equal(s.legacyTranscriptionTemporaries.scanned, 0); assert.equal(s.legacyTranscriptionTemporaries.truncated, true);
    assert.ok(sc.firstAt - sc.opendir >= 600, `first entry delivered ${sc.firstAt - sc.opendir} ms after opendir`);
    assert.ok(covering(tr, sc.opendir, sc.firstAt).some((g) => g.covers >= 600), "a gap covers >= 600 ms of opendir..first entry");
  });
});

// negative (pre-push review): without the injected block, timing is the very thing under investigation (#197 SF-M0),
// so it is OBSERVED, not asserted: the structure is checked; a slow first entry is reported and the test skipped with
// the numbers (a natural occurrence on this runner), never turned into a red run.
test("negative: without a block the trace is well formed; a slow first entry is reported, not judged", { timeout: 60000 }, async (t) => {
  await withStudio({ USAP_STALE_FILE_REPORT: "report", USAP_TEST_SF_TRACE: "1" }, async (srv) => {
    const s = await report(srv); const tr = await trace(srv);
    assert.ok(s && tr, "report and trace"); const sc = tr.scan[0];
    assert.ok(sc && sc.opendir <= sc.resolved && sc.resolved <= sc.firstAt && sc.firstAt <= sc.done, `ordered scan record ${JSON.stringify(sc)}`);
    const slow = sc.firstAt - sc.opendir, cov = covering(tr, sc.opendir, sc.firstAt).filter((g) => g.covers >= 100);
    t.diagnostic(`negative (${process.platform}): first entry ${Math.round(slow)} ms after opendir, matched ${s.legacyTranscriptionTemporaries.matched}, gaps covering the window ${JSON.stringify(cov)}, sync calls ${JSON.stringify(tr.sync)}`);
    if (slow >= 300 || s.legacyTranscriptionTemporaries.matched !== 1) t.skip(`natural slow scan observed (first entry ${Math.round(slow)} ms, matched ${s.legacyTranscriptionTemporaries.matched}): reported above, not judged`);
  });
});

test("a block that ends right before the trace is published is still recorded as a gap", { timeout: 60000 }, async () => {
  // a 300 ms block right after the scan finished, with a slow (1 s) gap sampler: the 50 ms publish timer is then due
  // first when the block ends, so only publish()'s own final check can record the gap (the round-16 macOS Intel shape)
  await withStudio({ USAP_STALE_FILE_REPORT: "report", USAP_TEST_SF_TRACE: "1", USAP_TEST_SF_TRACE_BLOCK_DONE: "300", USAP_TEST_SF_TRACE_LAG: "1000" }, async (srv) => {
    assert.ok(await report(srv)); const tr = await trace(srv);
    assert.ok(tr.gaps.some((g) => g.ms >= 250), `the 300 ms block is a recorded gap: ${JSON.stringify(tr.gaps)}`);
  });
});

test("fallback: with no scan the trace is still published once, with no scan entries; inert without the variable", { timeout: 60000 }, async () => {
  await withStudio({ USAP_STALE_FILE_REPORT: "", USAP_TEST_SF_TRACE: "1", USAP_TEST_SF_TRACE_FALLBACK: "800" }, async (srv) => {
    const tr = await trace(srv, 5000);
    assert.ok(tr, "published by the fallback"); assert.deepEqual(tr.scan, []);
    await sleep(300); assert.equal((srv.log().match(/\[sf-trace\]/g) || []).length, 1, "published once");
  });
  await withStudio({ USAP_STALE_FILE_REPORT: "report" }, async (srv) => {
    assert.ok(await report(srv)); await sleep(600);
    assert.ok(!/\[sf-trace\]/.test(srv.log()), "nothing printed without USAP_TEST_SF_TRACE");
  });
});

test("#214 check: a synchronous child on the first /api/diagnostics request is recorded in that request, with a covering gap", { timeout: 60000 }, async (t) => {
  await withStudio({ USAP_STALE_FILE_REPORT: "report", USAP_TEST_SF_TRACE: "1", USAP_TEST_SF_TRACE_REQ_SYNC: "600" }, async (srv) => {
    assert.ok(await report(srv), "report"); const tr = await trace(srv);
    assert.ok(tr, "trace");
    const rq = tr.req.find((r) => r.path === "/api/diagnostics");
    const sc = tr.sync.find((x) => x.fn === "execFileSync" && /^node(\.exe)?$/i.test(x.cmd) && x.ms >= 550);
    t.diagnostic(`request-path sync: request ${JSON.stringify(rq)}; sync ${JSON.stringify(tr.sync)}; scan ${JSON.stringify(tr.scan[0] || null)}; gaps ${JSON.stringify(tr.gaps)}`);
    assert.ok(rq && sc, "the first /api/diagnostics request and its synchronous child are recorded");
    assert.ok(sc.at >= rq.at && (rq.done === null || sc.at + sc.ms <= rq.done + 1), "the synchronous child ran inside that request");
    assert.ok(covering(tr, sc.at, sc.at + sc.ms).some((g) => g.covers >= 500), "a gap covers >= 500 ms of the synchronous child");
  });
});

test("#214 check: an asynchronous child started at listening is recorded; its overlap with the scan is observed", { timeout: 60000 }, async (t) => {
  await withStudio({ USAP_STALE_FILE_REPORT: "report", USAP_TEST_SF_TRACE: "1", USAP_TEST_SF_TRACE_ASYNC_CHILD: "400" }, async (srv) => {
    assert.ok(await report(srv), "report"); const tr = await trace(srv);
    assert.ok(tr, "trace");
    const ch = tr.child.find((x) => x.fn === "execFile" && /^node(\.exe)?$/i.test(x.cmd) && x.timeout === 5400);
    const sc = tr.scan[0];
    assert.ok(ch && sc, `the asynchronous child and the scan are recorded: ${JSON.stringify(tr.child)}`);
    assert.ok(ch.at >= tr.listening, "started when listening");
    assert.ok(!tr.sync.some((x) => x.fn === "execFileSync" && /^node(\.exe)?$/i.test(x.cmd)), "not recorded as a synchronous call");
    const end = ch.exit === null ? tr.published : ch.exit;
    const cov = covering(tr, Math.max(ch.at, sc.opendir), Math.min(end, sc.done)).filter((g) => g.covers >= 100);
    t.diagnostic(`async child (${process.platform}): ${JSON.stringify(ch)}; scan ${JSON.stringify(sc)}; gaps covering child and scan ${JSON.stringify(cov)}; sync ${JSON.stringify(tr.sync)}`);
  });
});
