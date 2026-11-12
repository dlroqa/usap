// services/chat-queue.cjs — bounded chat queue (Step 9.9c, docs/roadmap/STEP9_9_SCHEDULING.md, owner decision A).
//
// One chat request runs at a time (the text engine is started with --parallel 1, so it serves one request at a
// time anyway). At most `limit` (4) more wait behind it, first in, first out. When the queue is full a new request
// is refused at once with 429 QUEUE_FULL and a Retry-After estimate; a request that waits longer than `maxWaitMs`
// is refused with 503 QUEUE_TIMEOUT, so nothing waits indefinitely. A waiting request whose client disconnects
// leaves the queue at once and never reaches the engine.
//
// Off by default (`chatQueue: "off"`): the studio then behaves exactly as before 9.9c. Turning it on needs the
// owner's approval; see the settings in scheduler.cjs.
"use strict";

const DEFAULT_SERVICE_MS = 10000;

/**
 * @param {object} [o]
 * @param {number} [o.limit]      waiting requests allowed behind the running one (4)
 * @param {number} [o.maxWaitMs]  longest wait in the queue before QUEUE_TIMEOUT (10 minutes)
 * @param {() => number} [o.now]
 * @param {(fn: Function, ms: number) => any} [o.setTimer]
 * @param {(t: any) => void} [o.clearTimer]
 */
function createChatQueue({ limit = 4, maxWaitMs = 10 * 60 * 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = 0;
  const waiting = []; // { grant, refuse, timer, cancelled }
  let avgServiceMs = DEFAULT_SERVICE_MS;
  let served = 0;

  const retryAfterSeconds = (ahead) => Math.max(1, Math.min(120, Math.ceil((avgServiceMs * (ahead + 1)) / 1000)));

  function grantNext() {
    while (running === 0 && waiting.length) {
      const entry = waiting.shift();
      if (entry.cancelled) continue;
      clearTimer(entry.timer);
      entry.grant();
    }
  }

  /** A slot for one request. Call release() exactly once when its response has ended or closed. */
  function start() {
    running += 1;
    const startedAt = now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running -= 1;
      const took = Math.max(0, now() - startedAt);
      served += 1;
      avgServiceMs = served === 1 ? took || DEFAULT_SERVICE_MS : Math.round(avgServiceMs * 0.7 + took * 0.3);
      grantNext();
    };
  }

  /**
   * Ask for a turn. `onClientGone(cb)` must call cb if the client disconnects while waiting.
   * Resolves to { ok: true, release } or { ok: false, status, code, retryAfterSeconds, error }.
   */
  function admit(onClientGone) {
    if (running === 0 && waiting.length === 0) return Promise.resolve({ ok: true, release: start() });
    if (waiting.length >= limit) {
      const s = retryAfterSeconds(waiting.length);
      return Promise.resolve({ ok: false, status: 429, code: "QUEUE_FULL", retryAfterSeconds: s,
        error: `The text engine is busy: ${limit} requests are already waiting. Try again in about ${s} s.` });
    }
    return new Promise((resolve) => {
      const entry = { cancelled: false };
      entry.grant = () => resolve({ ok: true, release: start() });
      entry.timer = setTimer(() => {
        entry.cancelled = true;
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        const s = retryAfterSeconds(waiting.length);
        resolve({ ok: false, status: 503, code: "QUEUE_TIMEOUT", retryAfterSeconds: s,
          error: `This request waited more than ${Math.round(maxWaitMs / 1000)} s for the text engine. Try again in about ${s} s.` });
      }, maxWaitMs);
      waiting.push(entry);
      onClientGone(() => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        clearTimer(entry.timer);
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        resolve({ ok: false, status: 0, code: "CLIENT_GONE" });
      });
    });
  }

  return { admit, stats: () => ({ running, waiting: waiting.length, limit }) };
}

module.exports = { createChatQueue };
