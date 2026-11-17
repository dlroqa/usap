// Bench-only (#142): add observation to the R2 test. The assertions stay exactly as they were; on the point of
// failure the state is recorded first, then the original assertion runs. Usage: node patch-r2.cjs <engine-slot.test.cjs>
"use strict";
const fs = require("fs");
const file = process.argv[2];
let s = fs.readFileSync(file, "utf8");
const start = s.indexOf('test("R2 (slot on): four image loads at once');
const end = s.indexOf("\ntest(", start + 10);
if (start < 0 || end < 0) throw new Error("R2 not found");
let block = s.slice(start, end);
const before = block;
block = block.replace(
  "const rs = await Promise.all([4, 5, 6, 7].map((steps) => imageLoad(srv, \"sd1-img-q4_0.gguf\", { steps })));",
  "const T0 = Date.now(); const rs = await Promise.all([4, 5, 6, 7].map((steps) => imageLoad(srv, \"sd1-img-q4_0.gguf\", { steps }).then((r) => ({ ...r, at: Date.now() - T0 })))); globalThis.__r2 = { T0, statuses: rs.map((r) => [r.status, r.at, String(r.text).slice(0, 120)]) };");
block = block.replace(
  "    const live = await engines(srv);\n    assert.equal(live.length, 1);",
  `    const live = await engines(srv);
    {
      const snap = async (label) => {
        const diag = (await request(srv.port, "GET", "/api/diagnostics")).json;
        const ps = require("child_process").spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,etime=,args="], { encoding: "utf8" }).stdout.split("\\n").filter((l) => l.includes(srv.root));
        return { label, t: Date.now() - globalThis.__r2.T0, engines: await engines(srv), slot: (await resources(srv)).engineSlot, supervised: diag && diag.engines && diag.engines.processes && diag.engines.processes.supervised, backend: await backendStatus(srv).catch(() => null), ps };
      };
      const rec = { ...globalThis.__r2, liveAtCheck: live.length, snaps: [await snap("at-check")] };
      if (live.length !== 1) {
        const until = Date.now() + 10000;
        while (Date.now() < until) { await sleep(500); const x = await snap("after"); rec.snaps.push(x); if (x.engines.length === 1) break; }
      }
      require("fs").appendFileSync(process.env.DIAG142 || "diag142.jsonl", JSON.stringify(rec) + "\\n");
    }
    assert.equal(live.length, 1);`);
if (block === before || !block.includes("DIAG142") || !block.includes("__r2 = {")) throw new Error("patch did not apply");
s = s.slice(0, start) + block + s.slice(end);
fs.writeFileSync(file, s);
console.log("patched R2 in", file);
