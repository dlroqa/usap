// json-413 missing-record diagnostics (test-only, messages only, never judged). On Windows CI a client of
// json-413.test.cjs received its 413 and then ECANCELED, and the server's connection record for it was missing (the
// record is written by api-contract/connection-log-preload.cjs when the server's socket closes; the test looks it up
// by the client's local port). describeRecordMiss() reads one missed record with fixed rules from:
//   st      the client's state from raw() (t0 = wall ms at start; answeredAt/errorAt/closedAt relative to t0)
//   events  the preload's event trail (USAP_TEST_CONN_LOG_TRACE lines: arrive, end, finish, destroy, sockerr,
//           sockclose, flush; wall ms)
//   polls   the collection: { count, first, last } wall ms of the reads, deadline (wall ms), log: what the last read
//           saw { size, lines, bad (unparsable lines; records() returns none then), ports }, shrank (the file got
//           smaller between reads), late: { at } when the record appeared after the deadline (diagnostic look), or null
// Readings: never seen by the record listener / identity mismatch (arrived with another port) / never generated
// (socket not closed by the end of collection, or the record write failed) / published but unreadable / overwritten
// / published after the collection deadline (delayed) / published and present but not matched / unexplained.
// C3 (#205 follow-up, round 15): server  the studio process at the miss: { atMiss, afterLook } snapshots of
//   { pid, running, exit: { code, signal, at, before } , tail } (tail already sanitized by the caller: no paths, no
//   bodies). Checked FIRST: a server that was not running at the miss, with no successful record write traced for the
//   connection, reads "server dead" (its exit code/signal/time relative to the client's start). A trail that hit the
//   preload's 400-line cap, or has unparsable lines, makes the trail-based readings undecidable ("trail incomplete").
//   polls.readStats counts the collector's failed reads by kind (ENOENT / parse), so "parse failure" is visible.
// Only numbers, codes and function names are printed: no paths, no bodies.
"use strict";

const ARRIVE_SLACK_MS = 1000; // an arrival this close to the client's start counts as "near" for the identity reading

