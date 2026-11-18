// #142: the fake sd-server (api-contract/fake-sd-server.cjs) records its own start, listen result and exit, so an
// unexplained start-up exit in the engine tests says whether the port was taken. Test-only fixture behaviour.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const FIXTURE = path.join(__dirname, "api-contract", "fake-sd-server.cjs");

// Runs a copy of the fixture in its own temp folder (its record is written next to it); bounded to 10 s.
function runFake(dir, port, { until } = {}) {
  const script = path.join(dir, "sd.cjs");
  fs.copyFileSync(FIXTURE, script);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, "--model", path.join(dir, "sd1-q4_0.gguf"), "--listen-port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), 10000);
    p.stdout.on("data", (d) => { out += d; if (until && until.test(out)) p.kill("SIGTERM"); });
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code, signal) => {
      clearTimeout(kill);
      const records = fs.existsSync(path.join(dir, "fake-sd-diag.jsonl"))
        ? fs.readFileSync(path.join(dir, "fake-sd-diag.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      resolve({ code, signal, out, err, records, pid: p.pid });
    });
  });
}

test("fake sd-server (#142): a taken port is reported (listen error, port, holders) and exits 1 during start-up, as before", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-fake-sd-diag-"));
  const holder = net.createServer();
  try {
    await new Promise((r) => holder.listen(0, "127.0.0.1", r));
    const port = holder.address().port;
    const r = await runFake(dir, port);
    assert.equal(r.code, 1, `exit code (stderr ${r.err})`);
    assert.match(r.err, new RegExp(`\\[ERROR\\] fake: listen on 127\\.0\\.0\\.1:${port} failed: EADDRINUSE \\(pid ${r.pid}, ppid ${process.pid}\\)`));
    assert.doesNotMatch(r.out, /listening on/, "never reported READY");
    const kinds = r.records.map((x) => x.e);
    assert.deepEqual(kinds, ["start", "listen-error", "exit"], JSON.stringify(r.records));
    const [start, failed, exit] = r.records;
    assert.equal(start.pid, r.pid); assert.equal(start.ppid, process.pid); assert.equal(start.port, port);
    assert.equal(failed.code, "EADDRINUSE"); assert.equal(failed.port, port);
    assert.equal(typeof failed.holders, "string", "the port's holders are recorded (or why they could not be)");
    assert.equal(exit.code, 1);
  } finally { holder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("fake sd-server (#142): a free port records start and listening with the actual address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-fake-sd-diag-"));
  try {
    const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
    const r = await runFake(dir, port, { until: /listening on/ });
    assert.match(r.out, new RegExp(`listening on: 127\\.0\\.0\\.1:${port}`));
    const kinds = r.records.map((x) => x.e);
    assert.deepEqual(kinds.slice(0, 2), ["start", "listening"], JSON.stringify(r.records));
    assert.equal(r.records[1].address.port, port);
    assert.equal(r.records[1].address.address, "127.0.0.1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
