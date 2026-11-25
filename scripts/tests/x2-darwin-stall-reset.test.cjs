// X2 (#151, test-only experiment, measured and never judged; macOS Intel only). json-413 and refusal-close clients on
// macOS Intel sometimes lose the server's refusal when their process doesn't run across the server's grace close.
// Controlled controls (N2) lost it with EPIPE; one historical loss had ECONNRESET. This experiment reproduces the
// transport shape with the studio's own refusal path and the real client, and records per connection what happened:
//   server child (fixtures/x2-server.cjs): node:http + closeAfterAnswer: 413 at +400 ms, socket paused (body unread),
//     FIN after the answer, destroy (RST) 2000 ms later;
//   client child (fixtures/x2-client.cjs): 16 rawRequest connections (Q-small 128 KiB / Q-large 96 MiB cap x
//     ignoreFin false/true x 4), corrected write accounting (io.writes), main thread blocked from ~150 ms after connect:
//     S0 no stall, S1 1800 ms (ends before the RST), S2 2700 ms (spans the RST). Each S twice, sequentially.
// It cannot show what stalls a real client, or how often. Assertions are instrument sanity only. Answer loss, error
// codes and validity are printed, never asserted. Elsewhere it is skipped (USAP_TEST_X2_ANY=1 runs it anywhere).
//
// Reporting (round 15): EVERY row is printed, valid or not, with each predeclared validity criterion, its measured
// values and the exclusion reason. All of it is computed here, after the client child has exited; the children are
// unchanged apart from emitting a few more already-measured times. Predeclared criteria (times in ms):
//   C1 stall began before the answer:     stallAt - answerAt < -50
//   C2 S1: stall ended before the close:  stallEnd - closeAt < -200;  S2: ended after it: stallEnd - closeAt > 200
//      (S0: not applicable)
//   C3 queue state at stall start:        Q-small: submitted == accepted;  Q-large: submitted > accepted
//   C4 unread data at the destroy:        server bytesRead < bytes the kernel accepted from the client (final)
// Validity is exactly as at 8017af7 (round-15 review: the verdict logic must not change): S0 rows are valid; S1/S2 rows
// are valid when C1, C2 and C3 hold. C4, and C3 on S0 rows, are REPORTED ONLY (marked "r" in the output), never used.
// The exclusion reason lists the failed criteria that decide validity. Times not recorded print as null.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const ON = (process.platform === "darwin" && process.arch === "x64") || process.env.USAP_TEST_X2_ANY === "1";
const FIX = path.join(__dirname, "fixtures");
const children = new Set(); // every child this file starts; all are killed in the test's finally
const own = (child) => { children.add(child); child.once("exit", () => children.delete(child)); return child; };

