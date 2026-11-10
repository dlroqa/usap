# Changelog (usap)

## Unreleased
### Security
* The local server now refuses requests that carry a foreign `Origin`, and (when bound to loopback) a non-loopback `Host`. Wildcard CORS headers are removed. The built-in UI is same-origin and is unaffected.
* Static file serving is confined to `app/dist/`.
* Outbound requests (web search, page fetching, model and engine downloads, Hugging Face lookups) can only reach public internet addresses. Each redirect is validated and the number of redirects is limited. The address checked is the address connected to. Search and normal downloads are unaffected (Step 9.3).
* Downloads are verified (Step 9.4). Engines, the portable Node.js and catalog models must match SHA-256 digests and sizes pinned in `scripts/config/download-digests.txt`; Node.js digests come from its GPG-signed checksum list. Other downloads are labelled `source-checksum` (transfer integrity only) or `unverified`. Files stream to a temporary file and replace the old one atomically only after verification, so a failed, interrupted or tampered download keeps the last-known-good file. Engine installs are staged, checked for the right CPU architecture and swapped in whole. Interrupted transfers are retried from the start, never resumed. See `docs/security/DOWNLOAD_INTEGRITY.md`.
* The in-app model download no longer builds a shell command for unzipping (S-8).
### Compatibility
* **Download status** (`GET /api/download-progress`) gains two additive fields, `integrity` (`verified`, `source-checksum` or `unverified`) and `sha256`. Existing fields are unchanged. Failed downloads now delete their partial file, so the "Delete and retry" hint became "Retry the download".
* A download whose pinned digest doesn't match is refused. Setup stops with an integrity error instead of installing the file.
* **Model downloads from private-network hosts** (e.g. a NAS mirror) are now refused by default. Set `USAP_ALLOW_LAN_DOWNLOADS=1` to allow them. Loopback, cloud-metadata addresses and this machine's own network addresses are always refused (Step 9.3).
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
* Added API contract tests (`scripts/tests/api-contract.test.cjs`, run by `ci.yml` on all 4 platforms). They pin 61 API calls (status codes, response shapes, errors) and test Origin/Host security, file confinement, model and conversation operations, behaviour without engines and the chat streaming format, against an isolated copy of the server (#13). Chat streaming tests (chunk order, engine errors before and during a stream, client disconnect, engine cleanup) now also run on Windows through a stand-in engine compiled at test time (#14, #17).
* Added `.github/workflows/docs.yml`: documentation consistency (links, attribution and license notice, evidence for GPU claims, planned items labelled as planned, README review for user-facing PRs).
### Internal
* Step 9.2: all user-data folders (models, chats, settings, outputs, caches) now come from one resolver, `scripts/server/paths.cjs`. The portable/USB layout is unchanged byte for byte: same `<root>/app/...` folders, nothing moved or deleted. A per-user installed-edition layout is prepared for the future desktop installers but not enabled.

### Documentation
* The README now describes USAP as its own project, with origins, credits and attribution to Portable Local Studio by techjarves. The original README is kept verbatim as `docs/USAGE_UPSTREAM.md`.
* Roadmap: desktop installers (planning only), Step 9 backend plan (#10, #11).

## Imported
* techjarves/Portable-Local-Studio @ a55c42c (see docs/audit/IMPORT_PROVENANCE.md).
