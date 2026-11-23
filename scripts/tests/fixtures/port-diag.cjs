// #170 diagnostics (test-only, message only, never judged): describes one image-engine replacement with engineSlot on
// as a bounded, numbers-only line for t.diagnostic(). It never decides a verdict: the tests keep their assertions.
//   o.t0       wall time just before the replacement request (all times are printed relative to it)
//   o.port     the port the replacement was expected to use (the preferred image port)
//   o.oldPid   PID of the engine being replaced
//   o.checks   every port check the server made (api-contract/port-check-preload.cjs records: { port, result, t }).
//              These include checks outside the replacement's own selection (for example status requests), so a
//              check is never labelled as the selection; runs of the same result are compressed.
//   o.diag     fake engine records (api-contract/fake-sd-server.cjs: start, listening, listen-error, exit)
//   o.oldAlive whether the old engine's PID is still running now (or null)
//   o.maxImage the most image engine processes seen at once by the test's sampler (or null)
//   o.slot     the engineSlot report from /api/resources (or null)
//
// The holder lookup in a listen-error record is taken by the fake *after* its bind failed (lsof or netstat), so it can
// miss a holder that was already gone. Holders are reduced to command name, PID, which end of the connection uses the
// port and its state; user names, paths and addresses are dropped. Readings say only what the records are consistent
// with; none names the holder or a cause.
"use strict";
const MAX_ITEMS = 10;

const cleanCmd = (s) => String(s || "?").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 15) || "?";
// Consecutive checks with the same result as one run: "first..last:result xN" (at most MAX_ITEMS runs, then "...").
function runsOf(checks, rel, withPort) {
  const runs = [];
  for (const c of checks) {
    const res = c.result === "free" ? "free" : cleanCmd(c.result);
    const last = runs[runs.length - 1];
    if (last && last.res === res && last.port === c.port) { last.to = c.t; last.n += 1; } else runs.push({ port: c.port, res, from: c.t, to: c.t, n: 1 });
  }
  const shown = runs.slice(0, MAX_ITEMS).map((x) => `${withPort ? `${x.port}@` : ""}${rel(x.from)}${x.n > 1 ? `..${rel(x.to)}` : ""}:${x.res}${x.n > 1 ? ` x${x.n}` : ""}`);
  return shown.join(",") + (runs.length > MAX_ITEMS ? `,... (${runs.length} runs)` : "");
}

// lsof -nP -iTCP:<port> (POSIX) or netstat -ano lines (Windows) → [{ cmd, pid, side: "local"|"remote", state }]
function parseHolders(text, port) {
  if (typeof text !== "string" || !text.trim()) return { status: "none", list: [] };
  if (/^unavailable: no process found/.test(text)) return { status: "none", list: [] };
  if (/^unavailable/.test(text)) return { status: "unavailable", list: [] };
  const list = [];
  const portRe = new RegExp(`[:.]${port}$`);
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (/^TCP$/i.test(cols[0])) { // netstat: Proto Local Foreign State PID
      const [, local, foreign, state, pid] = cols;
      const side = portRe.test(local) ? "local" : portRe.test(foreign) ? "remote" : null;
      if (side && /^\d+$/.test(pid || "")) list.push({ cmd: "?", pid: Number(pid), side, state: cleanCmd(state).toUpperCase() });
    } else if (/^\d+$/.test(cols[1])) { // lsof: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME [(STATE)]
      const m = /\(([A-Z_]+)\)\s*$/.exec(line);
      const name = cols[cols.length - (m ? 2 : 1)] || "";
      const [a, b] = name.split("->");
      const side = portRe.test(a) ? "local" : b && portRe.test(b) ? "remote" : null;
      if (side) list.push({ cmd: cleanCmd(cols[0]), pid: Number(cols[1]), side, state: m ? m[1] : "?" });
    }
    if (list.length >= MAX_ITEMS) break;
  }
  return { status: "seen", list };
}

function describeImageReplacement(o) {
  const t0 = o.t0;
  const rel = (t) => (t == null ? "?" : t - t0);
  const parts = [];
  const checks = (o.checks || []).filter((c) => c.port === o.port && c.t >= t0);
  parts.push(`server checks of ${o.port ?? "?"} after the request ${checks.length ? runsOf(checks, rel, false) : "none recorded"}`);
  const other = (o.checks || []).filter((c) => c.port !== o.port && c.t >= t0);
  if (other.length) parts.push(`checks of other ports ${runsOf(other, rel, true)}`);
  const diag = (o.diag || []).filter((r) => r.t >= t0);
  const oldExit = diag.find((r) => r.pid === o.oldPid && r.e === "exit");
  parts.push(`old engine exit record ${oldExit ? rel(oldExit.t) : "none (killed, or not recorded)"}; old PID running now ${o.oldAlive == null ? "?" : o.oldAlive}`);
  const starts = diag.filter((r) => r.e === "start" && r.pid !== o.oldPid && r.port === o.port);
  const newPid = starts.length ? starts[starts.length - 1].pid : null;
  const ofNew = (e) => diag.find((r) => r.pid === newPid && r.e === e);
  const start = ofNew("start"), listening = ofNew("listening"), err = ofNew("listen-error");
  parts.push(`replacement start ${start ? rel(start.t) : "none recorded"}${starts.length > 1 ? ` (${starts.length} starts on this port)` : ""}; ${listening ? `listening ${rel(listening.t)}` : err ? `listen error ${cleanCmd(err.code)} ${rel(err.t)}` : "no bind result recorded"}`);
  if (o.maxImage != null) parts.push(`most image engines at once ${o.maxImage}`);
  if (o.slot && o.slot.counts) parts.push(`slot unconfirmed exits ${o.slot.counts.unconfirmed ?? "?"} phase ${cleanCmd(o.slot.phase)}`);
  if (!err) { parts.push("reading: the replacement bound its port"); return parts.join("; "); }

  const lastFree = [...checks].reverse().find((c) => c.result === "free" && c.t <= err.t);
  parts.push(`last free check before the bind ${lastFree ? `${rel(lastFree.t)} (${err.t - lastFree.t} ms before the error)` : "none"}`);
  const h = parseHolders(err.holders, o.port);
  const role = (pid) => (pid === o.oldPid ? "old engine" : pid === newPid ? "replacement" : "other");
  parts.push(`holders after the error (lookup may miss a holder already gone) ${h.status === "unavailable" ? "unavailable" : h.list.length ? h.list.map((x) => `${x.cmd}/${x.pid} ${role(x.pid)} ${x.side} ${x.state}`).join(",") : "none"}`);
  const listeners = h.list.filter((x) => x.side === "local" && x.state === "LISTEN" && x.pid !== newPid);
  let reading;
  if (h.status === "unavailable") reading = "holder lookup unavailable: no reading";
  else if (listeners.some((x) => x.pid === o.oldPid)) reading = "the old engine was still listening after its exit was confirmed: consistent with delayed release by the old engine";
  else if (listeners.length) reading = "another process was listening on the port: consistent with concurrent ownership (identity not established)";
  else if (!lastFree) reading = "no free check of this port was recorded before the bind: no reading on the selection";
  else if (h.list.length) reading = "no listener seen, only connection states on the port: consistent with a selection-to-bind race with a holder already gone, or platform bind behaviour; not decided";
  else reading = "nothing seen on the port after the error: consistent with a short-lived holder between the check and the bind, or platform bind behaviour; not decided";
  parts.push(`reading: ${reading}`);
  return parts.join("; ");
}

module.exports = { describeImageReplacement, parseHolders };
