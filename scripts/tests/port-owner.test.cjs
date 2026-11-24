// #170 port evidence (scripts/ci/port-owner.cjs): a PASSIVE reader of who holds a TCP port, and the line describing a
// port's release after an engine's recorded exit. Test-only; never judged.
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const { portOwners, parseProcNet, parseNetstat, parseLsof, describePortRelease } = require("../ci/port-owner.cjs");

test("port owner: parsers for /proc/net/tcp, netstat -ano and lsof read state and owner of the right port only", () => {
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:52D2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:52D2 0100007F:C350 06 00000000:00000000 03:00000F5B 00000000     0        0 0 3 0000000000000000",
    "   2: 0100007F:52D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  assert.deepEqual(parseProcNet(proc, 21202), [{ state: "LISTEN", inode: "4242" }, { state: "TIME_WAIT", inode: "0" }]);
  const ns = ["Active Connections", "", "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:21202        0.0.0.0:0              LISTENING       3676",
    "  TCP    127.0.0.1:21202        127.0.0.1:50001        TIME_WAIT       0",
    "  TCP    127.0.0.1:212020       0.0.0.0:0              LISTENING       9"].join("\r\n");
  assert.deepEqual(parseNetstat(ns, 21202), [{ state: "LISTENING", pid: 3676 }, { state: "TIME_WAIT", pid: 0 }]);
  assert.deepEqual(parseLsof("p812\nf23\nTST=LISTEN\nTQR=0\np900\nf5\nTST=CLOSE_WAIT\n"), [{ state: "LISTEN", pid: 812 }, { state: "CLOSE_WAIT", pid: 900 }]);
});

test("port owner: release line — owner over time and whether an engine outlived its recorded exit", () => {
  const T = 1000, name = (p) => ({ 11: "engine e1", 21: "guard g1", 5: "studio server" }[p] || "another process");
  const listen = (pids) => ({ sockets: [{ state: "LISTEN", pids }] });
  const samples = [
    { t: T + 0, owners: listen([11]), alive: { 11: true } },
    { t: T + 250, owners: listen([11]), alive: { 11: true } },   // engine e1's exit is recorded at +131
    { t: T + 500, owners: listen([11]), alive: { 11: true } },
    { t: T + 750, owners: { sockets: [{ state: "TIME_WAIT", pids: [] }] }, alive: { 11: false } },
    { t: T + 1000, owners: { sockets: [] }, alive: { 11: false } },
  ];
  const s = describePortRelease({ t0: T, samples, exits: { 11: T + 131 }, name });
  assert.equal(s, "preferred port: 0: LISTEN by engine e1; 750: not listening, TIME_WAIT 1; 1000: not listening; engine e1 exit recorded 131: PID still alive in 2 later sample(s), last 500");
  const other = describePortRelease({ t0: T, samples: [{ t: T, owners: listen([]), alive: {} }, { t: T + 250, owners: { error: "ENOENT" }, alive: {} }], name });
  assert.match(other, /0: LISTEN by unknown owner; 250: unreadable ENOENT; no engine exits recorded/);
  assert.doesNotMatch(s, /\b(11|21)\b(?! later)/, "no raw process ids");
});

test("port owner: a real listener on this machine is read passively (owner = this process), then not listening", { skip: !["linux", "darwin", "win32"].includes(process.platform) }, async () => {
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const on = await portOwners(port);
  assert.ok(!on.error, JSON.stringify(on));
  const l = on.sockets.filter((x) => /^LISTEN/.test(x.state));
  assert.equal(l.length, 1, JSON.stringify(on));
  assert.ok(l[0].pids.includes(process.pid), `owner is this process (${JSON.stringify(l[0].pids)} vs ${process.pid})`);
  await new Promise((r) => srv.close(r));
  const off = await portOwners(port);
  assert.equal((off.sockets || []).filter((x) => /^LISTEN/.test(x.state)).length, 0, JSON.stringify(off));
  // reading never binds: the port can be listened on again right after a reading
  await portOwners(port); const again = net.createServer(); await new Promise((r, j) => again.once("error", j).listen(port, "127.0.0.1", r)); await new Promise((r) => again.close(r));
});
