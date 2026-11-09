# Priorities & PR sequence

Order: (1) preserve existing functionality and UI → (2) build/test/release gates in GitHub Actions → (3) hardening/modularity → (4) optional features.

| PR | Scope | Depends on | Status |
|---|---|---|---|
| 00 | Import with provenance + audit docs | — | merged (#1) |
| 01 | **Security first:** static path confinement, origin/host policy (S-1..S-3) + regression tests + `ci.yml` (build, existing tests, backend smoke) | 00 | merged (#2); dual-arch macOS CI in #3 |
| 02 | Playwright render/E2E against the real built UI + mock API; original-UI screenshot baselines; `UI_PRESERVATION_BASELINE.md` | 01 | in review |
| 03 | `cross-platform.yml` (ubuntu/windows/macos boot + launcher syntax), `security.yml` (CodeQL, audit, secret scan), guarded `release.yml` | 01 | |
| 04 | Medium security backlog S-4..S-10 | 01 | |
| 05+ | Modularity, lifecycle/queue, then optional cloud/router (feature-flagged, off by default) | 02, 03 | |

The sequence changed from the original plan: the security fixes moved ahead of the general CI build-out because S-1/S-2 are high severity, and the owner asked for them first (2026-11-09).

## Proposed follow-ups awaiting owner approval
* D-1/D-3 chat stream flush race fix (see `docs/audit/UI_PRESERVATION_BASELINE.md`).
* D-2 mobile sidebar layout (behaviour/layout change, needs a spec).
* ~~B-1 Intel macOS first-time setup~~ (approved; PR #5).
