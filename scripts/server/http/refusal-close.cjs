// refusal-close.cjs — close a connection whose request was answered before its body was read.
//
// When the server answers a request without reading its body (a refusal such as 401, 403, 404, 413 or 415), Node
// would otherwise keep the connection open and go on reading and discarding the rest of the body for as long as the
// client keeps sending. Only Node's request timeout (300 s) would end it. For such requests this helper:
//
//   1. adds `Connection: close` to the answer, so the client knows the connection ends after it;
//   2. once the answer is written, stops reading the socket and half-closes it (FIN), so the client still receives
//      the complete answer while it is sending. The socket is kept stopped with public stream APIs only, and one
//      that reads during its grace period anyway is closed by a periodic fail-closed check (see linger);
//   3. destroys the socket after a short grace period (GRACE_MS), so a client that keeps the connection open
//      (silent, slow, or still sending) can't hold it.
//
// A request whose body has been received completely, that has no body, or whose declared Content-Length is small
// (at most SMALL_BODY_BYTES) keeps Node's normal handling (including keep-alive): at most that many bytes are read
// and discarded. If such a small body is still incomplete when the answer has been written, it gets the same grace
// period to arrive; otherwise the connection is closed, so a client can't hold it until Node's request timeout.
// Larger declared bodies and chunked bodies (unknown length) are closed as described above. Accepted requests never call this. It only decides how the connection ends; the
// answer itself (status, headers, body) is unchanged, and no request is ever routed differently.
//
// Node detail (checked by scripts/tests/refusal-close.test.cjs): Node ends a `Connection: close` response by calling
// `socket.destroySoon()`, after switching the unread body to discard mode. destroySoon would close the socket at once
// and, with unread data, the client's TCP stack reports a reset and may drop the answer it already received. This
// helper therefore replaces destroySoon on that one socket. If a future Node version stops calling destroySoon, the
// `finish` fallback below still closes the connection within the grace period, and the test fails so the change is seen.
"use strict";

const GRACE_MS = 2000;
const SMALL_BODY_BYTES = 64 * 1024;
const noop = () => {};
const WATCH_BYTES = 256 * 1024; // fail-closed trigger: a socket found to have read more than this is closed. Not a cap:
                                // it keeps reading until the next check finds it.
const WATCH_MS = 100;           // nominal interval of the shared check; timers run late when the event loop is busy
let lingering = 0; // sockets currently in their grace period (reported to tests)
let resumed = 0;      // times Node resumed a socket in its grace period and it was paused again (reported to tests)
let closedReading = 0; // sockets closed early because they still read during the grace period (reported to tests)
const watched = new Map(); // socket -> { readAtStart, watchBytes }
let watchTimer = null;

// One shared, unref'd timer checks every socket in its grace period, so the cost does not grow with their number.
function watchAll() {
  for (const [socket, w] of watched) {
    if (socket.destroyed) { watched.delete(socket); continue; }
    if (socket.bytesRead - w.readAtStart > w.watchBytes) { watched.delete(socket); closedReading += 1; socket.destroy(); }
  }
  if (watched.size === 0) { clearInterval(watchTimer); watchTimer = null; }
}
function watch(socket, watchBytes) {
  watched.set(socket, { readAtStart: socket.bytesRead, watchBytes });
  socket.once("close", () => watched.delete(socket));
  if (!watchTimer) { watchTimer = setInterval(watchAll, WATCH_MS); watchTimer.unref(); }
}

/** True when part of a request body that is chunked, or declared larger than smallBodyBytes, may still arrive. */
function bodyMayRemain(req, smallBodyBytes = SMALL_BODY_BYTES) {
  if (!req || req.complete) return false;
  const h = req.headers || {};
  if (h["transfer-encoding"] !== undefined) return true;
  const n = Number(h["content-length"]);
  return Number.isFinite(n) && n > smallBodyBytes;
}

