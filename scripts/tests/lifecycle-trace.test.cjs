// Controls for the #170 R1b/R5 diagnostics (fixtures/port-trace-preload.cjs, fixtures/lifecycle-trace.cjs; messages
// only): the preload records a free and a busy bind and changes nothing about them (a server without an "error"
// listener still crashes), ignores other ports and does nothing without its variable; holder lines from Windows
// netstat and macOS lsof read as state, side and role; the line maps processes to roles and never prints process
// ids, port numbers, paths or addresses.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { portTraceEnv, createLifecycleTrace, describeLifecycle, parseHolders, PRELOAD } = require("./fixtures/lifecycle-trace.cjs");

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-lctrace-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const readAll = (f) => { try { return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const BIND = new Set(["listen-attempt", "listening", "listen-error", "closed"]);
const readJsonl = (f) => readAll(f).filter((r) => BIND.has(r.ev)); // bind records only
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
// A child Node process with the preload (through NODE_OPTIONS, as the tests set it) that listens on `port`.
function child(port, traceFile, { withErrorListener = true, env = {} } = {}) {
  const code = `const s=require("node:net").createServer();${withErrorListener ? "s.on('error',e=>{console.log('error '+e.code);process.exit(3)});" : ""}s.listen(${port},"127.0.0.1",()=>{console.log("listening");s.close(()=>process.exit(0))});`;
  return spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 20000, env: { ...process.env, SD_BACKEND_PORT: String(port), ...(traceFile ? portTraceEnv(traceFile) : {}), ...env } });
}

