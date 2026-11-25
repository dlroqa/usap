// #170 R1b bind trace reader (test-only, messages only). Joins the studio's own binds on the image engine's port
// (fixtures/e1-bind-trace-preload.cjs, kind "studio" or "inject") with each image engine generation's listen attempt
// (api-contract/fake-sd-server.cjs records: start, listening / listen-error with tCall and tOk / tErr taken BEFORE the
// fake's synchronous holder lookup). It never judges a test: it returns one line for a failure message.
//
// Fixed reading per engine generation on the traced port (times in ms, Date.now on one host; U = 1 ms resolution):
//   attempt window W = [tCall, tRes], tRes = tOk (listening) or tErr (listen-error).
//   A studio bind P that BOUND held the port somewhere inside [bind-start, closed] (closed missing = still held at the
//   end of the trace). Not [bound, closed]: checkPort (serve.cjs) attaches its own 'listening' handler, which closes the
//   port, before listen() runs, so the preload's "bound" line is written after that close; the real hold lies between
//   bind-start and bound. The superset can only err towards G/T, never clear a probe that held the port.
//   engine listen-error EADDRINUSE:
//     G  "overlap, studio bind won": some bound P has bound <= tRes - U and closed >= tCall + U (held across part of W)
//     T  "touch, inconclusive":      no G, but some bound P is within U of W (1 ms resolution can't order them)
//     U  "unrelated to studio binds": no bound P within U of W; the nearest studio bind and its gap are named, with the
//        previous generation's exit relative to tCall and the fake's holder lookup
//     X  "untimed": the record has no tErr (older fake) - never read as G or U
//   engine listening: "engine won" for every studio bind that failed (bind-error) inside [tCall, end of that engine];
//     nearest bound P outside W is reported as "near" with its gap.
//   a generation on another port (fallback range) is "untraced".
// The cross-process comparison uses Date.now (wall clock, shared by processes on one host, 1 ms). tp (timeOrigin +
// now(), sub-ms) is printed for the closest pair only (tpGap): its per-process origin may differ slightly on Windows.
// prevExit: the previous image engine generation ON THE SAME PORT (the backend probe on another port writes a start
// record too); null when it has no exit record (always on Windows: engines are stopped with taskkill /F).
// traceAge: ms between the trace's last line and the reading; a large value means buffered lines may be missing.
"use strict";
const U = 1;

function studioBinds(trace) {
  const binds = new Map();
  for (const e of trace) {
    if (!e || !e.id) continue;
    const b = binds.get(e.id) || { id: e.id, kind: e.kind, by: (e.by || []).slice(0, 3).join("<") };
    if (e.ev === "bind-start") { b.start = e.t; b.tpStart = e.tp; b.thStart = e.th; }
    if (e.ev === "bound") { b.bound = e.t; b.tpBound = e.tp; b.thBound = e.th; }
    if (e.ev === "closed") { b.closed = e.t; b.thClosed = e.th; }
    if (e.ev === "bind-error") { b.error = e.code; b.errorAt = e.t; }
    binds.set(e.id, b);
  }
  return [...binds.values()];
}

// gap between a held interval [a, b] and W = [w0, w1]; 0 when they intersect
const gap = (a, b, w0, w1) => (b < w0 ? w0 - b : a > w1 ? a - w1 : 0);

function generations(diag, port) {
  const gens = [];
  for (const r of diag) {
    if (!r || !r.pid) continue;
    if (r.e === "start") gens.push({ pid: r.pid, ppid: r.ppid, port: r.port, startAt: r.t });
    const g = [...gens].reverse().find((x) => x.pid === r.pid);
    if (!g) continue;
    if (r.e === "listening") Object.assign(g, { result: "listening", tCall: r.tCall, tRes: r.tOk, tpRes: r.tpOk, thCall: r.thCall, thRes: r.thOk });
    if (r.e === "listen-error") Object.assign(g, { result: r.code || "error", tCall: r.tCall, tRes: r.tErr, tpRes: r.tpErr, thCall: r.thCall, thRes: r.thErr, holders: String(r.holders || "").replace(/\s+/g, " ").slice(0, 160), lateStamp: r.t });
    if (r.e === "exit") g.exitAt = r.t;
  }
  return gens.map((g, i) => ({ ...g, n: i + 1, traced: g.port === port }));
}