function linger(socket, graceMs, setTimer, clearTimer, watchBytes = WATCH_BYTES) {
  if (!socket || socket.destroyed || socket.__usapLingering) return;
  socket.__usapLingering = true;
  lingering += 1;
  socket.on("error", noop); // a reset from the client during the grace period is expected
  let timer = null;
  socket.once("close", () => { if (timer) clearTimer(timer); lingering -= 1; });
  // Read nothing more, and keep it that way, using public stream APIs only. pause() alone is not enough: when the
  // answer finishes, Node switches the unread body to discard mode and, on the next tick, resumes the socket so the
  // body is read and thrown away. A resumed stream emits 'resume' in the same tick in which it starts reading, before
  // any data can arrive, so pausing it again there stops the read. scripts/tests/refusal-close.test.cjs checks that
  // Node still behaves this way.
  socket.on("resume", () => { if (!socket.destroyed) { resumed += 1; socket.pause(); } });
  socket.pause();
  socket.end();             // FIN after the answer already queued
  timer = setTimer(() => socket.destroy(), graceMs);
  // Fail closed: if the socket still reads during its grace period anyway (a Node version that resumes it some other
  // way), the next check (nominally every WATCH_MS; later when the event loop is busy) closes it instead of letting it
  // read and discard at network speed for the whole grace period. This is a backstop, not a bound: what it reads
  // before the check runs depends on network speed and scheduling. Answers are never lost to this on a Node that
  // behaves as checked above, because such a socket reads nothing more.
  // (No 'data' listener: on a server socket, adding one makes Node's HTTP server change how it reads that socket, and
  // a body in discard mode never emits 'data' on the request.)
  watch(socket, watchBytes);
}

// A small declared body still arriving after the answer: keep the connection if it completes within the grace period
// (keep-alive as before), close it otherwise.
function closeIfSmallBodyStalls(req, res, graceMs, setTimer, clearTimer) {
  const socket = req.socket;
  if (!socket || socket.destroyed || res.__usapSmallBodyDeadline) return;
  res.__usapSmallBodyDeadline = true;
  res.once("finish", () => {
    if (req.complete || socket.destroyed) return;
    let timer = null;
    const clear = () => { if (timer) { clearTimer(timer); timer = null; } };
    req.once("end", clear);
    socket.once("close", clear);
    timer = setTimer(() => { timer = null; if (!req.complete && !socket.destroyed) { socket.on("error", noop); socket.destroy(); } }, graceMs);
  });
}

/**
 * Call before writing a refusal (before writeHead / res.end). Returns true when the connection will be closed.
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ graceMs?: number, smallBodyBytes?: number, setTimer?: Function, clearTimer?: Function, watchBytes?: number }} [o]
 */
function closeAfterAnswer(req, res, { graceMs = GRACE_MS, smallBodyBytes = SMALL_BODY_BYTES, setTimer = setTimeout, clearTimer = clearTimeout, watchBytes = WATCH_BYTES } = {}) {
  if (!req || !res || res.headersSent || res.__usapCloseAfterAnswer) return false;
  if (!bodyMayRemain(req, smallBodyBytes)) {
    const declared = Number((req.headers || {})["content-length"]);
    if (!req.complete && Number.isFinite(declared) && declared > 0) closeIfSmallBodyStalls(req, res, graceMs, setTimer, clearTimer);
    return false;
  }
  const socket = req.socket;
  if (!socket || socket.destroyed) return false;
  res.__usapCloseAfterAnswer = true;
  res.setHeader("Connection", "close");
  const original = socket.destroySoon;
  let handled = false;
  if (typeof original === "function") {
    socket.destroySoon = function destroySoonAfterRefusal() {
      socket.destroySoon = original;
      handled = true;
      if (req.complete) return original.call(socket); // nothing unread after all: Node's normal close
      linger(socket, graceMs, setTimer, clearTimer, watchBytes);
    };
  }
  // Fallback: Node registers its own `finish` handler (which calls destroySoon) before any route runs, so by the
  // time this one runs Node has already closed the connection or handed it to us. If it did neither, close it here.
  res.once("finish", () => {
    if (handled || socket.destroyed) return;
    if (typeof original === "function" && socket.destroySoon !== original) socket.destroySoon = original;
    if (!req.complete) linger(socket, graceMs, setTimer, clearTimer, watchBytes);
  });
  return true;
}

module.exports = {
  closeAfterAnswer, bodyMayRemain, GRACE_MS, SMALL_BODY_BYTES, WATCH_BYTES, WATCH_MS,
  lingeringCount: () => lingering, resumedCount: () => resumed, closedReadingCount: () => closedReading,
};
