// #170 diagnostics: the image-replacement description (fixtures/port-diag.cjs). Message-only helper; these tests pin
// what it reports, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeImageReplacement, parseHolders } = require("./fixtures/port-diag.cjs");

const PORT = 21147, OLD = 500, NEW = 600, T0 = 100000;
const lsof = (rows) => ["COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME", ...rows].join("\n");
const base = (holders, extra = {}) => ({
  t0: T0, port: PORT, oldPid: OLD, oldAlive: false, maxImage: 1, slot: { phase: "loading", counts: { unconfirmed: 0 } },
  checks: [{ port: PORT, result: "free", t: T0 + 40 }],
  diag: [
    { e: "start", pid: OLD, port: PORT, t: T0 - 5000 }, { e: "exit", pid: OLD, t: T0 + 20 },
    { e: "start", pid: NEW, port: PORT, t: T0 + 60 }, { e: "listen-error", pid: NEW, code: "EADDRINUSE", port: PORT, t: T0 + 180, holders },
  ],
  ...extra,
});

test("port-diag: the old engine still listening reads as delayed release by the old engine", () => {
  const s = describeImageReplacement(base(lsof([`node      ${OLD} runner   21u  IPv4 0x1      0t0  TCP 127.0.0.1:${PORT} (LISTEN)`])));
  assert.match(s, /server checks of 21147 after the request 40:free/);
  assert.match(s, /old engine exit record 20; old PID running now false/);
  assert.match(s, /replacement start 60; listen error EADDRINUSE 180/);
  assert.match(s, /last free check before the bind 40 \(140 ms before the error\)/);
  assert.match(s, new RegExp(`holders after the error \\(lookup may miss a holder already gone\\) node/${OLD} old engine local LISTEN`));
  assert.match(s, /reading: the old engine was still listening after its exit was confirmed: consistent with delayed release/);
  assert.doesNotMatch(s, /runner|127\.0\.0\.1/, "no user names or addresses");
});

test("port-diag: another listener, connection states only, nothing seen, unavailable", () => {
  assert.match(describeImageReplacement(base(lsof([`python3   777 runner   3u  IPv4 0x2      0t0  TCP 127.0.0.1:${PORT} (LISTEN)`]))),
    /python3\/777 other local LISTEN; reading: another process was listening on the port: consistent with concurrent ownership \(identity not established\)/);
  assert.match(describeImageReplacement(base(lsof([`node      42 runner   30u  IPv4 0x3      0t0  TCP 127.0.0.1:53000->127.0.0.1:${PORT} (TIME_WAIT)`]))),
    /node\/42 other remote TIME_WAIT; reading: no listener seen, only connection states on the port: consistent with a selection-to-bind race .* or platform bind behaviour; not decided/);
  assert.match(describeImageReplacement(base("unavailable: no process found")), /holders after the error \(lookup may miss a holder already gone\) none; reading: nothing seen on the port after the error/);
  assert.match(describeImageReplacement(base("unavailable: ENOENT")), /holders after the error .* unavailable; reading: holder lookup unavailable: no reading/);
});

test("port-diag: a passing replacement, a busy port, and no free check before the bind", () => {
  const ok = base(""); ok.diag = ok.diag.slice(0, 3).concat({ e: "listening", pid: NEW, t: T0 + 150 });
  assert.match(describeImageReplacement(ok), /listening 150; most image engines at once 1; slot unconfirmed exits 0 phase loading; reading: the replacement bound its port$/);
  const busy = base(""); busy.checks = [{ port: PORT, result: "EADDRINUSE", t: T0 + 40 }, { port: 28088, result: "free", t: T0 + 5100 }];
  busy.diag = busy.diag.slice(0, 2);
  const s = describeImageReplacement(busy);
  assert.match(s, /server checks of 21147 after the request 40:EADDRINUSE; checks of other ports 28088@5100:free/);
  assert.match(s, /replacement start none recorded; no bind result recorded/);
  const noFree = base("unavailable: no process found"); noFree.checks = [];
  assert.match(describeImageReplacement(noFree), /server checks of 21147 after the request none recorded.*reading: no free check of this port was recorded before the bind/);
});

test("port-diag: netstat lines (Windows) are parsed; output stays bounded", () => {
  const h = parseHolders(`  TCP    127.0.0.1:${PORT}      0.0.0.0:0      LISTENING       4321\n  TCP    127.0.0.1:5000   127.0.0.1:${PORT}  ESTABLISHED  99`, PORT);
  assert.deepEqual(h.list, [{ cmd: "?", pid: 4321, side: "local", state: "LISTENING" }, { cmd: "?", pid: 99, side: "remote", state: "ESTABLISHED" }]);
  const many = lsof(Array.from({ length: 60 }, (_, i) => `node      ${1000 + i} someone   3u  IPv4 0x2  0t0  TCP 127.0.0.1:${PORT}->127.0.0.1:${50000 + i} (ESTABLISHED)`));
  const o = base(many); o.checks = Array.from({ length: 80 }, (_, i) => ({ port: PORT, result: "free", t: T0 + i }));
  const s = describeImageReplacement(o);
  assert.ok(s.length < 1600, `bounded (${s.length})`);
  assert.match(s, /server checks of 21147 after the request 0\.\.79:free x80/, "runs compressed");
  const alt = base(""); alt.checks = Array.from({ length: 30 }, (_, i) => ({ port: PORT, result: i % 2 ? "free" : "EADDRINUSE", t: T0 + i }));
  assert.match(describeImageReplacement(alt), /,\.\.\. \(30 runs\)/, "at most 10 runs shown");
  assert.doesNotMatch(s, /someone|[\\/][\w.-]+[\\/]/, "no user names or paths");
  assert.equal(parseHolders(undefined, PORT).status, "none");
});
