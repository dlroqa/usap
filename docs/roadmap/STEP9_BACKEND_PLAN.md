# Step 9: foundational backend improvements (plan)

Authorized by the owner on 2026-11-09. This is delivered as **small, incremental,
independently testable PRs**, all behind or around the existing interface. The installer work
(Step 10) stays deferred until Step 9's essential items are complete and validated.

Starting point: `scripts/server/serve.cjs` is one ~7,750-line file with 67 `/api/...` routes,
plus `request-policy.cjs` (security policy) and `model-kind.cjs`. Every data path is fixed
under `<root>/app/`.

## Gates for every Step 9 PR

A Step 9 PR merges only if all of these hold:

1. **All 8 required checks pass:** `build-test` ×4 (unit + security regression tests, build)
   and `render` ×4 (pixel-exact screenshots, behaviour and accessibility tests against the
   approved UI).
2. **No change under `app/frontend/`**, and `tests/e2e/ORIGINAL_UI_COMMIT` is untouched.
   Baselines are never regenerated to hide a regression.
3. **API contract tests pass unchanged** (added in 9.1). Existing routes, status codes and
   response fields stay compatible. New fields and routes are additive only.
4. **`native-runtime` passes on all 4 targets** whenever the PR touches the server, setup,
   launchers or engines: real LLM, Whisper, Kokoro and image inference on the CPU, with GPU
   paths still recorded as UNSUPPORTED/UNAVAILABLE.
5. **No user data is moved or deleted.** Any migration needs a tested forward and rollback path
   first, plus an owner decision.
6. Security regression tests keep passing, and branch protection is unchanged.

## PR sequence

