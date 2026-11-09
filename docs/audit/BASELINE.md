# Baseline (upstream a55c42c, before any usap change)

Legend: **R** = verified by run · **C** = verified by reading code · **D** = documented only (README) · **U** = unverified

## Environment used
Linux x86_64 (Ubuntu-family), Node v22.23.1, npm 10.9.8, no GPU, no models downloaded.
The portable runtime that the launchers download is Node **22.12.0** (`scripts/setup/setup.sh:50`).

## Results

| Check | Command | Result | Ev |
|---|---|---|---|
| Install from lockfile | `cd app/frontend && npm ci` | pass, 31 packages, 0 vulnerabilities (`npm audit`) | R |
| Production build | `npm run build` (Vite 8) | pass, ~1 s; writes `app/dist/`; warns that the main chunk is 704 kB | R |
| Upstream regression tests | `node --test scripts/tests/issue-regressions.test.cjs` | 29/29 pass (**3 fail without `npm ci`**: `api.js` imports `@tauri-apps/api`) | R |
| Model-kind tests | `node --test scripts/tests/model-kind.test.cjs` | 8/8 pass | R |
| `node --test scripts/tests/` (directory form) | — | fails: Node 22 treats it as a module path; use a glob or explicit files | R |
| Server boot, no models | `PORT=14200 node scripts/server/serve.cjs` | listens on 127.0.0.1, serves UI; `/api/health`, `/api/llm/status`, `/api/models`, `/api/llm/models`, `/api/llm/conversations` → 200; unknown `/api/*` → 404 JSON | R |
| Inference (LLM, SD, Whisper, Kokoro) | — | needs native binaries + models | U |
| Windows / macOS launchers | `windows.bat`, `mac.sh` | not run here | U |
| Linux launcher full setup | `linux.sh` | not run (downloads multi-GB runtimes) | U |
| Desktop (Tauri) build | — | **does not exist**: no `src-tauri/`; the `@tauri-apps/*` deps are vestigial, and `invoke` is used only behind runtime checks | C |

## Known limitations / defects found
1. No CI, no workflows, no branch protection on usap `main`. (R, via GitHub API)
2. `scripts/__pycache__/openvino_npu_worker.cpython-313.pyc` is committed upstream (a generated binary). (C)
3. The setup scripts use `npm install`, not `npm ci`, so the lockfile is not enforced on user machines. (C)
4. Downloaded native runtimes (llama.cpp, stable-diffusion.cpp, whisper.cpp, Node, Python) get **no checksum verification**. (C)
5. Two high-severity request-handling issues were found and are tracked privately; they are fixed in PR 01. See `SECURITY_THREATS.md`.
