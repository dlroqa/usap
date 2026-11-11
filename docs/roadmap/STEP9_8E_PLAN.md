# Step 9.8e plan: hardware and diagnostics module

Status: **implemented, in review** (separate PR, needs its own approval). The web-search security
fixes (#47, #48, #49, #51) are merged. See [As implemented](#as-implemented) for where the code
differs from this plan.

## What exists today (`scripts/server/serve.cjs`, about lines 430–1700, plus callers)

| Area | Functions | State |
|---|---|---|
| CPU | `getCpuSample`, `getCpuUsagePercent`, `getPhysicalCores` | sample cache |
| GPU detection | `detectLinuxGpuFromSysfs`, `detectLlamaCudaGpu`, `detectLlamaVulkanGpu`, `detectLlamaSyclGpu`, `getPreferredVulkanBackendName`, `getGpuInfo` | `cached*` values (once per run) |
| NPU detection | `detectNpu`, `getOpenVinoNpuInfo`, `getCoreMLNpuInfo` | cached |
| Memory and VRAM polling | `pollNvidiaVram`, `getNvidiaVram`, `pollLlamaVram`, `getLlamaVram`, `pollMacRam` | **three 5-second timers**, `cachedVramInfo`, `cachedMacRamUsedGb` |
| Reports | `getHardwareSpecs`, `getTelemetry`, `getHardwareHash` | none |
| Used by model loading | `chooseAutoLayers` (GPU layers from free VRAM), `chooseAutoContext` (context from RAM/VRAM), `getStableSyclGpuLayers`, `getBackendOptions` | `cachedBackendOptions` |
| Routes | `GET /api/hardware-specs`, `/api/telemetry`, `/api/backend-options`, `/api/health`, `/api/diagnostics` (already in `routes/system.cjs`, 9.8a) | |

## Target

```
scripts/server/services/hardware.cjs   createHardwareService({ os, fs, spawnSync, platform, paths, now })
  cpu:       usagePercent(), physicalCores(), logicalCores()
  gpu:       info(), preferredVulkanBackend(), llamaGpu(kind)           (cached, as today)
  npu:       detect(), openVinoInfo(), coreMLInfo()
  memory:    ram(), vram()                                              (same polling and same values)
  reports:   specs(), telemetry(), hash()
  budget:    freeVramBytes(), freeRamBytes()                            (read-only, for loaders and the scheduler)
  start()/stop()                                                         (the three 5 s timers; stop() for tests and shutdown)
```

* The **routes stay in `routes/system.cjs`**; they get their functions from the service instead of
  from `serve.cjs`.
* `chooseAutoLayers` / `chooseAutoContext` stay with the model loaders (they move with 9.8h). They
  read memory **only** through `hardware.budget.*`, the single seam the future **resource scheduler
  (Step 9.9)** plugs into for admission checks and per-engine limits. That needs no change to the
  loaders.
* All `spawnSync`/file probes (nvidia-smi, sysfs, `--list-devices`) are injected, so tests can supply
  recorded outputs per OS and GPU vendor. Real hardware isn't needed for the unit tests.
* No new process, timer, port or service: the same three timers, now started and stopped explicitly.

## Compatibility rules

* Response shapes and values of `/api/hardware-specs`, `/api/telemetry`, `/api/backend-options`,
  `/api/health` and `/api/diagnostics` are unchanged; the API contract tests guard them.
* Detection order and caching stay the same, so GPU/NPU selection and auto-tuning give the same
  results.
* GPU acceleration remains **unverified** in USAP; this step doesn't change that status.

## Privacy and security in diagnostics

* No credentials, tokens or API keys are part of any hardware or diagnostics output. The Step 9.6
  diagnostics test already checks for the access token and authorization/cookie strings; 9.8e extends
  it to every hardware route.
* **Found while planning:** eight read-only routes return absolute host paths (root, engine binaries,
  model and runtime folders), which signed-in LAN devices can see. Tracked as
  [#52](https://github.com/dlroqa/usap/issues/52), with two options for the owner: shorten for every
  client, or for remote clients only. The UI doesn't display these fields. This is a behaviour change,
  so it's a separate PR from the pure 9.8e move.
* `getHardwareHash` identifies the machine's hardware. It stays local (it's used for the benchmark
  cache) and isn't added to any response.

## Tests planned (`scripts/tests/hardware-module.test.cjs`)

1. **Recorded detection outputs:** NVIDIA (nvidia-smi CSV), AMD/Intel sysfs, Vulkan/SYCL
   `--list-devices`, Apple (sysctl/vm_stat), no GPU. Each gives the same `info()` and `specs()` as the
   current code; a golden comparison against the pre-move functions.
2. **Memory budget:** `freeVramBytes` / `freeRamBytes` from recorded polls; `chooseAutoLayers` /
   `chooseAutoContext` give identical results through the seam.
3. **Timers:** `start()` and `stop()` create and clear exactly three intervals. No timer is left after
   `stop()` (fake clock).
4. **Real server:** the hardware routes keep their contract shapes; they're behind sign-in and the
   Origin check; no token or credential strings appear.
5. **Native-runtime** jobs keep passing on all 4 platforms. This is the real detection path on hosted
   runners (CPU only).

## Risks

* Detection code has many per-OS and per-vendor branches that hosted CI can't exercise (no GPUs). The
  recorded-output tests are the main protection; real-GPU verification stays a separate, open item.
* The timers start at module load today. Making them explicit has to keep the first sample timing, or
  the first telemetry response could differ (covered by test 3).

## As implemented

* `scripts/server/services/hardware.cjs` exports `createHardwareService(deps)`. The 26 hardware
  functions and their caches were moved **byte for byte** (checked by an AST comparison against
  `main`). The only edit: `pollNvidiaVram` reads the image engine process through the injected
  `getBackendProc()`, because that state still lives in `serve.cjs`. `serve.cjs` binds the same
  function names from `hardware.fns`, so no caller changed.
* The service exposes `fns` (the existing functions, under their existing names) rather than the
  `cpu/gpu/npu/memory/reports` namespaces sketched above. Grouped names can come later without moving
  code again; keeping the old names made the move verifiable line by line.
* **Timers:** the plan said "three 5 s timers". The code has **two** on Linux and Windows (NVIDIA VRAM,
  llama.cpp device memory) and **three** on macOS (plus RAM from `vm_stat`). `start()` creates exactly
  those, in the same order, at the same point of start-up; `stop()` clears them. Tests pin the count per
  platform.
* **Budget:** `budget.totalRamBytes()`, `freeRamBytes()`, `totalVramBytes()` and `freeVramBytes()` are
  read-only (frozen) and use the same sources as `/api/telemetry`. **Nothing reads them yet.**
  `chooseAutoContext` keeps reading `os.totalmem()` and `getGpuInfo()` directly, so auto-tuning is
  unchanged. It moves to the budget with the loaders in 9.8h. `chooseAutoLayers` has no callers (it
  was unused upstream too) and stays where it is.
* `parseLlamaDeviceList` (used by the llama.cpp backend probe), `getBackendOptions` (with its cache)
  and `getHardwareHash` (benchmark cache key, never in a response) stay in `serve.cjs`.
* Golden check: on this development machine (Linux x64, no GPU), `/api/hardware-specs`,
  `/api/backend-options` and `/api/telemetry` (without the live CPU/RAM usage) are identical between
  `main` and this branch, and `/api/llm/backends` differs only in `generatedAt`. This is one machine,
  not a hardware matrix; the recorded-output tests cover the other platforms and vendors.

