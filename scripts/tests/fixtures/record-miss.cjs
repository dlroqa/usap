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
//   E  the log tail is summarized from an allowlist (round 27, sanitizeTail below): no raw log text is printed; reads at
//      most the last 64 KiB; the tail at the miss is printed when it differs from the one after the late look. Trail
//      fields are printed only through allowlists too (codes, identifiers, integers).
// Only numbers, codes and function names are printed: no paths, no bodies.
"use strict";

const ARRIVE_SLACK_MS = 1000; // an arrival this close to the client's start counts as "near" for the identity reading

const TRAIL_CAP = 400; // lines; the preload stops tracing silently there (api-contract/connection-log-preload.cjs)
function describeServer(server, rel) {
  if (!server) return "";
  const one = (x) => (!x ? "?" : x.running ? `running (pid ${x.pid})` : `exited (pid ${x.pid}, code ${x.exit && x.exit.code !== undefined ? x.exit.code : "?"}, signal ${(x.exit && x.exit.signal) || "none"}, at ${rel(x.exit && x.exit.at)}${x.exit && x.exit.before ? ", before the test's stop" : ""})`);
  return `studio at the miss ${one(server.atMiss)}, after the late look ${one(server.afterLook)}`;
}
// The log tails go LAST, each within its own budget, so the cut of the whole line can only shorten tails and never
// drops the client, trail, collection or read-failure parts (round 26, E).
const TAIL_BUDGET = 400;
function describeTails(server) {
  if (!server) return "";
  const cut = (x) => (x.length > TAIL_BUDGET ? `…${x.slice(-(TAIL_BUDGET - 1))}` : x); // the end of a log is the useful part
  const after = server.afterLook && server.afterLook.tail;
  const t0 = server.atMiss && server.atMiss.tail;
  const parts = [];
  if (after) parts.push(`log tail [${cut(after)}]`);
  else if (server.afterLook && after === "") parts.push("log tail [empty]");
  if (t0 && (!server.afterLook || t0 !== after)) parts.push(`log tail at the miss [${cut(t0)}]`); // E
  return parts.join("; ");
}
function describeRecordMiss({ st, port, events = [], polls = {}, server = null, trailBad = 0, trailErr = null }) {
  const t0 = st.t0;
  const rel = (w) => (Number.isFinite(w) ? Math.round(w - t0) : "none");
  const arrives = events.filter((e) => e.ev === "arrive");
  const mine = arrives.filter((e) => e.rp === port);
  const of = (id, ev) => events.filter((e) => e.id === id && e.ev === ev);
  const client = `client answer ${st.answeredAt ?? "none"}, error ${st.error ? safeCode(st.error) : "none"} ${st.errorAt ?? ""}, close ${st.closedAt ?? "none"}`.replace(/ +,/g, ",");
  const coll = `collection ${polls.count || 0} reads ${rel(polls.first)}..${rel(polls.last)} (deadline ${rel(polls.deadline)})${polls.log ? `, last read ${polls.log.error ? `failed ${safeCode(polls.log.error)}` : `${polls.log.lines} lines, ${polls.log.bad} unparsable, ports ${(polls.log.ports || []).filter(Number.isInteger).slice(0, 8).join("/") || "none"}`}` : ""}${polls.shrank ? ", log shrank" : ""}`; // C: the log read error is printed
  let verdict, trail = "";
  const lastMine = mine.length ? mine[mine.length - 1] : null; // the same arrival the trail reading uses (port reuse)
  const flushedOk = !!lastMine && of(lastMine.id, "flush").some((f) => f.result === "ok");
  const dead = server && server.atMiss && !server.atMiss.running;
  // B: running at the miss, exited by the late look (an exit reported late, e.g. on Windows)
  const deadLate = server && server.atMiss && server.atMiss.running && server.afterLook && !server.afterLook.running;
  const fmt = (o) => Object.entries(o || {}).map(([k, v]) => `${safeCode(k)}x${Number.isInteger(v) ? v : "?"}`).join(",");
  const rs = polls.readStats || {}, rsLate = polls.readStatsLate || {}; // C: this lookup's own counts
  const reads = Object.keys(rs).length || Object.keys(rsLate).length ? `; collector read failures ${fmt(rs) || "none"}${Object.keys(rsLate).length ? `, during the late look ${fmt(rsLate)}` : ""}` : "";
  const capped = events.length + trailBad >= TRAIL_CAP; // the preload's cap counts lines, parsable or not
  const incomplete = capped || trailBad > 0; // A: decided first; a capped trail cannot show the record write
  const exitPart = (x) => `(code ${x.code !== undefined ? x.code : "?"}, signal ${x.signal || "none"}) at ${rel(x.at)}${x.before ? " (before the test stopped it)" : " (after the test began stopping it)"}${Number.isFinite(x.at) && Number.isFinite(polls.last) ? (x.at >= polls.last ? `, ${Math.round(x.at - polls.last)} ms after the last read` : `, ${Math.round(polls.last - x.at)} ms before the last read`) : ""}`;
  const incompleteText = `trail incomplete (${events.length} lines${capped ? ", the preload's cap" : ""}, ${trailBad} unparsable)`;
  if (trailErr) {
    verdict = `${trailErr === "ENOENT" ? "trail absent (ENOENT: the preload wrote no trace line)" : `trail unreadable (${safeCode(trailErr)})`}: undecidable from the trail${dead ? `; the studio had exited ${exitPart(server.atMiss.exit || {})}` : ""}`; // D
  } else if (dead && incomplete) {
    verdict = `server dead; ${incompleteText}, record write undecidable: the studio had exited ${exitPart(server.atMiss.exit || {})}`; // A
  } else if (dead && !flushedOk) {
    verdict = `server dead: the studio had exited ${exitPart(server.atMiss.exit || {})}, with no record write traced for this connection`;
  } else if (incomplete) {
    verdict = `${incompleteText}: undecidable from the trail`;
  } else if (!mine.length) {
    const near = arrives.filter((e) => e.at >= t0 - ARRIVE_SLACK_MS && e.at <= t0 + (st.closedAt ?? 0) + ARRIVE_SLACK_MS);
    verdict = near.length ? `identity mismatch: a request arrived near this client with remotePort ${near.map((e) => (Number.isInteger(e.rp) ? e.rp : "none")).slice(0, 3).join("/")} (client local port ${port})`
      : `never seen by the record listener (${arrives.length} traced arrivals, none for port ${port})`;
  } else {
    const a = mine[mine.length - 1], id = a.id;
    const t = (ev) => { const x = of(id, ev); return x.length ? x[0] : null; };
    const end = t("end"), fin = t("finish"), des = t("destroy"), err = t("sockerr"), sc = t("sockclose"), fl = t("flush");
    trail = `server: arrive ${rel(a.at)} (declared ${Number.isFinite(a.cl) ? a.cl : "none"}${a.over ? ", over the limit" : ""}), res.end ${rel(end && end.at)}, finish ${rel(fin && fin.at)}${fin ? ` (${Number.isInteger(fin.status) ? fin.status : "?"})` : ""}, destroy ${rel(des && des.at)}${des ? ` by ${(Array.isArray(des.by) ? des.by.slice(0, 4).map(safeName) : []).join(" < ") || "unknown"}` : ""}, socket error ${err ? `${safeCode(err.code)} ${rel(err.at)}` : "none"}, socket close ${rel(sc && sc.at)}, record write ${fl ? `${safeCode(fl.result)} ${rel(fl.at)}` : "none"}`;
    if (mine.length > 1) trail += ` (${mine.length} arrivals for this port)`;
    if (!sc) verdict = `never generated: the server socket was not closed by the end of collection${des ? "" : " (no destroy seen)"}`;
    else if (!fl || fl.result !== "ok") verdict = `never generated: the record write failed (${fl ? safeCode(fl.result) : "no write attempt"})`;
    else if (polls.log && polls.log.bad > 0) verdict = `published, but the log had ${polls.log.bad} unparsable line(s): collected as none`;
    else if (polls.shrank) verdict = "published, then the log shrank (overwritten)";
    else if (Number.isFinite(polls.last) && fl.at > polls.last) verdict = `published after the last read (delayed, ${Math.round(fl.at - polls.last)} ms after it)`;
    else if (polls.log && (polls.log.ports || []).includes(port)) verdict = "published and present at the last read, but not matched";
    else verdict = "published before the last read but not seen (unexplained)";
  }
  if (deadLate && !/^server dead/.test(verdict)) { // B: prefixed, so the trail reading stays visible
    const x = server.afterLook.exit || {};
    verdict = `studio exited after the miss ${exitPart(x)} (deadline ${rel(polls.deadline)}); ${verdict}`;
  }
  const late = polls.late ? `; record appeared after the deadline at ${rel(polls.late.at)}` : "; record not seen after the deadline either";
  const srv = describeServer(server, rel), tails = describeTails(server);
  return { verdict, line: `${verdict}: ${[srv, client, trail, coll + reads].filter(Boolean).join("; ")}${late}${tails ? `; ${tails}` : ""}`.slice(0, server ? 1600 : 900) }; // 900 as before; room for the studio part only when it is given
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

// Round 27: the studio log tail is no longer scrubbed by matching paths (raw lines could still carry an unusual path,
// a query, a prompt or a file name); it is SUMMARIZED from an allowlist. Each kept line becomes only these tokens, in
// order: a leading "[tag]" (lowercase), error class names (…Error), error codes (EXXX, ERR_XXX), signals (SIGXXX),
// "code N" / "exit N" numbers, a small set of lowercase status words, and stack frames as "at fn (file:line:col)" where
// fn is an identifier and file is a basename from the repository's own script files (else "<file>"; "node:" modules are
// kept by name). Everything else — paths, URLs, quoted text, bodies, numbers without a known label — is dropped, and the
// lines without any allowed token are only counted. Bounded: the last 64 KiB, at most maxLines lines, maxChars chars.
const TAIL_INPUT_MAX = 64 * 1024;
const WORDS = /\b(uncaught|unhandled|rejection|exception|fatal|abort(?:ed)?|killed|timeout|timed out|listening|ready|shutting down|stopp(?:ed|ing)|exited|crash(?:ed)?|heap|out of memory|warning|deprecat(?:ed|ion)|refused|reset)\b/gi;
let repo = null; // the repository's own scripts: basename -> path, and the [tags] its server source prints (read once, after a miss)
function repoIndex() {
  if (repo) return repo;
  const fs = require("node:fs"), path = require("node:path");
  repo = { files: new Map(), tags: new Set(), src: new Map() };
  const walk = (d, depth) => { if (depth > 6) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1); else if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:cjs|mjs|js)$/.test(e.name) && !repo.files.has(e.name)) repo.files.set(e.name, f); } };
  const scripts = path.resolve(__dirname, "..", "..");
  walk(scripts, 0);
  for (const [, f] of repo.files) if (f.startsWith(path.join(scripts, "server"))) { try { for (const m of fs.readFileSync(f, "utf8").matchAll(/["'`]\s*\[([a-z][a-z0-9-]{0,24})\]/g)) repo.tags.add(m[1]); } catch (_) { /* none */ } }
  return repo;
}
function sourceHas(base, name) { // a function name is printed only if the repository file it is attributed to contains it
  const r = repoIndex(); const f = r.files.get(base); if (!f) return false;
  if (!r.src.has(base)) { try { r.src.set(base, require("node:fs").readFileSync(f, "utf8")); } catch (_) { r.src.set(base, ""); } }
  const last = name.split(".").pop().replace(/^<|>$/g, "");
  return last === "anonymous" || r.src.get(base).includes(last);
}
const ERRNO = new Set(Object.keys(require("node:os").constants.errno || {}));
const ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "AbortError", "SystemError", "AssertionError"]);
const BUILTINS = new Set(require("node:module").builtinModules.filter((m) => !m.startsWith("_")));
const IDENT = /^[A-Za-z_$][\w$]{0,59}(?:\.(?:[A-Za-z_$][\w$]{0,59}|<anonymous>)){0,3}$/;
function frameOf(line) {
  const m = line.match(/^\s*at (?:async )?(?:(\S{1,120}) \()?(.*?):(\d{1,7}):(\d{1,7})\)?\s*$/);
  if (!m) return null;
  const loc = m[2], base = loc.split(/[\\/]/).pop();
  const lc = `${m[3]}:${m[4]}`;
  if (/^node:/.test(loc)) { const mod = loc.slice(5); return `at (node:${mod.startsWith("internal/") ? "internal" : BUILTINS.has(mod) ? mod : "?"}:${lc})`; }
  if (!repoIndex().files.has(base)) return `at (<file>:${lc})`; // not one of the repository's own files: no name, no function
  const fn = m[1] && IDENT.test(m[1]) && sourceHas(base, m[1]) ? `${m[1]} ` : m[1] ? "<fn> " : "";
  return `at ${fn}(${base}:${lc})`;
}
function summarizeLine(line) {
  const fr = frameOf(line);
  if (fr) return fr;
  const out = [];
  const tag = line.match(/^\s*\[([a-z][a-z0-9-]{0,24})\]/); if (tag && repoIndex().tags.has(tag[1])) out.push(`[${tag[1]}]`);
  for (const m of line.matchAll(/\b([A-Z][A-Za-z]{0,40}Error)\b/g)) if (ERROR_CLASSES.has(m[1])) out.push(m[1]);
  for (const m of line.matchAll(/\b(E[A-Z0-9]{2,24})\b/g)) if (ERRNO.has(m[1])) out.push(m[1]);
  for (const m of line.matchAll(/\b(ERR_[A-Z0-9_]{2,60})\b/g)) out.push(m[1]); // Node's own code shape (residual: user text shaped like it)
  for (const m of line.matchAll(/\b(SIG(?:HUP|INT|QUIT|ILL|ABRT|BUS|FPE|KILL|SEGV|PIPE|ALRM|TERM|USR1|USR2|CHLD|BREAK))\b/g)) out.push(m[1]);
  for (const m of line.matchAll(/\b(code|exit(?: code)?|status)[ :=]+(-?\d{1,6})\b/gi)) out.push(`${m[1].toLowerCase()} ${m[2]}`);
  for (const m of line.matchAll(WORDS)) out.push(m[1].toLowerCase());
  return out.length ? [...new Set(out)].join(" ") : null;
}
function sanitizeTail(text, { maxLines = 20, maxChars = 1024 } = {}) {
  let t = String(text || "");
  if (t.length > TAIL_INPUT_MAX) t = t.slice(-TAIL_INPUT_MAX).replace(/^[^\n]*\n?/, ""); // the cut first line is dropped
  const kept = []; let other = 0;
  for (const l of t.split(/\r?\n/)) { if (!l.trim()) continue; const x = summarizeLine(l); if (x) kept.push(x); else other += 1; }
  const lines = kept.slice(-maxLines);
  const dropped = other + (kept.length - lines.length);
  return `${lines.join(" | ")}${dropped ? `${lines.length ? " | " : ""}(${dropped} other line${dropped === 1 ? "" : "s"})` : ""}`.slice(-maxChars);
}
// Trail fields are written by the test preload, but they are still only printed through these allowlists.
const safeCode = (x) => (typeof x === "string" && /^[A-Za-z0-9_]{1,40}$/.test(x) ? x : x === undefined || x === null ? "none" : "?");
const safeName = (x) => (typeof x === "string" && (IDENT.test(x) || /^<anonymous>$/.test(x)) ? x : "<fn>");

module.exports = { describeRecordMiss, parseTrail, makeRecordCollector, sanitizeTail };
