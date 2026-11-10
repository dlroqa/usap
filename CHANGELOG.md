# Changelog (usap)

## Unreleased
### Security
* The local server now refuses requests that carry a foreign `Origin`, and (when bound to loopback) a non-loopback `Host`. Wildcard CORS headers are removed. The built-in UI is same-origin and is unaffected.
* Static file serving is confined to `app/dist/`.
* Outbound requests (web search, page fetching, model and engine downloads, Hugging Face lookups) can only reach public internet addresses. Each redirect is validated and the number of redirects is limited. The address checked is the address connected to. Search and normal downloads are unaffected (Step 9.3).
* Downloads are verified (Step 9.4). Engines, the portable Node.js and catalog models must match SHA-256 digests and sizes pinned in `scripts/config/download-digests.txt`; Node.js digests come from its GPG-signed checksum list. Other downloads are labelled `source-checksum` (transfer integrity only) or `unverified`. Files stream to a temporary file and replace the old one atomically only after verification, so a failed, interrupted or tampered download keeps the last-known-good file. Engine installs are staged, checked for the right CPU architecture and swapped in whole. Interrupted transfers are retried from the start, never resumed. See `docs/security/DOWNLOAD_INTEGRITY.md`.
* The in-app model download no longer builds a shell command for unzipping (S-8).
* **Sign-in for network sharing** (Step 9.5, S-7, #25). When the server listens beyond loopback (`UAIS_HOST`), every request from another device needs the access token, either through a server-rendered sign-in page (an `HttpOnly`, `SameSite=Strict` session cookie) or as `Authorization: Bearer`. The token is random (256 bits) and kept in `app/config/lan-access-token`; it is never logged or accepted in a URL. `node scripts/server/lan-auth.cjs rotate` signs everyone out, and `revoke` refuses all network access; both apply without a restart. Failed attempts are rate limited per client. The studio no longer forwards cookies or `Authorization` to its local image engine. The token file is restricted to the current user (mode 0600, or a Windows ACL without inherited, `Users` or `Everyone` entries), with a startup warning on drives without permissions (FAT/exFAT). Requests carrying proxy headers never get the local exemption, and throttling ignores forwarding headers. See `docs/security/LAN_ACCESS.md`.
* JSON API routes require `Content-Type: application/json` (S-9). Other declared types and untyped bodies get `415`; a `POST` without a body still works.
### Reliability
* **Engine supervision** (Step 9.6, #29). Every chat, image, speech and voice engine runs under a small guard process (`scripts/server/engine-guard.cjs`) that stops it when the studio server goes away for any reason. On Linux and macOS, a crash or `SIGKILL` used to leave the engine running with its memory and port. Windows already ended engines with the server, through Node's job object. Stops are polite first, then forced after 3 s (`USAP_ENGINE_STOP_GRACE_MS`), and wait for the port to be free. Exit codes and crash signals (e.g. Metal `SIGABRT`) still reach the server.
* A text engine that crashes after loading is restarted with the same settings after 1 s, 2 s and 4 s, at most 3 times in 10 minutes (`USAP_ENGINE_AUTO_RESTART=0` turns this off). After that, chat explains what happened. An engine that ran out of memory is never restarted (allocation errors, Windows `STATUS_NO_MEMORY`, or less free RAM than the model needs), and neither is one stopped on purpose.
* Stopping the text engine during a model load cancels it at once, instead of waiting for the load to finish, and no fallback backend is tried afterwards. `USAP_LLM_READY_TIMEOUT_MS` overrides the load timeout.
* An unexpected image-engine crash signal is reported as a clear error.
### Reliability (Step 9.7, #35)
* **One error model for the API** (`scripts/server/errors.cjs`). Error responses keep `{ ok: false, error }` and any route-specific fields, and add a machine-readable `code`. Statuses follow the cause: 400 invalid request, 404 missing item, 409 wrong state, 503 engine not installed, 500 server or engine failure. See `docs/runtime/API_ERRORS.md`.
* A request that triggers an unexpected error in a route is answered with a generic `500 INTERNAL_ERROR`, and the server keeps running. Wrongly typed request fields get `400 INVALID_REQUEST`. JSON bodies that aren't objects (`null`, arrays, numbers, strings) get `400` instead of no answer.
* Error messages never include stack traces or internal Node.js text. Absolute paths are shortened (studio-relative, `~` for the home folder).
### Compatibility
* **Ten error paths changed status** from 500 to 400, 404, 409 or 503 (Step 9.7; table in `docs/runtime/API_ERRORS.md`). Shapes and messages are unchanged, and the interface is unaffected. Scripts that checked for `500` on these paths should check `ok: false` or the new `code`.
* Additive API fields (Step 9.6): `GET /api/llm/status` → `engine` (state, restarts, last exit); `GET /api/diagnostics` → `engines`; chat `409` responses gain a `code` (`ENGINE_NOT_READY`, `ENGINE_STARTING`, `ENGINE_RESTARTING`, `ENGINE_CRASHED`); a cancelled load answers `409` with `code: "ENGINE_START_CANCELLED"`. Existing fields and messages are unchanged.
* **Download status** (`GET /api/download-progress`) gains two additive fields, `integrity` (`verified`, `source-checksum` or `unverified`) and `sha256`. Existing fields are unchanged. Failed downloads now delete their partial file, so the "Delete and retry" hint became "Retry the download".
* A download whose pinned digest doesn't match is refused. Setup stops with an integrity error instead of installing the file.
* **Model downloads from private-network hosts** (e.g. a NAS mirror) are now refused by default. Set `USAP_ALLOW_LAN_DOWNLOADS=1` to allow them. Loopback, cloud-metadata addresses and this machine's own network addresses are always refused (Step 9.3).
* **Browser-based third-party tools** on another origin that called the studio API (e.g. `/v1/*`) are now refused. To allow one, set `UAIS_ALLOWED_ORIGINS=https://tool.example` (comma-separated); only those origins receive CORS headers.
* If you reach a loopback-bound server through a custom hostname, add it with `UAIS_ALLOWED_HOSTS`.
* Non-browser clients (curl, scripts, SDKs), which send no `Origin`, are unaffected. LAN mode (`UAIS_HOST=0.0.0.0`) still works for same-origin use, now with sign-in for other devices (Step 9.5). The default local-only mode has no sign-in, as before.
* **Scripts posting JSON** must send `Content-Type: application/json` (e.g. `curl -H 'Content-Type: application/json' -d '{...}'`). Plain `curl -d` sends a form type and now gets `415` (S-9).
* **Scripts using a network-shared studio** need `Authorization: Bearer <token>`. `GET /api/auth/status`, `POST /api/auth/login` and `POST /api/auth/logout` are new, additive routes.
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
* Added `scripts/tests/api-errors.test.cjs` (Step 9.7, all 4 platforms): the error model; every corrected status; malformed and non-object bodies; wrongly typed fields on 19 JSON routes without a crash; no path or stack leaks; and the statuses and messages the frontend relies on.
* Added `scripts/tests/engine-supervision.test.cjs` (Step 9.6, all 4 platforms). It shows the original orphan problem with a plainly started engine on Linux and macOS (and the Windows baseline, where Node's job object already ended it), then proves supervised engines stop when the server is killed outright, through the supervisor and through the real server. It also covers polite, forced and immediate stops, exit-code and signal pass-through, failed launches, stdin pass-through, repeated start/stop cycles, crash restarts and the restart limit, cancelled, failed and timed-out loads, concurrent start/stop requests, and diagnostics.
* Added `scripts/tests/lan-auth.test.cjs`: sign-in tests (missing and invalid credentials, tokens in URLs, bearer and browser sign-in, rate limiting, session expiry, token rotation and revocation, the loopback and DNS-rebinding rules, a real non-loopback client, no credentials in logs or engine requests) and JSON content-type tests, on all 4 platforms (Step 9.5).
* Added API contract tests (`scripts/tests/api-contract.test.cjs`, run by `ci.yml` on all 4 platforms). They pin 61 API calls (status codes, response shapes, errors) and test Origin/Host security, file confinement, model and conversation operations, behaviour without engines and the chat streaming format, against an isolated copy of the server (#13). Chat streaming tests (chunk order, engine errors before and during a stream, client disconnect, engine cleanup) now also run on Windows through a stand-in engine compiled at test time (#14, #17).
* Added `.github/workflows/docs.yml`: documentation consistency (links, attribution and license notice, evidence for GPU claims, planned items labelled as planned, README review for user-facing PRs).
### Internal
* Step 9.2: all user-data folders (models, chats, settings, outputs, caches) now come from one resolver, `scripts/server/paths.cjs`. The portable/USB layout is unchanged byte for byte: same `<root>/app/...` folders, nothing moved or deleted. A per-user installed-edition layout is prepared for the future desktop installers but not enabled.

### Documentation
* The README now describes USAP as its own project, with origins, credits and attribution to Portable Local Studio by techjarves. The original README is kept verbatim as `docs/USAGE_UPSTREAM.md`.
* Roadmap: desktop installers (planning only), Step 9 backend plan (#10, #11).

## Imported
* techjarves/Portable-Local-Studio @ a55c42c (see docs/audit/IMPORT_PROVENANCE.md).