test("preload: a free bind is recorded as attempt, listening, closed; a busy one as its error code; outcomes unchanged", async () => {
  const port = await freePort();
  const f1 = path.join(dir, "free.jsonl");
  const r1 = child(port, f1);
  assert.equal(r1.status, 0, r1.stderr); assert.match(r1.stdout, /listening/);
  assert.deepEqual(readJsonl(f1).map((x) => `${x.ev} ${x.port}`), ["listen-attempt preferred", "listening preferred", "closed preferred"]);
  const blocker = net.createServer().listen(port, "127.0.0.1"); await new Promise((r) => blocker.once("listening", r));
  try {
    const f2 = path.join(dir, "busy.jsonl");
    const r2 = child(port, f2);
    assert.equal(r2.status, 3); assert.match(r2.stdout, /error EADDRINUSE/);
    assert.deepEqual(readJsonl(f2).map((x) => `${x.ev} ${x.port} ${x.code || ""}`.trim()), ["listen-attempt preferred", "listen-error preferred EADDRINUSE"]);
    // control: without an "error" listener the process still dies of the unhandled error, as without the preload
    const r3 = child(port, path.join(dir, "busy3.jsonl"), { withErrorListener: false });
    const r4 = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${port},"127.0.0.1")`], { encoding: "utf8", timeout: 20000 });
    assert.notEqual(r3.status, 0); assert.equal(r3.status, r4.status); assert.match(r3.stderr, /EADDRINUSE/);
  } finally { await new Promise((r) => blocker.close(r)); }
});

test("preload: other ports are not recorded; without USAP_TEST_PORT_TRACE nothing is written", async () => {
  const port = await freePort();
  const f = path.join(dir, "other.jsonl");
  const r = child(port, f, { env: { SD_BACKEND_PORT: String(port === 1 ? 2 : 1) } });
  assert.equal(r.status, 0); assert.deepEqual(readJsonl(f), []);
  const g = path.join(dir, "off.jsonl");
  const r2 = spawnSync(process.execPath, ["--require", PRELOAD, "-e", `require("node:net").createServer().listen(${port},"127.0.0.1",function(){this.close()})`], { encoding: "utf8", env: { ...process.env, SD_BACKEND_PORT: String(port), USAP_TEST_PORT_TRACE: "" } });
  assert.equal(r2.status, 0); assert.equal(fs.existsSync(g), false);
});

test("holders: Windows netstat and macOS lsof lines read as state, side and pid; unavailable stays a short word", () => {
  const win = "  TCP    127.0.0.1:21147        0.0.0.0:0              LISTENING       4242\n  TCP    127.0.0.1:21147        127.0.0.1:50000        TIME_WAIT       0\n  TCP    127.0.0.1:50001        127.0.0.1:21147        ESTABLISHED     77";
  assert.deepEqual(parseHolders(win, 21147).rows, [{ state: "LISTENING", pid: 4242, side: "local" }, { state: "TIME_WAIT", pid: 0, side: "local" }, { state: "ESTABLISHED", pid: 77, side: "remote" }]);
  const mac = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 runner 22u IPv4 0x1 0t0 TCP 127.0.0.1:21147 (LISTEN)\nnode 77 runner 23u IPv4 0x2 0t0 TCP 127.0.0.1:50001->127.0.0.1:21147 (ESTABLISHED)";
  assert.deepEqual(parseHolders(mac, 21147).rows, [{ state: "LISTEN", pid: 4242, side: "local" }, { state: "ESTABLISHED", pid: 77, side: "remote" }]);
  assert.equal(parseHolders("unavailable: no process found", 1).unavailable, "unavailable: no process found");
});

test("line: roles in order, stand-in bind failure with its holders by role; no pids, ports, paths or addresses", () => {
  const t0 = 1_000_000, port = 21147;
  const trace = path.join(dir, "line-trace.jsonl"), sd = path.join(dir, "line-sd.jsonl");
  const w = (f, rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  w(trace, [
    { t: t0 + 10, pid: 500, ppid: 1, ev: "listen-attempt", id: 1, port: "preferred" }, { t: t0 + 11, pid: 500, ppid: 1, ev: "listening", id: 1, port: "preferred" }, { t: t0 + 11, pid: 500, ppid: 1, ev: "closed", id: 1, port: "preferred" },
    { t: t0 + 60, pid: 500, ppid: 1, ev: "listen-attempt", id: 2, port: "preferred" }, { t: t0 + 61, pid: 500, ppid: 1, ev: "listening", id: 2, port: "preferred" }, { t: t0 + 61, pid: 500, ppid: 1, ev: "closed", id: 2, port: "preferred" },
    { t: t0 + 300, pid: 902, ppid: 802, ev: "listen-attempt", id: 1, port: "preferred" }, { t: t0 + 302, pid: 902, ppid: 802, ev: "listen-error", id: 1, port: "preferred", code: "EADDRINUSE" },
  ]);
  w(sd, [
    { e: "start", t: t0 + 100, pid: 901, ppid: 801, port, model: "m" },
    { e: "start", t: t0 + 290, pid: 902, ppid: 802, port, model: "m" },
    { e: "listen-error", t: t0 + 303, pid: 902, code: "EADDRINUSE", port, holders: `  TCP    127.0.0.1:${port}        0.0.0.0:0              LISTENING       901` },
  ]);
  let now = t0;
  const st = createLifecycleTrace({ traceFile: trace, standInDiagFile: sd, now: () => now, alive: (pid) => pid !== 801 });
  now = t0 + 120; st.onDiagnostics({ engines: { processes: { supervised: [{ label: "image", guardPid: 701, enginePid: 801 }], recentExits: [] } } });
  now = t0 + 280; st.onDiagnostics({ engines: { processes: { supervised: [{ label: "image", guardPid: 702, enginePid: 802 }], recentExits: [{ label: "image", enginePid: 801, code: 1, signal: null, at: new Date(t0 + 250).toISOString() }] } } });
  const line = describeLifecycle(st, { proc: { pid: 500 }, sdPort: port }, { testPid: 1 });
  assert.match(line, /^after the last restart-backend answer \(none written\): first loss 120 e1 gone \(first seen not alive\); roles: studio, g1 e1 g2 e2 s1 s2;/);
  assert.match(line, /10\.\.60 studio check preferred free x2/);
  assert.match(line, /250 supervisor exit recorded engine e1 code 1/);
  assert.match(line, /s2 listen-error EADDRINUSE preferred; holders LISTENING local s1/);
  assert.match(line, /100 s1 start \(parent e1\)/);
  assert.match(line, /120 e1 gone \(first seen not alive\)/);
  for (const bad of ["21147", "500", "701", "801", "901", "127.0.0.1", "\\"]) assert.ok(!line.includes(bad), `printed ${bad}: ${line}`);
});

test("preload: process start/exit by kind, the studio's guard spawn and its restart-backend answer, in order", async () => {
  const d = fs.mkdtempSync(path.join(dir, "roles-"));
  const f = path.join(d, "steps.jsonl");
  // a stand-in "studio" (serve.cjs) that spawns a stand-in guard (engine-guard.cjs) and answers POST /api/restart-backend
  fs.writeFileSync(path.join(d, "engine-guard.cjs"), "setTimeout(() => process.exit(0), 50);\n");
  fs.writeFileSync(path.join(d, "serve.cjs"), `const http=require("node:http");const {spawn}=require("node:child_process");
const s=http.createServer((req,res)=>{const g=spawn(process.execPath,[${JSON.stringify(path.join(d, "engine-guard.cjs"))}],{stdio:"ignore"});res.writeHead(200);res.end("{}");g.on("exit",()=>{s.close();});});
s.listen(0,"127.0.0.1",()=>{const r=http.request({host:"127.0.0.1",port:s.address().port,method:"POST",path:"/api/restart-backend"},(x)=>x.resume());r.end();});`);
  const r = spawnSync(process.execPath, [path.join(d, "serve.cjs")], { encoding: "utf8", timeout: 20000, env: { ...process.env, SD_BACKEND_PORT: "1", ...portTraceEnv(f) } });
  assert.equal(r.status, 0, r.stderr);
  const rows = readAll(f);
  const studio = rows.find((x) => x.ev === "process-start" && x.kind === "studio");
  const spawned = rows.find((x) => x.ev === "spawned" && x.what === "guard");
  const answer = rows.find((x) => x.ev === "answer");
  const guard = rows.find((x) => x.ev === "process-start" && x.kind === "guard");
  assert.ok(studio && spawned && answer && guard, JSON.stringify(rows));
  assert.equal(spawned.child, guard.pid, "the spawned child is the guard that started");
  assert.equal(answer.status, 200);
  assert.ok(spawned.t <= answer.t, "spawn recorded before the answer the handler wrote after it");
  assert.ok(rows.some((x) => x.ev === "process-exit" && x.kind === "guard" && x.code === 0));
});
