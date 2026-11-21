# Image-generation request validation (design)

Status: **design only, not implemented.** Nothing in this document changes the server, and nothing is turned on.
Implementation, its scope and any default each need separate owner approval. It complements the image-generation
queue design ([STEP9_9F_IMAGE_QUEUE.md](STEP9_9F_IMAGE_QUEUE.md)), whose implementation is in review and off by default.

## 1. Today (verified in code on main)

`routes/image.cjs` forwards every `GET` and `POST` under `/v1/` and `/sdapi/` to `services/image-engine.cjs`
`proxyImageBackendRequest`, which pipes the request body to the image engine unchanged: any content type, any size,
any content. The studio's own JSON routes already go through `readJsonBody` (content-type check, 64 MiB ceiling, early
`413` on a declared length over it, refusal handling that closes the connection safely).

| Route | Sent by | Body |
|---|---|---|
| `POST /sdapi/v1/txt2img` | WebUI (`app/frontend/src/services/api.js`), API clients | JSON object |
| `POST /sdapi/v1/img2img` | WebUI (with base64 `init_images`), API clients | JSON object; can be tens of MiB |
| `POST /v1/images/generations` | OpenAI-style API clients | JSON object |
| `POST /v1/images/edits` | OpenAI-style API clients | `multipart/form-data` — not JSON |
| all other `/v1/*`, `/sdapi/*` | API clients, WebUI status calls | forwarded as today |

How the engine treats malformed input is not part of the studio's contract. The aim is that the studio, not the
engine, answers requests that cannot be valid.

## 2. Proposal

Validate **only** the three JSON generation routes before forwarding. `/v1/images/edits` and every other route stay
byte-for-byte unchanged.

1. **Content type** `application/json` (or `+json`); otherwise `415`, as for the studio's JSON routes.
2. **Size**: the same 64 MiB ceiling as the JSON routes; a declared length over it gets `413` before reading, with the
   existing refusal handling; chunked bodies are counted in bytes actually received.
3. **Shape**: the body must parse as a JSON **object**; otherwise
   `400 { ok:false, code:"INVALID_REQUEST", detail:"Generation failed: …" }`. The `Generation failed` prefix is the one
   the WebUI already shows.
4. **Forward the original bytes**, never a re-serialisation, so a valid request reaches the engine byte-identical.
5. **No field schema.** The engine owns its parameters; validating fields would drift across engine versions.
6. **Setting** `imageRequestValidation: off | on`, default **off**. Whether `USAP_SCHEDULER=off` should also turn it
   off is an owner decision (it is input safety, not scheduling).

## 3. Where validation runs

Parsing needs the whole body in memory. Today's direct proxy streams and holds nothing, and it does not limit how
many generation requests run at once. Validating there would let memory grow with concurrent large requests.

| Option | Memory in the default path | Cost |
|---|---|---|
| (a) incremental JSON tokenizer in the proxy | none buffered | more code to review |
| (b) validate only when the image queue is on (it already holds each body within its budget) | **none new** | direct path unchanged |
| (c) buffer in the proxy plus a small concurrency bound for unqueued requests | bounded | a new limit in the default path |

**Recommendation: (b) first**: no new buffering when the queue is off. (a) is a later option for the direct path. With
the queue on, validation runs on the held body before forwarding, and a refusal releases the queue reservation exactly
once through the existing clean-up path.

## 4. Compatibility and cost

* Clients sending a JSON object see no change. The WebUI always does.
* New answers: `415`, `413`, `400 INVALID_REQUEST`, only for requests that are not a JSON object of acceptable size.
* One `JSON.parse` per request (up to 64 MiB). CPU cost to be measured on each OS before any default decision; no
  figure is claimed here.
* Valid JSON that an engine mishandles is out of scope.

## 5. Tests (planned with the implementation)

Unit tests for each route × {valid, invalid JSON, non-object JSON, wrong or missing content type, declared size over the
ceiling, chunked over the ceiling}: expected status, nothing forwarded on refusal, original bytes forwarded on success
(byte comparison), `/v1/images/edits` untouched, other routes untouched, queue on and off, exactly-once release.
Negative controls: validation bypassed, re-serialised forward, edits route validated, refusal forwarded. Native (four
OS, CPU): the WebUI request shapes still generate, and a refused request leaves the engine loaded.

## 6. Rollout and rollback

1. This design (documentation only).
2. Implementation, default off, scope (b) unless the owner chooses otherwise.
3. Native evidence on four OS.
4. A separate default decision.

Rollback: `imageRequestValidation: off` restores today's proxy exactly.
