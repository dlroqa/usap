# Step 9.8h: text engine, chat and streaming

Status: **in review** (not merged). Part of the modular backend plan in [STEP9_8_MODULES.md](STEP9_8_MODULES.md).
This is the last 9.8 extraction.

This step moves the text engine (llama.cpp), chat requests, streaming and saved conversations out of
`scripts/server/serve.cjs`. The code is moved, not rewritten. Responses, streams, prompts, message order, engine
settings, the restart policy, storage folders and the interface are unchanged. No new port, service or dependency is
added.

## Dependency map (before the move)

### Request lifecycle

```
browser (TextChat.jsx)                     builds messages: optional system prompt, history, the new user message
  │  POST /api/llm/chat {messages, stream, sampling…, useWeb?, webQuery?}
  ▼
pipeline.cjs                               Host → Origin/CORS → preflight → sign-in → router → legacy routes (error boundary)
  ▼
/api/llm/chat route                        readJsonBody (JSON only, 64 MB) → 409 unless the engine is ready
  ▼                                        (ENGINE_RESTARTING / ENGINE_CRASHED / ENGINE_STARTING / ENGINE_NOT_READY)
doLlmChat                                  ← web-search.cjs augmentMessagesWithWebSearch (only if useWeb)
  │  builds the engine request: loaded model, messages as sent (+ web context), sampling with defaults and caps
  ├─ stream:false → requestJson → engine JSON (+ web_sources) → 200
  └─ stream:true  → http.request over a keep-alive agent (maxSockets 1) to 127.0.0.1:PORT_LLM/v1/chat/completions
        engine status ≠ 2xx → JSON error with the engine's status and message (one out-of-memory retry, below)
        engine 2xx → SSE headers → optional `event: web_sources` → engine bytes passed through unchanged → end
        client closes → engine request destroyed (the engine stops generating)
        engine connection fails mid-stream → client response destroyed (no [DONE])
```

