// Record API fixtures from a real serve.cjs (no models installed) and
// normalise anything machine-specific (paths, hostnames, hardware, clocks),
// so fixtures are deterministic and contain no local data.
//   node scripts/record-fixtures.mjs        (needs app/dist built)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_ENDPOINTS, fixtureFileFor } from "../support/endpoints.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(here, "..", "fixtures", "api");

const FIXED_TIME = "2026-01-01T12:00:00.000Z";
const KEY_OVERRIDES = {
  os_name: "Linux (fixture)", platform: "linux", arch: "x64", hostname: "studio-host",
  cpu_name: "Fixture CPU", cpu_cores_physical: 8, cpu_cores_logical: 16,
  ram_total_gb: 16, ram_used_gb: 6.2, ram_free_gb: 9.8, cpu_usage: 12,
  gpu_name: "Fixture GPU", gpu_vram_gb: 8, vram_used_gb: 0, vram_total_gb: 8,
  totalMemory: 17179869184, freeMemory: 10522669056, uptime: 3600, pid: 4242,
  nodeVersion: "v22.12.0", node: "v22.12.0", cpus: 16,
};
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function normalize(value, key, ctx) {
  if (Object.hasOwn(KEY_OVERRIDES, key ?? "") && typeof value !== "object") return KEY_OVERRIDES[key];
  if (typeof value === "string") {
    if (ISO_RE.test(value)) return FIXED_TIME;
    let s = value.split(ctx.root).join("/studio").split(ctx.home).join("/home/user").split(ctx.host).join("studio-host");
    if (ctx.cpu) s = s.split(ctx.cpu).join("Fixture CPU");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, undefined, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k, ctx)]));
  }
  return value;
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, "scripts/server/serve.cjs")], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const ctx = { root, home: os.homedir(), host: os.hostname(), cpu: os.cpus()[0]?.model?.trim() };
    fs.mkdirSync(outDir, { recursive: true });
    for (const endpoint of FIXTURE_ENDPOINTS) {
      const res = await fetch(base + endpoint);
      const body = normalize(await res.json(), undefined, ctx);
      const text = JSON.stringify(body, null, 2) + "\n";
      for (const leak of [ctx.root, ctx.home, ctx.host]) {
        if (leak && text.includes(leak)) throw new Error(`fixture for ${endpoint} still contains local data`);
      }
      fs.writeFileSync(path.join(outDir, fixtureFileFor(endpoint)), text);
      console.log(`recorded ${endpoint} (${res.status})`);
    }
  } finally {
    server.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
