# API contract tests (Step 9.1)

`scripts/tests/api-contract.test.cjs` pins the local server's API behaviour before any backend
refactoring. It runs in `ci.yml` (the `build-test` required check) on Windows x64, Linux x64,
macOS arm64 and macOS Intel.

## How it works
* `harness.cjs` copies `scripts/` into a fresh temp root with empty `app/` data folders and
  starts `serve.cjs` there. Every port (`PORT`, `LLM_PORT`, `BACKEND_PORT`, `SPEECH_PORT`,
  `TTS_PORT`) is free and random. No request can touch the checkout's real models, chats or outputs,
  and the server and everything it spawned are killed afterwards.
* `routes.cjs` lists the covered calls. `contract.json` records, for each one, its status code,
  content type and **response shape** (key names and value types, not values).
* A missing key, a changed type or a changed status code fails. **Extra keys pass**, because additive
  changes are compatible.
* `depth: 1` pins only the top-level keys of payloads whose nested content depends on the OS or
  hardware (health, diagnostics, hardware specs, backend options…).

## What is covered
| Area | Tests |
|---|---|
| Route availability, status codes, response schemas | 26 GET routes, plus successful POSTs (stop, cancel, cleanup…) |
| Invalid input and failure conditions | 28 calls: empty/invalid bodies, malformed JSON, unknown routes, wrong method |
| Error format | every error has a non-empty `error` string, and `ok: false` where `ok` is present |
| Origin / Host security | foreign `Origin` refused on every GET route and on state-changing POSTs (nothing changes), no CORS headers, foreign `Host` refused, preflight refused, same-origin allowed |
| File confinement | traversal attempts against delete/read routes can't delete or read sentinel files outside the data folders |
| Model management, configuration | model files are listed, deleted by name (only that file), 404 when gone; conversations save → list → delete |
| Engines unavailable | whisper, Kokoro, image and chat requests fail with an explanation; the server keeps serving |
| Streaming format | `/api/llm/chat` streams OpenAI-style SSE (`data:` chunks, `finish_reason`, `data: [DONE]`) and non-stream JSON, through a fake `llama-server` (`fake-llama-server.cjs`). Linux and macOS only: Windows needs a real `.exe`, so that test is skipped there with that reason |

Not covered here (needs network, native dialogs or real engines): downloads, Hugging Face
search, `pick-model-file`, real inference. Real inference is covered by `native-runtime.yml`.

## Changing the contract deliberately
1. Make the API change, keeping it additive where possible.
2. Run `node scripts/tests/api-contract/record.cjs` to re-record `contract.json`.
3. In the PR, explain every changed entry in `contract.json` and why existing clients (the
   frontend) still work. Never re-record just to make a failing test pass.

Current behaviour that is recorded as-is, for Step 9.7 (error consistency) to address with an
additive change:
* Some invalid-input errors return **500** instead of 400 (`llm/start`, `llm/delete-conversation`, `llm/import-model`, `import-model`, `save-output`, `llm/benchmark`).
* `delete-model`, `download-model` and `output-file` errors have no `ok` field.
