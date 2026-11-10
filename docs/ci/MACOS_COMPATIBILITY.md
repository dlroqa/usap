# macOS compatibility: Apple Silicon (arm64) and Intel (x86_64)

**Status: macOS support is NOT complete.** On both native architectures, the hosted runners
complete real first-time setup, a repeat launch, and real inference for text, speech, voice
and image generation on the **CPU**. Two things are still missing: **Metal GPU** inference is
unverified (the runners' GPU is a paravirtual device that can't run it), and Intel image
generation works but is slow with the upstream binary (see below).

## Evidence by architecture

Runtime rows come from `native-runtime.yml` run
[42728508137](https://github.com/dlroqa/usap/actions/runs/42728508137) on PR #9 (`9dd6a94`).
Each run starts from a fresh checkout, does the `mac.sh` first launch (real setup), runs
`scripts/ci/runtime-validate.sh`, then does a second launch.

| Gate | macOS arm64 (`macos-15`, Apple M1 VM) | macOS x86_64 (`macos-15-intel`, Core i7-8700B, 4 vCPU) |
|---|---|---|
| Native hardware, no Rosetta (`hw.optional.arm64`, `proc_translated`) | PASS | PASS |
| First-time setup via `mac.sh` / second launch without setup | PASS / PASS | PASS / PASS |
| Portable Node 22.12.0, llama-server b11418, whisper-cli: arch + startup | arm64 PASS | x86_64 PASS |
| Image backend `sd` + `libstable-diffusion.dylib`: arch + startup | universal (`x86_64 arm64`) PASS | universal PASS, now installed on Intel (#9) |
| Kokoro native addons (onnxruntime-node 1.21.0, sharp 0.34.5) | PASS | PASS |
| **LLM** via app API (Qwen2.5-0.5B-Instruct Q4_K_M, `gpuLayers: 0`) | PASS (CPU compute) | PASS (CPU) |
| **Speech** via app API (whisper tiny.en, JFK sample) | PASS | PASS |
| **TTS** via app API (Kokoro 82M q8 → WAV) | PASS | PASS |
| **Image** via app API, CPU backend (SD 1.5 Q4_0) | PASS: 256×256, 4 steps, 43 s | PASS: 256×256, 4 steps, 355 s (see below) |
| Image via app API, Metal backend | UNSUPPORTED on the runner: ggml-metal aborts with `unsupported op 'NORM'` on "Apple Paravirtual device" | UNSUPPORTED on the runner (same) |
| Metal GPU inference on real hardware | **UNVERIFIED** (needs a physical Apple Silicon Mac, see [RUNNER_REQUIREMENTS.md](RUNNER_REQUIREMENTS.md)) | **UNVERIFIED** |
| Core ML / ANE | **UNVERIFIED** (skipped in CI via `USAP_SKIP_COREML=1`) | not applicable |
| Packaged release per architecture | none (no packaging pipeline yet) | none |

What the image check proves: the app API loaded the model, generated, and returned a PNG of
the requested size with non-trivial content. It doesn't judge quality. SD 1.5 at 256 px
and 4 steps gives a rough image by design. With the same seed and CPU RNG, Linux x64,
Windows x64 and macOS arm64 produced the same composition (mean abs. pixel difference ≈9–14/255,
normal float divergence across CPUs), which is consistent with the same model really running.

Test models are pinned by revision and SHA-256 (see `scripts/ci/runtime-validate.sh`). They
are downloaded on the runner only and never uploaded.

## Image generation on macOS: what changed in #9

* **Intel install:** stable-diffusion.cpp publishes one macOS archive (named arm64). Its `sd`,
  `sd-cli` and `libstable-diffusion.dylib` are universal. Setup now installs it on Intel too,
  and keeps it only if `lipo` shows `x86_64` in the binary **and every dylib**. Otherwise it
  removes it, and the UI/API explain why image generation is unavailable.
* **CPU image backend on macOS:** the same binary always contains ggml's CPU backend.
  macOS now offers **CPU** next to **Metal GPU** (`--backend cpu --params-backend cpu`).
  CPU is the default on Intel Macs, where Metal image generation is unverified. Apple Silicon
  keeps Metal as the default.

## Intel performance limitation

The x86_64 slice of the upstream universal `libstable-diffusion.dylib` is built for baseline
x86-64: `ggml_cpu_has_avx`, `_avx2`, `_fma` and `_f16c` return 0, and the code has no YMM
instructions (checked by disassembling the slice of the pinned, SHA-verified archive).
Measured on `macos-15-intel` (i7-8700B, 4 vCPU) with the pinned model, 256×256, 4 steps, CPU
(experiment runs [42716998780](https://github.com/dlroqa/usap/actions/runs/42716998780) and
[42723239546](https://github.com/dlroqa/usap/actions/runs/42723239546)):

| Binary | Threads | Sampling | Wall time |
|---|---|---|---|
| Upstream universal (SSE3 x86_64 slice) | 8 (the app's old default) | ~430 s/it | >600 s (capped) |
| Upstream universal | 4 | ~84 s/it, 147 s | 239 s |
| Native build of the same pinned tag (`build_from_source.sh`, `GGML_NATIVE=ON`, 354 s build) | 4 | 43.6 s | 67 s |

Two fixes follow from this:
* **Thread oversubscription (fixed in #9):** the app passed `--threads 8` to the image engine regardless
  of the machine, which made generation ~5× slower on 4-core Macs. The spawned thread count is now capped
  at the logical CPU count. Inside the app this took Intel from a >30 min timeout to 355 s, and Apple Silicon from
  162 s to 43 s.
* **SSE3-only binary (open, owner decision):** a native x86_64 build is a further 3–4× faster. Options:
  (a) ship a CI-built, provenance-recorded x86_64 build (fits Step 10 packaging), or (b) offer an
  opt-in local build on Intel Macs via the existing `build_from_source.sh` (needs Xcode Command Line
  Tools and CMake; ~6 min). Neither is implemented.

## Remaining gaps
* **Metal / GPU:** needs a physical Apple Silicon Mac (self-hosted runner) to verify GPU
  offload for the LLM (`gpuLayers > 0`), whisper and SD.
* **Intel image speed:** the native x86_64 build (see above) is an owner decision.
* **Packaging:** no signed per-arch release artifacts yet.

## Runner lifecycle
The owner's plan states that `macos-15-intel` remains available only until about August 2027. Before then,
re-check GitHub's runner-images announcements, and plan a self-hosted Intel Mac runner (or
drop Intel support by explicit owner decision). Don't silently remove the `macos-x86_64`
required check.
