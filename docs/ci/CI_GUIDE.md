# CI guide

## `ci.yml` (required check)
Triggers: every pull request, pushes to `main`, manual dispatch. Permissions: `contents: read` only. No secrets, no model downloads.

| Step | What it proves |
|---|---|
| `npm ci` in `app/frontend` | the lockfile installs reproducibly (fails if it is missing or out of sync) |
| `node --check` on server/search/worker/test scripts | no syntax errors in code that isn't bundled |
| `npm run build` + output checks | the Vite build succeeds, `index.html` references the entry bundle, no source maps ship |
| `node --test "scripts/tests/*.test.cjs"` | upstream regressions, model-kind detection, and security regressions, including a real `serve.cjs` boot on a random port with no models |

Matrix: `ubuntu-24.04`, `windows-2025`, `macos-15`, on Node **22.12.0** (the version the portable launchers install).
Artifacts (7-day retention): `test-results-<os>` (JUnit XML) and `frontend-dist` (web assets only; **not** a portable app bundle).

## What CI does *not* prove
Inference with real models, GPU/NPU backends, or the full first-run launcher setup (it downloads multi-GB runtimes). See `RUNNER_REQUIREMENTS.md` (PR 03).

## Running the same commands locally
```bash
cd app/frontend && npm ci && npm run build && cd ../..
node --test "scripts/tests/*.test.cjs"
```
Note: `node --test scripts/tests/` (directory form) does not work on Node 22; use the quoted glob.

## Policies
* Third-party actions are pinned to full commit SHAs; bump them deliberately in a dedicated PR.
* No `continue-on-error` on required jobs. Never weaken a test to get green.
