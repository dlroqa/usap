# Changelog (usap)

## Unreleased
### Security
* The local server now refuses requests that carry a foreign `Origin`, and (when bound to loopback) a non-loopback `Host`. Wildcard CORS headers are removed. The built-in UI is same-origin and is unaffected.
* Static file serving is confined to `app/dist/`.
### Compatibility
* **Browser-based third-party tools** on another origin that called the studio API (e.g. `/v1/*`) are now refused. To allow one, set `UAIS_ALLOWED_ORIGINS=https://tool.example` (comma-separated); only those origins receive CORS headers.
* If you reach a loopback-bound server through a custom hostname, add it with `UAIS_ALLOWED_HOSTS`.
* Non-browser clients (curl, scripts, SDKs), which send no `Origin`, are unaffected. LAN mode (`UAIS_HOST=0.0.0.0`) still works for same-origin use.
### CI
* Added `.github/workflows/ci.yml` (build + tests on Linux, Windows, macOS arm64 and macOS x86_64).
* Added `.github/workflows/render-e2e.yml` and `tests/e2e/` (Playwright): original-UI pixel baselines per render target, behaviour, accessibility and live-backend tests. No application changes.

## Imported
* techjarves/Portable-Local-Studio @ a55c42c (see docs/audit/IMPORT_PROVENANCE.md).
