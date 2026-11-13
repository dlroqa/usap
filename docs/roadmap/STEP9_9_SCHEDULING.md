# Step 9.9: resource scheduling (plan)

Status: **planned** (owner decisions in section 5). This document only describes and plans; nothing in it is implemented yet. Each rollout stage
below is a separate PR that needs the owner's approval. Part of [STEP9_BACKEND_PLAN.md](STEP9_BACKEND_PLAN.md).

Goal: one studio on one computer should stay responsive and never run out of memory because of what it starts
itself. The studio stays a single local process that works offline. Single-user use doesn't change unless a limit is
reached, and then the user gets a clear message instead of a crash or a stall.

## 1. How it works today (after Step 9.8)

### Engines and who owns them

| Workload | Engine (process) | Owner module | One at a time? | Queue | Timeout |
|---|---|---|---|---|---|
| Text chat | llama-server, one per loaded model | `services/llm-engine.cjs`, `services/chat.cjs` | Engine operations (load, stop, benchmark, restart) run one at a time (`runExclusiveLlmOperation`). Chat requests share one keep-alive connection (`maxSockets: 1`), so they run one after another | Unbounded (Node's socket queue) | Streaming: none. Non-streaming: 5 min. A client that leaves ends its engine request |
| Image generation | sd-server (stable-diffusion.cpp), OpenVINO worker, Core ML | `services/image-engine.cjs` | One engine. Generations are proxied as they arrive; a settings change during a generation is refused | None in the studio | No fixed proxy timeout. A client that leaves does **not** cancel the engine (#64) |
| Speech recognition | whisper.cpp CLI, one process per job | `services/speech-engine.cjs` | Yes: `runExclusiveSpeechOperation` | Unbounded promise chain | None (#41: no cancel) |
| Voice synthesis | Kokoro worker, one process per job | `services/tts-engine.cjs` | Yes: `runExclusiveTtsOperation` | Unbounded promise chain | None |
| Downloads | in-process downloader | `services/downloads.cjs` | Yes: one download slot; others are refused (409) | None (refused) | Per-request network timeouts |

Across engines, only **one heavy model** is loaded at a time: a text model and an image model can't both be loaded
(`assertNoOtherActiveRuntime`, `409 MODEL_ALREADY_ACTIVE`). Speech and voice models are loaded per job, alongside
either.

### CPU, memory and GPU

* **Threads:** each engine sets its own count. Text uses min(16, CPUs) by default (up to 64 on request). Image uses
  8 (capped since #9). Speech uses min(8, CPUs). Engines running at the same time can together use more threads than
  the CPU has.
* **Memory before loading:** there is no general headroom check. Text chooses its context and GPU layers from the
  model size and the hardware (`chooseAutoContext`, `chooseAutoLayers`). After an out-of-memory failure chat
  retries once with a smaller context, streaming or not (#67).
* **Memory after a crash:** `restart-policy.cjs` restarts a crashed text engine at most 3 times in 10 minutes, and
  never after it ran out of memory or when free memory is below the model size. The image, speech and voice engines
  are not restarted automatically (#32). Resource-aware recovery is #33.
* **Read-only budget (Step 9.8e):** `hardware.budget` stays read-only until a scheduling stage that uses it is approved. It reports total and free RAM, and total and free VRAM where a
  poll actually reports them (NVIDIA through `nvidia-smi`; llama.cpp device lists). Nothing reads it yet. Apple
  unified memory, AMD without llama.cpp and Intel NPUs report total only, or nothing.
* **Supervision (Step 9.6):** every engine runs under `supervisor.cjs` and an engine guard, so engines stop when
  the server stops, even after a hard kill.

### Known gaps

1. A slow or stuck chat request delays every chat behind it, with no limit and no position shown.
2. Image, speech and voice jobs can't be cancelled from the studio (#64, #41).
3. Several engines can be busy at once with no shared CPU limit.
4. Loading a model can push the computer into swapping or out-of-memory, with no check first.
5. Fixed before any scheduling work: an engine that can't be started no longer stops the server (#68, PR #72).

## 2. Design

### Principles

* **Measure first, then limit:** stage 1 is read-only. Limits come later, one at a time, each off by default or set
  so loose that today's single-user use never hits them, until it has been measured on all 4 OS.
* **Refuse rather than stall:** when a limit is reached, the request gets a clear `429` or `409` with a `Retry-After`
  and the reason, and nothing already running is affected.
* **No new process, port or service:** the scheduler is a module inside the server
  (`services/scheduler.cjs`), used by the existing engine modules.
* **Rollback:** each limit has a setting (environment variable and `app/config/scheduler.json`). `off` restores
  today's behaviour exactly, and a CI test checks that.

### Resources and policies

| Resource | Policy (proposed) |
|---|---|
| CPU threads | One thread budget = physical cores. Each engine asks for threads when a job starts. When engines overlap, the budget is shared (for example, an image job while a chat streams gets the cores the chat isn't using, at least 2). Today's counts are kept when only one engine is busy |
| System RAM | Before loading a model: estimated need (file size + context, from `model-metadata.cjs`) vs. `budget.freeRamBytes()`. Below the need: refuse with `INSUFFICIENT_MEMORY` and the numbers, unless the user forces it. Warn-only in the first stage |
| VRAM | Only where a poll reports free VRAM. Used to choose GPU layers and to warn, never to refuse when the number is unknown. GPU and NPU behaviour is unverified on real hardware and stays labelled that way |
| Heavy models | Keep "one heavy model at a time" (decision B). Text and image together are not part of 9.9 |
| Chat queue | Per engine, a queue of at most 4 waiting requests behind the running one (decision A). Requests past the limit get `429 QUEUE_FULL` with `Retry-After`. Queued requests that disconnect leave the queue at once. Status reports queue length |
| Image queue | Same shape, default 2 waiting. Client disconnect cancels a queued job; cancelling a running job needs #64 |
| Speech, voice | Keep one at a time; add queue limits (default 4) and cancel for queued jobs (#41) |
| Fairness | First in, first out per engine. Between engines, no job waits for another engine's queue. Per-user fairness comes with multi-user accounts (#28), not before |
| Timeouts | Keep today's. Add: a queued request waits at most 10 minutes; a streaming chat with no bytes from the engine for 5 minutes is ended (the engine request is aborted) |
| Memory pressure | Poll free RAM while jobs run. When it falls below a floor (e.g. 5% or 1 GB), new jobs wait and the status shows why; nothing running is killed by the studio. Out-of-memory crashes keep the Step 9.6 rule: no automatic restart |
| Crash recovery | Unchanged for text. Image, speech and voice recovery follows #32, after the queue exists, so a crash fails the queued jobs with a clear error instead of hanging |

### Read-only monitoring

`GET /api/resources` (additive, read-only, behind the same pipeline and sign-in):
* the budget (RAM, VRAM where known, with a `known` flag);
* each engine's state, the running job and the queue length;
* the thread budget and its current shares;
* the active limits and whether each is `off`, `warn` or `enforce`.

It returns no paths, ids of other clients, prompts or file names. It is safe to poll; the UI doesn't use it until a
separate UI change is approved.

### Later (designed for, not built in 9.9)

* **Per-user limits and API-key quotas:** the queue entries carry an owner field (always `local` today), so limits
  can later count per user or per key once multi-user accounts and API keys exist (#28).
* **Local/cloud routing:** the scheduler's "can this run here now?" answer is the input a future router would use
  to choose local or (opt-in) cloud inference. Nothing is sent anywhere, and offline use doesn't change.

## 3. Rollout

| Stage | PR | Behaviour change | Rollback |
|---|---|---|---|
| 9.9a (done) | Fix #68 (unstartable engine stops the server; PR #72) and #67 (non-streaming chat errors; PR #73), both merged | Bug fixes only | Revert the PR |
| 9.9b (done, #77) | `services/scheduler.cjs` with read-only accounting; `GET /api/resources`; tests | None: it only records and reports | `USAP_SCHEDULER=off` (or `"scheduler": "off"` in `app/config/scheduler.json`) leaves the route out |
| 9.9c (in review, off by default) | Bounded chat queue (decision A): 1 running + 4 waiting per engine, FIFO, `429 QUEUE_FULL` with `Retry-After`, waiting requests leave on disconnect, `503 QUEUE_TIMEOUT` after the longest wait (10 min) | Only when turned on: requests past the limit get `429` | `chatQueue: off` (the default) or `USAP_SCHEDULER=off` restores the unbounded queue |
| 9.9d (in review) | Memory check before loading a model, **warn only** (a field in the start response and a log line) | None for users; adds a field | Setting `memoryCheck: off` |
| 9.9e | Thread budget shared between engines | Thread counts change only when engines overlap | `threads: off` |
| 9.9f | Memory check **enforced** (with a force option), image/speech/voice queues, queue timeouts, stream idle timeout. Still one heavy model at a time (decision B) | New refusals, each with a clear message | Per-setting `off` |

Each stage lands only after its tests pass on all 4 OS and the native-runtime timings (Step 9.10) don't regress.
Stages 9.9c–f change behaviour and each needs a separate owner approval.

### Stage 9.9b as built

* `services/scheduler.cjs` builds a snapshot from accessors the engines already have, plus counters added to the
  existing operation queues (text engine, speech, voice) and to chat requests (active, and streaming requests
  waiting for the one engine connection). The counters only count: order, timing and limits are unchanged.
* `GET /api/resources` (`routes/resources.cjs`) returns `{ ok, scheduler: { mode: "observe", decisions: false },
  cpu, memory, heavyModel, engines, limits }`. Every number is `{ value, known }`; unknown memory is
  `{ value: null, known: false }`, and a VRAM total of 0 counts as unknown. It names no model, path, prompt,
  conversation, client or credential; `heavyModel` is only `{ type }`. Every limit reads `off`.
* The image engine has no studio-side queue, so its queue is reported as unknown.
* Rollback: `USAP_SCHEDULER=off` or `app/config/scheduler.json` `{ "scheduler": "off" }`. The environment wins.
* Evidence: `scripts/tests/scheduler.test.cjs` (8 tests), and the 9.8h 60-request golden comparison against
  `main` is identical with the scheduler on and off.

### Stage 9.9c as built (off by default)

Numbering: the owner asked for the bounded chat queue as 9.9c, so it swapped places with the warn-only memory check
(now 9.9d). Nothing else in the rollout changed.

* `services/chat-queue.cjs`: one chat runs at a time (the engine runs with `--parallel 1`, so this matches what it
  can do), at most 4 wait, first in, first out. A full queue answers `429` `{ ok: false, code: "QUEUE_FULL",
  retryAfterSeconds }` with a `Retry-After` header, estimated from recent chat durations (1–120 s). A waiting
  request whose client disconnects leaves at once and never reaches the engine. Nothing waits longer than
  `chatQueueMaxWaitMs` (10 minutes; 1 s to 1 hour): then `503 QUEUE_TIMEOUT` with `Retry-After`.
* A request admitted after the engine stopped or crashed gets `409 ENGINE_NOT_READY` instead of reaching a missing
  engine. The running chat is never touched by the queue.
* Setting: `USAP_CHAT_QUEUE=on|off` or `app/config/scheduler.json` `{ "chatQueue": "on" }` (the environment wins),
  read at start-up. Off by default; `USAP_SCHEDULER=off` also turns it off. `GET /api/resources` shows
  `limits.chatQueue` and the running and waiting counts.
* Unchanged: one heavy model at a time (decision B); no memory decisions (unknown memory is still reported as
  unknown); no new timeout on the running stream; no UI change.
* Evidence: `scripts/tests/chat-queue.test.cjs` (10 tests: queue order, limits, disconnects, timeouts, settings, a
  burst of 12, stopping and crashing the engine while requests wait, stopping the server, and off/rollback). The
  9.8h 60-request comparison against `main` is identical with the queue off and on.
* Real-model validation (opt-in, `scripts/ci/chat-queue-validate.cjs`, native-runtime job on all 4 OS): after the
  first launch stops, the script starts its own servers from the checkout with `USAP_CHAT_QUEUE=on` in their
  environment only (the installed default stays off), loads Qwen2.5 0.5B Q4_K_M with real llama.cpp on the CPU, and
  checks from outside, through the app API and the engine's own `/metrics`:
  * 1 running + 4 waiting, `429 QUEUE_FULL` with a `Retry-After` that matches the body, FIFO completion order;
  * a cancelled waiting request leaving the queue and never reaching the engine (engine prompt-token counter);
  * a cancelled running request stopping engine generation (`requests_processing` back to 0, no more tokens);
  * two streams through the queue (complete SSE, `finish_reason`, `[DONE]`, the second starting after the first),
    and three consecutive streams, with the queue on and off; two overlapping streams with the queue off;
  * recovery after a request the engine refuses (prompt longer than the context);
  * 5 rounds of a full queue with 2 MB waiting requests cancelled: no leaked slots, engine idle, bounded memory;
  * a hard engine kill with requests waiting (stream cut, waiting requests answered, supervisor restart, chat
    works again);
  * server shutdown with requests queued (every client answered or closed, engine process and ports gone);
  * `503 QUEUE_TIMEOUT` with a 3 s limit;
  * rollback: `USAP_SCHEDULER=off`, and `USAP_CHAT_QUEUE=off` over a `scheduler.json` that says on (7 simultaneous
    requests, none refused).

  Two different engine failures, handled differently: an engine connection that **ends** (crash, reset, a cut-off
  error body) produces a terminal event, and the chat answers at once (#90 for error responses). An engine
  connection that **stalls** (stays open and sends nothing) produces no event, so nothing ends it today; that needs
  the bounded execution and timeout work of stage 9.9f.

  The script only touches the engine its own server started (found by its listening port, never by name). What
  the queue doesn't do is recorded as `UNSUPPORTED`, not passed: memory-pressure admission (9.9f) and a
  timeout for the running request. Which error a waiting request gets after a crash is recorded as `EXPECTED`.

### Stage 9.9d as built (warn only)

* `services/memory-check.cjs` runs just before an engine process starts with a model: the text engine
  (llama.cpp, after any previous engine has stopped and the context size, KV-cache type and GPU layers are final,
  including automatic restarts after a crash and the out-of-memory retry) and the image engine
  (stable-diffusion.cpp; Core ML folders are not assessed). It is an optional dependency of both engines, wrapped
  so that nothing it does can refuse, delay or change a load: it never returns an error, unloads, restarts,
  reroutes, queues or reorders anything, and changes no thread count, context size or other setting.
* **Measured:** total RAM and available RAM from `hardware.budget`, and model file sizes (plus a vision projector).
  Available RAM is `MemAvailable` on Linux (`os.freemem()`, checked to be identical), available physical memory on
  Windows, and on macOS free + inactive + speculative pages from `vm_stat` (polled every 5 s; before the first poll
  only free pages are known, which reads low and is marked `macos-available-memory-pessimistic`).
* **Estimated:** the KV cache at the context the engine is started with, from the GGUF header (layers, KV heads,
  key/value length) and the cache type (`q8_0`, `f16`, `q4_0`, ...), plus a fixed 256 MiB allowance for compute
  buffers. Estimates are rounded to MiB and labelled `estimate`; file sizes are labelled `measured-file-size`.
  Image working memory depends on resolution and pipeline and is **not estimated**.
* **Verdicts:** `may-not-fit` (the model files alone are larger than available memory), `tight` (available memory
  is below the estimate plus a margin of 5% of RAM, at least 512 MiB), `likely-fits`, or `unknown`. Unknown memory
  is never "enough": the verdict is `unknown` when available or total memory can't be read or is implausible
  (`null`, not a number, negative, more than the total), when the header has no usable metadata, when layers are
  offloaded to a discrete GPU (GPU memory isn't assessed in this stage), and for image models unless the files alone
  don't fit. Apple Silicon offload is compared with the shared memory pool (`unified`). Other work running at the
  time (chat, transcription, voice, image generation) is listed and never changes the verdict.
* **Output:** `memoryCheck` in the `POST /api/llm/start` and `POST /api/restart-backend` responses (only when that
  request produced a result), `memory.checks.text` / `memory.checks.image` and `limits.memoryCheck: "warn"` in
  `GET /api/resources`, and one `[memory]` server log line per load. A result contains sizes, a verdict, a
  warning code (`MEMORY_MAY_NOT_FIT`, `MEMORY_TIGHT`) and reason codes: no model, file or folder name, path, user
  name, prompt or process argument. No UI change.
* Cost: about 45 ms on a header with a 152,000-token vocabulary, once per model load; bounded by
  `model-metadata.cjs` read limits.
* Setting: `USAP_MEMORY_CHECK=warn|off` or `app/config/scheduler.json` `{ "memoryCheck": "off" }` (the environment
  wins), read at start-up. Default `warn`; `USAP_SCHEDULER=off` also turns it off. Off gives the responses, log and
  `/api/resources` of 9.9c exactly (`limits.memoryCheck: "off"`, no `memory.checks`, `stage: "9.9c"`).
* Limits of the estimate: it doesn't predict peak use, whether memory-mapped weights stay resident (the OS can
  page them out and back in, so "may not fit" can mean heavy swapping rather than a failed load), GPU memory, or
  memory other programs will take later. It is a hint for the user and an input for 9.9f, not a guarantee.
* Evidence: `scripts/tests/memory-check.test.cjs` (17 tests: sufficient, tight and insufficient memory; unknown
  and malformed readings; missing and broken metadata; a 70B-class estimate; cache types; GPU offload and unified
  memory; concurrent work; never throwing; privacy; settings; and, on the real server with the fake engines, a
  model estimated not to fit that loads and chats exactly like the check off (success and failure responses), the
  same chat-queue admission with and without a warning, a crash restart that is assessed again, a failed start
  without a stale result, `USAP_SCHEDULER=off`, and an image load). The native-runtime job records the real
  Qwen2.5 0.5B and CPU image results on all 4 OS (`scripts/ci/memory-check-report.cjs`).

## 4. Tests (GitHub Actions)

* **Unit:** the scheduler with a fake clock and fake engines. Covers queue order, limits, disconnects while queued,
  timeouts, thread shares, memory decisions with known and unknown VRAM, and that `off` matches today.
* **Server:** the fake llama-server and fake sd-server under concurrent load. Covers 20 simultaneous chats with
  a queue limit of 4 (4 queued, the rest get 429, every accepted stream completes in order), clients leaving the
  queue, image and chat at the same time, and memory refusals with a fake budget.
* **Native (all 4 OS, real models):** a chat and an image job at the same time finish correctly, and timings are
  recorded for Step 9.10.
* **Rollback:** with every setting `off`, the 9.8h golden comparison (60 requests) stays identical.

## 5. Owner decisions (2026-11-11)

These set the policy for later stages. They don't turn anything on: each behaviour-changing stage still needs its
own approval.

**A. Chat queue.** At most **4 waiting** chat requests per engine, not counting the one running. When the queue is
full, a new request gets `429` with code `QUEUE_FULL` and a `Retry-After` header estimated from the running and
queued work (at least 1 s), so nothing waits indefinitely. Queued requests are served first in, first out, so
earlier requests are never overtaken. A queued request whose client disconnects leaves the queue at once. Rollback:
`chatQueue: off` (setting and `USAP_CHAT_QUEUE=off`) restores today's unbounded behaviour, and a CI test checks
that. Lands in stage 9.9c (built: see below).

**B. One heavy model at a time.** The current default stays: a text and an image model are never loaded together
during the initial rollout (9.9b–9.9f). It can be reconsidered only after RAM and the relevant VRAM are reliably
accounted for, memory headroom has been measured, real workloads have been tested on all 4 OS with clear failure
handling and no unacceptable regressions, and the owner approves separately. **Unknown memory information never
counts as proof that a workload fits:** when free VRAM or RAM is unknown, the answer is "unknown", never "fits".

**C. Queue and memory information in the UI.** Showing queue position and memory warnings is approved as a
concept, after the stages that produce them are tested. A minimal UI change may be proposed then, as its own PR,
keeping the layout, visual design, navigation, themes and behaviour. No UI change is part of 9.9b–9.9f.

Stage 9.9b (read-only accounting and `GET /api/resources`) is authorized for implementation; its PR needs a separate
merge approval.
