# Desktop installers: roadmap requirement (planning only)

**Status:** mandatory production-release requirement, added 2026-11-09 by the owner.
**Planning only.** Installer implementation must not start until Step 8 (native inference
verification) and Step 9 (foundational backend improvements) are complete and validated.
No installer code or installer-specific PRs exist yet.

Portable Local Studio is **not production-release-ready** until both distribution methods
below meet their validation requirements.

## 1. Distribution methods (one codebase, one UI)

| Edition | Targets | Format |
|---|---|---|
| **A. Portable / USB** (exists today) | Windows x64, Linux x64, macOS arm64, macOS x86_64 | Folder or drive run via `windows.bat` / `linux.sh` / `mac.sh`, no installation |
| **B. Installed desktop** (to build) | Windows x64 | `.exe` installer or `.msi` |
| | Linux x64 | AppImage and/or `.deb` |
| | macOS Apple Silicon (arm64) | native `.app` in a `.dmg` |
| | macOS Intel (x86_64) | native Intel `.app` in a `.dmg` (separate arch-specific build, or universal if every bundled binary is universal) |

Both editions ship the same server (`scripts/server/serve.cjs`), the same built frontend
(`app/dist`), and the same engines. The UI, navigation, themes, settings and behaviour stay as
they are (the [UI preservation baseline](../audit/UI_PRESERVATION_BASELINE.md) and the
`render-e2e` pixel gates apply to both).

## 2. Constraints found in the current code

These are the architecture points the installed edition depends on. Each maps to a Step 9 item.

1. **Every data path is fixed under `<repo>/app/`.** `serve.cjs` derives models, `llm-models`,
   `chat-history`, `config`, `outputs`, `transcriptions`, `tts-outputs`, the caches and the
   engine directories from `ROOT`. An installed app can't write there: Program Files,
   a signed `.app` bundle and a read-only AppImage mount are all read-only or must stay unmodified.
   → **Step 9: a single data-root resolver.** Portable mode keeps `<root>/app/...` (default,
   unchanged). Installed mode uses per-user OS locations:

   | OS | Installed-edition data root (proposal) |
   |---|---|
   | Windows | `%LOCALAPPDATA%\PortableLocalStudio\` (models and outputs can be large; not Roaming) |
   | Linux | `$XDG_DATA_HOME/portable-local-studio/` (default `~/.local/share/...`), config in `$XDG_CONFIG_HOME` |
   | macOS | `~/Library/Application Support/PortableLocalStudio/`, caches in `~/Library/Caches/...` |

   Mode detection must be explicit (for example a marker file shipped only in the portable
   layout, or an installer-set flag), never guessed from a path. User-chosen model folders must
   keep working.
2. **Engines are downloaded at first launch into `app/`** (llama.cpp, whisper.cpp,
   stable-diffusion.cpp, Node, Kokoro runtime). For installed builds, decide per engine:
   bundle at build time (CI-built, checksum-pinned), or download into the user data root.
   On macOS, binaries downloaded after install carry quarantine attributes and aren't covered
   by the app's notarization.
3. **macOS whisper comes from Homebrew.** On the runners, `whisper-cli` loads `libggml` from
   `/usr/local/Cellar` / `/opt/homebrew/Cellar`. A distributable `.app` can't depend on
   Homebrew; whisper.cpp must be bundled (built in CI) for both architectures.
4. **The macOS image engine.** Upstream publishes one universal archive whose x86_64 slice is
   SSE3-only (no AVX/AVX2). A native x86_64 build of the same pinned tag samples about 3–4×
   faster (see [MACOS_COMPATIBILITY.md](../ci/MACOS_COMPATIBILITY.md)). Installer builds should
   ship CI-built, per-arch engines with recorded provenance.
5. **Node runtime.** The portable edition downloads Node 22.12.0. Installed builds either bundle
   the same Node runtime (plain bundled runtime, or a wrapper like Electron/Tauri only if it adds
   no UI change) or package it. The choice is a Step 10 design decision.
6. **Loopback-only server.** The `request-policy.cjs` Host/Origin rules must hold unchanged
   in both editions. Installed builds must not open firewall ports.
7. **Upgrade and uninstall safety.** Never overwrite or delete user models, conversations,
   settings or generated outputs. Uninstallers remove program files only. Data removal is an
   explicit, separate, user-confirmed action.

## 3. Packaging dependencies (Step 10 inputs, not decided yet)

| Need | Candidates to evaluate |
|---|---|
| Windows installer | WiX (`.msi`) or Inno Setup / NSIS (`.exe`); Authenticode signing |
| Linux | `appimagetool` (AppImage), `dpkg-deb` / `nfpm` (`.deb`); optional GPG-signed repo later |
| macOS | `.app` bundle layout, `codesign` (hardened runtime, entitlements for JIT if needed), `notarytool` + stapling, `hdiutil` / `create-dmg` |
| Credentials | Signing certificates and Apple notarization credentials as GitHub encrypted secrets, used only in a protected `release` environment with manual approval; never in logs, artifacts or PR jobs |

## 4. Schedule (where this sits)

| Step | Scope | Gate to start |
|---|---|---|
| 8 | Native inference verification (chat, image, speech, voice, acceleration backends; record UNSUPPORTED/UNVERIFIED explicitly) | in progress |
| 9 | Foundational backend: modularization, security backlog, API reliability, model lifecycle, **data-root resolver**, storage safety | Step 8 complete |
| 10 | Desktop installers for both editions from the shared codebase | Steps 8 and 9 complete and validated |
| 11 | Installation and release testing in GitHub Actions: build, install, first launch, upgrade, uninstall, data preservation; signing and notarization | Step 10 |
| 12 | Production release validation: architecture-specific artifacts, documented supported platforms and capabilities | Step 11; explicit owner authorization to publish |

## 5. Validation requirements (Steps 10–12)

GitHub Actions stays the primary build, test, render-verification, packaging and
release-preparation platform. **A package that builds is not proof of working inference.**
Every installer job must:

* install the package on a clean runner of the matching OS/arch (native, no Rosetta or
  emulation; same assertions as `native-runtime.yml`)
* launch the installed app, then run `scripts/ci/runtime-validate.sh` against it (real LLM,
  Whisper, Kokoro and image inference where supported; GPU paths recorded per
  [RUNNER_REQUIREMENTS.md](../ci/RUNNER_REQUIREMENTS.md))
* run the `render-e2e` pixel and accessibility gates against the installed app's UI
* upgrade over the previous version and verify models, conversations, settings and outputs
  are byte-identical afterwards
* uninstall and verify the user data root is untouched and program files are removed
* re-run the portable edition's checks to prove it isn't broken by the shared changes

Repository backups stay on the verified local machine only. They're never uploaded to Actions
artifacts, caches, releases or any cloud service.
