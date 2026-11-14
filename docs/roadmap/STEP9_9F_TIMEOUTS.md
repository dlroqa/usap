# Step 9.9f, first substage: chat-engine timeouts, cancellation and cleanup (design)

Status: design merged (#100). **Implemented, off by default** (`chatTimeouts: "off"`), with the corrections
in §11 ("As built"), which take precedence over §2–§7 where they differ. Any change of default needs separate
owner approval.

Scope: text chat only (`POST /api/llm/chat`, streaming and non-streaming, to llama-server). Out of scope:
memory-aware admission (enforced memory check), image/speech/voice queues, P4-2, engine restarts, and any
change to llama.cpp thread counts, polling (`--poll`), batch sizes or model loading. Part of
[STEP9_9_SCHEDULING.md](STEP9_9_SCHEDULING.md) stage 9.9f.

Goal: no chat request can stall indefinitely. A stall must never cause unsafe engine concurrency or an
automatic restart, and must not silently change today's behaviour.

## 1. Today (main `d501d0c`)

| | Streaming | Non-streaming |
|---|---|---|
| Waiting in the chat queue (only if `chatQueue` on; off by default) | 10 min, then `503 QUEUE_TIMEOUT` | same |
| Running request | **no limit.** An engine that keeps the connection open and sends nothing holds the client, the single kept-alive engine connection (`maxSockets 1`) and, with the queue on, the queue slot, indefinitely. Everyone queued behind it gets `QUEUE_TIMEOUT` after 10 min. | `requestJson(…, 300000)`: a 300 s **socket-inactivity** timeout. llama-server sends nothing until the answer is complete, so in practice it is a 300 s total limit. When it expires, the request is destroyed, and the chat answers **HTTP 500 `{ ok:false, error:"Request timed out" }`** (no code). |
| Client disconnects | The engine request is destroyed (`services/chat.cjs`). | **The engine request is not aborted.** It runs until it finishes or reaches 300 s. With the queue on, the slot is released on `close`, so the next request waits inside llama-server behind the abandoned one. |
| Retries | One stale kept-alive connection retry, only if: first attempt, reset/broken pipe within 2 s of getting the connection, no engine status line, nothing sent to the client. One out-of-memory retry with a smaller context, which **restarts the engine** inside the request (`retryCount` ≤ 1). | The same out-of-memory retry. No transport retry: the request may already have run. |

Other facts this design depends on:

* The original WebUI has **no client-side timeout**. Streaming carries the Stop button's `AbortSignal`;
  non-streaming carries none.
* WebUI stream parsing (`app/frontend/src/services/api.js`): any `data:` JSON with an `error` field **throws**,
  whatever the event name, and `TextChat.jsx` replaces the partial reply with an error bubble
  (`Error: <message>`, `error: true`, saved as such). A stream that just **ends without `[DONE]`** is treated as a
  **successful reply** when some text arrived (`finishReason` stays null). A silent end therefore isn't
  acceptable as a timeout signal.
* The studio's HTTP server has `server.timeout = 0` (uploads and downloads); it adds no response timeout.
* Engine start-up is not on the chat path (chat answers `409 ENGINE_NOT_READY`), except in the out-of-memory
  retry. That retry's start is bounded by the existing ready limit: 720 × 500 ms = 6 min on CPU, 3 min otherwise
  (`waitForLlmReady`).
* The web search, when requested, runs before the engine request and has its own limits.

## 2. What llama-server does when the studio cancels (pinned build `b11418`, from its source)

* **Transport.** The studio cancels by destroying its HTTP request to the engine. On both paths llama-server's
  handler polls `is_connection_closed`. When it sees the connection is gone, it posts a `CANCEL` task for the
  request's tasks to the front of its task queue (`server-queue.cpp`, `server_response_reader::stop`).
* **Computation.** That `CANCEL` task is handled by the engine's single main loop
  (`server-context.cpp`, `SERVER_TASK_TYPE_CANCEL` → `slot.release()`), **between** iterations of
  `update_slots`. Each iteration runs one `llama_decode` of up to `--batch-size` tokens (512 by default here). The
  server sets no `abort_callback`, so a decode in progress always runs to completion. Computation therefore stops
  only after the current decode finishes and the main loop gets back to its task queue.
  * For a healthy engine this is milliseconds during generation, and up to one prompt batch during prompt
    evaluation. On a slow CPU, one 512-token batch can take many seconds.
  * For a hung engine (a stuck backend or driver, a suspended or swapped-out process) it **never** happens.
* **Therefore: closing the HTTP connection does not prove the engine stopped computing.** The studio must
  never treat an abort as "engine free".
* **Confirmation signal** (corrected after reading `server-queue.cpp` and `server-context.cpp`; see §11).
  The studio already starts llama-server with `--metrics`. `GET /metrics` posts a high-priority `METRICS` task.
  It is answered **even while a decode runs**: during `yield_to_queue` a worker thread handles `METRICS` and
  `SLOT_GET`, and declines everything else, including `CANCEL`, until the decode is done. During a decode the slot
  doing it is counted in `requests_processing`. A slot stops counting only when it is released, which happens
  between decodes. So `requests_processing 0` with `requests_deferred 0`, read after the abort, means no slot is
  computing. "No answer" is not the busy signal (a busy engine answers with 1); it means a stuck or suspended
  process, which also never confirms anything. The real-model chat-queue check (`scripts/ci/chat-queue-validate.cjs`) already uses this
  signal: after a client cancelled a **streaming request during generation**, it observed `requests_processing`
  back to 0 (within about 2.1 s, including its own polling interval) and no further tokens, on all 4 targets
  (native run 43536307834). That covers a healthy engine during generation only: not prompt evaluation, not
  non-streaming, and not a stuck engine.
* llama-server's own HTTP read/write timeout is 3600 s by default (`--timeout`, not passed by the studio). It
  doesn't bound a request that is still computing, and it isn't changed here.

## 3. Setting

```
USAP_CHAT_TIMEOUTS=off|observe|on               (environment; wins over the file)
app/config/scheduler.json:
  { "chatTimeouts": "off",                      "off" | "observe" | "on"; default "off"
    "chatFirstByteSeconds": 600,                integer seconds, 30–3600; default 600 (experimental)
    "chatIdleSeconds": 120 }                    integer seconds, 10–600;  default 120 (experimental)
USAP_CHAT_FIRST_BYTE_SECONDS, USAP_CHAT_IDLE_SECONDS   (environment overrides for the two numbers)
USAP_SCHEDULER=off                              forces chatTimeouts off (global rollback)
```

* Units are whole seconds. Values are read once at start-up, and `/api/resources` reports the values in effect.
* Validation is per value, never fatal:
  * a mode other than the three words (trimmed, case-insensitive) is ignored, and the next source applies;
  * a number that isn't an integer, or is out of range, is ignored and logged once (`[timeouts] ignored
    chatIdleSeconds=…: allowed 10–600 s`), and the next source or the default applies.
  * Values are never clamped silently, so a typo can't become a different limit.
* The 600 s and 120 s values are **experimental starting values**, to be revisited with measurements (§9).
  The non-streaming 300 s limit is **not** configurable here (§4).

Modes:

* **`off`** (default): today's code path, unchanged. No new timers, probes, gate or abort, and the same
  responses including the uncoded 500 after 300 s. A golden test compares responses with `main`.
* **`observe`**: today's behaviour, unchanged. The same timers run, but on expiry they only record
  "would have timed out" (phase and elapsed seconds) in `/api/resources` and in one log line. Observe mode
  never aborts, sends nothing, sends no `/metrics` probe, never gates admission and never touches the queue.
  Client-cancel handling stays legacy (the streaming destroy still happens, the non-streaming request is still
  not aborted).
* **`on`**: enforcement and cleanup as below.

## 4. Deadlines and precedence

| Path | Deadline | Starts | Stops | Configurable |
|---|---|---|---|---|
| Streaming | **First byte** | when the request body is written to the engine | at the engine's **first body chunk** (not its status line), or when the response ends | 30–3600 s, default 600 |
| Streaming | **Idle** | at each engine body chunk after the first | at the next chunk, or when the response ends | 10–600 s, default 120 |
| Non-streaming | **Total** | when the request is written to the engine | when the complete response has been received | **No: 300 s, as today** |

* **Exactly one deadline is armed at a time**, so two never compete. Streaming arms first-byte, then idle
  after the first chunk. Non-streaming arms only the total deadline. First-byte and idle never apply to
  non-streaming, so a configured first-byte below 300 s does not tighten non-streaming, and 600 s does not
  loosen it.
* **Streaming has no total limit.** A long answer that keeps producing output is legitimate, and
  `max_tokens` ≤ 4096 already bounds it.
* **In `on` mode, the 300 s non-streaming limit is a true wall-clock total** (one timer), instead of a socket
  inactivity timer. For llama-server, which sends nothing before the complete answer, the two expire at the same
  moment, so legacy timing is kept. The difference: expiry gives a coded `504 ENGINE_TIMEOUT` (`phase:"total"`)
  instead of the uncoded 500, and the engine request is aborted and confirmed (§6). In `off` and `observe`, the
  legacy socket timer and its 500 remain as they are.
* **"First byte" means the first body chunk**, because llama-server may send its status line before prompt
  evaluation is finished. Counting the status line would hand prompt evaluation to the 120 s idle limit. Prompt
  evaluation belongs to the first-byte limit. When the studio's own `200` headers are sent depends on when the
  engine's status line arrives: they are sent when it does, as today. The implementation measures this on the
  native targets.
* **Same-tick races:** whichever event runs first in Node's event loop settles the request (§5).
  * If the response's `end` was processed first, the timer has already been cleared.
  * If the timer callback runs first, the outcome is a timeout, even if the bytes were already in flight.
  * Both are valid outcomes, and neither produces two answers.
* **Time not counted:**
  * the web search;
  * waiting in the chat queue (that has its own 10-minute limit);
  * waiting at the uncertain-cancellation gate (§6, bounded separately);
  * an engine restart during the out-of-memory retry.
* **Stale-connection retry** (the existing 2 s rule): it does **not** restart the deadline. The first-byte or
  total timer keeps running from the first write, so the retry can't extend a request. A request that has timed
  out has settled, and is never retried.
* **Out-of-memory retry** (existing, at most once per request):
  * when the out-of-memory error is recognised, the attempt's timer is cleared and the attempt settles
    internally (no client answer yet);
  * the engine restart is bounded by the existing ready limit (6 min on CPU, 3 min otherwise);
  * the single retry gets a **fresh** deadline of the same kind.
  * Worst case for streaming: 2 × first byte + one restart. For non-streaming: 2 × 300 s + one restart.
  * There is no second retry (`retryCount` stays ≤ 1), so repeated retries can't extend it.
* **Bounded memory and handles:** each deadline is one timer object, cleared at settlement. Timers use
  injectable `setTimer`/`clearTimer`/`now` (as `chat-queue.cjs` does), so tests use fake time.

## 5. Request lifecycle and exactly-once settlement

Each chat request has one settlement record. `settle(outcome)` runs its body **once**; later calls return
immediately. Every path below calls it:

```
              admitted (queue slot owned, if the queue is on; gate passed, §6)
                 │  web search, if requested (not timed here)
                 ▼
   ┌──────── SENT ───────┐   first-byte (stream) or total (non-stream) deadline armed
   │          │ first body chunk (stream only)
   │          ▼
   │      STREAMING       idle deadline re-armed on each chunk
   │          │
   ▼          ▼
 settle(outcome), once:
   COMPLETED           engine response ended normally ([DONE] passed through, or full JSON)
   ENGINE_ERROR        engine status ≥ 400, cut-off response (#90), connection error, garbage
   TIMEOUT_FIRST_BYTE  │
   TIMEOUT_IDLE        ├─ "on" only
   TIMEOUT_TOTAL       │
   CLIENT_CANCELLED    client closed before the response ended
```

`settle` does, in this order:

1. Clear the armed timer, remove the listeners it added (the `onEngineResponseSettled` pattern from #90,
   extended with timers), and add a no-op `error` listener so a late engine error can't become an uncaught
   exception.
2. Answer the client, **at most once**, only if it is still connected and nothing final has been written
   (`!res.writableEnded && !res.destroyed`):
   * `TIMEOUT_*` before the studio sent headers → `504` with
     `{ ok:false, code:"ENGINE_TIMEOUT", phase:"first-byte"|"idle"|"total", error:"The text engine didn't
     respond within N s. The request was stopped; try again, or reload the model if this keeps happening." }`;
   * `TIMEOUT_*` after streaming started → one
     `data: {"error":{"message":"The text engine stopped responding (no output for N s). The answer is
     incomplete.","code":"ENGINE_TIMEOUT","phase":"idle"}}` event, then the end of the stream, **without
     `[DONE]`**;
   * `CLIENT_CANCELLED` → nothing to answer;
   * `COMPLETED`/`ENGINE_ERROR` → as today.
3. If the outcome isn't `COMPLETED` or a complete `ENGINE_ERROR` response, **destroy the engine request** and
   hand the engine to cancellation confirmation (§6). In `on` mode this includes non-streaming client
   cancellation, which today doesn't abort.
4. Release the queue slot through the existing idempotent `release()`, at the point §6 says (immediately for
   `COMPLETED`/`ENGINE_ERROR`, otherwise after confirmation).

Rules:

* No retry after a timeout, and no automatic engine restart, unload or kill at any point.
* Partial output: already-sent chunks are never retracted and nothing is appended to the generated text.
  API clients see the partial chunks, the error event and no `[DONE]`. The original WebUI shows the error bubble
  in place of the partial reply (§1). That is its existing error behaviour, and the WebUI is not changed.
* Messages contain no paths, ports, engine arguments, prompt text, file or model names, or stack traces. The
  existing `redactPaths` and fixed-message helpers are reused.

## 6. Cancellation confirmation and queue-slot ownership

The studio-wide **text-engine state**, which only exists in `on` mode:

```
 READY ──(abort sent: timeout or client cancel)──▶ CONFIRMING
   ▲                                                  │ probe GET /metrics every 1 s, each probe bounded to 5 s
   │◀── requests_processing == 0 ─────────────────────┤
   │                                                  │ no confirmation within the 120 s confirmation window
   │                                                  ▼
   │◀── a later probe (every 15 s) sees 0 ───── UNRESPONSIVE
   │◀── the text engine stops, crashes, or a model is (re)loaded (engine generation changes): READY for the new engine
```

* **Who owns the engine while CONFIRMING.** The aborted request's slot passes to the confirmation, not to the next
  request. With the queue on, the queue slot is released only when CONFIRMING ends, so FIFO order is kept and no
  queued request is sent to an engine that may still be computing. With the queue off, a request that arrives
  while CONFIRMING waits at a small admission gate (bounded by the confirmation window) instead of being sent at
  once.
* **CONFIRMING → READY**: a `/metrics` answer with `requests_processing` 0. The slot is released, and the next
  request (queue FIFO or gate) proceeds.
* **CONFIRMING → UNRESPONSIVE** after 120 s without confirmation. This is the bounded safe state:
  * new chat requests are refused **at once** with `503 { ok:false, code:"ENGINE_UNRESPONSIVE", error:"The text engine
    is still busy with a stopped request or isn't responding. Wait, or reload the model.", retryAfterSeconds:30 }`
    and `Retry-After: 30`;
  * queued requests and requests at the gate get the same answer, in FIFO order;
  * nothing waits indefinitely, nothing new is sent to the engine, and the engine is **not** restarted;
  * a background probe every 15 s (bounded to 5 s) returns to READY as soon as the engine is idle (for example
    a long prompt batch that finally ended). Loading, stopping or reloading the model, which the user does
    explicitly, also ends the state: the engine generation changes, and the old state is discarded;
  * the queue slot is released when entering UNRESPONSIVE, so the queue has no stuck owner. The gate keeps
    refusing, so releasing it admits nothing.
* **No metric** (`/metrics` answers but without `requests_processing`): cancellation can't be confirmed, so it is
  treated as unconfirmed (stay CONFIRMING, then UNRESPONSIVE). It is never assumed safe. The studio always
  starts the engine with `--metrics`, and the native tests assert the metric is present on all 4 targets.
* **Normal completion and complete engine error responses** need no confirmation: the engine finished the task
  and answered. An engine crash goes through the existing supervisor, which is unchanged.
* **Concurrency.** llama-server runs with `--parallel 1`, so even a wrongly admitted request wouldn't run in
  parallel inside the engine. It would queue behind the still-running work and likely stall in turn. The gate
  prevents that, and keeps the slot accounting honest.
* Other engines (image, speech, voice) are not gated or changed.
* **Constants** (fixed in this substage, documented, not settings): probe interval 1 s, probe limit 5 s,
  confirmation window 120 s, background probe 15 s, Retry-After 30 s. They can become settings later if
  measurements show a need.
* **Architecture.** This fits inside `services/chat.cjs`, plus a new `services/chat-timeouts.cjs` and the
  existing `chat-queue.cjs` (one new hook: "release later"). No change to the engine, the supervisor, other
  engines or the WebUI is needed. **No blocker found.** If implementation shows otherwise, the affected behaviour
  will be reported before it is built.

## 7. Observability

`GET /api/resources` gains one additive key, `chatTimeouts`, which is absent when the mode is `off`. Existing
fields are unchanged. `limits.runningTimeouts` is added (`"off"|"observe"|"on"`), next to the existing
`limits.queueTimeouts`.

```json
"chatTimeouts": {
  "mode": "on",
  "firstByteSeconds": 600, "idleSeconds": 120, "nonStreamTotalSeconds": 300,
  "engine": "ready",                         // "ready" | "confirming" | "unresponsive" (on only)
  "counts": { "firstByte": 0, "idle": 0, "total": 0, "clientCancelled": 0,
              "cancelConfirmed": 0, "cancelUnconfirmed": 0, "refusedUnresponsive": 0 },
  "wouldHaveTimedOut": { "firstByte": 0, "idle": 0, "total": 0 },   // observe only
  "last": { "outcome": "TIMEOUT_IDLE", "stream": true, "elapsedSeconds": 121, "confirmSeconds": 0.4,
            "at": "2026-…Z" }
}
```

* Numbers, fixed words and an ISO time only: no prompts, file names, model names, usernames, paths or
  conversation content.
* One log line per timeout, unconfirmed cancellation or state change (`[timeouts] …`), with the same rules.
* In `observe` mode only the counters and `last` change. A test asserts that observe sends no probe, gates
  nothing, keeps queue state identical, and gives responses byte-identical to `off`.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A legitimate long prompt evaluation on a slow CPU exceeds the first-byte limit (prompt evaluation scales with prompt length; the context ladder reaches 32768 tokens) | Off by default; 600 s is a starting value with a 3600 s ceiling; `observe` measures real first-byte times before anyone enables `on`; the error tells the user what happened |
| Heavy paging, or llama.cpp context-shift or cache work, pauses output for longer than the idle limit | Configurable 10–600 s; measured in observe mode first |
| An abort is mistaken for "engine free" | §6: capacity is released only on a `requests_processing 0` answer; otherwise the bounded UNRESPONSIVE state |
| UNRESPONSIVE refuses chats while the engine is just slow to finish a batch | A background probe returns to READY as soon as the engine is idle; the message says to wait or reload; the counts show how often it happens |
| The `/metrics` probe adds load | Only in `on` mode, only after an abort, at most one probe at a time |
| Partial reply lost in the WebUI on an idle timeout | Existing WebUI error behaviour (§1); the WebUI isn't changed; API clients keep the partial chunks |
| A change in a future llama.cpp version (metric name, cancellation path) | Native checks assert both on every target; an engine bump has to pass them |
| Fake-timer tests miss real-socket behaviour | Real-socket fake-engine tests plus native real-model checks (§9) |

## 9. Validation plan

**Deterministic tests, all 4 OS** (fake timers for the timer logic, plus a real-socket fake llama-server with
second-scale limits set through the environment):

* a connection that never sends its first byte (stream: 504 before headers; in-stream error after headers);
* a stream that sends partial output and then stalls (error event, no `[DONE]`, engine request destroyed);
* a trickle at idle−ε and a first chunk at first-byte−ε (must **not** time out);
* a non-streaming request past 300 s, on fake time: `504 ENGINE_TIMEOUT phase:"total"` when on; the legacy
  500 when off or observe;
* a client disconnect before the first byte and during a stream; a non-streaming client cancel (engine-side
  `aborted` counter in the fake engine, on mode only);
* races in the same tick: cancel with normal completion, an engine error with a timeout, a close after a
  timeout, a timeout after a close (one answer, one settlement, no late write, no uncaught error, listeners
  removed);
* queue on and off; several queued clients; FIFO order kept; the slot owned by the confirmation until
  `requests_processing 0`; exactly one release (counted);
* unconfirmed cancellation: the fake engine's `/metrics` hangs or keeps reporting 1 → CONFIRMING → UNRESPONSIVE
  → immediate `503 ENGINE_UNRESPONSIVE` → back to READY when the fake reports 0, and on a model reload;
* the out-of-memory retry: a fresh deadline after the restart, the restart time not counted, no second retry;
* the stale-connection retry doesn't restart the deadline;
* invalid settings (mode words, non-integers, out-of-range values) and precedence (environment > file >
  default);
* rollback: `off`, `USAP_SCHEDULER=off`, and the environment `off` over a file `on`, all byte-identical to `main`;
  observe identical to off except `/api/resources` and the logs;
* no leaked timers or sockets: the test process exits on its own, and the fake engine's open-connection count
  returns to 0.

**WebUI (Playwright, the existing render-e2e harness, no UI change):** a structured in-stream timeout shows
as an error bubble, not as a completed reply; the input becomes usable again; a 504 before headers shows the
error message.

**Native, 4 targets (`native-runtime`, real tiny model):**

* measure first-byte time (short and long prompts), the time of the engine's status line compared with its first
  body chunk, and the largest gap between chunks; this is evidence for the thresholds, not a pass/fail limit;
* assert that `/metrics` exposes `requests_processing`;
* on mode, client cancel and short-limit timeout: `requests_processing` back to 0 and recorded as **confirmed**
  only because of that probe. A successful HTTP abort on its own is never counted as proof;
* **a suspended real engine**, found by the studio's own engine port (never by process name):
  * Linux and macOS: `SIGSTOP` mid-stream → idle timeout → CONFIRMING → UNRESPONSIVE (refusals) → `SIGCONT` →
    READY without a restart (same engine PID) → the next chat works.
  * Windows: suspend through `NtSuspendProcess`/`NtResumeProcess` from PowerShell (P/Invoke).
  * The row is `UNSUPPORTED` only when suspension itself can't be set up on that runner, and the step says so.
    Anything that fails after suspension worked is `FAIL`.

## 10. Rollout

1. This design PR (docs only). Merge needs approval.
2. Implementation PR, default `off`, with the tests above and native evidence. Merge needs approval.
3. Manual `observe` measurements on the native targets → evidence → owner review of 600 s / 120 s.
4. Any default change (`observe` or `on`) is a separate approval. Rollback at every step: `chatTimeouts: "off"`,
   `USAP_CHAT_TIMEOUTS=off`, or `USAP_SCHEDULER=off`.

## 11. As built (Step 9.9f-1 implementation)

Where this section differs from §2–§7, this section is what the code does.

* **Files:** `scripts/server/services/chat-timeouts.cjs` (setting, counters, engine guard),
  `scripts/server/services/chat.cjs` (per-request deadlines, settlement, gate, queue-slot hand-over),
  `scripts/server/services/scheduler.cjs` (additive report) and `scripts/server/serve.cjs` (wiring). With the
  mode `off`, the chat service gets no timeout object, and every path is the previous code.
* **Confirmation rule (stricter than §6).** A cancellation counts as confirmed only when **all** of these hold:
  1. two `/metrics` readings, each from a probe **sent after the latest abort**;
  2. both show `requests_processing 0` and `requests_deferred 0`;
  3. they are at least 3 s apart (more than twice llama-server's 1 s `HTTP_POLLING_SECONDS`, the interval at which
     its handler notices a closed connection and posts the `CANCEL`);
  4. `n_decode_total`, `tokens_predicted_total` and `prompt_tokens_total` didn't change between them, so no decode
     ran in between;
  5. both carry the same `Process-Start-Time-Unix` header;
  6. the studio's engine sequence number (`llmProcSeq`, one per spawned process) was the same when each probe was
     sent and when it was answered.

  A reading that is missing, malformed, from another process or engine, sent before the latest abort, or
  contradictory (anything deferred, counters moving) resets the check. Only one probe is in flight at a time,
  and each is limited to 5 s. These readings don't identify the cancelled request: they show that **nothing** is
  computing, which is the condition for sending the next chat. llama-server's idle-sleep mode (which would answer
  from a cache) is off unless `--sleep-idle-seconds` is passed, and the studio doesn't pass it.
* **Engine identity.** The guard records the sequence number of the engine the aborted request was sent to.
  * An abort for an older process is ignored.
  * A new process that has become ready ends CONFIRMING or UNRESPONSIVE at once: the studio starts a new engine
    only after stopping the previous one (SIGTERM, then SIGKILL, then waiting for the port), so the uncertain work
    ended with that process. This covers a model load or reload and the supervisor's crash restart.
  * Answers that arrive late from the old process are discarded.
* **Experimental settings:** the confirmation window and the UNRESPONSIVE probe interval are settings, not fixed
  constants:
  * `chatCancelConfirmSeconds` / `USAP_CHAT_CANCEL_CONFIRM_SECONDS`: 10–600 s, default 120;
  * `chatUnresponsiveProbeSeconds` / `USAP_CHAT_UNRESPONSIVE_PROBE_SECONDS`: 5–300 s, default 15.

  They are validated like the two limits: whole seconds only; anything else is ignored and logged, never
  clamped. Fixed constants: probe interval while CONFIRMING 1 s, per-probe limit 5 s, quiet gap 3 s,
  Retry-After 30 s.
* **Queue-slot hand-over.** With the queue on, a request whose engine work was aborted hands its slot to the
  confirmation: the queue's `release()` runs when CONFIRMING ends, either confirmed or on entering UNRESPONSIVE.
  The next waiting request (FIFO) is then granted, and still passes the gate. Without the queue, each chat passes
  the same gate before anything is sent. While CONFIRMING it waits there (bounded by the window); while
  UNRESPONSIVE it is refused at once.
* **Keep-alives.** An engine body chunk made only of SSE comment lines (`: …`) or blank lines is passed through,
  but doesn't re-arm the idle deadline and doesn't end the first-byte deadline. llama.cpp `b11418` sends no such
  keep-alives; this only keeps a future one from hiding a stall.
* **Client cancellation:**
  * **on:** streaming as before, plus the abort enters confirmation. Non-streaming requests are now aborted too.
  * **observe:** the legacy behaviour exactly (the streaming abort only), and it is only counted.
  * **off:** legacy.
* **Report:** `chatTimeouts.counts` holds:
  * `firstByte`, `idle`, `total`: the three timeout kinds;
  * `clientCancelled`;
  * `cancelConfirmed`, `cancelUnconfirmed`: the outcome of confirmation;
  * `recovered`, `engineReplaced`: the two ways out of UNRESPONSIVE;
  * `refusedUnresponsive`;
  * `probes`, `probesRejected`.

  Plus `last` (outcome, stream flag, elapsed and confirmation seconds, time). In observe, `wouldHaveTimedOut`;
  in on, `engine` (`ready` / `confirming` / `unresponsive`).
