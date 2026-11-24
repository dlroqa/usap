// #151 transport diagnostics (test-only, messages only; never decides anything about the product). On macOS CI some
// json-413 clients lose the studio's 413: the server answers at once, keeps the connection for its grace period, then
// closes it with unread request bytes (a reset, RST) while the client's main thread has not read the answer. Linux
// never loses it. Two explanations are open:
//   H2a  the kernel discards received but unread data when the reset arrives;
//   H2b  the kernel keeps it, but Node handles a failed write (EPIPE/ECONNRESET) first and destroys the socket before
//        the pending read is delivered.
// This test separates the layers with fixtures/rst/server.cjs (never reads; answers 413 after ANSWER_MS; resets after
// GRACE_MS) and two kinds of client, each run REPS times:
//   K1/K2 kernel_client.py: no Node in the client, so recv() shows what the kernel kept (K1 idle, K2 still sending);
//   N1/N2 node_client.cjs: Node with its main thread blocked across the answer and the reset (N1 no write pending,
//         N2 writes pending), then the order of the events Node delivers.
// It prints one line per variant. Its only assertions check that the experiment happened (an answer was flushed and
// the connection was reset with unread bytes); what each platform keeps or loses is reported, not judged.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const DIR = path.join(__dirname, "fixtures", "rst");
const ANSWER_MS = 200, GRACE_MS = 600, REPS = 3;
const WAIT_MS = ANSWER_MS + GRACE_MS + 400; // the client looks only after the reset

function startServer() {
  const child = spawn(process.execPath, [path.join(DIR, "server.cjs"), String(ANSWER_MS), String(GRACE_MS)], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = []; let buf = "", onLine = null;
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch (_) { /* ignore */ } if (onLine) onLine(); } });
  const next = (pred, ms = 10000) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const check = () => { const i = lines.findIndex(pred); if (i >= 0) { onLine = null; resolve(lines.splice(i, 1)[0]); return true; } if (Date.now() > end) { onLine = null; resolve(null); return true; } return false; };
    if (!check()) { onLine = check; setTimeout(check, ms + 10); }
  });
  return { child, next, stop: () => { try { child.stdin.end(); } catch (_) {} } };
}
const python = () => { for (const p of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) { const r = spawnSync(p, ["-I", "-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8" }); if (r.status === 0 && r.stdout.trim() === "3") return p; } return null; };
const runJson = (cmd, args, timeout) => new Promise((resolve) => {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
  c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
  const t = setTimeout(() => c.kill(), timeout);
  c.on("close", (code) => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch (_) { resolve({ failed: `exit ${code}`, stderr: err.replace(/[^A-Za-z0-9 :_.-]/g, " ").slice(0, 160) }); } });
});

// One repetition's reading, times relative to the server's reset (destroyedAt).
function describeKernel(o, srv) {
  if (!o || o.failed) return `client failed (${o ? o.failed : "no output"})`;
  const r = (t) => Math.round(t - srv.destroyedAt);
  const send = o.sendError ? `send ${o.sendError[0]} at ${r(o.sendError[1])}` : o.mode === "sending" ? "send no error" : "idle";
  const recv = o.recv.map((x) => (x[0] === "data" ? `data ${x[2]}B${x[3] ? " 413" : ""}` : x[0] === "error" ? `error ${x[2]}` : x[0])).join(" > ");
  return `${send}; recv after reset: ${recv || "none"}`;
}
function describeNode(o, srv) {
  if (!o || o.failed) return `client failed (${o ? o.failed : "no output"})`;
  const r = (t) => Math.round(t - srv.destroyedAt);
  // consecutive identical events (one failed callback per pending write) are folded: "kind xN@first"
  const folded = [];
  for (const [t, k, a, b] of o.ev) {
    const txt = `${k}${k === "data" ? ` ${a}B${b ? " 413" : ""}` : a !== undefined ? ` ${a}` : ""}`;
    const last = folded[folded.length - 1];
    if (last && last.txt === txt && k !== "data") last.n += 1; else folded.push({ txt, n: 1, t });
  }
  const evs = folded.map((e) => `${e.txt}${e.n > 1 ? ` x${e.n}` : ""}@${r(e.t)}`).join(" > ");
  return `pending at block ${o.pendingAtBlock}B, blocked ${r(o.blockedAt)}..${r(o.unblockedAt)}; events ${evs || "none"}`;
}

test("#151 transport: what the kernel keeps after a reset (K) and what Node delivers (N), per platform (messages only)", async (t) => {
  const srv = startServer();
  try {
    const ready = await srv.next((l) => l.port);
    assert.ok(ready, "experiment server listening");
    const py = python();
    const variants = [
      ["K1 kernel, client idle", py ? [py, ["-I", path.join(DIR, "kernel_client.py"), String(ready.port), "idle", String(WAIT_MS)]] : null, describeKernel],
      ["K2 kernel, client still sending", py ? [py, ["-I", path.join(DIR, "kernel_client.py"), String(ready.port), "sending", String(WAIT_MS)]] : null, describeKernel],
      ["N1 Node, no write pending", [process.execPath, [path.join(DIR, "node_client.cjs"), String(ready.port), "fits", String(WAIT_MS)]], describeNode],
      ["N2 Node, writes pending", [process.execPath, [path.join(DIR, "node_client.cjs"), String(ready.port), "flood", String(WAIT_MS)]], describeNode],
    ];
    for (const [label, cmd, describe] of variants) {
      if (!cmd) { t.diagnostic(`#151 transport ${label}: not run (no Python 3 on this runner)`); continue; }
      const reps = [];
      for (let i = 0; i < REPS; i += 1) {
        const [out, rec] = await Promise.all([runJson(cmd[0], cmd[1], WAIT_MS + 15000), srv.next((l) => l.conn)]);
        assert.ok(rec && rec.answerFlushedAt && rec.destroyedAt, `${label}: the server answered and reset the connection`);
        assert.equal(rec.bytesRead, 0, `${label}: the server never read, so the close was a reset with unread bytes`);
        let d; try { d = describe(out, rec); } catch (_) { d = "description failed"; }
        reps.push(`rep ${i + 1}: answer flushed ${Math.round(rec.answerFlushedAt - rec.destroyedAt)}; ${d}`);
      }
      t.diagnostic(`#151 transport ${label} (${process.platform}; times ms from the reset): ${reps.join(" | ")}`.slice(0, 2500));
    }
  } finally { srv.stop(); }
});