const TRAIL_CAP = 400; // lines; the preload stops tracing silently there (api-contract/connection-log-preload.cjs)
function describeServer(server, rel) {
  if (!server) return "";
  const one = (x) => (!x ? "?" : x.running ? `running (pid ${x.pid})` : `exited (pid ${x.pid}, code ${x.exit && x.exit.code !== undefined ? x.exit.code : "?"}, signal ${(x.exit && x.exit.signal) || "none"}, at ${rel(x.exit && x.exit.at)}${x.exit && x.exit.before ? ", before the test's stop" : ""})`);
  const tail = server.afterLook && server.afterLook.tail ? `, log tail [${server.afterLook.tail}]` : "";
  return `studio at the miss ${one(server.atMiss)}, after the late look ${one(server.afterLook)}${tail}`;
}
function describeRecordMiss({ st, port, events = [], polls = {}, server = null, trailBad = 0 }) {
  const t0 = st.t0;
  const rel = (w) => (Number.isFinite(w) ? Math.round(w - t0) : "none");
  const arrives = events.filter((e) => e.ev === "arrive");
  const mine = arrives.filter((e) => e.rp === port);
  const of = (id, ev) => events.filter((e) => e.id === id && e.ev === ev);
  const client = `client answer ${st.answeredAt ?? "none"}, error ${st.error || "none"} ${st.errorAt ?? ""}, close ${st.closedAt ?? "none"}`.replace(/ +,/g, ",");
  const coll = `collection ${polls.count || 0} reads ${rel(polls.first)}..${rel(polls.last)} (deadline ${rel(polls.deadline)})${polls.log ? `, last read ${polls.log.lines} lines, ${polls.log.bad} unparsable, ports ${(polls.log.ports || []).slice(0, 8).join("/") || "none"}` : ""}${polls.shrank ? ", log shrank" : ""}`;
  let verdict, trail = "";
  const flushedOk = mine.some((a) => of(a.id, "flush").some((f) => f.result === "ok"));
  const dead = server && server.atMiss && !server.atMiss.running;
  const rs = polls.readStats || {};
  const reads = Object.keys(rs).length ? `; collector read failures ${Object.entries(rs).map(([k, v]) => `${k}x${v}`).join(",")}` : "";
  if (dead && !flushedOk) {
    const x = server.atMiss.exit || {};
    verdict = `server dead: the studio had exited (code ${x.code !== undefined ? x.code : "?"}, signal ${x.signal || "none"}) at ${rel(x.at)}${x.before ? " (before the test stopped it)" : ""}, with no record write traced for this connection`;
  } else if (events.length >= TRAIL_CAP || trailBad > 0) {
    verdict = `trail incomplete (${events.length} lines${events.length >= TRAIL_CAP ? ", the preload's cap" : ""}, ${trailBad} unparsable): undecidable from the trail`;
  } else if (!mine.length) {
    const near = arrives.filter((e) => e.at >= t0 - ARRIVE_SLACK_MS && e.at <= t0 + (st.closedAt ?? 0) + ARRIVE_SLACK_MS);
    verdict = near.length ? `identity mismatch: a request arrived near this client with remotePort ${near.map((e) => e.rp ?? "none").slice(0, 3).join("/")} (client local port ${port})`
      : `never seen by the record listener (${arrives.length} traced arrivals, none for port ${port})`;
  } else {
    const a = mine[mine.length - 1], id = a.id;
    const t = (ev) => { const x = of(id, ev); return x.length ? x[0] : null; };
    const end = t("end"), fin = t("finish"), des = t("destroy"), err = t("sockerr"), sc = t("sockclose"), fl = t("flush");
    trail = `server: arrive ${rel(a.at)} (declared ${a.cl ?? "none"}${a.over ? ", over the limit" : ""}), res.end ${rel(end && end.at)}, finish ${rel(fin && fin.at)}${fin ? ` (${fin.status})` : ""}, destroy ${rel(des && des.at)}${des ? ` by ${(des.by || []).join(" < ") || "unknown"}` : ""}, socket error ${err ? `${err.code} ${rel(err.at)}` : "none"}, socket close ${rel(sc && sc.at)}, record write ${fl ? `${fl.result} ${rel(fl.at)}` : "none"}`;
    if (mine.length > 1) trail += ` (${mine.length} arrivals for this port)`;
    if (!sc) verdict = `never generated: the server socket was not closed by the end of collection${des ? "" : " (no destroy seen)"}`;
    else if (!fl || fl.result !== "ok") verdict = `never generated: the record write failed (${fl ? fl.result : "no write attempt"})`;
    else if (polls.log && polls.log.bad > 0) verdict = `published, but the log had ${polls.log.bad} unparsable line(s): collected as none`;
    else if (polls.shrank) verdict = "published, then the log shrank (overwritten)";
    else if (Number.isFinite(polls.last) && fl.at > polls.last) verdict = `published after the last read (delayed, ${Math.round(fl.at - polls.last)} ms after it)`;
    else if (polls.log && (polls.log.ports || []).includes(port)) verdict = "published and present at the last read, but not matched";
    else verdict = "published before the last read but not seen (unexplained)";
  }
  const late = polls.late ? `; record appeared after the deadline at ${rel(polls.late.at)}` : "; record not seen after the deadline either";
  const srv = describeServer(server, rel);
  return { verdict, line: `${verdict}: ${[srv, client, trail, coll + reads].filter(Boolean).join("; ")}${late}`.slice(0, server ? 1600 : 900) }; // 900 as before; room for the studio part only when it is given
}

// Parse a trail file's text (bounded; bad lines skipped and counted) -> { events, bad }
function parseTrail(text, max = 400) {
  const events = []; let bad = 0;
  for (const l of String(text || "").split("\n").filter(Boolean).slice(0, max)) { try { events.push(JSON.parse(l)); } catch (_) { bad += 1; } }
  return { events, bad };
}

