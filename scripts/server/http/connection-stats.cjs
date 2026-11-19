// connection-stats.cjs — observe-only statistics about the HTTP server's TCP connections.
//
// It counts every connection the HTTP server accepts (its public "connection" event, emitted before any byte of a
// request is parsed, so connections that never send complete headers are counted too), classifies it as `local`
// (loopback peer) or `lan` (anything else) with the same address normalisation sign-in uses, and releases it exactly
// once when the socket closes. It never refuses, delays or changes a connection, and it is independent of the
// scheduler settings (USAP_SCHEDULER=off does not turn it off).
//
// Privacy: only aggregate numbers are kept — counts, peaks and fixed time buckets. No address, port, request line,
// header, body, credential or session identifier is stored or reported. Memory is constant: per open socket one
// small state object on the socket, nothing kept after it closes.
"use strict";

const { normalizePeerAddress, isLoopbackAddress } = require("../lan-auth.cjs");

// Fixed buckets (upper bounds, ms) for how long connections stay open and how long until their first request.
const LIFETIME_BUCKETS_MS = [1000, 10000, 60000, 600000, Infinity];
const FIRST_REQUEST_BUCKETS_MS = [100, 1000, 10000, 60000, Infinity];
const bucketNames = (bounds) => bounds.map((b) => (b === Infinity ? `over${bounds[bounds.length - 2]}` : `upTo${b}`));

/** "local" for a loopback peer (127.0.0.0/8, ::1, IPv4-mapped loopback), "lan" for anything else, including unknown. */
function classifyPeer(remoteAddress) {
  return isLoopbackAddress(normalizePeerAddress(remoteAddress)) ? "local" : "lan";
}

function createConnectionStats({ classify = classifyPeer, now = Date.now } = {}) {
  const since = new Date(now()).toISOString();
  const newClass = () => ({
    open: 0, peakOpen: 0, accepted: 0, closed: 0, closedWithoutRequest: 0,
    lifetimeMs: LIFETIME_BUCKETS_MS.map(() => 0), firstRequestMs: FIRST_REQUEST_BUCKETS_MS.map(() => 0),
  });
  const classes = { local: newClass(), lan: newClass() };
  let open = 0, peakOpen = 0, accepted = 0;
  let disabled = false; // set if an observer handler ever throws: counting stops, the server is never affected
  const kState = Symbol("connectionStats"); // per-socket state, on the socket itself (gone with it)

  // The handlers run inside the HTTP server's own event dispatch, where an exception could end the process. They
  // never throw: an unexpected error disables the statistics (reported in the snapshot, nothing about the error's
  // content) and leaves the connection untouched.
  const safe = (fn) => function safeObserver(...args) {
    if (disabled) return;
    try { fn.apply(this, args); } catch (_) { disabled = true; }
  };

  // Shared handlers (no closures per connection).
  const onClose = safe(function onClose() {
    const st = this[kState];
    if (!st || st.released) return; // exactly once
    st.released = true;
    const cls = st.cls;
    cls.open -= 1; cls.closed += 1; open -= 1;
    if (!st.sawRequest) cls.closedWithoutRequest += 1;
    const ms = now() - st.openedAt;
    cls.lifetimeMs[LIFETIME_BUCKETS_MS.findIndex((b) => ms <= b)] += 1;
  });

  const onConnection = safe(function onConnection(socket) {
    const cls = classes[classify(socket.remoteAddress)] || classes.lan;
    cls.open += 1; cls.accepted += 1; if (cls.open > cls.peakOpen) cls.peakOpen = cls.open;
    open += 1; accepted += 1; if (open > peakOpen) peakOpen = open;
    socket[kState] = { cls, openedAt: now(), sawRequest: false, released: false };
    socket.once("close", onClose);
  });

  const onRequest = safe(function onRequest(req) {
    const st = req && req.socket && req.socket[kState];
    if (!st || st.sawRequest) return;
    st.sawRequest = true;
    const ms = now() - st.openedAt;
    st.cls.firstRequestMs[FIRST_REQUEST_BUCKETS_MS.findIndex((b) => ms <= b)] += 1;
  });

  /** Listen on an http.Server. Listeners run before the request handler and never touch the socket's data. */
  function attach(server) {
    server.prependListener("connection", onConnection);
    server.prependListener("request", onRequest);
    return api;
  }

  function snapshot(extra = {}) {
    const out = (c) => ({
      open: c.open, peakOpen: c.peakOpen, accepted: c.accepted, closed: c.closed, closedWithoutRequest: c.closedWithoutRequest,
      lifetimeMs: Object.fromEntries(bucketNames(LIFETIME_BUCKETS_MS).map((n, i) => [n, c.lifetimeMs[i]])),
      firstRequestMs: Object.fromEntries(bucketNames(FIRST_REQUEST_BUCKETS_MS).map((n, i) => [n, c.firstRequestMs[i]])),
    });
    return { mode: disabled ? "disabled-after-error" : "observe", since, open, peakOpen, accepted, local: out(classes.local), lan: out(classes.lan), ...extra };
  }

  const api = { attach, onConnection, onRequest, snapshot };
  return api;
}

module.exports = { createConnectionStats, classifyPeer, LIFETIME_BUCKETS_MS, FIRST_REQUEST_BUCKETS_MS };
