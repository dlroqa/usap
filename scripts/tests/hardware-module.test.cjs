// Step 9.8e: services/hardware.cjs, tested with recorded system outputs for each supported platform
// (Linux x64, Windows x64, macOS arm64, macOS Intel) and GPU vendor. No real hardware is needed, and
// these tests do NOT show that any GPU or NPU works: they pin detection and report logic only.
// The real detection path runs in the native-runtime jobs (hosted CI runners, CPU only).
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createHardwareService } = require("../server/services/hardware.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

const GB = 1024 ** 3;

// ── A recorded machine ─────────────────────────────────────────────────────
function machine({
  platform, arch = "x64", cpuModel = "Test CPU", logical = 8, totalGb = 16, freeGb = 10,
  files = {}, exec: execMap = {}, spawn: spawnMap = {}, execFile: execFileMap = {}, backendPaths = {},
  execFileErr = {}, execFileHold = [], extraDeps = {}, // #197/#181 async GPU probe controls (additive)
}) {
  const calls = [];
  const cpu = (i) => ({ model: cpuModel, speed: 3000, times: { user: 100 + i, nice: 0, sys: 50, idle: 800, irq: 0 } });
  let cpus = Array.from({ length: logical }, (_, i) => cpu(i));
  const os = {
    cpus: () => cpus, totalmem: () => totalGb * GB, freemem: () => freeGb * GB, arch: () => arch,
    type: () => ({ linux: "Linux", win32: "Windows_NT", darwin: "Darwin" }[platform]), release: () => "1.0",
    platform: () => platform,
  };
  const dirs = new Set();
  for (const f of Object.keys(files)) { let d = path.posix.dirname(f); while (d && d !== "/" && d !== ".") { dirs.add(d); d = path.posix.dirname(d); } }
  const fs = {
    existsSync: (p) => p in files || dirs.has(p),
    readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" }); return files[p]; },
    readdirSync: (p) => { if (!dirs.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" }); const out = new Set(); for (const f of [...Object.keys(files), ...dirs]) if (path.posix.dirname(f) === p) out.add(path.posix.basename(f)); return [...out]; },
    statSync: () => ({ size: 0, isFile: () => true, isDirectory: () => false }),
  };
  const lookup = (map, cmd) => { for (const [k, v] of Object.entries(map)) if (cmd.startsWith(k) || cmd.includes(k)) return v; return undefined; };
  const execSync = (cmd) => { calls.push(["execSync", cmd]); const v = lookup(execMap, cmd); if (v === undefined) throw new Error(`not found: ${cmd}`); return v; };
  const spawnSync = (cmd, args = []) => {
    const line = [cmd, ...args].join(" ");
    calls.push(["spawnSync", line]);
    const v = lookup(spawnMap, line);
    return v === undefined ? { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" } : { status: 0, stdout: v, stderr: "" };
  };
  const pending = [];
  const exec = (cmd, opts, cb) => {
    if (typeof opts === "function") { cb = opts; }
    calls.push(["exec", cmd]);
    const v = lookup(execMap, cmd);
    pending.push(() => (v === undefined ? cb(new Error(`not found: ${cmd}`), "", "") : cb(null, v, "")));
  };
  const execFileOpts = [], killed = [], held = [];
  const execFile = (file, args, opts, cb) => {
    calls.push(["execFile", [file, ...args].join(" ")]);
    execFileOpts.push({ file, opts });
    const v = execFileMap[file];
    const child = { kill: (sig) => { killed.push([file, sig]); } };
    // on an error the recorded output (if any) is still delivered as stdout, so a probe that parses output despite the
    // error would be caught
    const deliver = () => (execFileErr[file] ? cb(execFileErr[file], v === undefined ? "" : v, "") : v === undefined ? cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "") : cb(null, v, ""));
    if (execFileHold.includes(file)) held.push(deliver); else pending.push(deliver); // held: the callback never comes unless released
    return child;
  };
  const intervals = [], timeouts = [];
  const timers = {
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; intervals.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timeouts.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
  let backendProc = null;
  const hw = createHardwareService({
    os, fs, path, execSync, spawnSync, exec, execFile, osPlatform: platform, timers,
    LLM_BACKEND_PATHS: { winVulkan: "W:/vk/llama-server.exe", winSycl: "W:/sycl/llama-server.exe", winHip: "W:/hip/llama-server.exe", winCuda: "W:/cuda/llama-server.exe",
      linuxVulkan: "/s/vk/llama-server", linuxSycl: "/s/sycl/llama-server", linuxRocm: "/s/rocm/llama-server", linuxCuda: "/s/cuda/llama-server", ...backendPaths },
    getBackendProc: () => backendProc, getOpenVinoPython: () => "", getCoreMLPythonPath: () => "", ...extraDeps,
  });
  return {
    hw, f: hw.fns, calls, intervals, timeouts, execFileOpts, killed, held,
    flush: () => { while (pending.length) pending.shift()(); },
    setBackendProc: (p) => { backendProc = p; },
    tick: () => { cpus = cpus.map((c) => ({ ...c, times: { ...c.times, user: c.times.user + 50, idle: c.times.idle + 50 } })); },
  };
}

// ── Recorded outputs ───────────────────────────────────────────────────────
const NVIDIA_SMI_NAME_TOTAL = "NVIDIA GeForce RTX 4070, 12282\n";
const NVIDIA_SMI_POLL = "NVIDIA GeForce RTX 4070, 1024, 12282\n";
const WIN_GPUS_JSON = JSON.stringify([
  { Name: "Microsoft Basic Display Adapter", VRAM: 0 },
  { Name: "Intel(R) UHD Graphics 770", VRAM: 1 },
  { Name: "NVIDIA GeForce RTX 3060", VRAM: 4 },
]);
const MAC_ARM_PROFILER = `Graphics/Displays:

    Apple M2 Pro:

      Chipset Model: Apple M2 Pro
      Type: GPU
      Bus: Built-In
      Total Number of Cores: 19
      Vendor: Apple (0x106b)
      Metal Support: Metal 3
`;
const MAC_INTEL_PROFILER = `Graphics/Displays:

    Intel UHD Graphics 630:

      Chipset Model: Intel UHD Graphics 630
      Type: GPU
      Bus: Built-In
      VRAM (Dynamic, Max): 1536 MB

    AMD Radeon Pro 5500M:

      Chipset Model: AMD Radeon Pro 5500M
      Type: GPU
      Bus: PCIe
      VRAM (Total): 4 GB
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65536.
Pages active:                            400000.
Pages inactive:                          131072.
Pages speculative:                        65536.
`;
const LLAMA_LIST_DEVICES = `Available devices:
  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15000 MiB free)
  Vulkan1: llvmpipe (LLVM 15.0.7, 256 bits) (7900 MiB, 7900 MiB free)
`;

// ── Linux x64 ──────────────────────────────────────────────────────────────
test("linux-x64, no GPU (the CI case): Unavailable GPU, CPU-only specs, no NPU", () => {
  const m = machine({ platform: "linux", logical: 4, totalGb: 16 });
  assert.deepEqual(m.f.getGpuInfo(), { name: "Unavailable", vram_gb: 0 });
  const specs = m.f.getHardwareSpecs();
  assert.equal(specs.os_name, "Linux 1.0");
  assert.equal(specs.cpu_cores_logical, 4);
  assert.equal(specs.cpu_cores_physical, 2, "4 logical = 2x2, treated as hyper-threaded (unchanged heuristic)");
  assert.equal(specs.ram_total_gb, 16);
  assert.equal(specs.gpu_name, "Unavailable");
  assert.equal(specs.gpu_vram_gb, 0);
  assert.deepEqual(specs.npu, { detected: false, vendor: null, name: null });
  assert.equal(typeof specs.tier, "string");
  assert.ok(Array.isArray(specs.recommended_models));
});

test("linux-x64, NVIDIA via nvidia-smi: name and VRAM from the CSV", () => {
  const m = machine({ platform: "linux", exec: { "nvidia-smi --query-gpu=name,memory.total": NVIDIA_SMI_NAME_TOTAL } });
  assert.deepEqual(m.f.getGpuInfo(), { name: "NVIDIA GeForce RTX 4070", vram_gb: 11.99 });
});

test("linux-x64, AMD via sysfs: vendor 0x1002 and mem_info_vram_total", () => {
  const m = machine({ platform: "linux", files: {
    "/sys/class/drm/card0/device/vendor": "0x1002\n",
    "/sys/class/drm/card0/device/mem_info_vram_total": String(8 * GB),
  } });
  assert.deepEqual(m.f.getGpuInfo(), { name: "AMD Radeon GPU", vram_gb: 8 });
});

test("linux-x64, llama.cpp Vulkan device list: VRAM telemetry picks the largest real device", () => {
  const m = machine({ platform: "linux", files: { "/s/vk/llama-server": "" }, execFile: { "/s/vk/llama-server": LLAMA_LIST_DEVICES } });
  assert.equal(m.f.getLlamaTelemetryBackendPath(), "/s/vk/llama-server");
  m.f.pollLlamaVram(true);
  m.flush();
  assert.deepEqual(m.f.getLlamaVram(), { gpu_name: "AMD Radeon RX 7800 XT", vram_used_gb: 1.34, vram_total_gb: 15.98 });
});

test("linux-x64, Intel NPU via lspci", () => {
  const m = machine({ platform: "linux", exec: { "lspci | grep -i": "00:0b.0 System peripheral: Intel Corporation Meteor Lake NPU (rev 04)" } });
  assert.deepEqual(m.f.detectNpu(), { detected: true, vendor: "intel", name: "00:0b.0 System peripheral: Intel Corporation Meteor Lake NPU (rev 04)" });
});

// ── Windows x64 ────────────────────────────────────────────────────────────
test("windows-x64: discrete GPU preferred over virtual and integrated adapters", () => {
  const m = machine({ platform: "win32", exec: { "Get-CimInstance Win32_VideoController | ForEach-Object": WIN_GPUS_JSON } });
  assert.deepEqual(m.f.getGpuInfo(), { name: "NVIDIA GeForce RTX 3060", vram_gb: 4 });
  assert.equal(m.f.getHardwareSpecs().os_name, "Windows_NT 1.0");
});

test("windows-x64: no GPU query available → Unavailable (detection failure is not an error)", () => {
  const m = machine({ platform: "win32" });
  assert.deepEqual(m.f.getGpuInfo(), { name: "Unavailable", vram_gb: 0 });
  assert.deepEqual(m.f.detectNpu(), { detected: false, vendor: null, name: null });
});

test("windows-x64: llama.cpp CUDA build listing a device wins over PowerShell", () => {
  const m = machine({ platform: "win32", files: { "W:/cuda/llama-server.exe": "" },
    spawn: { "W:/cuda/llama-server.exe --list-devices": "Available devices:\n  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23000 MiB free)\n" },
    exec: { "Get-CimInstance Win32_VideoController | ForEach-Object": WIN_GPUS_JSON } });
  const gpu = m.f.getGpuInfo();
  assert.match(gpu.name, /RTX 4090/);
  assert.ok(gpu.vram_gb > 23 && gpu.vram_gb < 24.1, String(gpu.vram_gb));
});

// ── macOS arm64 ────────────────────────────────────────────────────────────
test("macos-arm64: Apple GPU with unified memory; high tier at 16 GB; RAM from vm_stat", () => {
  const m = machine({ platform: "darwin", arch: "arm64", cpuModel: "Apple M2 Pro", logical: 10, totalGb: 16,
    exec: { "system_profiler SPDisplaysDataType": MAC_ARM_PROFILER, vm_stat: VM_STAT } });
  assert.deepEqual(m.f.getGpuInfo(), { name: "Apple M2 Pro", vram_gb: 16 });
  const specs = m.f.getHardwareSpecs();
  assert.equal(specs.tier, "high");
  assert.deepEqual(specs.npu, { detected: false, vendor: null, name: null }, "the Neural Engine is not reported as a separate NPU (unchanged)");
  m.f.pollMacRam();
  m.flush();
  // free = (65536 + 131072 + 65536) pages × 16 KiB = 4 GiB → used = 12 GB
  assert.equal(m.f.getTelemetry().ram_used_gb, 12);
  assert.equal(m.hw.budget.freeRamBytes(), 4 * GB);
  assert.deepEqual(m.f.getCoreMLNpuInfo(), { supported: true, ready: false, reason: "CoreML Python environment is not set up. Run scripts/setup/setup-coreml-npu.sh first." });
});

// Issue #116: start() asks vm_stat asynchronously. Until its first answer the source is "os-free-pages" and a memory
// check made then reports macos-available-memory-pessimistic; after it, "vm-stat" and no such reason. A server that
// loads a model right after it starts can be in either window, so two otherwise equal runs can differ in this reason.
test("macos: the memory source is os-free-pages until the first vm_stat answer, then vm-stat; the memory check follows", () => {
  const { assessModelLoad } = require("../server/services/memory-check.cjs");
  const reasons = (hw) => assessModelLoad({ kind: "text", info: { contextSize: 2048, gpuLayers: 0, backendMode: "CPU" }, budget: hw.budget,
    inspectModel: () => null, platform: "darwin", arch: "x64", now: () => 0 }).reasons;
  const m = machine({ platform: "darwin", arch: "x64", totalGb: 16, freeGb: 1, exec: { vm_stat: VM_STAT } });
  m.hw.start();
  assert.ok(m.calls.some(([kind, cmd]) => kind === "exec" && cmd === "vm_stat"), "start() asked vm_stat");
  assert.equal(m.hw.budget.freeRamSource(), "os-free-pages", "before the answer");
  assert.equal(m.hw.budget.freeRamBytes(), 1 * GB, "before the answer: free pages only (os.freemem)");
  assert.ok(reasons(m.hw).includes("macos-available-memory-pessimistic"));
  m.flush();
  assert.equal(m.hw.budget.freeRamSource(), "vm-stat", "after the answer");
  assert.equal(m.hw.budget.freeRamBytes(), 4 * GB);
  assert.ok(!reasons(m.hw).includes("macos-available-memory-pessimistic"));
  m.hw.stop();
});

test("macos-arm64: system_profiler failing falls back to 'Apple Metal GPU' with unified memory", () => {
  const m = machine({ platform: "darwin", arch: "arm64", totalGb: 8 });
  assert.deepEqual(m.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 8 });
});

// ── macOS Intel x86_64 ─────────────────────────────────────────────────────
test("macos-x86_64: discrete AMD GPU preferred over Intel UHD; VRAM in GB and MB parsed", () => {
  const m = machine({ platform: "darwin", arch: "x64", cpuModel: "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz", logical: 16, totalGb: 32,
    exec: { "system_profiler SPDisplaysDataType": MAC_INTEL_PROFILER } });
  assert.deepEqual(m.f.getGpuInfo(), { name: "AMD Radeon Pro 5500M", vram_gb: 4 });
  const specs = m.f.getHardwareSpecs();
  assert.equal(specs.cpu_cores_physical, 8);
  assert.notEqual(specs.tier, undefined);
  assert.equal(m.f.getCoreMLNpuInfo().supported, false, "no Apple Neural Engine on Intel Macs");
});

// ── Unsupported acceleration ───────────────────────────────────────────────
test("unsupported acceleration: virtual or software GPUs are recognised; no Vulkan runtime", () => {
  const m = machine({ platform: "linux" });
  for (const name of ["Microsoft Basic Render Driver", "VMware SVGA 3D", "VirtualBox Graphics Adapter", "Citrix Indirect Display"]) assert.equal(m.f.isVirtualOrSoftwareGpu(name), true, name);
  assert.equal(m.f.isVirtualOrSoftwareGpu("NVIDIA GeForce RTX 4070"), false);
  assert.equal(m.f.hasVulkanRuntime(), true, "Linux/macOS assume a Vulkan loader (unchanged)");
  assert.equal(m.f.getPreferredVulkanBackendName(), "vulkan0", "no vulkaninfo → device 0 (unchanged)");
  assert.equal(machine({ platform: "win32" }).f.hasVulkanRuntime(), false, "Windows without vulkan-1.dll");
  assert.equal(m.f.detectLlamaCudaGpu(), null);
  assert.equal(m.f.detectLlamaSyclGpu(), null);
  assert.equal(m.f.getOpenVinoNpuInfo().supported, false);
});

// ── Caching, CPU and telemetry ─────────────────────────────────────────────
test("detection runs once per run (cached, as before)", () => {
  const m = machine({ platform: "linux", exec: { "nvidia-smi --query-gpu=name,memory.total": NVIDIA_SMI_NAME_TOTAL } });
  const first = m.f.getGpuInfo();
  const n = m.calls.length;
  assert.equal(m.f.getGpuInfo(), first);
  assert.equal(m.calls.length, n, "no new probes on the second call");
});

test("CPU usage: 0 on the first sample, then the delta; threads follow physical cores", () => {
  const m = machine({ platform: "linux", logical: 8 });
  assert.equal(m.f.getCpuUsagePercent(), 0);
  m.tick();
  assert.equal(m.f.getCpuUsagePercent(), 50);
  assert.equal(m.f.getOptimalThreads(false), 4);
  assert.equal(m.f.getOptimalThreads(true), 2);
});

test("memory telemetry: NVIDIA poll feeds /api/telemetry and the budget; paused while the image engine runs", () => {
  const m = machine({ platform: "linux", totalGb: 32, freeGb: 20, exec: { "--query-gpu=name,memory.used,memory.total": NVIDIA_SMI_POLL } });
  assert.equal(m.hw.budget.freeVramBytes(), null, "nothing polled yet");
  m.f.pollNvidiaVram(true);
  m.flush();
  const t = m.f.getTelemetry();
  assert.equal(t.gpu_name, "NVIDIA GeForce RTX 4070");
  assert.equal(t.vram_used_gb, 1);
  assert.equal(t.vram_total_gb, 11.99);
  assert.equal(t.ram_total_gb, 32);
  assert.equal(t.ram_used_gb, 12);
  assert.equal(m.hw.budget.totalRamBytes(), 32 * GB);
  assert.equal(m.hw.budget.freeRamBytes(), 20 * GB);
  assert.equal(Math.round(m.hw.budget.freeVramBytes() / 1e6), Math.round((11.99 - 1) * GB / 1e6));
  assert.equal(m.hw.budget.totalVramBytes(), 11.99 * GB);
  assert.ok(Object.isFrozen(m.hw.budget), "the budget is read-only");

  m.setBackendProc({ pid: 1 });
  const before = m.calls.length;
  m.f.pollNvidiaVram(false);
  assert.equal(m.calls.length, before, "no driver query while the image engine runs (unchanged)");
});

test("memory telemetry: a failed nvidia-smi disables further NVIDIA polls (unchanged)", () => {
  const m = machine({ platform: "linux" });
  m.f.pollNvidiaVram(true);
  m.flush();
  assert.equal(m.f.getNvidiaVram(), null);
  const before = m.calls.length;
  m.f.pollNvidiaVram(true);
  assert.equal(m.calls.length, before);
});

// ── Timers ─────────────────────────────────────────────────────────────────
for (const [platform, expected] of [["linux", 2], ["win32", 2], ["darwin", 3]]) {
  test(`timers (${platform}): start() creates ${expected} 5-second intervals and polls once; stop() clears all`, () => {
    const m = machine({ platform, arch: platform === "darwin" ? "arm64" : "x64" });
    assert.equal(m.intervals.length, 0, "creating the service starts nothing");
    m.hw.start();
    assert.equal(m.intervals.length, expected);
    assert.ok(m.intervals.every((t) => t.ms === 5000));
    assert.equal(m.hw.activeTimers(), expected);
    m.hw.start();
    assert.equal(m.intervals.length, expected, "start() is idempotent");
    m.hw.stop();
    assert.ok(m.intervals.every((t) => t.cleared));
    assert.equal(m.hw.activeTimers(), 0);
  });
}

test("the service needs all of its dependencies", () => {
  assert.throws(() => createHardwareService({}), /missing dependency/);
});

// ── Real server: routes, sign-in, privacy, supervision ─────────────────────
const HW_ROUTES = ["/api/hardware-specs", "/api/telemetry", "/api/backend-options", "/api/health", "/api/diagnostics"];

test("real server: hardware routes need sign-in when it is on, and never return the token or credentials", async () => {
  const auth = require("../server/lan-auth.cjs");
  const fs = require("node:fs");
  const root = makeRoot();
  const srv = await startServer(root, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    const token = auth.readTokenFile(path.join(root, "app", "config", auth.TOKEN_FILE_NAME));
    assert.match(token, auth.TOKEN_RE);
    for (const p of HW_ROUTES) {
      assert.equal((await request(srv.port, "GET", p)).status, 401, `${p} without sign-in`);
      const r = await request(srv.port, "GET", p, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200, `${p} signed in`);
      const text = JSON.stringify(r.json);
      assert.ok(!text.includes(token), `${p}: no access token`);
      assert.doesNotMatch(text, /authorization|cookie|bearer/i, `${p}: no credential strings`);
    }
    assert.equal((await request(srv.port, "GET", "/api/hardware-specs", { headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}` } })).status, 403, "foreign Origin refused first");
  } finally {
    stopServer(srv);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  }
});

test("real server: hardware routes keep their response shapes; diagnostics still report engine supervision", async () => {
  const fs = require("node:fs");
  const root = makeRoot();
  const srv = await startServer(root);
  try {
    const specs = (await request(srv.port, "GET", "/api/hardware-specs")).json;
    for (const k of ["os_name", "cpu_name", "cpu_cores_physical", "cpu_cores_logical", "ram_total_gb", "gpu_name", "gpu_vram_gb", "npu", "tier", "recommended_models", "recommended_text_settings"]) assert.ok(k in specs, `specs.${k}`);
    assert.ok(specs.cpu_cores_logical >= 1);
    assert.ok(specs.ram_total_gb > 0);
    const tel = (await request(srv.port, "GET", "/api/telemetry")).json;
    for (const k of ["cpu_usage", "ram_used_gb", "ram_total_gb", "gpu_name", "vram_used_gb", "vram_total_gb"]) assert.ok(k in tel, `telemetry.${k}`);
    assert.ok(tel.cpu_usage >= 0 && tel.cpu_usage <= 100);
    const diag = (await request(srv.port, "GET", "/api/diagnostics")).json;
    assert.ok(diag.engines && typeof diag.engines === "object", "process supervision state (Step 9.6)");
  } finally {
    stopServer(srv);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  }
});

// ── #197/#181: bounded asynchronous GPU discovery (macOS) ─────────────────────────────────────────────────────────
// The GPU probe used to run `system_profiler` synchronously inside the first request that needed it (no timeout).
// primeGpuInfo() runs the same command with execFile, parses it with the same function and caches the same values.
const settle = async (m) => { m.flush(); await m.hw.ready(); };
const macSync = (arch, out) => machine({ platform: "darwin", arch, exec: { "system_profiler SPDisplaysDataType": out } });
const macAsync = (arch, out, extra = {}) => machine({ platform: "darwin", arch, execFile: { system_profiler: out }, ...extra });
const sysProfilerExecSyncs = (m) => m.calls.filter(([k, c]) => k === "execSync" && /system_profiler/.test(c)).length;

test("#197 async GPU probe: identical results to the synchronous path for recorded macOS outputs, with no synchronous probe", async () => {
  for (const [arch, out] of [["arm64", MAC_ARM_PROFILER], ["x64", MAC_INTEL_PROFILER]]) {
    const a = macSync(arch, out), b = macAsync(arch, out);
    b.hw.prime(); await settle(b);
    assert.equal(b.hw.gpuProbeState().state, "ready", arch);
    assert.deepEqual(b.f.getGpuInfo(), a.f.getGpuInfo(), `${arch}: same GPU`);
    assert.equal(JSON.stringify(b.f.getHardwareSpecs()), JSON.stringify(a.f.getHardwareSpecs()), `${arch}: byte-identical hardware specs`);
    assert.equal(b.hw.budget.totalVramBytes(), a.hw.budget.totalVramBytes(), `${arch}: same VRAM budget`);
    assert.equal(sysProfilerExecSyncs(b), 0, `${arch}: no synchronous system_profiler`);
  }
});

// Node 22's execFile error shapes, as measured (round 20): a timeout {code null, killed true, signal SIGKILL}; output
// over maxBuffer {code ERR_CHILD_PROCESS_STDIO_MAXBUFFER} (killed undefined; also checked with killed set, so the
// overflow test cannot depend on it); a missing command {code "ENOENT"} through the callback; a failed exit {code 1}.
const NODE_ERR = {
  timeout: () => Object.assign(new Error("timeout"), { code: null, killed: true, signal: "SIGKILL" }),
  overflow: () => Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
  overflowKilled: () => Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }),
  exit: () => Object.assign(new Error("exit 1"), { code: 1, killed: false, signal: null }),
};
const INTEL_CPU = "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz";

test("#197 async GPU probe (round 20): an Intel Mac whose probe fails never reports its RAM as GPU memory - GPU memory 0 (not known), each failure classified", async () => {
  for (const [label, extra, reason] of [
    ["ENOENT", { execFile: {} }, "spawn"],
    ["empty", { execFile: { system_profiler: "" } }, "none-listed"],
    ["garbage", { execFile: { system_profiler: "no gpu here\n" } }, "none-listed"],
    ["non-zero exit with output", { execFile: { system_profiler: MAC_INTEL_PROFILER }, execFileErr: { system_profiler: NODE_ERR.exit() } }, "exit"],
    ["output limit", { execFile: { system_profiler: MAC_INTEL_PROFILER }, execFileErr: { system_profiler: NODE_ERR.overflow() } }, "overflow"],
    ["output limit (killed set)", { execFile: { system_profiler: MAC_INTEL_PROFILER }, execFileErr: { system_profiler: NODE_ERR.overflowKilled() } }, "overflow"],
    ["timeout", { execFile: { system_profiler: MAC_INTEL_PROFILER }, execFileErr: { system_profiler: NODE_ERR.timeout() } }, "timeout"]]) {
    const m = machine({ platform: "darwin", arch: "x64", cpuModel: INTEL_CPU, totalGb: 32, ...extra });
    m.hw.prime(); await settle(m);
    assert.deepEqual(m.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 }, `${label}: GPU memory not known, never the 32 GB of RAM`);
    assert.deepEqual(m.hw.gpuProbeState().state, "fallback", label);
    assert.equal(m.hw.gpuProbeState().reason, reason, label);
    assert.equal(m.hw.gpuProbeState().source, "unavailable", label);
    assert.equal(m.hw.budget.totalVramBytes(), 0, `${label}: the VRAM budget is 0 (unknown), not RAM`);
    const specs = m.f.getHardwareSpecs();
    assert.equal(specs.gpu_vram_gb, 0, label);
    assert.equal(specs.tier, "low", `${label}: the conservative tier`);
    assert.ok(specs.recommended_models.length > 0 && specs.recommended_models.every((x) => /^GPU memory not known; 32 GB RAM\.$/.test(x.reason)), `${label}: the reason says unknown, not "0 GB VRAM"`);
    assert.deepEqual([specs.recommended_text_settings.gpuLayers, specs.recommended_text_settings.contextSize], [0, 2048], `${label}: the low tier's settings (CPU layers, 2048 context)`);
    assert.equal(sysProfilerExecSyncs(m), 0, label);
  }
  // the synchronous path (used only before prime) gives the same truthful value
  assert.deepEqual(machine({ platform: "darwin", arch: "x64", cpuModel: INTEL_CPU, totalGb: 32 }).f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 });
});

test("#197 async GPU probe (round 20): on Apple Silicon (arm64, or x64 Node under Rosetta) a failed probe keeps the unified memory, marked inferred", async () => {
  for (const [label, arch, cpuModel] of [["arm64", "arm64", "Apple M2"], ["Rosetta", "x64", "Apple M2"], ["Rosetta VirtualApple", "x64", "VirtualApple @ 2.50GHz processor"]]) {
    const m = machine({ platform: "darwin", arch, cpuModel, totalGb: 16, execFile: {}, });
    m.hw.prime(); await settle(m);
    assert.deepEqual(m.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 16 }, label);
    assert.equal(m.hw.gpuProbeState().source, "inferred", label);
    assert.deepEqual(machine({ platform: "darwin", arch, cpuModel, totalGb: 16 }).f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 16 }, `${label}: sync path`);
  }
  // while pending, Apple Silicon's provenance is the unified memory it reports (inferred), an Intel Mac's is unavailable
  const pa = machine({ platform: "darwin", arch: "arm64", cpuModel: "Apple M2", totalGb: 16, execFile: { system_profiler: MAC_ARM_PROFILER }, execFileHold: ["system_profiler"] });
  pa.hw.prime(); assert.deepEqual([pa.hw.gpuProbeState().state, pa.hw.gpuProbeState().source], ["pending", "inferred"]); pa.hw.stop();
  const pi = machine({ platform: "darwin", arch: "x64", cpuModel: INTEL_CPU, execFile: { system_profiler: MAC_INTEL_PROFILER }, execFileHold: ["system_profiler"] });
  pi.hw.prime(); assert.deepEqual([pi.hw.gpuProbeState().state, pi.hw.gpuProbeState().source], ["pending", "unavailable"]); pi.hw.stop();
  // a successful probe: Rosetta reports like arm64 (unchanged parsing), the Intel discrete GPU's VRAM is measured
  const r = machine({ platform: "darwin", arch: "x64", cpuModel: "Apple M2", totalGb: 16, execFile: { system_profiler: MAC_ARM_PROFILER } });
  r.hw.prime(); await settle(r);
  assert.equal(r.f.getGpuInfo().vram_gb, 16); assert.equal(r.hw.gpuProbeState().source, "inferred");
  const i = machine({ platform: "darwin", arch: "x64", cpuModel: INTEL_CPU, totalGb: 32, execFile: { system_profiler: MAC_INTEL_PROFILER } });
  i.hw.prime(); await settle(i);
  assert.ok(i.f.getGpuInfo().vram_gb > 0); assert.equal(i.hw.gpuProbeState().source, "measured"); assert.equal(i.hw.gpuProbeState().reason, null);
});

test("#197 async GPU probe: a timeout (killed) and a callback that never arrives (guard) both give the fallback and kill the child", async () => {
  const t = macAsync("x64", MAC_INTEL_PROFILER, { execFileErr: { system_profiler: NODE_ERR.timeout() } });
  t.hw.prime(); await settle(t);
  assert.equal(t.hw.gpuProbeState().reason, "timeout"); assert.deepEqual(t.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 }, "no invented GPU memory");
  const g = macAsync("x64", MAC_INTEL_PROFILER, { execFileHold: ["system_profiler"] });
  const p = g.hw.prime();
  assert.equal(g.hw.gpuProbeState().state, "pending");
  const guard = g.timeouts.find((x) => !x.cleared); assert.ok(guard && guard.ms === 11000, "guard at timeout + 1 s");
  guard.fn(); await p;
  assert.equal(g.hw.gpuProbeState().reason, "guard"); assert.deepEqual(g.killed, [["system_profiler", "SIGKILL"]]);
  assert.deepEqual(g.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 });
  g.held.shift()(); assert.equal(g.f.getGpuInfo().name, "Apple Metal GPU", "a late real result after the guard changes nothing");
});

test("#197 async GPU probe: the exact execFile call - no shell, a timeout, SIGKILL, hidden window, 1 MiB output limit", () => {
  const m = macAsync("x64", MAC_INTEL_PROFILER); m.hw.prime();
  assert.equal(m.execFileOpts.length, 1);
  const { file, opts } = m.execFileOpts[0];
  assert.equal(file, "system_profiler");
  assert.deepEqual({ timeout: opts.timeout, killSignal: opts.killSignal, windowsHide: opts.windowsHide, maxBuffer: opts.maxBuffer, encoding: opts.encoding, shell: opts.shell }, { timeout: 10000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", shell: undefined });
  assert.deepEqual(m.calls.filter(([k]) => k === "execFile").map(([, c]) => c), ["system_profiler SPDisplaysDataType"]);
});

test("#197 async GPU probe: stop() while pending kills the child and releases waiters without caching; after stop nothing probes again (round 20)", async () => {
  const m = macAsync("x64", MAC_INTEL_PROFILER, { execFileHold: ["system_profiler"], exec: { "system_profiler SPDisplaysDataType": MAC_INTEL_PROFILER } });
  const p = m.hw.prime();
  m.hw.stop(); await p;
  assert.deepEqual(m.killed, [["system_profiler", "SIGKILL"]]);
  assert.deepEqual({ state: m.hw.gpuProbeState().state, reason: m.hw.gpuProbeState().reason }, { state: "stopped", reason: "cancelled" });
  m.held.shift()(); // the killed child's late callback (Node reports a caller's kill exactly like a timeout)
  assert.equal(m.hw.gpuProbeState().state, "stopped", "a late callback after stop changes nothing");
  assert.equal(m.timeouts.every((x) => x.cleared), true, "the guard timer is cleared");
  // after stop: getters answer "not known" without any probe, ready() resolves at once, prime() starts nothing
  assert.deepEqual(m.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 });
  m.f.getHardwareSpecs(); m.hw.budget.totalVramBytes(); await m.hw.ready(); await m.hw.prime();
  assert.equal(sysProfilerExecSyncs(m), 0, "no synchronous probe after stop");
  assert.equal(m.calls.filter(([k]) => k === "execFile").length, 1, "no new probe after stop");
  // stopped before it ever started (idle): the same
  const n = macSync("x64", MAC_INTEL_PROFILER); n.hw.stop();
  assert.deepEqual(n.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 }); await n.hw.ready(); await n.hw.prime();
  assert.equal(sysProfilerExecSyncs(n), 0); assert.equal(n.calls.filter(([k]) => k === "execFile").length, 0);
});

test("#197 async GPU probe: concurrent waiters share one probe; a synchronous caller while pending does NOT probe and gets the uncached 'not known' value (round 20)", async () => {
  const m = macAsync("x64", MAC_INTEL_PROFILER, { cpuModel: INTEL_CPU, exec: { "system_profiler SPDisplaysDataType": MAC_ARM_PROFILER } }); // the sync path would see different output
  const waits = [m.hw.ready(), m.hw.ready(), m.hw.prime(), m.hw.prime(), m.hw.ready()];
  assert.equal(m.calls.filter(([k]) => k === "execFile").length, 1, "one probe");
  assert.deepEqual(m.f.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 }, "while pending: not known (never invented)");
  assert.equal(sysProfilerExecSyncs(m), 0, "no synchronous probe while the bounded probe is pending");
  assert.equal(m.hw.gpuProbeState().state, "pending", "nothing cached by the synchronous caller");
  m.flush(); await Promise.all(waits);
  assert.deepEqual(m.f.getGpuInfo(), macSync("x64", MAC_INTEL_PROFILER).f.getGpuInfo(), "the probe's result is cached");
  assert.deepEqual({ state: m.hw.gpuProbeState().state, reason: m.hw.gpuProbeState().reason, source: m.hw.gpuProbeState().source }, { state: "ready", reason: null, source: "measured" });
  let quick = false; m.hw.ready().then(() => { quick = true; }); await Promise.resolve(); assert.equal(quick, true, "ready() resolves at once once cached");
});

test("#197 async GPU probe: ready() starts the probe lazily; the event loop keeps running while it is pending", async () => {
  const m = macAsync("x64", MAC_INTEL_PROFILER);
  let order = [];
  const done = m.hw.ready().then(() => order.push("ready"));
  assert.equal(m.hw.gpuProbeState().state, "pending", "lazily primed");
  await new Promise((r) => setImmediate(r)); order.push("loop ran");
  m.flush(); await done;
  assert.deepEqual(order, ["loop ran", "ready"]);
});

test("#197 async GPU probe: other platforms are unchanged (no execFile probe; the existing synchronous path)", async () => {
  for (const platform of ["linux", "win32"]) {
    const m = machine({ platform });
    await m.hw.prime();
    assert.equal(m.hw.gpuProbeState().state, "legacy", platform);
    assert.equal(m.hw.gpuProbeState().source, null, `${platform}: no macOS provenance`);
    assert.equal(m.calls.filter(([k, c]) => k === "execFile" && /system_profiler/.test(c)).length, 0, platform);
  }
});
