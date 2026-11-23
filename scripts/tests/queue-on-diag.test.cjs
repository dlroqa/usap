// #179 queue-on observation description (fixtures/queue-on-diag.cjs): message-only helper; these tests pin what it
// reports, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeQueueOnObservation } = require("./fixtures/queue-on-diag.cjs");

const T = 50000;
const base = {
  t0: T, sent: [T + 1, T + 152, T + 303], observedAt: T + 705,
  rs: { engines: { image: { queue: { running: 0, waiting: 0, limit: 2, known: true } } } },
  samples: [{ t: T + 2, running: 0, waiting: 0, known: true, engineRequests: 0, engineCompleted: 0, engineAborted: 0 }, { t: T + 160, running: 1, waiting: 0, known: true, engineRequests: 1, engineCompleted: 0, engineAborted: 0 }],
  diag: [{ e: "start", pid: 7, t: T - 3000 }, { e: "listening", pid: 7, t: T - 2900 }, { e: "exit", pid: 7, t: T + 400, code: 1 }],
  log: "[backend] Image backend is not reachable: connect ECONNREFUSED 127.0.0.1:10086 at C:\\Users\\x\\y\n[other] ignored\n[backend] restarted /home/runner/app",
};

test("queue-on observation: counts, send and answer times, samples and engine lifecycle in one line", () => {
  const results = [{ status: 502, ms: 380, doneAt: T + 381, json: { error: "Image backend is not reachable: socket hang up ECONNRESET" } }, { status: 200, ms: 3000, doneAt: T + 3152 }, undefined];
  const s = describeQueueOnObservation({ ...base, results });
  assert.match(s, /^queue at 705 ms: running 0 waiting 0 limit 2 known true \(expected running 1 waiting 2\)/);
  assert.match(s, /requests 0: sent 1, HTTP 502 at 381; studio error words ECONNRESET,socket hang up,not reachable \| 1: sent 152, HTTP 200 at 3152 \| 2: sent 303, not settled/);
  assert.match(s, /answered before the observation 1 of 3/);
  assert.match(s, /samples \(t: running\|waiting, engine requests\|completed\|aborted\) 2: 0\/0, 0\/0\/0; 160: 1\/0, 1\/0\/0/);
  assert.match(s, /engine processes 1: \[start@-3000 listening@-2900 exit 1@400\]/);
  assert.match(s, /server backend lines .*ECONNREFUSED/);
});

test("queue-on observation: missing records are said, not guessed", () => {
  const s = describeQueueOnObservation({ t0: T, observedAt: T + 700, rs: null });
  assert.match(s, /^queue at 700 ms: \/api\/resources gave no engine queue; requests none; answered before the observation 0 of 0; samples .* none; engine records: unavailable; server backend lines none$/);
  assert.match(describeQueueOnObservation({ ...base, results: [{ error: "ECONNRESET", ms: 5, doneAt: T + 6 }] }), /0: sent 1, client error ECONNRESET at 6/);
});

test("queue-on observation: bounded, no paths, addresses, bodies or prompts", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ t: T + i, running: 1, waiting: 2, engineRequests: i }));
  const long = "[backend] " + "x/y ".repeat(500);
  const s = describeQueueOnObservation({ ...base, samples: many, log: long.repeat(20), results: [{ status: 500, ms: 1, doneAt: T + 2, json: { error: "prompt: a secret cat at /home/u/p", detail: "x" } }] });
  assert.ok(s.length <= 2400);
  assert.doesNotMatch(s, /[\\/][a-z]|127\.0\.0\.1|secret|cat/);
  assert.equal((s.match(/: 1\/2,/g) || []).length, 12, "at most 12 samples");
});