| # | PR | Scope | Acceptance criteria |
|---|---|---|---|
| 9.1 | **API contract tests** (safety net, no server change) | Start `serve.cjs` against a temp root with no engines. Record status code + response shape (keys and types, not volatile values) for every `GET` route and the safe `POST` error paths | Runs in `ci.yml` on all 4 OS; passes on current `main`; deliberately breaking a field fails it |
| 9.2 | **Paths/config module** | Move the path constants into `scripts/server/paths.cjs` with one data-root resolver. Portable mode (the default) resolves to exactly today's `<root>/app/...` paths. Installed mode exists only as an internal, untested-by-users option | Unit test: every resolved path is byte-identical to the current one; no data moved; contract tests unchanged |
| 9.3 | **Security S-4/S-5** | Page-fetch SSRF: connect to the address that was checked (no second DNS lookup); bounded redirects with each hop re-validated | New regression tests for rebinding and redirect-to-private; existing tests pass |
| 9.4 | **Security S-6/S-8/S-10** | SHA-256 manifest for every downloaded runtime archive (verify before extracting; fail closed); `execFile` instead of a shell string; `npm ci` with the lockfile | Setup fails on a tampered archive (test); `native-runtime` passes on all 4 targets. **Done (#18)**; S-10 deferred by owner decision to a staged dependency update ([#22](https://github.com/dlroqa/usap/issues/22)) |
| 9.5 | **Security S-7/S-9** | Opt-in LAN mode requires a generated access token (never in URLs or logs); JSON routes require a JSON content type, while binary upload routes keep their types | Loopback default unchanged; tests for missing/invalid token and wrong content type; frontend unaffected (render gates). **Done (#25)** |
| 9.6 | **Process supervision + diagnostics** | Detect engine crashes (for example the Metal `SIGABRT`) and return a clear structured error instead of "socket hang up"; bounded restart with backoff; additive `GET /api/diagnostics` (versions, engines, backends, data root; no secrets) | Fault-injection test (kill the engine mid-request) gives a structured error; no zombie processes; contract tests unchanged except the additive route. **Done (#29)** ([ENGINE_SUPERVISION.md](../runtime/ENGINE_SUPERVISION.md)) |
| 9.7 | **Error envelope** | One helper for error responses: keep the existing `error` string, add `code` and an optional `hint` | Contract tests confirm the old fields remain; no frontend change. **Done (#35)** ([API_ERRORS.md](../runtime/API_ERRORS.md)); 10 corrected statuses recorded in the contract |
| 9.8 | **Route modules** (one domain per PR: models, LLM, speech, TTS, image, search, settings). The LLM/chat PR needed Windows streaming coverage first ([#14](https://github.com/dlroqa/usap/issues/14), resolved by #17) | Move handlers into `scripts/server/routes/*.cjs` and services into `scripts/server/services/*.cjs`; `serve.cjs` keeps wiring and policy | Each PR is a pure move plus wiring; contract, render and native gates pass. **In progress**: [design and PR sequence](STEP9_8_MODULES.md); 9.8a (pipeline, router, system routes) done (#36) |
| 9.9 | **Resource scheduling** | One thread policy for all engines (the image cap from #9 generalised); per-engine concurrency limit and queue; a memory-headroom check before loading a model, with a clear error | Unit tests for the policy and queue; `native-runtime` timings don't regress |
| 9.10 | **Benchmarks + regression thresholds** | `benchmark.yml` (weekly + on demand): fixed model, prompt, seed and size per engine per target; JSON results kept as artifacts; compare with a committed baseline | Fails if a metric is >1.5× slower than the baseline for that target (hosted-runner noise is documented; thresholds are reviewed before tightening) |
| 9.11 | **Optimized Intel image-engine build spec** (Option A, see below) | `build-sd-macos-x64.yml` builds the pinned source; tests and benchmarks it; produces a provenance record. **Not wired into setup yet** | See the Option A criteria below |
| 9.12 | **Storage abstraction readiness** | Installed-mode data root behind the 9.2 resolver, with a migration/rollback design document; still no data moved | Tests for both modes on all 4 OS; portable behaviour unchanged |

After these: optional cloud inference and intelligent model routing get planned as
feature-flagged, off-by-default modules. They're not introduced in Step 9 in a way that could
destabilize the core app.

## Option A: optimized Intel x86_64 image engine (build strategy)

Source: stable-diffusion.cpp `master-685-19bdfe2`, which pins its ggml submodule at
`0ce7ad3` (leejet/ggml).

* **Build on native Intel** (`macos-15-intel`, with the same no-Rosetta assertions):
  `-DSD_METAL=ON -DSD_BUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON
  -DGGML_CPU_ALL_VARIANTS=ON -DCMAKE_BUILD_TYPE=Release`, with an explicit
  `CMAKE_OSX_ARCHITECTURES=x86_64` and `MACOSX_DEPLOYMENT_TARGET` matching the oldest
  macOS the app supports.
* **No AVX2 assumption:** `GGML_CPU_ALL_VARIANTS` builds every x86 CPU variant in this
  ggml (`x64`, `sse42`, `sandybridge` with AVX, `haswell` with AVX2/FMA, and the AVX-512 tiers).
  stable-diffusion.cpp calls `ggml_backend_load_all()`, so ggml picks the best variant this
  CPU supports at runtime. `x64`/`sse42` are the fallback for the oldest supported Intel Macs.
* **Compatibility tests:**
  * run real generation with the auto-selected variant
  * force each lower variant (by shipping a reduced set) and confirm it still generates
  * confirm the variant ggml reports matches `sysctl machdep.cpu` features
  * confirm `otool -L` shows no Homebrew or `/usr/local` dependency
* **Benchmark:** the same pinned model, prompt, seed, size, steps, threads and flags against the
  universal binary, recording CLIP, sampling and decode times. The earlier experiment showed
  sampling 3–4× faster for a native build.
* **Provenance record** (JSON, kept with the build): source repo and revision, submodule revision, Apple
  clang and CMake versions, SDK, deployment target, all CMake flags, `otool -L` output, and SHA-256 of
  every shipped file.
* **Safety:** the universal binary stays the installed default until the optimized engine
  passes all of the above on Intel and is approved. It's integrated into the Intel portable and
  desktop packages in Step 10. Users never need Xcode, CMake or developer tools.
* **Distribution of the built engine:** CI artifacts are for validation only. Publishing a
  release asset that setup downloads requires explicit owner authorization (Step 12 rules).

## Not in Step 9
* Desktop installers (Step 10, deferred).
* Any UI change. If a backend improvement needs UI work, it's proposed separately for approval.
* GPU validation claims: Metal, Vulkan, CUDA, ROCm and Core ML stay **unverified** until
  physical GPU runners record a `PASS` (see [RUNNER_REQUIREMENTS.md](../ci/RUNNER_REQUIREMENTS.md)).