// trace: preload lines; diag: fake records; port: the traced (preferred) image port; from/to: optional time window
function readBindTrace({ trace = [], diag = [], port, from = -Infinity, to = Infinity, now = Date.now() }) {
  const binds = studioBinds(trace).filter((b) => b.start >= from - 5000 && b.start <= to);
  const end = Math.max(0, ...trace.map((e) => e.t || 0), ...diag.map((r) => r.t || 0));
  const held = binds.filter((b) => b.bound !== undefined).map((b) => ({ ...b, a: b.start, z: b.closed === undefined ? end : b.closed }));
  const gens = generations(diag, port).filter((g) => g.startAt >= from && g.startAt <= to);
  const rows = [];
  gens.forEach((g, i) => {
    const prev = [...gens.slice(0, i)].reverse().find((x) => x.port === g.port) || null;
    const base = { n: g.n, pid: g.pid, ppid: g.ppid, port: g.port, result: g.result || "no listen record" };
    if (!g.traced) { rows.push({ ...base, reading: "untraced" }); return; }
    if (!g.result) { rows.push({ ...base, reading: "no listen record" }); return; }
    if (g.tCall === undefined || g.tRes === undefined) { rows.push({ ...base, reading: "X untimed" }); return; }
    const w0 = g.tCall, w1 = g.tRes;
    const scored = held.map((b) => ({ b, d: gap(b.a, b.z, w0, w1) })).sort((x, y) => x.d - y.d);
    const tpGap = (b) => (Number.isFinite(b.tpStart) && Number.isFinite(g.tpRes) ? Math.round((b.tpStart - g.tpRes) * 1000) / 1000 : null);
    // round 16, printed only (the reading rules above are unchanged): the studio bind's start/bound/closed and the
    // engine's listen call on the machine-wide hrtime clock, in ms relative to the engine's result (tRes)
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const th = (b) => (Number.isFinite(g.thRes) && Number.isFinite(b.thStart) ? { start: r3(b.thStart - g.thRes), bound: Number.isFinite(b.thBound) ? r3(b.thBound - g.thRes) : null, closed: Number.isFinite(b.thClosed) ? r3(b.thClosed - g.thRes) : null, engineCall: Number.isFinite(g.thCall) ? r3(g.thCall - g.thRes) : null } : null);
    const nearest = scored[0] ? { id: scored[0].b.id, kind: scored[0].b.kind, by: scored[0].b.by, gapMs: scored[0].d, start: scored[0].b.a - w0, bound: scored[0].b.bound - w0, closed: scored[0].b.z - w0, tpGap: tpGap(scored[0].b), th: th(scored[0].b) } : null;
    const prevExit = prev && prev.exitAt !== undefined ? prev.exitAt - w0 : null;
    if (g.result === "EADDRINUSE") {
      const G = held.filter((b) => b.a <= w1 - U && b.z >= w0 + U);
      const T = held.filter((b) => !G.includes(b) && gap(b.a, b.z, w0, w1) <= U);
      const reading = G.length ? "G overlap, studio bind won" : T.length ? "T touch, inconclusive" : "U unrelated to studio binds";
      const who = (G.length ? G : T).slice(0, 3).map((b) => `${b.kind}#${b.id} ${b.by || "?"} start ${b.a - w0} bound ${b.bound - w0} closed ${b.z - w0} tpGap ${tpGap(b)} th ${JSON.stringify(th(b))}`);
      rows.push({ ...base, reading, window: `0..${w1 - w0}`, binds: who, nearest: G.length || T.length ? undefined : nearest, prevExit, holders: g.holders, lookupMs: g.lateStamp - w1 });
    } else if (g.result === "listening") {
      const stop = g.exitAt !== undefined ? g.exitAt : end;
      const lost = binds.filter((b) => b.error && b.errorAt >= w0 && b.errorAt <= stop);
      const near = nearest && nearest.gapMs > 0 && nearest.gapMs <= 100 ? nearest : null;
      const inW = scored.filter((x) => x.d === 0).length;
      rows.push({ ...base, reading: "listening", boundNearW: inW, engineWon: lost.length, near, prevExit });
    } else rows.push({ ...base, reading: `listen ${g.result}`, nearest, prevExit });
  });
  const failed = rows.filter((r) => /^(G|T|U|X)/.test(r.reading));
  const summary = failed.length ? failed.map((r) => r.reading.split(" ")[0]).join(",") : "no engine EADDRINUSE";
  const lastT = Math.max(-Infinity, ...trace.map((e) => e.t || -Infinity));
  const traceAge = Number.isFinite(lastT) ? now - lastT : null;
  const line = `#170 R1b bind trace (${process.platform}): port ${port}, trace age ${traceAge === null ? "no lines" : `${traceAge} ms`}, studio binds ${binds.length} (${[...new Set(binds.map((b) => `${b.kind}:${b.by || "?"}`))].slice(0, 4).join(" | ") || "none"}), engine generations ${gens.length}; reading ${summary}; ${JSON.stringify(rows)}`.slice(0, 3000);
  return { rows, summary, line, traceAge };
}

module.exports = { readBindTrace, studioBinds, generations, U };
