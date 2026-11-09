# macOS compatibility: Apple Silicon (arm64) and Intel (x86_64)

**Status: macOS support is NOT complete.** Text, speech and voice run with real inference on both native architectures (CPU). Image generation works on neither in CI: it is unsupported on Intel, and unverified on Apple Silicon. Metal/GPU acceleration is unverified.

## Evidence by architecture
Runtime rows: `macos-setup.yml` run [42669660908](https://github.com/dlroqa/usap/actions/runs/42669660908) on PR #5 (`7e7e324`): fresh checkout → `mac.sh` first launch (real setup) → validation → second launch.

| Gate | macOS arm64 (`macos-15`, Apple M1 VM) | macOS x86_64 (`macos-15-intel`, Core i7-8700B) |
|---|---|---|
| Native hardware, no Rosetta (`hw.optional.arm64`, `proc_translated`) | PASS | PASS |
| Node build/tests, browser UI gate (`ci.yml`, `render-e2e.yml`) | PASS | PASS |
| First-time setup via `mac.sh` | PASS | PASS (was `exit 1`, blocker B-1, fixed in #5) |
| Second launch without re-running setup | PASS | PASS |
| Portable Node 22.12.0 binary arch + startup | arm64 PASS | x86_64 PASS |
| llama-server (b11418) arch + startup | arm64 PASS | x86_64 PASS |
| whisper-cli (Homebrew) arch + startup | arm64 PASS | x86_64 PASS |
| Kokoro native addons (onnxruntime-node 1.21.0, sharp 0.34.5) load | arm64 PASS | x64 PASS |
| **LLM inference** via app API (Qwen2.5-0.5B-Instruct Q4_K_M, `gpuLayers: 0`) | PASS (CPU) | PASS (CPU) |
| **Speech inference** via app API (whisper tiny.en, JFK sample) | PASS | PASS |
| **TTS inference** via app API (Kokoro 82M q8 → WAV) | PASS | PASS |
| Image backend `sd` binary | present, starts (`lipo`: `x86_64 arm64`) | intentionally not installed; the UI/API explain why |
| Image generation inference | **UNVERIFIED** (no small license-clear SD model in CI) | **UNSUPPORTED** |
| Metal GPU offload (LLM/whisper/SD) | **UNVERIFIED** (CI VM, CPU-only test) | not applicable / unverified |
| Core ML / ANE | **UNVERIFIED** (skipped in CI via `USAP_SKIP_COREML=1`) | not applicable |
| Packaged release per architecture | none (no packaging pipeline yet) | none |

Test models are pinned by revision and SHA-256 (see `scripts/ci/macos-runtime-validate.sh`); they're downloaded on the runner only and never uploaded.

## Remaining gaps
* **Intel image generation:** stable-diffusion.cpp's release asset is named arm64, but the `sd` binary inside is **universal** (`x86_64 arm64`). Intel support may be achievable. Its bundled dylibs' architectures and Metal-on-Intel behaviour are not yet examined. Follow-up: inspect the archive on the Intel runner and run a CPU generation smoke test before enabling it.
* **Metal / GPU:** needs provisioned Apple Silicon hardware (self-hosted runner) to validate GPU offload and image inference.
* **Packaging:** no signed per-arch release artifacts yet (release pipeline, PR 03).

## Runner lifecycle
The owner's plan states that `macos-15-intel` remains available only until about August 2027. Before then: re-check GitHub's runner-images announcements, and plan a self-hosted Intel Mac runner (or drop Intel support by explicit owner decision). Don't silently remove the `macos-x86_64` required check.
