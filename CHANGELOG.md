# Changelog (usap)

## Unreleased
### Security
* The local server now refuses requests that carry a foreign `Origin`, and (when bound to loopback) a non-loopback `Host`. Wildcard CORS headers are removed. The built-in UI is same-origin and is unaffected.
* Static file serving is confined to `app/dist/`.
### Compatibility
* **Browser-based third-party tools** on another origin that called the studio API (e.g. `/v1/*`) are now refused. To allow one, set `UAIS_ALLOWED_ORIGINS=https://tool.example` (comma-separated); only those origins receive CORS headers.
* If you reach a loopback-bound server through a custom hostname, add it with `UAIS_ALLOWED_HOSTS`.
* Non-browser clients (curl, scripts, SDKs), which send no `Origin`, are unaffected. LAN mode (`UAIS_HOST=0.0.0.0`) still works for same-origin use.
### Fixes
* Chat: a finished or failed reply is no longer overwritten by a late streaming update. An error message stays visible, and a finished reply no longer shows "Thinking..." (#6).
* Accessibility: the image-size control's accessible name now starts with its visible label (WCAG 2.5.3) (#7).
* Mobile (≤640 px): the sidebar is an overlay drawer that starts closed and closes on navigation, instead of squeezing the content. Desktop is unchanged (#8).
### Platform support
* macOS Intel: first-time setup no longer fails (#5). Image generation is now installed on Intel Macs when setup verifies an x86_64 build of the engine (#9).
* macOS: a **CPU** image backend is offered next to Metal; it's the default on Intel Macs (#9).
* Image generation never runs more threads than the machine has logical CPUs. This was a ~4–5× slowdown on 4-core Macs (#9).
* Verified with real models in CI: chat, speech-to-text, text-to-speech and image generation on the CPU on Windows x64, Linux x64, macOS arm64 and macOS Intel. GPU backends remain unverified (#9).
### CI
* Added `.github/workflows/ci.yml` (build + tests on Linux, Windows, macOS arm64 and macOS x86_64, with native-hardware checks) (#2, #3).
* Added `.github/workflows/render-e2e.yml` and `tests/e2e/` (Playwright): original-UI pixel baselines per render target, behaviour, accessibility and live-backend tests (#4).
* Added `.github/workflows/native-runtime.yml`: real first-time setup and real inference on 4 platforms (#5, #9).
* Added `.github/workflows/docs.yml`: documentation consistency (links, attribution and license notice, evidence for GPU claims, planned items labelled as planned, README review for user-facing PRs).
### Documentation
* The README now describes USAP as its own project, with origins, credits and attribution to Portable Local Studio by techjarves. The original README is kept verbatim as `docs/USAGE_UPSTREAM.md`.
* Roadmap: desktop installers (planning only), Step 9 backend plan (#10, #11).

## Imported
* techjarves/Portable-Local-Studio @ a55c42c (see docs/audit/IMPORT_PROVENANCE.md).
