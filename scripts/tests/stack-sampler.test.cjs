// Controls for the #151 opt-in main-thread stack sampler (fixtures/stack-sampler.cjs; messages only). `sample` output
// is reduced to the main thread's leaf frames without addresses or paths; the sampler is confirmed running before the
// caller goes on, and a sampler that cannot start, or a platform without one, is reported instead of blocking; the
// json-413 client process reports the summary only when asked and is otherwise unchanged. A stand-in `sample`
// (a Node script) is used here; sudo is never used by these controls.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { startStackSampler, parseMainThread, cleanFrame } = require("./fixtures/stack-sampler.cjs");

const SAMPLE_TEXT = `Analysis of sampling node (pid 4242) every 10 milliseconds
Process:         node [4242]
Path:            /Users/runner/hostedtoolcache/node/22.12.0/x64/bin/node

Call graph:
    300 Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)
    + 300 start  (in dyld) + 1942  [0x7ff80a1b641e]
    +   300 node::Start(int, char**)  (in node) + 1234  [0x10a0b1c2d]
    +     290 uv_run  (in node) + 400  [0x10a1b2c3d]
    +     ! 200 uv__io_poll  (in node) + 1000  [0x10a1b2c3e]
    +     ! : 180 kevent  (in libsystem_kernel.dylib) + 10  [0x7ff80a4b5c6d]
    +     ! 70 uv__write  (in node) + 99  [0x10a1b2c40]
    +     ! : 70 write  (in libsystem_kernel.dylib) + 10  [0x7ff80a4b5c70]
    +     10 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace)  (in node) + 5  [0x10a000001]
    300 Thread_101
    + 300 thread_start  (in libsystem_pthread.dylib) + 15  [0x7ff80a4eebef]
    +   300 __psynch_cvwait  (in libsystem_kernel.dylib) + 10  [0x7ff80a4b5c71]

Total number in stack (recursive counted multiple, when >=5):
`;

test("parse: main thread only, exclusive leaf counts, sorted; no addresses or paths", () => {
  const p = parseMainThread(SAMPLE_TEXT);
  assert.equal(p.isMain, true); assert.equal(p.total, 300);
  // exclusive = own count minus children: uv_run 290-(200+70) = 20, uv__io_poll 200-180 = 20, node::Start 300-(290+10) = 0
  assert.deepEqual(p.leaves, [["kevent (libsystem_kernel.dylib)", 180], ["write (libsystem_kernel.dylib)", 70], ["uv_run (node)", 20], ["uv__io_poll (node)", 20], ["v8::internal::Heap::CollectGarbage(v8::internal::Allocati... (node)", 10]]);
  assert.ok(!JSON.stringify(p).includes("__psynch_cvwait"), "other threads are not counted");
  assert.ok(!/0x|\/Users/.test(JSON.stringify(p)));
  assert.equal(cleanFrame("foo  (in /usr/lib/libx.dylib) + 3  [0x1]"), "foo (libx.dylib)");
  assert.equal(parseMainThread("no graph here"), null);
});

function fakeSample(dir, { start = true, seconds = 1 } = {}) {
  const f = path.join(dir, `fake-sample-${start ? "ok" : "fail"}.cjs`);
  fs.writeFileSync(f, `#!${process.execPath}\nconst a=process.argv.slice(2);const file=a[a.indexOf("-file")+1];\n${start
    ? `console.log("Sampling process "+a[0]+" for "+a[1]+" seconds with "+a[2]+" milliseconds of run time between samples");setTimeout(()=>{require("fs").writeFileSync(file,${JSON.stringify(SAMPLE_TEXT)});process.exit(0)},${seconds * 1000});`
    : `console.error("sample cannot examine process "+a[0]+" for unknown reasons");process.exit(1);`}\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

test("sampler: confirmed running before the caller goes on, then summarized; a failing sampler is reported; non-macOS not run", { skip: process.platform === "win32" && "a script stand-in needs a POSIX shebang" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-stack-"));
  try {
    const s = startStackSampler({ pid: process.pid, seconds: 1, intervalMs: 10, platform: "darwin", sampleBin: fakeSample(dir), allowSudo: false });
    assert.deepEqual(await s.ready, { ok: true, how: "sample" });
    const line = await s.finish();
    assert.match(line, /^sample 10 ms x 1 s; main thread 300 samples; leaf frames: kevent \(libsystem_kernel\.dylib\) 180, write \(libsystem_kernel\.dylib\) 70/);
    const f = startStackSampler({ pid: process.pid, seconds: 1, platform: "darwin", sampleBin: fakeSample(dir, { start: false }), allowSudo: false });
    const r = await f.ready;
    assert.equal(r.ok, false); assert.match(r.reason, /sample exited 1: sample cannot examine process/);
    assert.match(await f.finish(), /^unavailable \(sample exited 1/);
    const n = startStackSampler({ platform: "linux" });
    assert.deepEqual(await n.ready, { ok: false, reason: "not macOS" });
    assert.equal(await n.finish(), "not run (not macOS)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("client process: without stackSample the output has no stack field; with it (not macOS here) it reports not run", async () => {
  const net = require("node:net");
  const srv = net.createServer((c) => { c.on("error", () => {}); c.end("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const run = (extra) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "fixtures", "refusal-clients.cjs"), JSON.stringify({ port: srv.address().port, n: 1, opts: { url: "/x", mode: "silent", maxMs: 3000 }, cpuDiag: true, ...extra })], { encoding: "utf8" }));
  try {
    const a = run({});
    assert.equal("stack" in a.proc, false);
    const b = run({ stackSample: { seconds: 1, intervalMs: 10 } });
    assert.equal(b.proc.stack, process.platform === "darwin" ? b.proc.stack : "not run (not macOS)");
    assert.deepEqual(Object.keys(b.clients[0]).sort(), Object.keys(a.clients[0]).sort());
  } finally { await new Promise((r) => srv.close(r)); }
});
