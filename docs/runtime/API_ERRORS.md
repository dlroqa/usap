# API errors (Step 9.7)

Every error from the studio's JSON API has the same shape:

```json
{ "ok": false, "error": "Select a downloaded GGUF text model first.", "code": "MODEL_REQUIRED" }
```

* `error` is the human-readable message, the same field as before. The interface shows it as is.
* `code` is machine-readable and additive. A route that already sent `code` (sometimes empty) keeps
  doing so.
* `hint` (optional) suggests what to do next.
* Route-specific fields stay, for example `activeRuntime` on engine starts and `port` on image-engine
  starts.

The model lives in `scripts/server/errors.cjs`.

## Status codes

| Status | Meaning | Examples (`code`) |
|---|---|---|
| 400 | The request is malformed or invalid | `INVALID_JSON`, `INVALID_REQUEST` (also a body that isn't a JSON object, or a field of the wrong type), `MODEL_REQUIRED`, `MODEL_UNSUPPORTED`, `INVALID_FILENAME`, `INVALID_IMAGE`, `TEXT_TOO_LONG` |
| 401 / 429 | Sign-in required / too many failed attempts (LAN mode, Step 9.5) | `auth_required`, `auth_rate_limited` |
| 403 | Request from another website, or a disallowed `Host` | none (unchanged) |
| 404 | The named model, file or item doesn't exist, or the endpoint is unknown | `MODEL_NOT_FOUND`; an unknown endpoint keeps the message `Unknown API endpoint` |
| 409 | The current state doesn't allow it | `MODEL_ALREADY_ACTIVE`, `ENGINE_NOT_READY`, `ENGINE_STARTING`, `ENGINE_RESTARTING`, `ENGINE_CRASHED`, `ENGINE_START_CANCELLED` |
| 413 | Body too large | `BODY_TOO_LARGE` |
| 415 | A JSON route got another content type | `UNSUPPORTED_MEDIA_TYPE` |
| 500 | Something failed inside the server or an engine, not the caller's fault | `ENGINE_START_FAILED`, `ENGINE_START_TIMEOUT`, `INTERNAL_ERROR` |
| 502 | The image engine couldn't be reached through the proxy | unchanged |
| 503 | A required engine or runtime isn't installed | `ENGINE_NOT_INSTALLED` |

## What changed (documented compatibility change)

Ten error paths used to answer `500` for problems with the request, or for a missing engine. They
now use the status matching the cause. The response shape and the `error` messages are unchanged.

| Call | Before | Now |
|---|---|---|
| `POST /api/llm/start` with no model | 500 | 400 `MODEL_REQUIRED` (404 `MODEL_NOT_FOUND` for an unknown model) |
| `POST /api/llm/benchmark` with no model | 500 | 400 `MODEL_REQUIRED` (404 for an unknown model) |
| `POST /api/llm/delete-conversation` without an id | 500 | 400 `INVALID_REQUEST` |
| `POST /api/import-model`, `/api/llm/import-model` with a bad filename | 500 | 400 `INVALID_FILENAME` |
| `POST /api/save-output` without an image | 500 | 400 `INVALID_IMAGE` |
| `POST /api/speech/start`, `/api/tts/start`, `/api/tts/speak` without the engine installed | 500 | 503 `ENGINE_NOT_INSTALLED` |
| `POST /api/openvino-generate` before the NPU model is loaded | 500 | 409 `ENGINE_NOT_READY` |

The interface treats every non-2xx response the same way (it shows `error`), so nothing changes for it.
`scripts/tests/api-contract/contract.json` records the new statuses. No other recorded call changed.

## Robustness

* **A malformed request can no longer stop the server.** Every request now runs inside one error
  boundary. An error a route didn't anticipate is answered with a generic `500 INTERNAL_ERROR`, and the
  details go only to the server's console. A request field of the wrong type (for example a list where a
  file name was expected) is answered with `400 INVALID_REQUEST`.
* **JSON bodies must be objects.** `null`, numbers, strings and arrays get `400` instead of leaving the
  request unanswered.

## Privacy of error messages

* No stack traces, and no internal Node.js error text for wrongly typed input.
* Absolute paths are shortened: paths inside the studio folder become relative (`app/speech-backend/…`),
  and the user's home folder becomes `~`. A device on the network doesn't learn the host's user name or
  folder layout.
* No tokens or credentials appear in errors (Step 9.5 tests check logs and responses).

## Streaming

Chat streaming errors are unchanged: an engine error before the stream is a JSON error response, and
an error during the stream is an `error` event in the stream. The contract tests check both.
