// X2 (#151, test-only experiment, measured and never judged; macOS Intel only). json-413 and refusal-close clients on
// macOS Intel sometimes lose the server's refusal when their process doesn't run across the server's grace close.
// Controlled controls (N2) lost it with EPIPE; one historical loss had ECONNRESET. This experiment reproduces the
// transport shape with the studio's own refusal path and the real client, and records per connection what happened:
//   server child (fixtures/x2-server.cjs): node:http + closeAfterAnswer: 413 at +400 ms, socket paused (body unread),
//     FIN after the answer, destroy (RST) 2000 ms later;
//   client child (fixtures/x2-client.cjs): 16 rawRequest connections (Q-small 128 KiB / Q-large 96 MiB cap x
//     ignoreFin false/true x 4), corrected write accounting (io.writes), main thread blocked from ~150 ms after connect:
//     S0 no stall, S1 1800 ms (ends before the RST), S2 2700 ms (spans the RST). Each S twice, sequentially.
// It cannot show what stalls a real client, or how often. Assertions are instrument sanity only: both children ran,
// every connection has a server record with 413, the accounting adds up, and the stall lasted. Answer loss, error
// codes and validity are printed, never asserted. Elsewhere it is skipped (USAP_TEST_X2_ANY=1 runs it anywhere).
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const ON = (process.platform === "darwin" && process.arch === "x64") || process.env.USAP_TEST_X2_ANY === "1";
const FIX = path.join(__dirname, "fixtures");

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(FIX, "x2-server.cjs")], { stdio: ["ignore", "pipe", "pipe"] });
    const recs = []; let buf = "", info = null;
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let o; try { o = JSON.parse(l); } catch (_) { continue; }
        if (o.port && !info) { info = o; resolve({ child, info, recs }); } else recs.push(o); }
    });
    child.once("exit", (c) => { if (!info) reject(new Error(`x2 server exited ${c}`)); });
  });
}
function runClient(port, stallMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(FIX, "x2-client.cjs"), String(port), String(stallMs)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    const kill = setTimeout(() => child.kill(), 30000);
    child.once("exit", (code) => { clearTimeout(kill); let o = null; try { o = JSON.parse(out); } catch (_) {} resolve({ code, o, err: err.slice(-300) }); });
  });
}

// Per connection, joined with its server record (remote port = client local port), times relative to the answer.
function describe(run, recs) {
  const rows = [];
  for (const c of run.o.conns) {
    const s = recs.find((r) => r.remotePort === c.localPort) || null;
    const ans = s && s.answerAt, cls = s && s.closeAt;
    const rel = (t) => (Number.isFinite(t) && Number.isFinite(ans) ? t - ans : null);
    const st = run.o.stall;
    const valid = !st || !s ? null : st.requestedMs === 0 ? true
      : st.at < ans - 50 && (st.requestedMs === 1800 ? st.end < cls - 200 : st.end > cls + 200)
        && (c.q === "Q-small" ? c.atStallStart && c.atStallStart.sub === c.atStallStart.ok : c.atStallStart && c.atStallStart.sub > c.atStallStart.ok);
    rows.push({ q: c.q, f: c.f, rep: c.rep, valid, server: s ? { status: 413, close: rel(cls), bytesRead: s.bytesRead, error: s.error || null } : null,
      read: c.bodyComplete, firstData: rel(c.firstDataAt), firstDataVsStallEnd: st && c.firstDataAt ? c.firstDataAt - st.end : null, error: c.error,
      syscall: c.writes.atError && c.writes.atError.syscall, errorAt: rel(c.errorAt), firstFailBeforeError: Boolean(c.writes.atFirstFail && c.writes.atError && c.writes.atFirstFail.seq < c.writes.atError.seq),
      failCalls: c.writes.failCalls, atStallStart: c.atStallStart, notAcceptedAtError: c.writes.atError && c.writes.atError.notAccepted, pendingAtError: c.pendingAtError, gaveUp: c.gaveUp });
  }
  return rows;
}
function cellLine(label, run, rows) {
  const st = run.o.stall, ans = Math.min(...rows.map((r) => (r.server ? 0 : Infinity)));
  const groups = {};
  for (const r of rows) { const k = `${r.q}/fin-${r.f ? "ignored" : "honoured"}`; (groups[k] = groups[k] || []).push(r); }
  const parts = Object.entries(groups).map(([k, g]) => {
    const v = g.filter((r) => r.valid);
    const codes = {}; for (const r of v) { const key = `${r.error || "none"}/${r.syscall || "-"}`; codes[key] = (codes[key] || 0) + 1; }
    return `${k}: valid ${v.length}/${g.length}, answer read ${v.filter((r) => r.read).length}, lost ${v.filter((r) => !r.read).length}, codes ${JSON.stringify(codes)}, first failed callback before 'error' ${v.filter((r) => r.firstFailBeforeError).length}`;
  });
  return `#151 X2 ${label} (${process.platform}/${process.arch} ${process.version}): stall ${st ? `${st.requestedMs} ms, ${st.end - st.at} ms measured` : "none"}; first tick after ${run.o.firstTickAfter && st ? run.o.firstTickAfter - st.end : "-"} ms; ${parts.join(" | ")}${Number.isFinite(ans) ? "" : ""}`;
}

test("X2 (macOS Intel): stall across the server's grace reset vs answer loss and EPIPE/ECONNRESET, measured only", { skip: !ON && "macOS Intel only (USAP_TEST_X2_ANY=1 to run elsewhere)", timeout: 120000 }, async (t) => {
  const srv = await startServer();
  try {
    const all = [];
    for (const pass of [1, 2]) for (const [label, ms] of [["S0", 0], ["S1", 1800], ["S2", 2700]]) {
      const before = srv.recs.length;
      const run = await runClient(srv.info.port, ms);
      assert.equal(run.code, 0, `client child ran (${run.err})`);
      assert.ok(run.o && Array.isArray(run.o.conns) && run.o.conns.length === 16, "client output parsed");
      const until = Date.now() + 5000; // the server writes a record when each socket has closed
      while (srv.recs.length - before < 16 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      const rows = describe(run, srv.recs.slice(before));
      assert.equal(rows.filter((r) => r.server).length, 16, "every connection has a server record");
      for (const c of run.o.conns) assert.equal(c.writes.ok + c.writes.fail + (c.writes.sub - c.writes.ok - c.writes.fail), c.writes.sub, "accounting adds up");
      if (ms) assert.ok(run.o.stall && run.o.stall.end - run.o.stall.at >= ms * 0.9, "the stall lasted");
      const line = cellLine(`${label} pass ${pass}`, run, rows);
      t.diagnostic(line);
      all.push({ label, pass, rows });
    }
    // bounded event order of up to 6 rows per S (lost answers first), for the record
    for (const label of ["S0", "S1", "S2"]) {
      const rows = all.filter((a) => a.label === label).flatMap((a) => a.rows).sort((a, b) => Number(a.read) - Number(b.read)).slice(0, 6);
      t.diagnostic(`#151 X2 ${label} detail: ${JSON.stringify(rows)}`.slice(0, 2500));
    }
  } finally { srv.child.kill(); }
});
