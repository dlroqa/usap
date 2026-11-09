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
| S-1 | Static file serving path confinement | High | Fixed in PR 01 (regression tests in CI) |
| S-2 | Cross-origin request policy for the local API | High | Fixed in PR 01 (regression tests in CI) |
| S-3 | DNS-rebinding protection (Host header validation) | Medium | Fixed in PR 01 |
| S-4 | Page-fetch SSRF guard: DNS check and connection are separate lookups | Medium | Backlog (PR 04) |
| S-5 | Search-provider redirects: unbounded and target unvalidated | Medium | Backlog (PR 04) |
| S-6 | No integrity verification (checksum/signature) of downloaded native runtimes | Medium | Backlog (PR 03/04) |
| S-7 | No authentication when LAN mode (`UAIS_HOST`) is enabled | Medium (opt-in) | Backlog (PR 04) |
| S-8 | One shell-string `execSync(unzip …)` built from a server-derived path | Low | Backlog (PR 04) |
| S-9 | Request bodies parsed as JSON regardless of Content-Type | Low (mitigated by S-2 fix) | Backlog |
| S-10 | Setup uses `npm install`, not `npm ci` (lockfile not enforced) | Low | Backlog |

## Existing controls (verified by code)
Loopback bind by default; 64 MB JSON body cap; `basename` + `pathInside` checks on model/output/TTS file routes; an SSRF guard on page fetch (scheme + private-range checks).
