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
// Round 26 corrections (messages only; lookup, deadline and verdict of the required-record assertion unchanged):
//   A  an incomplete trail (cap or unparsable lines) is decided BEFORE "server dead": a capped trail cannot show the
//      record write, so a dead studio then reads "server dead; trail incomplete, record write undecidable".
//   B  a studio running at the miss but exited by the late look reads "studio exited after the miss" (exit time vs the
//      deadline and the last read), prefixed to the trail reading, so a late-reported exit is not hidden by it.
//   C  read failures are counted per lookup (not per collector), split into before the deadline and during the late
//      look; the log read error at the deadline is printed (missing log vs unreadable log vs unparsable line).
//   D  a trail file that cannot be read reads "trail unreadable (<code>): undecidable", not "never seen".
//   E  the sanitized tail keeps :line:col after a removed path and error codes of dropped object lines, reads at most
//      the last 64 KiB, and the tail at the miss is printed when it differs from the one after the late look.
// Only numbers, codes and function names are printed: no paths, no bodies.
"use strict";

const ARRIVE_SLACK_MS = 1000; // an arrival this close to the client's start counts as "near" for the identity reading

const TRAIL_CAP = 400; // lines; the preload stops tracing silently there (api-contract/connection-log-preload.cjs)
function describeServer(server, rel) {
  if (!server) return "";
  const one = (x) => (!x ? "?" : x.running ? `running (pid ${x.pid})` : `exited (pid ${x.pid}, code ${x.exit && x.exit.code !== undefined ? x.exit.code : "?"}, signal ${(x.exit && x.exit.signal) || "none"}, at ${rel(x.exit && x.exit.at)}${x.exit && x.exit.before ? ", before the test's stop" : ""})`);
  const tail = server.afterLook && server.afterLook.tail ? `, log tail [${server.afterLook.tail}]` : "";
  const t0 = server.atMiss && server.atMiss.tail;
  const tailAtMiss = t0 && (!server.afterLook || t0 !== server.afterLook.tail) ? `, log tail at the miss [${t0}]` : ""; // E
  return `studio at the miss ${one(server.atMiss)}, after the late look ${one(server.afterLook)}${tail}${tailAtMiss}`;
}
function describeRecordMiss({ st, port, events = [], polls = {}, server = null, trailBad = 0, trailErr = null }) {
  const t0 = st.t0;
  const rel = (w) => (Number.isFinite(w) ? Math.round(w - t0) : "none");
  const arrives = events.filter((e) => e.ev === "arrive");
  const mine = arrives.filter((e) => e.rp === port);
  const of = (id, ev) => events.filter((e) => e.id === id && e.ev === ev);
  const client = `client answer ${st.answeredAt ?? "none"}, error ${st.error || "none"} ${st.errorAt ?? ""}, close ${st.closedAt ?? "none"}`.replace(/ +,/g, ",");
  const coll = `collection ${polls.count || 0} reads ${rel(polls.first)}..${rel(polls.last)} (deadline ${rel(polls.deadline)})${polls.log ? `, last read ${polls.log.error ? `failed ${polls.log.error}` : `${polls.log.lines} lines, ${polls.log.bad} unparsable, ports ${(polls.log.ports || []).slice(0, 8).join("/") || "none"}`}` : ""}${polls.shrank ? ", log shrank" : ""}`; // C: the log read error is printed
  let verdict, trail = "";
  const flushedOk = mine.some((a) => of(a.id, "flush").some((f) => f.result === "ok"));
  const dead = server && server.atMiss && !server.atMiss.running;
  // B: running at the miss, exited by the late look (an exit reported late, e.g. on Windows)
  const deadLate = server && server.atMiss && server.atMiss.running && server.afterLook && !server.afterLook.running;
  const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${k}x${v}`).join(",");
  const rs = polls.readStats || {}, rsLate = polls.readStatsLate || {}; // C: this lookup's own counts
  const reads = Object.keys(rs).length || Object.keys(rsLate).length ? `; collector read failures ${fmt(rs) || "none"}${Object.keys(rsLate).length ? `, during the late look ${fmt(rsLate)}` : ""}` : "";
  const capped = events.length >= TRAIL_CAP;
  const incomplete = capped || trailBad > 0; // A: decided first; a capped trail cannot show the record write
  const exitPart = (x) => `(code ${x.code !== undefined ? x.code : "?"}, signal ${x.signal || "none"}) at ${rel(x.at)}${x.before ? " (before the test stopped it)" : " (after the test began stopping it)"}${Number.isFinite(x.at) && Number.isFinite(polls.last) ? (x.at >= polls.last ? `, ${Math.round(x.at - polls.last)} ms after the last read` : `, ${Math.round(polls.last - x.at)} ms before the last read`) : ""}`;
  const incompleteText = `trail incomplete (${events.length} lines${capped ? ", the preload's cap" : ""}, ${trailBad} unparsable)`;
  if (trailErr) {
    verdict = `trail unreadable (${trailErr}): undecidable from the trail${dead ? `; the studio had exited ${exitPart(server.atMiss.exit || {})}` : ""}`; // D
  } else if (dead && incomplete) {
    verdict = `server dead; ${incompleteText}, record write undecidable: the studio had exited ${exitPart(server.atMiss.exit || {})}`; // A
  } else if (dead && !flushedOk) {
    verdict = `server dead: the studio had exited ${exitPart(server.atMiss.exit || {})}, with no record write traced for this connection`;
  } else if (incomplete) {
    verdict = `${incompleteText}: undecidable from the trail`;
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
  if (deadLate && !/^server dead|^trail unreadable/.test(verdict)) { // B: prefixed, so the trail reading stays visible
    const x = server.afterLook.exit || {};
    verdict = `studio exited after the miss ${exitPart(x)} (deadline ${rel(polls.deadline)}); ${verdict}`;
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
  const delta = (from) => Object.fromEntries(Object.entries(readStats).map(([k, v]) => [k, v - (from[k] || 0)]).filter(([, v]) => v > 0));
  const recordFor = async (st) => {
    const until = Date.now() + deadlineMs;
    const base = { ...readStats }; // C: this lookup's counts only
    const polls = { count: 0, first: null, last: null, deadline: until, log: null, shrank: false, late: null }; let size = 0;
    for (;;) {
      const r = records().find((x) => x.remotePort === st.localPort);
      // per poll only the log's size (one stat, for shrink detection); the log itself is read and parsed only after a miss
      if (trace) { const n = Date.now(); polls.count += 1; if (polls.first === null) polls.first = n; polls.last = n; let sz = 0; try { sz = fs.statSync(log).size; } catch (_) { sz = 0; } if (sz < size) polls.shrank = true; size = sz; }
      if (r || Date.now() > until) {
        if (!r && trace) {
          try {
            polls.log = logInfo(); // what the log held at the deadline
            polls.readStats = delta(base); const lateBase = { ...readStats }; // C: before the deadline vs the late look
            const srv = server ? { atMiss: null, afterLook: null } : null;
            if (srv) { try { srv.atMiss = server(); } catch (_) { /* diagnostics only */ } }
            for (const end = Date.now() + lateLookMs; Date.now() < end && !polls.late; await sleep(100)) if (records().find((x) => x.remotePort === st.localPort)) polls.late = { at: Date.now() };
            if (srv) { try { srv.afterLook = server(); } catch (_) { /* diagnostics only */ } } // stderr has had time to drain
            polls.readStatsLate = delta(lateBase);
            let text = "", trailErr = null;
            if (trail) { try { text = fs.readFileSync(trail, "utf8"); } catch (e) { trailErr = String((e && e.code) || "error").slice(0, 12); } } // D
            const pt = parseTrail(text);
            st.recordMiss = describeRecordMiss({ st, port: st.localPort, events: pt.events, polls, server: srv, trailBad: pt.bad, trailErr }).line;
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
const TAIL_INPUT_MAX = 64 * 1024; // E: only the last 64 KiB of the log are scanned
function sanitizeTail(text, { root = "", maxLines = 20, maxChars = 1024 } = {}) {
  const os = require("node:os");
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let t = String(text || "").slice(-TAIL_INPUT_MAX);
  for (const p of [root, os.tmpdir(), os.homedir()].filter(Boolean)) t = t.replace(new RegExp(esc(p).replace(/\\\\/g, "[\\\\/]"), "gi"), "<path>");
  // E: a path ends before ":line" or ":line:col", which is kept (stack frames stay readable)
  const LC = String.raw`((?::\d+){1,2})?(?=[\s"')]|$)`;
  t = t.replace(new RegExp(String.raw`file:\/\/\/?[^\s"')]*?` + LC, "gim"), "<path>$1") // file URLs
    .replace(new RegExp(String.raw`\\\\[^\s"'\\]+\\[^\s"']*?` + LC, "gm"), "<path>$1") // UNC \\host\share\...
    .replace(new RegExp(String.raw`[A-Za-z]:[\\/][^\s"']*?` + LC, "gm"), "<path>$1") // drive paths, either slash
    .replace(new RegExp(String.raw`(^|[\s"'(=:])\/(?:[^\s"'/]+\/)+[^\s"']*?` + LC, "gm"), "$1<path>$2") // absolute POSIX paths, also after = or :
    .replace(/<path>(?:[^\s"')]*?<path>)+/g, "<path>"); // a path whose pieces were replaced twice
  // drop lines carrying bodies: JSON ({"), util.inspect objects/arrays ({ key: / [{); E: their error code is kept
  const codeOf = (l) => (l.match(/\bcode:\s*'([A-Z][A-Z0-9_]{1,39})'/) || l.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]{1,39})"/) || [])[1];
  const lines = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => (!/\{"|\{\s*[\w$]+:|\[\{/.test(l) ? l : codeOf(l) ? `[obj code=${codeOf(l)}]` : null)).filter(Boolean).slice(-maxLines);
  return lines.join(" | ").slice(-maxChars);
}

module.exports = { describeRecordMiss, parseTrail, makeRecordCollector, sanitizeTail };