/**
 * The json-413 record lookup (moved here unchanged so the controls exercise the same code): records() reads the log
 * (any unparsable line -> none, as before); recordFor(st) polls every 50 ms until the record for st.localPort is found
 * or deadlineMs has passed. With trace, each poll also notes the log's size (one stat); only a miss reads the log
 * again (once) and gets st.recordMiss (one reading) after one extra look of at most lateLookMs (diagnostic only: the
 * returned value is still the miss, so the required-record assertion fails exactly as before).
 */
function makeRecordCollector({ fs = require("node:fs"), log, trail = null, trace = false, deadlineMs, lateLookMs = 3000, server = null }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readStats = {}; // C3: failed reads by kind (ENOENT / parse); counting adds no I/O
  const records = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { const k = e instanceof SyntaxError ? "parse" : String(e.code || "error").slice(0, 12); readStats[k] = (readStats[k] || 0) + 1; return []; } };
  const logInfo = () => { try { const text = fs.readFileSync(log, "utf8"); const p = parseTrail(text, 10000); return { size: text.length, lines: p.events.length + p.bad, bad: p.bad, ports: p.events.map((x) => x.remotePort) }; } catch (e) { return { size: 0, lines: 0, bad: 0, ports: [], error: String(e.code || "error") }; } };
  const recordFor = async (st) => {
    const until = Date.now() + deadlineMs;
    const polls = { count: 0, first: null, last: null, deadline: until, log: null, shrank: false, late: null }; let size = 0;
    for (;;) {
      const r = records().find((x) => x.remotePort === st.localPort);
      // per poll only the log's size (one stat, for shrink detection); the log itself is read and parsed only after a miss
      if (trace) { const n = Date.now(); polls.count += 1; if (polls.first === null) polls.first = n; polls.last = n; let sz = 0; try { sz = fs.statSync(log).size; } catch (_) { sz = 0; } if (sz < size) polls.shrank = true; size = sz; }
      if (r || Date.now() > until) {
        if (!r && trace) {
          try {
            polls.log = logInfo(); // what the log held at the deadline
            const srv = server ? { atMiss: null, afterLook: null } : null;
            if (srv) { try { srv.atMiss = server(); } catch (_) { /* diagnostics only */ } }
            for (const end = Date.now() + lateLookMs; Date.now() < end && !polls.late; await sleep(100)) if (records().find((x) => x.remotePort === st.localPort)) polls.late = { at: Date.now() };
            if (srv) { try { srv.afterLook = server(); } catch (_) { /* diagnostics only */ } } // stderr has had time to drain
            polls.readStats = { ...readStats };
            let text = ""; try { text = fs.readFileSync(trail, "utf8"); } catch (_) { /* none */ }
            const pt = parseTrail(text);
            st.recordMiss = describeRecordMiss({ st, port: st.localPort, events: pt.events, polls, server: srv, trailBad: pt.bad }).line;
          } catch (_) { st.recordMiss = "description failed"; }
        }
        return r;
      }
      await sleep(50);
    }
  };
  return { records, recordFor };
}

// C3: a bounded, sanitized log tail: root/temp/home paths and drive paths replaced, lines with JSON bodies dropped.
function sanitizeTail(text, { root = "", maxLines = 20, maxChars = 1024 } = {}) {
  const os = require("node:os");
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let t = String(text || "");
  for (const p of [root, os.tmpdir(), os.homedir()].filter(Boolean)) t = t.replace(new RegExp(esc(p).replace(/\\\\/g, "[\\\\/]"), "gi"), "<path>");
  t = t.replace(/[A-Za-z]:\\[^\s"']*/g, "<path>").replace(/(^|[\s"'(])\/(?:[\w.-]+\/)+[\w.-]*/g, "$1<path>");
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !l.includes('{"')).slice(-maxLines);
  return lines.join(" | ").slice(-maxChars);
}

module.exports = { describeRecordMiss, parseTrail, makeRecordCollector, sanitizeTail };
