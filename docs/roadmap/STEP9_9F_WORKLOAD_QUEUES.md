# Step 9.9f, third substage: voice, transcription and image-generation job queues (design)

Status: design merged (#113). The **voice queue is implemented, off by default** (§11, "As built"). The transcription
and image queues are design only. Nothing here was turned on by default. Each queue, its limits and its default need separate
owner approval, and each lands in its own implementation PR. Part of [STEP9_9_SCHEDULING.md](STEP9_9_SCHEDULING.md)
stage 9.9f. It follows the engine lifecycle coordination of #105 ([STEP9_9F_ENGINE_LIFECYCLE.md](STEP9_9F_ENGINE_LIFECYCLE.md)).

Code references are to `main` at `feea81d`.

## 1. Summary

* Three bounded job queues, one per engine, each **off by default** and rolled out one at a time:
  1. Kokoro voice;
  2. Whisper transcription;
  3. image generation.
* The policy is the same as the 9.9c chat queue: one job running, a few waiting, first in first out.
  * Full queue: `429 QUEUE_FULL` with `Retry-After`.
  * Waited too long: `503 QUEUE_TIMEOUT`.
  * A waiting job whose client disconnects leaves at once and never reaches the engine.
* A queue orders **jobs** (inference) only. It never loads, stops or restarts an engine. Model loads and stops stay in
  the lifecycle chains (the text chain, and the image lifecycle chain added by #112), which are a different thing
  (§4).
* No cross-engine priority, no per-job memory admission, no GPU or VRAM enforcement, and no running-job timeouts in
  this substage.
* `USAP_SCHEDULER=off` turns every queue off. Off means the code path from before, exactly.

## 2. Today (verified in code)

| Workload | Ordering today | Limit | Waiting job on client disconnect | Running job cancel |
|---|---|---|---|---|
| Kokoro voice `POST /api/tts/speak` | `runExclusiveTtsOperation`: one **unbounded** FIFO chain for model start and synthesis (`routes/tts.cjs:65-67`) | none | **still runs later**: no disconnect handling | none: `stopTts()` only resets state; the per-job worker (`supervisor.spawnSupervised`, `tts-engine.cjs:399`) keeps running |
| Whisper `POST /api/speech/transcribe` | `runExclusiveSpeechOperation`: one **unbounded** FIFO chain (`routes/speech.cjs:65`) | none | **still runs later** | none: `stopSpeech()` only resets state; `whisper-cli` (`speech-engine.cjs:346`) keeps running |
| Image generation (`/sdapi/*`, `/v1/*` proxied to sd-server; `POST /api/openvino-generate`; Core ML through the same proxy) | **no studio-side order**: requests go straight to the engine; `generationsInFlight` is counted only (9.9e) | whatever the engine does | the proxy request is destroyed; what the engine then does is not measured | only by stopping the image engine (#64) |
| Text chat | 9.9c chat queue (off by default), 9.9f-1 timeouts (off) | 1 + 4 when on | removed at once (9.9c) | 9.9f-1, when on |

Two more facts the design has to respect:

* **Transcription buffers the whole upload before it waits.** `readBinaryBody` accepts up to 1 GiB
  (`serve.cjs:669`) and the audio is read before the job joins the chain. So many waiting transcriptions mean
  unbounded memory today. A queue must refuse **before** the body is read (§5.3).
* **Each voice and transcription job is its own supervised process.** Ending a running job means stopping that
  process, with confirmed exit, which today nothing does.

Not measured yet. Each of these is a native measurement task, not a guess:

* sd-server under concurrent `txt2img`: whether it serializes, how long it holds the extra connections, and what it
  does when a client disconnects mid-generation;
* job durations per platform (they set the wait limits and `Retry-After`);
* per-job memory of Whisper (model plus audio) and Kokoro (worker RSS).

## 3. The queue primitive

Generalize `services/chat-queue.cjs` into a shared `services/job-queue.cjs`, with the same semantics, so all four
queues behave alike. The chat queue then uses it, and its behaviour, codes and reporting don't change (its existing
tests are the check).

* **Per engine:** `running` at most 1, `waiting` at most `limit`, strictly FIFO.
* **`admit(onClientGone)`** resolves `{ ok: true, release }` or `{ ok: false, status, code, retryAfterSeconds, error }`:
  * full: `429 QUEUE_FULL`, `Retry-After` from the observed average job time × position (1–120 s, as 9.9c);
  * waited longer than `maxWaitMs`: `503 QUEUE_TIMEOUT`;
  * client gone while waiting: the entry is removed at once, and the job never runs.
* **`release()` exactly once** per granted job, whatever happens: success, error, engine crash, client disconnect
  mid-job, or server stop. A second call does nothing. Every route path calls it from one `finally`.
* **No timers left behind:** a granted or cancelled entry clears its wait timer.

Proposed limits (owner decision 1): voice 4 waiting, 10 min wait; transcription 4 waiting, 10 min wait; image 2
waiting, 15 min wait (image jobs are long on CPU). The native measurements in §8 come first and can change them.

## 4. Lifecycle chains versus job queues

| | Lifecycle chain (text chain; image chain from #112) | Job queue (this design) |
|---|---|---|
| What it orders | engine start, stop, reload, restart, benchmark, model switch | inference jobs: a synthesis, a transcription, an image generation |
| Bounded | no: lifecycle operations are few and user-driven | yes: `limit` waiting, `maxWaitMs` |
| On a full or late queue | not applicable | `429` / `503` |
| Owns the engine process | yes (with the #105 slot when `engineSlot` is on) | **never**: it doesn't start, stop or restart anything |

Rules between the two:

* **A job never enters a lifecycle chain**, and a lifecycle operation never waits in a job queue. A stop must never
  wait behind queued jobs.
* **Today's lifecycle answers are kept.**
  * Image: a settings change while a generation runs stays `409 "Image generation is in progress"`.
  * Voice: `/api/tts/speak` starts the engine first when it isn't ready; that start stays in the TTS chain, before
    the job is admitted (it's a lifecycle step, not a job). Same for transcription.
* **When a stop happens while jobs wait:**
  * waiting jobs of that engine are refused at once with `503 ENGINE_STOPPED` (proposed, a new code);
  * the running job ends with the engine's own error;
  * nothing is retried, and nothing is restarted to "drain" the queue.
* **Image queue and the heavy-engine slot.** With `engineSlot` off, the #105 race still exists, so an image queue
  can't promise that the engine it queued for is still the owner. Proposal (owner decision 2): the image queue may
  be turned on only together with `engineSlot` on. Otherwise it stays off and the server logs why. With the slot
  on, a job admitted while the slot is `unloading` or `idle` is refused with the existing `409 ENGINE_NOT_READY` (already used by `/api/openvino-generate`), not sent.

## 5. Per-engine design

### 5.1 Kokoro voice (first)

* Wraps the synthesis step of `POST /api/tts/speak` only. The model start before it stays in the TTS chain.
* The client disconnecting while waiting removes the job.
* **Client disconnecting while running** (owner decision 3): either
  * (a) let it finish and discard the result (today's behaviour, simplest); or
  * (b) stop the worker process with confirmed exit (the `stopProcess` helper from #112), then release.

  Recommendation: (a) first, because it changes nothing on the running path. Add (b) only with native evidence.
* `/api/tts/stop`: unchanged for the running job. Waiting jobs are refused `503 ENGINE_STOPPED`.
* Crash of the worker: the job fails as today, the slot is released once, and the next job runs.

### 5.2 Whisper transcription (second)

* Wraps the transcription step. **Admission happens before the audio body is read**, so a refused request costs
  nothing. A `429` before reading the body means the client may get the answer while still uploading. The route
  then drains or destroys the request (the HTTP-correct way is answering and closing).
* Running-job disconnect: same choice as 5.1 (decision 3).
* The 9.9e thread budget (off) and the logical-CPU cap (on) don't change. They read "transcribing" as today.

### 5.3 Image generation (last)

* Wraps `POST /sdapi/v1/txt2img|img2img` and `/v1/images/*` in the proxy, plus `POST /api/openvino-generate`.
  Model listing (`GET /v1/models`) and other read-only calls are never queued. Whether Core ML paths are included
  is owner decision 4; it can't be tested on CI.
* A `429` on `/sdapi` and `/v1` is new for A1111/OpenAI-compatible clients. That is acceptable only because the
  queue is opt-in (owner decision 5).
* The client disconnecting while waiting removes the job. While running, the proxy request is destroyed as today.
  The engine's behaviour must be measured first (§2). If sd-server keeps computing after a disconnect, the next job
  waits until the engine is idle (`generationState`) before it's sent. That is "exactly one job on the engine",
  checked against the engine, not against the closed connection.
* No running-job timeout (image can only be cancelled by stopping the engine, #64).

## 6. Interactions

* **Chat queue and 9.9f-1 timeouts:** independent. Chat keeps its own queue and gate. No cross-engine priority, so
  a voice job never waits for a chat and the reverse.
* **9.9f-2 memory admission:** text loads only, unchanged. No per-job memory admission in this substage.
* **9.9e thread budget:** unchanged. Queues reduce oversubscription only by running one job per engine.
* **#105 slot:** see §4 (the image queue requires it on).
* **Crash and ownership:** each queue belongs to one engine. A crash of that engine fails the running job and
  releases its turn once. Waiting jobs keep their place. If the engine is no longer ready when their turn comes,
  they get the engine's not-ready answer. Nothing restarts automatically because of a queue.

## 7. Settings, reporting, rollback

* `voiceQueue`, `speechQueue`, `imageQueue`: `off | on`, default **off**. Set via `USAP_VOICE_QUEUE`,
  `USAP_SPEECH_QUEUE` and `USAP_IMAGE_QUEUE`, or `app/config/scheduler.json`. Limits are fixed in the first
  implementation (as 9.9c), with only the wait configurable within bounds. Invalid values are ignored and logged.
* `USAP_SCHEDULER=off` forces all of them off. Off is the code path from before, byte for byte.
* `GET /api/resources`, only when a queue is on:
  * `engines.voice.queue`, `engines.speech.queue` and `engines.image.queue`, each `{ running, waiting, limit, known: true }`;
  * `limits.voiceQueue` and the others;
  * counts of refusals and timeouts.

  Numbers and fixed words only, no text, file names or prompts.
* **Original WebUI:** unchanged. It already shows server errors for image, transcription and voice. A Playwright
  check per screen confirms that `429`/`503` appear as errors.

## 8. Tests

### 8.1 Deterministic (all 4 OS, `node --test`, fake engines)

* Fake engines with hold and release controls, as chat's `MODE:hold`:
  * a Kokoro worker stand-in;
  * a whisper-cli stand-in;
  * sd-server `slow-generate` plus a held mode.
* Capacity, `429` and `Retry-After`; FIFO order; queue timeout.
* A waiting disconnect never reaches the engine.
* `release` exactly once (success, error, crash, disconnect, stop).
* A transcription refused before its body is read.
* Stop with waiting jobs: `503 ENGINE_STOPPED`, no restart.
* Image queue: refused to turn on without `engineSlot`; slot interplay.
* Off and `USAP_SCHEDULER=off`: byte-identical responses.
* The chat queue's existing tests, unchanged, on the shared primitive.
* Mutation checks (no bound, no FIFO, no disconnect removal, double release, release skipped on error).

### 8.2 Native (linux-x64, windows-x64, macos-arm64, macos-x86_64; real CPU engines)

* Measurements first (§2): sd-server concurrency and disconnect behaviour, job durations, per-job memory.
* Per queue, on its own test servers with only that queue on:
  * a burst beyond capacity: `429` count and completion order;
  * a cancelled waiting job never reaching the engine (engine-side counters, not the closed connection);
  * an engine crash while jobs wait;
  * no orphaned job processes afterwards.
* GPU/NPU (Vulkan, Metal, CUDA, OpenVINO, Core ML) are recorded as UNAVAILABLE or UNSUPPORTED, never as passed.

## 9. Rollout

1. This design (approval).
2. Native measurements (§2), as a measurement-only PR or a manual workflow run.
3. The shared primitive, with the chat queue moved onto it (no behaviour change), plus the voice queue (off).
4. Transcription queue (off).
5. Image queue (off; requires `engineSlot` on).
6. A separate decision on any default, after four-platform evidence.

## 10. Risks and open decisions

### 10.1 Risks

* Refusing transcriptions before reading the body changes HTTP timing for slow uploads. The answer arrives early,
  so clients must handle an early response (browsers do).
* Image jobs may keep running on the engine after a disconnect. Until that is measured, the image queue's idle check
  must read engine state, which can lag (9.9e noted `generationState` follows the log).
* Moving the chat queue onto a shared primitive touches a merged feature. Its unchanged tests are the guard, and it
  can be left as is if the owner prefers (decision 6).
* More `429`s for scripted API clients, when on.

### 10.2 Open decisions for the owner

1. Queue limits and maximum waits per engine (proposed in §3).
2. Image queue only with `engineSlot` on (recommended), or allowed alone with the race documented.
3. Running-job disconnect: finish and discard (recommended first), or stop the job process with confirmed exit.
4. Whether the image queue covers Core ML and OpenVINO generation paths (not testable on CI).
5. Whether a `429` on `/sdapi` and `/v1` is acceptable when on.
6. Share one primitive with the chat queue (recommended), or leave the chat queue untouched.
7. A new code `ENGINE_STOPPED` for waiting jobs refused by a stop, or reuse `ENGINE_NOT_READY`.
8. Whether CI flake issues #108–#110 should be explained before more native queue checks are added.

## 11. As built: voice queue

Implementation: `scripts/server/services/job-queue.cjs` (setting and queue), with the call sites in
`routes/tts.cjs`, `serve.cjs` and `services/scheduler.cjs`. The chat queue (`services/chat-queue.cjs`) is
**unchanged**: the voice queue uses a new module with the same policy, so the merged chat queue isn't touched
(decision 6 deferred).

### 11.1 Baseline (today's voice chain, real Kokoro worker, CPU)

Measured with `scripts/ci/voice-queue-validate.cjs` in `native-runtime` before the queue existed (run 43668281325,
linux-x64, windows-x64, macos-arm64; macOS Intel: see §11.5):

| | linux-x64 | windows-x64 | macos-arm64 |
|---|---|---|---|
| Short job (45 chars), median | 3.5 s | 4.7 s | 3.3 s |
| Long job (359 chars) | 22.4 s | 26.3 s | 22.3 s |
| Peak worker RSS | 418–429 MB | 375–384 MB | 463 MB |
| 6 concurrent requests | all 200, in order, 1 worker at a time, 29.6 s | 35.9 s | 29.3 s |

Observed legacy behaviour, the same on all three:

* the chain is unbounded (no 429, no deadline);
* a client that disconnects while waiting still gets its job run and saved;
* a running job is never cancelled (its worker finishes);
* `/api/tts/stop` only resets state;
* server shutdown leaves no worker.

One worker process runs per job, and only one at a time: the chain already serializes, so the queue adds a bound, a
deadline and disconnect handling, not new exclusion.

### 11.2 Policy and limits

* Setting `voiceQueue: off | on` (`USAP_VOICE_QUEUE` wins over `scheduler.json`), default `off`. `USAP_SCHEDULER=off`
  forces it off, with a log line.
* 1 running + **4 waiting**, FIFO. Full: `429 { ok:false, code:"QUEUE_FULL", error }` with `Retry-After`
  (1–120 s, from the observed average job time).
* Longest wait: **10 minutes** by default (`USAP_VOICE_QUEUE_MAX_WAIT_MS` / `voiceQueueMaxWaitMs`, 1 s to 1 h), then
  `503 QUEUE_TIMEOUT` with `Retry-After`.
  * Why 10 minutes: a typical job measured 3–26 s, so 4 waiting jobs of that size drain in under 2 minutes, well
    inside the limit.
  * The API allows texts up to 5,000 characters, about 14× the long job. Scaling linearly (an estimate, not
    measured), that is roughly 5–6 minutes per job on these runners.
  * So a queue of very long jobs is exactly what the bound refuses, instead of leaving clients waiting indefinitely.
* Only the synthesis is queued. The model start before it (a lifecycle step) stays in the TTS chain, as before.

### 11.3 Cancellation and cleanup

* **Waiting client disconnects:** it leaves the queue at once. Its job never reaches Kokoro and nothing is saved.
* **Running client disconnects:** not cancelled. Each job has its own Kokoro worker process, so job-specific
  cancellation would be possible, but it isn't added in this PR (decision 3: finish and discard first). The job
  finishes, its output is saved as before, and only then is the turn released, so the next job never overlaps it.
* **`/api/tts/stop`:** waiting jobs are refused with `409 ENGINE_NOT_READY` (decision 7: the existing code). The
  running job finishes, as before.
* **Exactly once:** the turn is released in one `finally` per job (success, error, worker crash, disconnect).
  `release()` is idempotent. A disconnect after the grant, a timeout and a refusal can't settle a job twice.
* **Shutdown:** unchanged. The supervisor stops the worker, and waiting requests end with the server.
* No running-job timeout, no retry, no restart.

### 11.4 Reporting and compatibility

* Only when on, `GET /api/resources` gains:
  * `engines.voice.queue { running, waiting, known, limit }`;
  * `limits.voiceQueue: "on"`;
  * `voiceQueue { mode, limit, maxWaitSeconds, counts }`;
  * `scheduler.decisions: true`.

  Numbers and fixed words only, no text, voices or file names.
* Success (`{ ok, output }`) and error bodies are unchanged. The original WebUI is unchanged and shows the new
  codes as errors.
* With the queue off, every response is as before.

### 11.5 Tests and evidence

* `scripts/tests/voice-queue.test.cjs` covers:
  * unit tests with fake timers: empty, partial and full queues, FIFO, the deadline, waiting disconnect, exactly-once
    settlement (disconnect, timeout, refusal and grant racing), and `refuseWaiting`;
  * the real server with a stand-in Kokoro worker that holds, fails or crashes on request: 429 and `Retry-After`, FIFO
    at the worker, the deadline, waiting and running disconnects, crash and failure, stop with waiting jobs,
    completion racing a disconnect, shutdown, default off (legacy unbounded behaviour) and `USAP_SCHEDULER=off`.
* Mutation checks (locally): 8 of 8 deliberate breaks caught: no bound, LIFO, waiting disconnect ignored, no release
  on failure, release not idempotent, no deadline, stop not refusing, release at client close.
* Native: the same script, with the queue checks on the queue's own test server.
* macOS Intel: the baseline step didn't run in run 43668281325, because an earlier, unrelated check failed
  (`chat-timeouts-validate`: "after that abort, computation stopped", twice). The voice step now runs regardless
  (`if: !cancelled()`).
