# Threat model (public summary)

> Detailed reproduction steps for unfixed issues are deliberately **not** published here.
> They go to the upstream maintainer through private coordinated disclosure.

## Assets
Local chat history, transcriptions, generated media, model files (multi-GB), local filesystem, and the user's machine (child-process execution).

## Trust boundaries
1. Browser ⇄ `serve.cjs`. **Any web page the user visits can send requests to `localhost`**, so origin policy is a security boundary.
2. LAN ⇄ `serve.cjs`, only when `UAIS_HOST` is set. There is no authentication.
3. Local non-browser processes ⇄ `serve.cjs`.
4. `serve.cjs` → the internet (HF search/download, web search, page fetch, runtime downloads).
5. `serve.cjs` → native child processes (argument construction).

## Findings

| ID | Area | Severity | Status |
|---|---|---|---|
| S-1 | Static file serving path confinement | High | Fixed in PR 01 (`scripts/server/request-policy.cjs`, tests in `scripts/tests/security-regressions.test.cjs`) |
| S-2 | Cross-origin request policy for the local API | High | Fixed in PR 01 (regression tests in CI) |
| S-3 | DNS-rebinding protection (Host header validation) | Medium | Fixed in PR 01 |
| S-4 | Page-fetch SSRF guard: DNS check and connection are separate lookups | Medium | Fixed in Step 9.3 (`scripts/server/net-guard.cjs`, tests in `scripts/tests/ssrf.test.cjs`); the guard also covers downloads and Hugging Face lookups |
| S-5 | Search-provider redirects: unbounded and target unvalidated | Medium | Fixed in Step 9.3 (bounded, every hop validated) |
| S-6 | No integrity verification (checksum/signature) of downloaded native runtimes | Medium | Fixed in Step 9.4: pinned SHA-256 + size for engines, Node.js (publisher-signed) and catalog models (`scripts/server/integrity.cjs`, `scripts/setup/verify-download.*`; tests in `scripts/tests/*integrity*.test.cjs`). Coverage and remaining unverified sources: `docs/security/DOWNLOAD_INTEGRITY.md` |
| S-7 | No authentication when LAN mode (`UAIS_HOST`) is enabled | Medium (opt-in) | Backlog (PR 04) |
| S-8 | One shell-string `execSync(unzip …)` built from a server-derived path | Low | Fixed in Step 9.4 (`execFileSync` with an argument list) |
| S-9 | Request bodies parsed as JSON regardless of Content-Type | Low (mitigated by S-2 fix) | Backlog |
| S-10 | Setup uses `npm install`, not `npm ci` (lockfile not enforced) | Low | Open: deferred from Step 9.4, because `npm ci` deletes `node_modules` on every run and would change the portable per-OS `node_modules` swap. npm still checks lockfile `sha512` integrity; CI uses `npm ci`. Needs an owner decision |
| S-11 | Native engine ports (llama-server, sd-server, …) are loopback-bound but directly reachable by local pages; their own CORS policy is not controlled by serve.cjs | Medium | Backlog: needs binaries to verify (U) |

## Existing controls (verified by code)
Loopback bind by default; 64 MB JSON body cap; `basename` + `pathInside` checks on model/output/TTS file routes; an SSRF guard on page fetch (scheme + private-range checks).
