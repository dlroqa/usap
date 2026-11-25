// #197 stale-file scan trace (test-only preload, messages only). Loaded with NODE_OPTIONS=--require into the ONE studio
// that stale-file-report.test.cjs's report test starts with USAP_TEST_SF_TRACE=1; inert anywhere else (other
// processes, or without the variable). The failing run on macOS Intel (1d253e1) showed the scan's 500 ms budget used up
// before its first entry (scanned 0, truncated true). This records, in memory, what the studio did in that window:
//   listening            when the server started listening
//   req / res            the first 20 requests (path only, no query) and when each finished
//   sync                 synchronous child-process calls (execSync / execFileSync / spawnSync, outermost only):
//                        command basename, start, duration, timeout set, outcome
//   opendir / first / done  the scan's directory: opendir called / resolved (or error code), the first entry
//                        requested / delivered, the iterator done, entries delivered
//   gaps                 event-loop gaps >= 50 ms (10 ms timer), and the loop-delay histogram's max
// Times are performance.now() in ms (monotonic, since this process started). Nothing is written to a file and no
// thread-pool work is added (the scan itself uses the thread pool): the record is printed ONCE to stderr as
// "[sf-trace] {...}" about 50 ms after the scan's directory iterator finished (fallback: 10 s), then every timer of this
// preload stops. Bounded (40 events per kind). No names, no paths. It never changes what the studio does.
// Controls only (stale-scan-trace.test.cjs): USAP_TEST_SF_TRACE_BLOCK=<ms> blocks the event loop for <ms> right after
// the scan's opendir is called (the failing run's shape); USAP_TEST_SF_TRACE_FALLBACK=<ms> shortens the 10 s fallback;
// USAP_TEST_SF_TRACE_BLOCK_DONE=<ms> blocks right after the scan's iterator finished and USAP_TEST_SF_TRACE_LAG=<ms>
// slows the gap sampler, so the publish timer deterministically runs before it after that block.
"use strict";
if (process.env.USAP_TEST_SF_TRACE === "1" && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), http = require("node:http");
  const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
  const now = () => Math.round(performance.now() * 10) / 10;
  const rec = { listening: null, req: [], sync: [], scan: [], gaps: [], loopMax: null, published: null };
  const add = (list, o) => { if (list.length < 40) list.push(o); };
  let published = false, pubTimer = null;
  // sync child-process calls
  let depth = 0;
  for (const fn of ["execSync", "execFileSync", "spawnSync"]) {
    const orig = cp[fn];
    cp[fn] = function tracedSync(cmd, ...rest) {
      if (depth > 0 || published) return orig.call(this, cmd, ...rest);
      const opts = rest.find((x) => x && typeof x === "object" && !Array.isArray(x)) || {};
      const t0 = now(); depth += 1; let outcome = "ok";
      try { const r = orig.call(this, cmd, ...rest); if (r && r.error) outcome = String(r.error.code || "error").slice(0, 16); else if (r && r.signal) outcome = String(r.signal); return r; }
      catch (e) { outcome = String((e && (e.code || e.signal)) || "error").slice(0, 16); throw e; }
      finally { depth -= 1; add(rec.sync, { fn, cmd: path.basename(String(cmd).trim().split(/\s+/)[0]).replace(/[^\w.-]/g, "").slice(0, 32), at: t0, ms: Math.round((now() - t0) * 10) / 10, timeout: opts.timeout || 0, outcome }); }
    };
  }
  // listening + the first 20 requests (path only)
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function tracedEmit(ev, ...args) {
    if (!published) {
      if (ev === "listening" && rec.listening === null) rec.listening = now();
      if (ev === "request" && rec.req.length < 20) {
        const [req, res] = args; const o = { path: String(req.url || "").split("?")[0].slice(0, 40), at: now(), done: null }; rec.req.push(o);
        res.once("finish", () => { o.done = now(); });
      }
    }
    return emit.call(this, ev, ...args);
  };
  // the scan's directory: opendir and its async iterator (the module looks fs.promises.opendir up when it calls it)
  const opendir = fs.promises.opendir;
  fs.promises.opendir = async function tracedOpendir(...a) {
    const s = { opendir: now(), resolved: null, error: null, first: null, firstAt: null, done: null, entries: 0 }; add(rec.scan, s);
    const block = Number(process.env.USAP_TEST_SF_TRACE_BLOCK || 0); // control only
    if (block > 0) setImmediate(() => { const end = performance.now() + block; while (performance.now() < end) { /* injected block */ } });
    let dir;
    try { dir = await opendir.apply(this, a); } catch (e) { s.error = String((e && e.code) || "error").slice(0, 16); s.resolved = now(); throw e; }
    s.resolved = now();
    const iter = dir[Symbol.asyncIterator].bind(dir);
    dir[Symbol.asyncIterator] = function tracedEntries() {
      const it = iter();
      const finish = () => { if (s.done === null) { s.done = now(); schedulePublish();
        const bd = Number(process.env.USAP_TEST_SF_TRACE_BLOCK_DONE || 0); // control only
        if (bd > 0) setImmediate(() => { const end = performance.now() + bd; while (performance.now() < end) { /* injected block */ } }); } };
      return {
        async next() { if (s.first === null) s.first = now(); const r = await it.next(); if (s.firstAt === null) s.firstAt = now(); if (r.done) finish(); else s.entries += 1; return r; },
        async return(v) { finish(); return it.return ? it.return(v) : { done: true, value: v }; },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    return dir;
  };
  // event-loop gaps and delay
  let last = performance.now();
  const lag = setInterval(() => { const n = performance.now(); const g = n - last; last = n; if (g >= 50) add(rec.gaps, { from: Math.round((n - g) * 10) / 10, ms: Math.round(g) }); }, Number(process.env.USAP_TEST_SF_TRACE_LAG || 10));
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  function publish() {
    if (published) return; published = true;
    // the lag sampler and this timer can be due together after a block: record the pending gap before stopping the
    // sampler (round-16 macOS Intel CI: a 342 ms execSync ending just before publish was missed as a gap)
    { const n = performance.now(); const g = n - last; if (g >= 50) add(rec.gaps, { from: Math.round((n - g) * 10) / 10, ms: Math.round(g), atPublish: true }); }
    clearInterval(lag); clearTimeout(pubTimer); clearTimeout(fallback);
    rec.loopMax = Math.round(h.max / 1e6); h.disable(); rec.published = now();
    try { process.stderr.write(`[sf-trace] ${JSON.stringify(rec)}\n`); } catch (_) { /* diagnostics only */ }
  }
  function schedulePublish() { if (!published && !pubTimer) pubTimer = setTimeout(publish, 50); }
  const fallback = setTimeout(publish, Number(process.env.USAP_TEST_SF_TRACE_FALLBACK || 10000)); fallback.unref(); lag.unref();
}
