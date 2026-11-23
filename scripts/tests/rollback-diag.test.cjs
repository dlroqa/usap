// Image-queue rollback diagnostics (fixtures/rollback-diag.cjs): message-only helper; these tests pin what it
// reports, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeRollbackFailures, errorWords } = require("./fixtures/rollback-diag.cjs");

const T0 = 50000;
const ok = (ms) => ({ status: 200, ms, json: { images: ["x"] } });

test("rollback-diag: a 502 from the studio's proxy keeps only the error's code words", () => {
  const results = [ok(3010), { status: 502, ms: 41, json: { ok: false, error: "Image backend is not reachable: read ECONNRESET" } }, ok(3020), ok(3031)];
  const diag = [{ e: "start", pid: 7, t: T0 - 4000 }, { e: "listening", pid: 7, t: T0 - 3900 }, { e: "exit", pid: 7, code: 0, t: T0 + 40 },
    { e: "start", pid: 8, t: T0 + 60 }, { e: "listen-error", pid: 8, code: "EADDRINUSE", t: T0 + 90 }];
  const log = "  [backend] Starting: sd --listen-port 21003 --model C:\\Users\\runner\\AppData\\Local\\Temp\\usap-contract-1\\app\\models\\x.gguf\n  [backend] exited with code 0 (process 1): requested\nother line";
  const s = describeRollbackFailures(results, { t0: T0, diag, stats: { requests: 3, completed: 3 }, log });
  assert.match(s, /^1 of 4 not 200; answers 0:200@3010,1:502@41,2:200@3020,3:200@3031; request 1: HTTP 502 after 41 ms; studio error words ECONNRESET,not reachable/);
  assert.match(s, /engine processes 2: \[start@-4000 listening@-3900 exit 0@40\] \[start@60 listen-error EADDRINUSE@90\]/);
  assert.match(s, /engine stats requests 3 completed 3/);
  assert.match(s, /server backend lines backend Starting: sd --listen-port 21003 --model \| backend exited with code 0 process 1 : requested$/);
  assert.doesNotMatch(s, /Users|runner|Temp|[\\/]/, "no paths or user names");
});

test("rollback-diag: client errors, missing records and the bound", () => {
  const s = describeRollbackFailures([{ error: "ECONNRESET", ms: 5 }, ok(3000)], { t0: T0, diag: null, stats: null, log: "" });
  assert.match(s, /^1 of 2 not 200; answers 0:ECONNRESET@5,1:200@3000; request 0: client error ECONNRESET after 5 ms; studio error words none; engine records: unavailable; engine stats: unavailable; server backend lines none$/);
  const many = Array.from({ length: 40 }, (_, i) => ({ status: 502, ms: i, json: { error: `Image backend is not reachable: connect ECONNREFUSED 127.0.0.1:${20000 + i}` } }));
  const long = describeRollbackFailures(many, { t0: T0, diag: [], log: Array.from({ length: 100 }, () => "[backend] x".repeat(50)).join("\n") });
  assert.ok(long.length <= 2400, `bounded (${long.length})`);
  assert.doesNotMatch(long, /127\.0\.0\.1/);
  assert.equal(errorWords("socket hang up"), "socket hang up");
  assert.equal(errorWords(undefined), "none");
});
