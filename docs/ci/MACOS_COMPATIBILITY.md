# macOS compatibility: Apple Silicon (arm64) and Intel (x86_64)

**Status: macOS support is NOT complete.** Both architectures pass the Node/frontend CI gate and the browser UI gate. Intel first-time setup is blocked (B-1), and no native engine or inference has been verified on either architecture.

## Evidence by architecture

| Gate | macOS arm64 (`macos-15`) | macOS x86_64 (`macos-15-intel`) | Evidence |
|---|---|---|---|
| Runner + Node architecture asserted (`uname -m`, `process.arch`) | CI | CI | `ci.yml` step "Verify runner and Node architecture" |
| `npm ci`, syntax checks, Vite production build | CI | CI | `ci.yml` |
| Unit + security tests, real `serve.cjs` boot (no models) | CI | CI | `ci.yml` |
| Headless UI render + pixel regression (27 states) + behaviour + a11y + live-backend smoke | CI | CI | `render-e2e.yml` `render (macos-arm64)` / `render (macos-x86_64)`, own baselines per arch |
| Launcher `mac.sh` first-time setup | **unverified** | **fails by design (B-1)** | code: `scripts/setup/setup.sh:429-433` |
| Native binary arch (`file`/`lipo -info`) of downloaded engines | unverified | unverified | needs setup to run |
| llama.cpp text inference | unverified (expects Metal) | unverified (x64 CPU build selected, `serve.cjs:1973`) | |
| stable-diffusion.cpp image generation | unverified (Metal arm64 build) | **no x86_64 build is downloaded (B-1)** | |
| whisper.cpp transcription | unverified (Homebrew path) | unverified | `setup-whisper.sh` |
| Kokoro TTS (onnxruntime-node) | unverified | unverified | |
| Core ML / ANE | unverified | not applicable (Apple Silicon only) | |
| Release packages per architecture | none exist | none exist | no packaging pipeline yet |

"CI" means verified in GitHub Actions on that architecture. It does **not** mean the app or its engines work there.

## Blockers
* **B-1 (Intel setup):** `setup.sh` runs `exit 1` on non-arm64 macOS before installing anything else: "The official macOS backend binary is Apple Silicon only (arm64)". The app therefore can't be set up on Intel Macs today, even though llama.cpp ships `macos-x64` builds that `setup-llama.sh` already knows how to fetch.
  *Proposed remediation (needs owner-approved spec, since it changes setup behaviour):* on Intel, skip or disable the image backend with a clear message, or build stable-diffusion.cpp for x86_64 (CPU) in CI with traceable provenance. Install the text, speech and TTS engines, gate the image tab's start action on backend availability, and verify each engine on `macos-15-intel`.
* **B-2:** no CI job runs the launchers or downloads engines yet (PR 03 `cross-platform.yml`).

## Runner lifecycle
The owner's plan states that `macos-15-intel` remains available only until about August 2027. Before then: re-check GitHub's runner-images announcements, and plan a self-hosted Intel Mac runner (or drop Intel support by explicit owner decision). Don't silently remove the `macos-x86_64` required check.
