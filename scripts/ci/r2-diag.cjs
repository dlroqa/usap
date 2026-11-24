// #170 diagnostics for the native engine-lifecycle check "R2 three image loads at once" (scripts/ci/engine-lifecycle-
// validate.cjs; test-only, messages only, never judged). On Windows it once answered 200/200/200 with at most one image
// process, then found no live image engine and backend-status "running" false. This describes, as one bounded,
// sanitized line, what the validator recorded, so a start failure, an early exit and a loss of tracking read
// differently. It decides nothing: R2's verdict is computed before and unchanged.
//   o.t0       wall time just before the three loads were sent (all times are ms relative to it)
//   o.loads    [{ steps, sentAt, answeredAt, status, code, error }] in send order
//   o.samples  [{ t, sup: [{ guardPid, enginePid, startedAt }], exits: [{ enginePid, code, signal, at }] }] image entries
//              from /api/diagnostics (engines.processes) as the validator's own sampler fetched them
//   o.final    { status: /api/backend-status JSON, sup, exits, alive: { pid: bool }, portOpen }  read after the verdict
//   o.log      the test server's log text (only [backend], [engine-slot], [api] restart and error lines are used)
// Process ids are replaced by e1, e2, ... in order of first appearance (guards g1, g2, ...); paths, addresses and ports
// are removed from log lines; error texts are reduced to code words.
"use strict";
const MAX = 12;
const words = (t) => {
  const s = String(t || "");
  const codes = s.match(/\bE[A-Z]{3,}\b/g) || [];
  const phr = ["not reachable", "timed out", "socket hang up", "exited", "cancel", "failed", "in use", "not ready"].filter((p) => s.toLowerCase().includes(p));
  return [...new Set([...codes, ...phr])].slice(0, 4).join(",") || "none";
};
const cleanLine = (l) => String(l).replace(/[A-Za-z]:\\[^\s"]*|\/[^\s"]*/g, " ").replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "ADDR")
  .replace(/\b(port|pid|PID|process)\s*[:=]?\s*\d+/g, "$1 N").replace(/[^A-Za-z0-9 _.,:()=\[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

function describeR2(o = {}) {
  const t0 = o.t0;
  const rel = (t) => { const v = typeof t === "string" ? Date.parse(t) : t; return Number.isFinite(v) && Number.isFinite(t0) ? Math.round(v - t0) : "?"; };
  const ids = new Map(), gids = new Map();
  const eid = (p) => { if (!p) return "none"; if (!ids.has(p)) ids.set(p, `e${ids.size + 1}`); return ids.get(p); };
  const gid = (p) => { if (!p) return "none"; if (!gids.has(p)) gids.set(p, `g${gids.size + 1}`); return gids.get(p); };
  const parts = [];
  const loads = Array.isArray(o.loads) ? o.loads : [];
  parts.push(`loads ${loads.map((l) => `steps ${l.steps}: sent ${rel(l.sentAt)}, ${l.status} ${l.code ? String(l.code).replace(/[^A-Z_]/g, "") : ""} at ${rel(l.answeredAt)}${l.status !== 200 ? ` (${words(l.error)})` : ""}`.replace(/\s+/g, " ")).join("; ") || "none"}`);
  // Engine timeline from the samples: each engine's first and last sighting as supervised, and its recorded exit.
  const seen = new Map(), exits = new Map();
  for (const s of Array.isArray(o.samples) ? o.samples : []) {
    for (const r of s.sup || []) { const k = r.enginePid || `guard:${r.guardPid}`; const v = seen.get(k) || { first: s.t, last: s.t, guard: r.guardPid, started: r.startedAt, engine: r.enginePid }; v.last = s.t; if (r.enginePid) v.engine = r.enginePid; seen.set(k, v); }
    for (const x of s.exits || []) if (x.enginePid && !exits.has(x.enginePid)) exits.set(x.enginePid, x);
  }
  const fin = o.final || {};
  for (const x of fin.exits || []) if (x.enginePid && !exits.has(x.enginePid)) exits.set(x.enginePid, x);
  const timeline = [...seen.values()].slice(0, MAX).map((v) => {
    const x = v.engine ? exits.get(v.engine) : null;
    return `${eid(v.engine)}/${gid(v.guard)} started ${rel(v.started)}, supervised ${rel(v.first)}..${rel(v.last)}${x ? `, exited ${rel(x.at)} code ${x.code ?? "none"} signal ${x.signal ?? "none"}` : ", no exit recorded"}`;
  });
  const exitOnly = [...exits.values()].filter((x) => ![...seen.values()].some((v) => v.engine === x.enginePid) && rel(x.at) !== "?" && rel(x.at) >= -1000);
  for (const x of exitOnly.slice(0, MAX)) timeline.push(`${eid(x.enginePid)} exited ${rel(x.at)} code ${x.code ?? "none"} signal ${x.signal ?? "none"} (never sampled as supervised)`);
  parts.push(`image engines ${timeline.length ? timeline.join("; ") : "none recorded"}`);
  const st = fin.status || {};
  const liveSup = (fin.sup || []).map((r) => `${eid(r.enginePid)}/${gid(r.guardPid)}`);
  const aliveBy = Object.entries(fin.alive || {}).map(([p, a]) => `${eid(Number(p))} ${a ? "alive" : "gone"}`);
  parts.push(`after the check: backend running ${st.running}, ready ${st.ready}, loading ${String(st.loading ?? "none").replace(/[^A-Za-z_-]/g, "")}, unloading ${String(st.unloading ?? "none").replace(/[^A-Za-z_-]/g, "")}, current steps ${st.settings && Number.isFinite(st.settings.steps) ? st.settings.steps : "none"}, error ${words(st.error)}, engine port open ${fin.portOpen ?? "?"}; supervised now ${liveSup.join(",") || "none"}; OS ${aliveBy.join(",") || "none"}`);
  // Reading: what the records are consistent with (no cause is named; nothing is decided).
  const engines = [...new Set([...[...seen.values()].map((v) => v.engine).filter(Boolean), ...exits.keys()])];
  const anyAlive = Object.values(fin.alive || {}).some(Boolean);
  let reading;
  if (engines.length === 0 && seen.size === 0) reading = "no image engine process was recorded after the loads: consistent with a failure to start";
  else if (anyAlive && !(fin.sup || []).length) reading = "an engine process is still alive but no longer supervised: consistent with a loss of tracking";
  else if (anyAlive && st.running !== true) reading = "an engine process is alive and supervised but the backend is not marked running: consistent with a loss of tracking in the image state";
  else if (!anyAlive && engines.length && engines.every((p) => exits.has(p))) reading = "every engine recorded during the check exited (codes above): consistent with an early exit or a stop after the loads";
  else if (!anyAlive) reading = "no engine alive and not every exit recorded: not determined from these records";
  else reading = "an engine is alive and tracked";
  parts.push(`reading: ${reading}`);
  const lines = String(o.log || "").split(/\r?\n/).filter((l) => /\[backend\]|\[engine-slot\]|Restart backend request|error|exit/i.test(l)).slice(-MAX).map(cleanLine).filter(Boolean);
  parts.push(`server lines ${lines.length ? lines.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 3000);
}

module.exports = { describeR2 };