Out of memory: a streaming request whose engine answer looks like an allocation failure restarts the engine once
with the next smaller context (`retryLowerContext`, through the engine lock) and is sent again; a second failure is
returned. The non-streaming path never detects it (existing bug, #67).

Engine lifecycle (`POST /api/llm/start`, `/api/llm/stop`, automatic restarts):

```
start → runExclusiveLlmOperation (one engine operation at a time)
      → startLlm → startLlmAttempts: model checks (name, folder, .gguf, architecture) → backends (preferred first)
        × load profiles → startLlmWithBackend: free port, args (context, layers, cache, vision projector),
        supervisor.spawnSupervised (engine guard: the engine dies with the server) → waitForLlmReady
      → success: settings saved per model (config/llm-model-settings.json)
stop  → stopLlmNow (cancels a start in progress at once) → killLlm (polite stop, forced after 2.5 s, port freed)
exit after ready, not requested → handleUnexpectedLlmExit → restart-policy.cjs decideRestart:
        at most 3 restarts in 10 min with 1/2/4 s backoff; never after running out of memory or without enough
        free memory; never after an intentional stop (the start token changes)
```

### State and ownership

| State | Owner after the move | Written by | Read outside the owner |
|---|---|---|---|
| `llmProc`, `llmProcSeq`, `llmReady`, `llmError`, `llmSettings`, `PORT_LLM` | `services/llm-engine.cjs` | the engine; `llmError` also by `POST /api/llm/start` (as before) | status, stats, diagnostics, health, active-runtime check, model routes, web-search planner, chat |
| `llmStartToken`, `llmStarting`, `llmLastStartRequest`, `llmLastExit`, `llmCrash`, `llmRestartTimer`, `llmRestartAttempts`, `llmRestarting`, `llmOperationQueue` | `services/llm-engine.cjs` | the engine only | none (lifecycle snapshot) |
| `cachedLlmBackendProbe`, `cachedLlmBackendProbeAt` | `services/llm-engine.cjs` | the engine only | none |
| keep-alive agent to the engine | `services/chat.cjs` | – | – |
| conversation files (`app/chat-history/*.json`, from `paths.cjs`) | `services/conversations.cjs` | save, delete | – |
| `config/llm-model-settings.json`, `config/llm-benchmarks.json` | `services/llm-engine.cjs` | start, benchmark, `POST /api/llm/model-settings` | – |

Engine state is exposed as a frozen object of getters (`llmEngine.state`), so readers always see the current value
and can't change it. Only the routes get `routeState`, which adds a setter for `llmError`.

Shared with other modules: `assertNoOtherActiveRuntime` (one heavy model at a time across text and image),
`killLlm` (the image engine stops the text engine when needed, now passed as a wrapper), the supervisor and
restart policy, hardware detection (`getGpuInfo`), and `readdirVisible` from the model store.

## Module boundaries

| Module | Owns | Does not own |
|---|---|---|
| `services/llm-engine.cjs` | Engine state; backend detection and probes; per-model settings and benchmarks; start (backends, profiles, context and layer choice, vision projector), readiness, stop; supervision and bounded restart; status, stats and benchmark helpers; the llmfit lookup | HTTP, chat requests, conversation files |
| `services/chat.cjs` | Chat request building, the engine connection, streaming pass-through, the `web_sources` event, the out-of-memory retry, disconnect handling | Engine state (reads it through getters), web search (`services/web-search.cjs`) |
| `services/conversations.cjs` | Saving, listing and deleting conversations in the chat history folder | Prompt building (conversations are not read by the server when chatting) |
| `routes/llm.cjs` | The 13 routes below | Everything else |

Routes: `GET /api/llm/status`, `/api/llm/backends` (prefix), `/api/llm/stats`, `/api/llm/model-settings`,
`/api/llm/conversations`, `/api/llm/recommend` (prefix); `POST /api/llm/model-settings`, `/api/llm/save-conversation`,
`/api/llm/delete-conversation`, `/api/llm/start`, `/api/llm/stop`, `/api/llm/benchmark`, `/api/llm/chat`.

A conversation module and a chat module were kept separate because they share nothing: the browser keeps the
conversation and sends it with each message; the server only stores the copy the browser saves.

## How it was moved

* 75 declarations and the 13 route bodies were moved by a script that works on the syntax tree, using real scope
  resolution (eslint-scope) to find free variables. A second check compares each with the previous `serve.cjs`
  after undoing only the rewrites below: all are identical, and every route keeps its exact matching condition.
* Rewrites (free variables only): engine state `X` became `state.X` in the chat service and the routes, and
  `llmEngine.state.X` in the 14 places in `serve.cjs` that read it (status, health, diagnostics, the active-runtime
  check, the model routes, the web-search planner). Nothing outside the engine writes engine state, except the
  routes' `llmError`, as before.
* Eight functions and one cache were declared inside the request handler (`isOomError`, `retryLowerContext`,
  `doLlmChat`, `getLlmRuntimeStats`, the benchmark helpers, the llmfit lookup). They moved as they are. The llmfit cache
  was created again for every request; a new lookup is still created per request, so it still never caches (#69).
* The engine is created where its state was declared. Functions bound later in `serve.cjs` (`getGpuInfo`,
  `readdirVisible`) are passed as wrappers resolved when called, and the image engine, created first, now gets
  `killLlm` as a wrapper. Start-up order is unchanged.
* A golden comparison ran 60 requests against the previous and the new server with the same fake engine and
  files: every route, refused models, conversations with hostile ids and content, five kinds of streams (normal,
  200 chunks, engine error, malformed, cut mid-stream) compared byte for byte with their headers, the out-of-memory
  retry (streaming and not), a benchmark, wrong methods and query strings, and the saved files. All identical.

## Where untrusted text enters the prompt

| Input | Enters as | Protection | Remaining weakness |
|---|---|---|---|
| The user's messages and system prompt | Sent by the browser, passed on in order with their roles | Sign-in and Origin checks decide who may send them | The server does not check roles: any signed-in client can send any role, including `system`. This is by design (the client is the user) |
| Web results (`useWeb`) | One `user` message after the leading system messages | Untrusted-source markers with a per-request nonce, control tokens removed, size limits, no role change (`docs/security/WEB_CONTENT_TRUST.md`); the query planner sees only the user's own words (#43) | A model can still follow instructions written in a page. Prompt injection is reduced, not prevented |
| Earlier assistant answers | Sent back by the browser as `assistant` messages on the next turn | None beyond the above | An answer that repeated text from a web page returns as `assistant` text, outside the untrusted markers |
| Attached documents (PDF text) | Part of the user's message (built in the browser) | None | Document text is not marked as untrusted |
| Saved conversations | Not read by the server when chatting | Ids reduced to safe names, paths kept inside the folder, images not saved | Stored as sent, including web sources |

Nothing in chat can call another server operation: the engine's answer is passed to the browser, never executed.
Changes to these boundaries belong in separate security PRs (the planned prompt-injection module).

## Tests

`scripts/tests/llm-chat.test.cjs` (21 tests) runs the real server with the fake llama-server
(`scripts/tests/api-contract/fake-llama-server.cjs`, which gains `MODE:echo`, `MODE:oom`, `MODE:garbage` and
`/fake/last`). It adds to the existing streaming tests (`api-contract.test.cjs`) and supervision tests
(`engine-supervision.test.cjs`):

* module boundaries: the 13 routes in order with their matching rules; engine state read-only; missing
  dependencies refused;
* missing, outside-the-folder, non-GGUF and unsupported-architecture models refused before an engine starts; a
  Q4_K_M GGUF loading through the normal backend path under the supervisor;
* non-streaming answers; sampling defaults and the 4096-token cap; the loaded model always used;
* the proxied stream byte-for-byte equal to the engine's, with the same headers and event order; tokens delivered
  as they arrive; a long stream not cut off; a malformed engine stream passed through; engine errors as JSON;
  invalid JSON, wrong content type and oversized bodies refused without stack traces or paths;
* five simultaneous requests each complete and in order; five clients leaving mid-stream abort their engine
  requests and nothing runs on; stopping during a stream ends it without `[DONE]`, frees the port and does not
  restart; chat refused while loading; overlapping loads leave one engine;
* an engine killed mid-stream: the stream is cut, the engine is restarted once (limit 3), and chat works again;
* out of memory while streaming: one retry with a smaller context, no loop; not streaming: no retry (#67);
* conversations: file format, order, dropped roles, omitted images, newest first, kept across a server restart;
  hostile ids never reach outside the folder;
* web results as one user message after the system prompt, the client's messages unchanged, control tokens
  removed, `web_sources` first in the stream and in the JSON answer;
* with sign-in on: all 13 routes need sign-in, cross-site requests are refused and change nothing, a signed-in
  stream works, and the token never reaches the log or the engine.

Six safeguards were removed one at a time (disconnect abort, the ready check, the token cap, the single retry, the
read-only state, the sources event). Each removal made its test fail.

Real CPU chat with a real quantized model (Qwen2.5 0.5B Instruct Q4_K_M) runs in
`.github/workflows/native-runtime.yml` on Linux x64, Windows x64, macOS arm64 and macOS Intel. Step 9.8h adds a
streaming check there (SSE headers, several content events, a finish reason, `[DONE]`) and a check that a client
leaving mid-stream does not break the next request. GPU and NPU backends are unverified.

## Existing behaviour kept as it is

* Simultaneous chat requests share one connection to the engine (`maxSockets: 1`), so they run one after another
  with no queue limit. Resource scheduling is Step 9.9.
* A streaming request to the engine has no timeout; a non-streaming one times out after 5 minutes. A client that
  leaves always ends its engine request.
* A non-streaming engine error answers `500 "[object Object]"` and is never retried after running out of memory (#67).
* A text engine that cannot be started (for example not executable) stops the whole server (#68).
* Some validation errors still answer `500` (for example an invalid conversation id), as noted in Step 9.7.
* llmfit recommendations are looked up again on every request (#69).