function startServer(ms = 10000) {
  return new Promise((resolve, reject) => {
    const child = own(spawn(process.execPath, [path.join(FIX, "x2-server.cjs")], { stdio: ["ignore", "pipe", "pipe"] }));
    const recs = []; let buf = "", info = null, errTail = "";
    const fail = (why) => { if (info) return; clearTimeout(timer); child.kill(); reject(new Error(`x2 server: ${why} (${errTail.slice(-200)})`)); };
    const timer = setTimeout(() => fail(`no port within ${ms} ms`), ms);
    child.on("error", (e) => fail(String(e.code || e.message)));
    child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); }); // drained, so it can never block the child
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let o; try { o = JSON.parse(l); } catch (_) { continue; }
        if (o.port && !info) { info = o; clearTimeout(timer); resolve({ child, info, recs }); } else recs.push(o); }
    });
    child.once("exit", (c) => fail(`exited ${c}`));
  });
}
function runClient(port, stallMs) {
  return new Promise((resolve) => {
    const child = own(spawn(process.execPath, [path.join(FIX, "x2-client.cjs"), String(port), String(stallMs)], { stdio: ["ignore", "pipe", "pipe"] }));
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const kill = setTimeout(() => child.kill(), 30000);
    child.on("error", () => {});
    child.once("close", (code) => { clearTimeout(kill); let o = null; try { o = JSON.parse(out); } catch (_) {} resolve({ code, o, err: err.slice(-300) }); }); // 'close': stdout fully read
  });
}
async function killAll() {
  for (const c of [...children]) { try { c.kill("SIGKILL"); } catch (_) {} }
  const until = Date.now() + 5000;
  while (children.size && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

const n = (v) => (Number.isFinite(v) ? Math.round(v) : null); // null = not recorded
const rel = (t, base) => (Number.isFinite(t) && t > 0 && Number.isFinite(base) && base > 0 ? Math.round(t - base) : null); // null = not recorded
// Per connection, joined with its server record (remote port = client local port). Pure: used only after the run.
function describe(run, recs) {
  const st = run.o.stall;
  return run.o.conns.map((c) => {
    const s = recs.find((r) => r.remotePort === c.localPort) || null;
    const ans = s ? s.answerAt : NaN, cls = s ? s.closeAt : NaN;
    const a0 = c.atStallStart || {};
    const crit = {};
    if (st && st.requestedMs > 0) {
      crit.C1 = { ok: st.at - ans < -50, v: rel(st.at, ans) };
      crit.C2 = st.requestedMs < 2000 ? { ok: st.end - cls < -200, v: rel(st.end, cls) } : { ok: st.end - cls > 200, v: rel(st.end, cls) };
    }
    const stalled = Boolean(st && st.requestedMs > 0);
    crit.C3 = { ok: c.q === "Q-small" ? a0.sub === a0.ok : a0.sub > a0.ok, v: [n(a0.sub), n(a0.ok)], reportedOnly: !stalled };
    // C4 uses the FINAL accepted count, which also counts bytes still in flight at the destroy: an upper bound on
    // "unread at destroy", not a measurement of it (reported only)
    crit.C4 = { ok: Boolean(s) && s.bytesRead < c.writes.ok, v: [n(s && s.bytesRead), n(c.writes.ok)], reportedOnly: true };
    const failed = Object.entries(crit).filter(([, x]) => !x.ok && !x.reportedOnly).map(([k]) => k);
    if (!s) failed.unshift("no-server-record");
    const e = c.writes.atError;
    return { q: c.q, f: c.f, rep: c.rep, valid: s ? failed.length === 0 : null, excl: failed.join("+") || "-", crit, // null: no server record (as before)
      status: c.status, read: c.bodyComplete, fdAns: rel(c.firstDataAt, ans), fdStallEnd: st ? rel(c.firstDataAt, st.end) : null,
      err: c.error, sys: e ? e.syscall : null, errCls: rel(c.errorAt, cls), sub: c.writes.sub, ok: c.writes.ok, fail: c.writes.fail,
      qinErr: e ? e.queuedInNode : null, ffFirst: Boolean(c.writes.atFirstFail && e && c.writes.atFirstFail.seq < e.seq), failCalls: c.writes.failCalls, gaveUp: c.gaveUp,
      srv: s ? { status: s.status, close: rel(cls, ans), read: s.bytesRead, error: s.error || null } : null };
  });
}
// one compact line per S x pass with every row: [q,f,rep, valid,excl, C1,C2,C3,C4 values, answer, error, writes]
function rowsLine(label, run, rows) {
  const st = run.o.stall;
  const head = { stall: st ? [st.requestedMs, n(st.end - st.at), n(st.at - run.o.t0)] : null, connected: n(run.o.connectedAt - run.o.t0),
    armLate: st && run.o.connectedAt ? n(st.at - run.o.connectedAt - 150) : null, maxGapBefore: n(run.o.maxGapBefore), lastTickBefore: st && run.o.lastTickBefore ? n(st.at - run.o.lastTickBefore) : null,
    firstTickAfter: st && run.o.firstTickAfter ? n(run.o.firstTickAfter - st.end) : null, partial: Boolean(run.o.partial) };
  const R = rows.map((r) => [r.q === "Q-small" ? "S" : "L", r.f ? 1 : 0, r.rep, r.valid === null ? null : r.valid ? 1 : 0, r.excl,
    r.crit.C1 ? r.crit.C1.v : null, r.crit.C2 ? r.crit.C2.v : null, [...r.crit.C3.v, r.crit.C3.reportedOnly ? "r" : r.crit.C3.ok ? 1 : 0], [...r.crit.C4.v, "r", r.crit.C4.ok ? 1 : 0],
    r.status, r.read ? 1 : 0, r.fdAns, r.fdStallEnd, r.err, r.sys, r.errCls, r.sub, r.ok, r.fail, r.qinErr, r.ffFirst ? 1 : 0, r.failCalls, r.gaveUp ? 1 : 0, r.srv && r.srv.close]);
  return `#151 X2 rows ${label} ${JSON.stringify(head)} R=${JSON.stringify(R)}`;
}
function cellLine(label, run, rows) {
  const st = run.o.stall;
  const groups = {};
  for (const r of rows) { const k = `${r.q}/fin-${r.f ? "ignored" : "honoured"}`; (groups[k] = groups[k] || []).push(r); }
  const parts = Object.entries(groups).map(([k, g]) => {
    const v = g.filter((r) => r.valid);
    const codes = (list) => { const o = {}; for (const r of list) { const key = `${r.err || "none"}/${r.sys || "-"}`; o[key] = (o[key] || 0) + 1; } return JSON.stringify(o); };
    return `${k}: all ${g.length} read ${g.filter((r) => r.read).length} lost ${g.filter((r) => !r.read).length} codes ${codes(g)}; valid ${v.length} read ${v.filter((r) => r.read).length} lost ${v.filter((r) => !r.read).length} codes ${codes(v)}`;
  });
  return `#151 X2 ${label} (${process.platform}/${process.arch} ${process.version}): stall ${st ? `${st.requestedMs} ms, ${st.end - st.at} ms measured` : "none"}; max tick gap before the stall ${n(run.o.maxGapBefore)} ms; ${parts.join(" | ")}`;
}

test("X2 (macOS Intel): stall across the server's grace reset vs answer loss and EPIPE/ECONNRESET, measured only", { skip: !ON && "macOS Intel only (USAP_TEST_X2_ANY=1 to run elsewhere)", timeout: 120000 }, async (t) => {
  try {
    const srv = await startServer();
    for (const pass of [1, 2]) for (const [label, ms] of [["S0", 0], ["S1", 1800], ["S2", 2700]]) {
      const before = srv.recs.length;
      const run = await runClient(srv.info.port, ms);
      assert.equal(run.code, 0, `client child ran (${run.err})`);
      assert.ok(run.o && Array.isArray(run.o.conns) && run.o.conns.length === 16, "client output parsed");
      const until = Date.now() + 5000; // the server writes a record when each socket has closed
      while (srv.recs.length - before < 16 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      const recs = srv.recs.slice(before);
      const rows = describe(run, recs);
      assert.equal(rows.filter((r) => r.srv).length, 16, "every connection has a server record"); // as at 8017af7
      for (const c of run.o.conns) assert.equal(c.writes.ok + c.writes.fail + (c.writes.sub - c.writes.ok - c.writes.fail), c.writes.sub, "accounting adds up"); // as at 8017af7
      if (ms) assert.ok(run.o.stall && run.o.stall.end - run.o.stall.at >= ms * 0.9, "the stall lasted");
      t.diagnostic(cellLine(`${label} pass ${pass}`, run, rows));
      t.diagnostic(rowsLine(`${label} p${pass}`, run, rows));
    }
  } finally { await killAll(); }
});

// Reporting control (every OS; pure, no sockets): every row is printed with its criteria and exclusion reason, and an
// excluded row is counted in "all" but not in "valid". Rows come from a hand-made run, so nothing here can affect X2.
test("X2 reporting: every row is printed with its predeclared criteria and exclusion reason", () => {
  const T = 1_000_000;
  const conn = (i, q, extra = {}) => ({ q, f: false, rep: i, localPort: 5000 + i, status: 413, bodyComplete: true, firstDataAt: T + 2700, errorAt: null, error: null, gaveUp: false,
    writes: { sub: 200, ok: q === "Q-small" ? 200 : 150, fail: 0, failCalls: 0, atFirstFail: null, atError: null }, atStallStart: { sub: 200, ok: q === "Q-small" ? 200 : 150 }, ...extra });
  const run = { o: { t0: T, connectedAt: T + 40, maxGapBefore: 12, lastTickBefore: T + 185, firstTickAfter: T + 2895, partial: false,
    stall: { requestedMs: 2700, at: T + 190, end: T + 2890 }, conns: [conn(0, "Q-small"), conn(1, "Q-large"), conn(2, "Q-small", { firstDataAt: null, bodyComplete: false, error: "ECONNRESET", errorAt: T + 2895 })] } };
  const recs = [0, 1, 2].map((i) => ({ remotePort: 5000 + i, answerAt: i === 1 ? T + 100 : T + 400, closeAt: (i === 1 ? T + 100 : T + 400) + 2000, bytesRead: 100, status: 413 }));
  run.o.conns.push(conn(3, "Q-large", { atStallStart: { sub: 200, ok: 200 } }), conn(4, "Q-small"));
  recs.push({ remotePort: 5003, answerAt: T + 400, closeAt: T + 2400, bytesRead: 500, status: 413 }); // C4 fails: reported only
  const rows = describe(run, recs);
  assert.deepEqual(rows.map((r) => [r.valid, r.excl]), [[true, "-"], [false, "C1"], [true, "-"], [false, "C3"], [null, "no-server-record+C1+C2"]],
    "C1 / C3 decide validity; C4 never does; no server record leaves validity unknown (as at 8017af7)");
  const line = rowsLine("S2 p1", run, rows);
  assert.equal((line.match(/\["[SL]",/g) || []).length, 5, "every row is printed, the excluded ones included");
  assert.match(line, /\[500,150,"r",0\]/, "C4 is printed and marked reported-only, even when it fails");
  assert.match(line, /\["S",0,4,null,"no-server-record\+C1\+C2",null,null,\[200,200,1\],\[null,200,"r",0\]/, "unknown values print as null, not -1");
  assert.match(line, /"C1",90,/, "the excluded row carries its reason and the measured value");
  const cell = cellLine("S2 pass 1", run, rows);
  assert.match(cell, /Q-small\/fin-honoured: all 3 read 2 lost 1 codes \{"none\/-":2,"ECONNRESET\/-":1\}; valid 2 read 1 lost 1/);
  assert.match(cell, /Q-large\/fin-honoured: all 2 read 2 lost 0 codes \{"none\/-":2\}; valid 0 read 0 lost 0/);
});

module.exports = { describe, rowsLine, cellLine }; // pure reporting functions
