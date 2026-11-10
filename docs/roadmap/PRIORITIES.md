# Priorities & PR sequence

Order: (1) preserve existing functionality and UI → (2) build/test/release gates in GitHub Actions → (3) hardening/modularity → (4) packaging and release → (5) optional features.

| PR | Scope | Depends on | Status |
|---|---|---|---|
| 00 | Import with provenance + audit docs | — | merged (#1) |
| 01 | **Security first:** static path confinement, origin/host policy (S-1..S-3) + regression tests + `ci.yml` (build, existing tests, backend smoke) | 00 | merged (#2); dual-arch macOS CI merged (#3) |
| 02 | Playwright render/E2E against the real built UI + mock API; original-UI screenshot baselines; `UI_PRESERVATION_BASELINE.md` | 01 | merged (#4) |
| — | Intel macOS first-time setup (B-1) | 01 | merged (#5) |
| — | Approved UI defect fixes: D-1/D-3 chat flush race, A-1 image-size label, D-2 mobile sidebar | 02 | merged (#6, #7, #8) |
| 03 | `cross-platform.yml` (ubuntu/windows/macos boot + launcher syntax), `security.yml` (CodeQL, audit, secret scan), guarded `release.yml` | 01 | |
| 04 | Medium security backlog S-4..S-10 | 01 | |
| 05+ | Modularity, lifecycle/queue, then optional cloud/router (feature-flagged, off by default) | 02, 03 | |

The sequence changed from the original plan: the security fixes moved ahead of the general CI build-out because S-1/S-2 are high severity, and the owner asked for them first (2026-11-09).

## Development steps 8–12

| Step | Scope | Gate to start | Status |
|---|---|---|---|
| 8 | **Native inference verification:** real LLM, Whisper, Kokoro and image inference on Windows x64, Linux x64, macOS arm64, macOS x86_64 (`native-runtime.yml`); GPU paths recorded as UNSUPPORTED/UNVERIFIED with reasons | — | in progress (draft PR #9) |
| 9 | **Foundational backend:** modular services, model/engine lifecycle, API reliability, security backlog (S-4..S-10), benchmarks; **data-root resolver and storage safety** needed for packaging; then optional cloud/routing (off by default) | Step 8 complete | not started |
| 10 | **Desktop installers** (mandatory for production release): portable/USB plus installed editions from one codebase and UI | Steps 8 and 9 complete and validated | **planning only**, see [DESKTOP_INSTALLERS.md](DESKTOP_INSTALLERS.md) |
| 11 | Installation and release testing in GitHub Actions: install, first launch, upgrade, uninstall, data preservation, signing/notarization | Step 10 | not started |
| 12 | Production release validation: architecture-specific artifacts; documented platforms and capabilities | Step 11; explicit owner authorization to publish | not started |

**Release readiness:** Portable Local Studio is not production-release-ready until both
the portable/USB edition and the installed desktop edition (Windows `.exe`/`.msi`, Linux
AppImage/`.deb`, macOS arm64 and Intel `.dmg`) pass their validation, including real inference
on each OS/arch. A successful package build isn't proof of working inference.

Throughout: the existing UI, features and portable/USB execution are preserved, and
GitHub Actions stays the primary build/test/release platform. Repository backups stay on the
verified local machine only.

## Proposed follow-ups awaiting owner approval
* ~~D-1/D-3 chat stream flush race fix~~ (approved; merged #6).
* ~~D-2 mobile sidebar layout~~ (approved; merged #8).
* ~~B-1 Intel macOS first-time setup~~ (approved; merged #5).
* Intel macOS image speed: ship a native x86_64 stable-diffusion.cpp build (see [MACOS_COMPATIBILITY.md](../ci/MACOS_COMPATIBILITY.md) once #9 lands).
