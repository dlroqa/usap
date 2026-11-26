// #151 diagnostics (test-only, messages only, never judged): when refusal-close.test.cjs finds a server answer later
// than its bound (accept -> 'finish'), describeLateAnswer() says WHERE the time went, from what was already observed:
//   server   per connection, stamped by the in-process test server: acceptedAt/acceptedHr ('connection'),
//            requestAt/requestHr ('request': the request head PARSED by the server, not its arrival) and
//            answeredAt/answeredHr (res 'finish'). The *Hr stamps are process.hrtime in ms (monotonic, one process;
//            Numbers, so the records stay JSON). The refusal is written synchronously inside the request handler, so
//            request->finish is the server's own work plus the next loop pass.
//   client   the refusal-clients.cjs process's record for that connection: t0 (Date.now() just BEFORE its
//            net.connect() call), drainsAt (its socket drained after writing; the request head is written before
//            any body chunk, so a drain proves the head had left the client), io.firstDataAt (the answer reached it),
//            and its `ticks` (Date.now() at a 10 ms interval). Client and server are compared on the host's wall
//            clock: Date.now() in both processes on one machine, within about 2 ms of each other (round-16
//            calibration); client ticks are 10 ms apart.
// Readings, only as far as the observations go (the server's own event loop is not observed here):
//   evidence incomplete            no request time or no monotonic stamps for this connection
//   wall clock stepped             the wall-clock and monotonic accept->finish disagree by more than 50 ms: the bound
//                                  was measured on a wall clock that moved
//   request head parsed late       accept->request holds most of the time. Then: the client had already sent the
//                                  head (a drain before the parse), so the rest is transport or server reading (a
//                                  client timer gap over the same window is added); or the client's event loop ran no
//                                  timer for most of that window (its process not running or blocked, or a host-wide
//                                  stall: the ticks cannot tell which); or it kept running (transport or server
//                                  reading: not distinguishable); or inconclusive
//   delay after the request head   request->finish holds most of the time (the server's processing or writing)
//   other or unexplained           neither (only reachable with inconsistent stamps)
// plus how many connections were late (all 20 clients share one process, so possibly a shared cause; whether they
// were late at the same time is not checked). Nothing is changed or judged; the line is bounded (900 chars; the limits come
// before the numbers, so a cut only drops numbers) and carries only numbers and fixed words.
"use strict";

const LATE_PART_MS = 500;   // a phase "holds" the delay when it is at least this long ...
const LATE_PART_SHARE = 0.5; // ... and at least this share of accept->finish
const PAUSE_SHARE = 0.8;    // a client tick gap covering this share of a window: the client process did not run
const RUNNING_GAP_MS = 100; // client ticks no further apart than this through a window: the client kept running
const CLOCK_STEP_MS = 50;   // wall vs monotonic disagreement that means the wall clock moved
const HEAD_SENT_SLACK_MS = 5; // a drain this much before the parse (cross-process wall-clock error ~2 ms)
const MANY_LATE = 5;

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const ms = (a, b) => (fin(a) && fin(b) ? b - a : null);
const r = (x) => (fin(x) ? String(Math.round(x)) : "none");

// the largest gap between consecutive client ticks that overlaps [from, to] (wall ms) and how much of the window it
// covers; ticks that do not span the window are "not covered"
function tickGapIn(ticks, from, to) {
  if (!Array.isArray(ticks) || ticks.length < 2 || !fin(from) || !fin(to) || to < from) return null;
  const t = ticks.filter(fin).slice().sort((a, b) => a - b);
  if (t.length < 2 || t[0] > from || t[t.length - 1] < to) return { covered: false };
  let max = 0, at = null;
  for (let i = 1; i < t.length; i += 1) {
    const a = t[i - 1], b = t[i];
    if (b < from || a > to) continue;
    if (b - a > max) { max = b - a; at = [a, b]; }
  }
  return { covered: true, max, overlap: at ? Math.max(0, Math.min(at[1], to) - Math.max(at[0], from)) : 0 };
}

function describeLateAnswer({ c, conns = [], clients = [], ticks = [], bound }) {
  if (!c) return "late-answer diagnosis: no server record";
  const wall = ms(c.acceptedAt, c.answeredAt);
  const late = conns.filter((x) => fin(x.answeredAt) && fin(x.acceptedAt) && x.answeredAt - x.acceptedAt > bound).length;
  const noRequest = conns.filter((x) => !fin(x.requestAt)).length;
  const aToR = ms(c.acceptedHr, c.requestHr), rToF = ms(c.requestHr, c.answeredHr), aToF = ms(c.acceptedHr, c.answeredHr);
  const parts = [`server (hrtime): accept->head parsed ${r(aToR)} ms, head parsed->finish ${r(rToF)} ms, accept->finish ${r(aToF)} ms (wall ${r(wall)} ms)`];
  parts.push(`${late} of ${conns.length} connections over ${bound} ms, ${noRequest} without a recorded request`);
  const st = clients.find((x) => x && x.localPort === c.remotePort);
  let gapReq = null, headSent = null;
  if (st) {
    const firstDrain = Array.isArray(st.drainsAt) && st.drainsAt.length ? st.drainsAt[0] : null;
    const got = st.io && fin(st.io.firstDataAt) ? st.io.firstDataAt : null;
    parts.push(`client (wall clock): accept - connect() call ${r(ms(st.t0, c.acceptedAt))} ms, first drain ${r(ms(c.acceptedAt, firstDrain))} ms after accept, answer reached the client ${r(ms(c.answeredAt, got))} ms after finish`);
    if (fin(c.requestAt)) {
      gapReq = tickGapIn(ticks, c.acceptedAt, c.requestAt);
      if (fin(firstDrain) && firstDrain < c.requestAt - HEAD_SENT_SLACK_MS) headSent = firstDrain - c.acceptedAt;
    }
    const gapFin = fin(c.requestAt) ? tickGapIn(ticks, c.requestAt, c.answeredAt) : null;
    const show = (g) => (!g ? "none" : !g.covered ? "ticks do not cover it" : `${r(g.max)} ms`);
    parts.push(`client's largest tick gap: accept->head parsed ${show(gapReq)}, head parsed->finish ${show(gapFin)}`);
  } else parts.push("client: no record for this port");
  let reading;
  if (!fin(c.requestAt) || aToR === null || rToF === null || aToF === null) reading = "evidence incomplete (no request time or no monotonic stamps for this connection)";
  else if (fin(wall) && Math.abs(wall - aToF) > CLOCK_STEP_MS) reading = `wall clock stepped by ${r(wall - aToF)} ms (Date.now and hrtime disagree; the bound was measured on the wall clock)`;
  else {
    const holds = (x) => x >= LATE_PART_MS && x >= LATE_PART_SHARE * aToF;
    if (holds(aToR)) {
      const window = c.requestAt - c.acceptedAt; // wall, like the ticks
      const paused = gapReq && gapReq.covered && gapReq.overlap >= PAUSE_SHARE * window;
      const pause = paused ? `the client's event loop ran no timer for ${r(gapReq.overlap)} ms of that window (its process not running or blocked, or a host-wide stall; the server's loop is not observed)` : "";
      let client = "client evidence inconclusive";
      if (headSent !== null) client = `the client had sent the head by ${r(headSent)} ms after accept (first drain); the remaining ${r(window - headSent)} ms is after the client's write: transport or server reading${paused ? `; also, the client loop ran no timer for ${r(gapReq.overlap)} ms of it` : ""}`;
      else if (paused) client = pause;
      else if (gapReq && gapReq.covered && gapReq.max <= RUNNING_GAP_MS) client = "the client process kept running (transport or server reading: not distinguishable here)";
      reading = `request head parsed late; ${client}`;
    } else if (holds(rToF)) reading = "delay after the request head was parsed (the server's processing or writing; its own scheduling is not observed here)";
    else reading = "other or unexplained timing";
  }
  if (late >= MANY_LATE) reading += `; ${late} connections late (possibly a shared cause: the client process, the server process or the host)`;
  // the limits come right after the reading, so the 900-character cut can only drop numbers, never them
  const limits = "limits: client and server wall clocks within ~2 ms, client ticks 10 ms apart, the server's event loop is not observed";
  return `late-answer diagnosis: ${reading}. ${limits}; ${parts.join("; ")}`.slice(0, 900);
}

module.exports = { describeLateAnswer, tickGapIn, LATE_PART_MS, HEAD_SENT_SLACK_MS, RUNNING_GAP_MS };
