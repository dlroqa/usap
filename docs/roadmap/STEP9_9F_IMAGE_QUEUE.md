# Step 9.9f-3: image-generation queue (design)

Status: **implemented, off by default** (§13, "As built", which takes precedence over §2–§12 where they differ).
Nothing in this document is turned on by default; turning it on needs `engineSlot` on and, as a default, separate
approval. It expands §5.3 of [STEP9_9F_WORKLOAD_QUEUES.md](STEP9_9F_WORKLOAD_QUEUES.md), using the CPU measurements
of sd-server and the voice and Whisper queues ([STEP9_9F_WHISPER_QUEUE.md](STEP9_9F_WHISPER_QUEUE.md)) as models.
The owner's decisions D1–D6 are recorded in §10. All limits are **provisional design targets**, not final defaults.

## 1. Today (verified in code on main and measured)

### 1.1 Code path

* The WebUI (`app/frontend/src/services/api.js`) sends `POST /sdapi/v1/txt2img` or `/sdapi/v1/img2img` to the studio
  with a JSON body. For img2img, the chosen file is base64-encoded **as is** (no resize, no size limit), so the body
  is about 1.34× the file size.
* `routes/image.cjs` forwards **every** `GET` and `POST` under `/v1/` and `/sdapi/` to
  `services/image-engine.cjs` `proxyImageBackendRequest`. Nothing under `/sdcpp/` is forwarded.
* The proxy forwards each request **at once**: `req.pipe(proxyReq)`, `timeout: 0`, no body limit, no studio-side
  order. The only state is the 9.9e counter `generationsInFlight`, which counts but never limits. It drops by one when
  the **client** connection closes, even though the engine is still working.
* When the client leaves, the proxy does not destroy the upstream request. The upstream response is still piped to
  the closed client connection, so it is no longer read.
* The same proxy port serves sd-server (CPU, Vulkan, CUDA, ROCm, Metal builds) or, when `backendType` resolves to
  `apple-npu`, the Core ML Python worker (`scripts/workers/coreml_server.py`). `POST /api/openvino-generate` (OpenVINO
  NPU worker) is a separate route and a separate process.
* `generationState.active` follows sd-server's log lines and lags at the start of a job. `/api/restart-backend`
  answers `409 "generation in progress"` while it is true.
* WebUI error display: on a non-OK answer it shows `detail` (or `error.message`). It replaces any message that does
  not begin with `Generation failed` by a generic "server is not responding or crashed" text. The studio's usual
  error shape `{ ok: false, error: "<text>", code }` therefore shows only as `Generation failed (HTTP <status>)`.

### 1.2 sd-server routes (pinned release `master-685-19bdfe2`, `examples/server/routes_*.cpp`)

| Route | Kind | Reachable through the studio |
|---|---|---|
| `POST /sdapi/v1/txt2img`, `POST /sdapi/v1/img2img` | synchronous generation (JSON) | yes |
| `POST /v1/images/generations` | synchronous generation (JSON) | yes |
| `POST /v1/images/edits` | synchronous generation (multipart) | yes |
| `GET /v1/models`, `GET /sdapi/v1/{options, sd-models, samplers, schedulers, loras, upscalers, latent-upscale-modes}` | metadata | yes |
| `POST /sdcpp/v1/img_gen`, `POST /sdcpp/v1/vid_gen`, `GET /sdcpp/v1/jobs/{id}`, `POST /sdcpp/v1/jobs/{id}/cancel`, `GET /sdcpp/v1/capabilities` | asynchronous jobs | **no** (loopback port only) |
| `GET /` | sd-server's own page | no |

* Every synchronous generation holds sd-server's engine-wide `sd_ctx_mutex` for the whole job. This is why
  concurrent requests run one after another.
* sd-server's own capabilities report `cancel_queued: true, cancel_generating: false`. Only an asynchronous job that
  has not started can be cancelled; a running generation cannot be cancelled by any API.

### 1.3 Measured (real sd-server, CPU, 256×256, 4 steps, SD 1.5 Q4_0, through the proxy)

| | Linux x64 | Windows x64 | macOS ARM64 | macOS Intel |
|---|---|---|---|---|
| one request | 36 s | 36 s | 27 s | 343 s |
| two concurrent | 37 / 73 s | 34 / 68 s | 40 / 67 s (partial overlap, no gain) | 292 / 585 s |
| peak RSS | ≈2.0 GB | ≈1.9 GB | ≈1.9 GB | ≈2.0 GB |

* A second concurrent request gives **no throughput gain**.
* **A disconnect never stops a running generation**, through the proxy or directly. The engine keeps all its cores
  until the job ends, and the next request waits for it.
* **A request that disconnects while waiting still runs.** It is already inside sd-server, so one full job's worth
  of CPU is spent for nobody.
* Recovery is clean (ready, same process). Unload takes about 2 s.
* Realistic WebUI settings (512×512, 20+ steps) are many times slower. Estimating 4× the pixels and 5× the steps, one
  job on macOS Intel would take well over an hour. This is an estimate, not a measurement.
* GPU, Core ML, OpenVINO, Metal, CUDA, ROCm and Vulkan were **not** measured.

## 2. Goals and non-goals

Goals, only when the queue is turned on:

* exactly **one** generation forwarded to sd-server at a time;
* at most **two** waiting jobs (provisional), in FIFO order;
* waiting jobs **held in the studio** until they are sent, so a client that leaves while waiting frees its place and
  costs nothing on the engine;
* engine ownership released only on **verified** completion or termination of the forwarded job, never because the
  client left;
* honest status, including a running job whose client left or a backend that stalls.

Non-goals:

* cancelling a running generation (#64; sd-server cannot);
* more than one running job;
* any change when the queue is off;
* backends other than sd-server (D5);
* GPU or NPU claims;
* WebUI changes.

## 3. Settings and rollback

* `imageQueue: off | on`, default **off**. It is set with `USAP_IMAGE_QUEUE` or `app/config/scheduler.json`
  `{ "imageQueue": "on" }`; the environment wins. `USAP_SCHEDULER=off` forces it off, and the reason is reported
  (`forcedOffBy: "scheduler-off"`).
* It turns on **only together with `engineSlot: on`** (#105). Otherwise it stays off and the server logs why, so the
  queue can rely on knowing which engine owns the slot. The image queue therefore inherits every blocker on turning
  `engineSlot` on. Today #120 (sd-server exiting after it reported ready, seen on Windows CI) blocks that, and #105
  stays open.
* `imageQueueLimit`: 1–2 waiting, default **2**.
* `imageQueueMaxWaitMs`: default **10 min**, configurable from 1 s up to **60 min**, which is the shared primitive's
  maximum (D2).
* `imageQueueBodyBytes`: hard ceiling per request, default **64 MiB** (provisional, D6). `imageQueueBodyBudgetBytes`:
  aggregate in-memory reservation for all held bodies, default **128 MiB**.
* Off: the queue is not created, and the proxy path is today's code, unchanged.
* `services/job-queue.cjs` is reused unchanged.

## 4. Scope (D1, D5)

* **Queued:** `POST /sdapi/v1/txt2img`, `POST /sdapi/v1/img2img`, `POST /v1/images/generations` and
  `POST /v1/images/edits`. These are the four synchronous generation routes the studio forwards (§1.2). The match is
  exact on the path; a query string is allowed.
* **Not queued, forwarded as today:**
  * every `GET` (metadata, options, models, health);
  * any other `POST` under `/v1/` or `/sdapi/` (sd-server answers `404`, unchanged).
* **Not reachable, unchanged:** `/sdcpp/*` asynchronous jobs are not forwarded by the studio. A local program that
  calls sd-server's loopback port directly bypasses the queue, as it does today. sd-server's engine-wide lock still
  serializes such a job with the studio's forwarded job, so the queue's "one forwarded job" stays true. The running
  job can then take longer than expected (§8).
* **Backends (D5):** the queue is active only while the running image backend is **sd-server**. If the backend
  resolves to `apple-npu` (Core ML worker), the proxy behaves exactly as today and `/api/resources` reports the queue
  as `inactive: "backend"`. `/api/openvino-generate` is never queued. Other backends need their own design approval
  and native validation.
* sd-server builds for GPU devices (Vulkan, CUDA, ROCm, Metal) are the same server and ordering logic, but **only the
  CPU build is validated**. No GPU claim is made.

## 5. Admission and body handling (D6)

1. **Admission at arrival, before any body byte is read.**
   * Not ready (D3): if the engine does not own the slot, or is starting, loading or unloading, the answer is
     `503 ENGINE_NOT_READY` with `Retry-After`. Nothing is queued during start-up or model loading.
   * A full queue answers `429 QUEUE_FULL` with `Retry-After`.
   * A declared `Content-Length` over the ceiling answers `413` and closes at once, with no discard.
   * The aggregate body budget is checked as a reservation: the declared length, or the ceiling for a chunked body.
     If it cannot be reserved, the answer is `429 QUEUE_FULL` with reason `body-budget`.
2. **Actual bytes are counted, not the declared length.** Each request has one account from arrival, as in the
   Whisper queue (§13.2 there):
   * one cumulative ceiling (64 MiB) covering upload and any discard after a refusal;
   * one absolute upload deadline from arrival (proposed 120 s);
   * an idle limit (30 s) from the last byte received;
   * a refusal never starts a new deadline; immediate close keeps the documented reset tradeoff (#131).
3. **Bounded memory and backpressure.**
   * The body is kept as the received chunks. It is never concatenated, parsed or re-encoded; sd-server validates it,
     as today.
   * Worst case held in memory is the aggregate budget (128 MiB) plus at most one read chunk per open request.
   * Reading is paced by TCP. The body is written to sd-server chunk by chunk, waiting for `drain`.
   * The reservation is released exactly once: when the job is forwarded and written, or when it is refused, times
     out or its client leaves.
4. **Why the body must be read before the job's turn.** Node's `requestTimeout` (300 s) runs until the whole request
   is received. Holding an unread upload while waiting longer than that fails, so waiting is only possible for a
   request that has been received in full.
5. **Memory versus disk for held bodies** (D6 asks for the comparison before implementation):

   | | Memory (proposed) | Disk (`cache/image-uploads`, Whisper-style ledger) |
   |---|---|---|
   | Bound | aggregate budget 128 MiB (≤ 2 waiting + 1 receiving) | storage budget + free-space check |
   | Privacy | prompts and user images never touch disk | prompts and init images written to the portable drive |
   | Crash | nothing left behind | leftover files; needs the stale-file sweep, which is not implemented |
   | Cost | RAM next to a ≈2 GB engine | USB write and read per job; slower on portable drives |
   | Complexity | small (no files, no rename, no cleanup) | ledger, file safety, cleanup paths |

   Recommendation: **memory**, because the count and the size are both small and hard-bounded. Before
   implementation, peak RSS with 3 × 64 MiB bodies is measured on all four OS. If it is not acceptable, the ceiling
   is lowered rather than moving to disk.
6. **FIFO.** A place is assigned at admission. A job is sent when it reaches the front and its body is complete. A
   job whose upload is still running keeps its place and is sent when the upload ends, as with Whisper.

## 6. Dispatch, ownership and the running job (D3, D4)

* **Check at dispatch.** A job is sent only if:
  * the image engine still owns the slot and is ready;
  * the backend is sd-server;
  * the engine's start token (#105) is the one recorded at admission.

  Otherwise the job is refused with `503 ENGINE_NOT_READY` and `Retry-After`. A model switch or restart therefore
  never runs a job that was admitted for a different engine. The queue never holds the image lifecycle chain while a
  job waits.
* **Forwarding** is today's proxy request with the held body: `timeout: 0` and no running-job deadline (§7).
* **Ownership (D4).** The running place is released exactly once, and only on one of these:
  * the upstream response has ended;
  * the upstream request failed with an error;
  * the sd-server process exit is confirmed by supervision.

  A client that leaves never releases it.
* **Client leaves while running.** The upstream request is kept. The upstream response is read and discarded:
  counted, never stored. This lets the end of the job be observed. Status shows `abandoned: true`. There is no
  discard cap, because nothing is stored and the response comes from the local engine.
* **Stalled backend.** If sd-server stops answering without exiting, the place stays owned. It is never freed by a
  timer or by the log-driven `generationState`. Status shows `running` with `runningSeconds`, so a stall is visible.
  The way out is the existing stop or restart (`/api/stop-backend`), which ends the process; ownership is released on
  the confirmed exit.
* **Unexpected exit (#120).** If sd-server exits during or between jobs:
  * the forwarded request fails, and the client gets today's `502` engine error;
  * ownership is released on the confirmed exit;
  * waiting jobs are refused with `503 ENGINE_NOT_READY`;
  * nothing is retried, and the queue never restarts the engine.

  Production image supervision is not changed by this design.
* **Client leaves while waiting.** The job leaves the queue at once, its body reservation is released, and it is
  never sent. This is the main gain over today (measured as one full job of CPU).
* **Stop or restart.**
  * `/api/stop-backend` and `/api/restart-backend` refuse **waiting** jobs with `503 ENGINE_NOT_READY` (D3; the voice
    and Whisper queues use `409` for the same code, so the status differs by design and is documented).
  * The forwarded job ends through the existing stop path; ownership is released on the confirmed exit.
  * Restart's existing `409 "generation in progress"` also applies while a forwarded job is unsettled. This closes the
    window where the log lags at the start of a job.
  * The engineSlot lifecycle order (#105) is unchanged.

## 7. Deadlines (D2)

* The **waiting deadline** (default 10 min, at most 60 min) applies only while a job waits in the studio. When it
  expires, that job alone gets `503 QUEUE_TIMEOUT` with `Retry-After`. It never cancels or affects the running job.
* A **running job has no deadline.** sd-server cannot cancel it, so a timer could only lie about the engine state.
  * If a generation runs longer than the waiting deadline, or longer than the 60 min maximum, it simply continues.
    The jobs waiting behind it time out one by one with `503 QUEUE_TIMEOUT`, and new jobs are admitted while there is
    room.
  * On macOS Intel with realistic settings this is the expected outcome for a second job.
  * Only `/api/stop-backend` ends a running job.
* `Retry-After` for `QUEUE_TIMEOUT` and `QUEUE_FULL` is an estimate from recent job times, at least 30 s.

## 8. Errors and WebUI compatibility

* Every queue answer keeps the studio shape `{ ok: false, error, code }` and adds an A1111-style `detail` that begins
  with `Generation failed:`. For example: `Generation failed: the image queue is full. Try again in about 40 s.`
  The unchanged WebUI then shows the real reason instead of a generic message (§1.1).
* Codes:

  | Status | Code | When |
  |---|---|---|
  | `503` | `ENGINE_NOT_READY` + `Retry-After` | engine not ready at admission or dispatch, or stopped or restarted while waiting |
  | `429` | `QUEUE_FULL` + `Retry-After` | the queue is full, or the body budget cannot be reserved |
  | `503` | `QUEUE_TIMEOUT` + `Retry-After` | the waiting deadline expired |
  | `413` | | body over the ceiling |
  | `408` | | upload deadline or idle limit |

* A successful answer is the engine's answer, passed through byte for byte as today.
* Queue answers on `/sdapi` and `/v1` are new for scripted A1111 and OpenAI clients. They only appear when the
  queue is on.
* A request that bypasses the studio (§4) can make the running job take longer than its estimate. This affects only
  `Retry-After` accuracy, never ordering.

## 9. Reporting

When on, `/api/resources` gets additive `engines.image.queue` data:
`{ running, waiting, limit, known: true, abandoned, runningSeconds, inactive }`. `inactive` is `null`, or `"backend"`
when the backend is not sd-server. `limits.imageQueue` reports the active settings and any ignored values. When off,
nothing changes (today's "unknown" stays). `generationsInFlight` keeps its 9.9e meaning.

## 10. Owner decisions (2026-11-16)

* **D1 Routes:** only the four synchronous generation routes the studio forwards (§4). Metadata, options, management
  and health routes are excluded.
* **D2 Waiting deadline:** 10 min default, configurable up to 60 min, `503 QUEUE_TIMEOUT`. It is separate from the
  running job, which has no deadline (§7).
* **D3 Engine not ready:** `503 ENGINE_NOT_READY` with `Retry-After`. Nothing is queued during start-up or loading.
* **D4 Ownership:** held until verified completion or termination. Status shows `abandoned` and `runningSeconds`.
  Ownership is never released because a client left or a timer fired.
* **D5 Backend:** sd-server only. Core ML and OpenVINO are unchanged and need separate approval and validation.
* **D6 Body:** a 64 MiB provisional hard ceiling, counting actual bytes; bounded memory, backpressure and an
  aggregate reservation. Memory versus disk is compared in §5; peak RSS is measured before implementation.
* Capacity: one running, at most two waiting (provisional).

## 11. Tests (before any default change)

### 11.1 Deterministic (`node --test`, all four OS, fake sd-server)

* **Off and rollback**
  * Off, and `USAP_SCHEDULER=off`: byte-identical proxy behaviour, and no new `/api/resources` keys.
  * Refused to turn on without `engineSlot`, with the reason logged.
* **Routes and backends**
  * Exactly the four routes are queued; every `GET` and every other `POST` is forwarded unchanged.
  * With the backend `apple-npu`, the queue is inactive and the proxy is unchanged.
* **Ordering and limits**
  * FIFO and one running.
  * `429` at the limit and on body-budget exhaustion, with `Retry-After`.
  * `503 QUEUE_TIMEOUT` at the waiting deadline; the running job is untouched.
  * `503 ENGINE_NOT_READY` at admission (starting, loading or unloading) and at dispatch (start token changed).
* **Disconnects and ownership**
  * A client that leaves while waiting is never forwarded (the fake engine sees 0 requests), and its reservation is
    released.
  * A client that leaves while running: ownership is held until the fake engine answers, the answer is discarded,
    and the job shows as abandoned.
  * Stalled fake engine: ownership is held indefinitely (fake clock), `runningSeconds` grows, and stop releases it
    only after the confirmed exit.
  * The fake engine exits mid-job: `502` to the client, release on the confirmed exit, waiting jobs refused.
* **Body bounds**
  * Declared size over the ceiling, chunked body over the ceiling, slow drip, silent client, an early refusal
    followed by a drip.
  * Assert the bytes the server read, close times and held memory, as in the Whisper tests.
  * Forwarding respects `drain`.
* **Stop, restart and errors**
  * Stop or restart with waiting jobs refuses them; restart is refused while a forwarded job is unsettled.
  * Error bodies carry `detail` beginning `Generation failed:`, and the existing WebUI error helper shows it (unit
    test, helper unchanged).
* **Hygiene:** every test is time-bounded, cleans up in `finally`, and leaves no timers or processes behind.

### 11.2 Native CPU (linux-x64, windows-x64, macos-arm64, macos-x86_64; real sd-server, 256×256, 4 steps)

* Default off: same answers as today.
* On, with slot on:
  * two requests run one after the other;
  * a waiting request whose client leaves never reaches the engine (engine CPU idle after the others);
  * a running request whose client leaves keeps ownership until the engine finishes;
  * stop refuses waiting jobs;
  * `USAP_SCHEDULER=off` rollback.
* Measure peak RSS with three 64 MiB bodies held (D6).
* Record times per platform. macOS Intel gets a longer job budget in CI, not a weaker assertion.

## 12. Rollout

1. This design is reviewed and merged (docs only).
2. The implementation goes in a separate PR, off by default, requiring `engineSlot` on, with the tests in §11 on all
   four OS. It needs separate approval.
3. Turning it on, even only for testing outside CI, requires `engineSlot` to be cleared for activation first
   (#120). Turning it on by default is a later decision, after the aggregate connection admission (#131) and GPU/NPU
   measurements.

## 13. As built

Implementation: `scripts/server/services/image-queue.cjs`, wired in `serve.cjs` (setting, creation, `/api/resources`,
shutdown) and `routes/image.cjs` (the four routes, restart and stop). `services/job-queue.cjs` is unchanged.

### 13.1 Settings
| Setting (environment wins over `app/config/scheduler.json`) | Default | Range |
|---|---|---|
| `USAP_IMAGE_QUEUE` / `imageQueue` | `off` | `on`, `off` |
| `USAP_IMAGE_QUEUE_LIMIT` / `imageQueueLimit` (waiting) | 2 | 1–2 |
| `USAP_IMAGE_QUEUE_MAX_WAIT_MS` / `imageQueueMaxWaitMs` | 600000 (10 min) | 1 s – 60 min |
| `USAP_IMAGE_QUEUE_BODY_BYTES` / `imageQueueBodyBytes` | 64 MiB | 1–64 MiB |
| `USAP_IMAGE_QUEUE_BODY_BUDGET_BYTES` / `imageQueueBodyBudgetBytes` | 128 MiB | 1–192 MiB, and at least the per-request ceiling |

A value outside its range is ignored and reported at start-up, never clamped. The upload deadlines are fixed as
designed (§5.2): 120 s from arrival, 30 s without data. `USAP_SCHEDULER=off` forces the queue off
(`forcedOffBy: "scheduler-off"`). `imageQueue: on` without `engineSlot: on` is not supported: the queue stays off
(`forcedOffBy: "engine-slot-off"`) and the server logs why at start-up. The 192 MiB upper end of the budget exists so
the D6 measurement (§13.5) can hold three full bodies; the default stays 128 MiB.

### 13.2 Ownership and dispatch
* Engine identity comes only from the slot and the image engine's own state: the slot owner (`image`), phase
  (`loaded`), epoch, the current engine process and its readiness. The epoch and process are recorded at admission
  and compared at dispatch (§6); there is no second ownership mechanism.
* The running place is released exactly once: upstream response ended, upstream request or response failed, or the
  engine process's exit event. The body and its reservation are released when the body has been written to the
  engine (or when the job ends without being forwarded), before the place is released.
* Forwarding uses the proxy's own header handling (credentials removed, `Host` rewritten, CORS headers removed from
  the answer), `timeout: 0`, and writes the held chunks with backpressure. Upstream connection errors keep today's
  `502 "Image backend is not reachable: …"`.
* The Step 9.9e generation count (`generationsInFlight`) counts forwarded jobs as the proxy does (through a shared
  `trackGeneration` helper), so its meaning is unchanged.

### 13.3 Answers
Every queue answer is `{ ok: false, code, error, detail }`, with `detail` = `"Generation failed: "` + the message:
`503 ENGINE_NOT_READY`, `429 QUEUE_FULL` (plus `reason: "body-budget"` for the budget), `503 QUEUE_TIMEOUT`,
`413 BODY_TOO_LARGE`, `408 UPLOAD_TIMEOUT` (with `phase`: `idle` or `total`). `Retry-After` is at least 30 s.
Refusals before the body was read close the connection after the answer without reading the body
(`http/refusal-close.cjs`, as every other refusal).

### 13.4 Reporting
When on, `/api/resources` adds `limits.imageQueue: "on"`, `engines.image.queue`
`{ running, waiting, limit, known: true, abandoned, runningSeconds, inactive }`, and `imageQueue`
`{ mode, limit, maxWaitSeconds, memory: { bodyBytes, budgetBytes, reservedBytes, heldJobs }, counts }`. Off: unchanged.

### 13.5 Tests and evidence
* `scripts/tests/image-queue.test.cjs`: the setting and routes; the queue in process against a controllable fake
  upstream and engine state (FIFO and one at a time; pass-through of the engine's answer; a client leaving while
  waiting and while running; a stalled engine and its exit; an engine failure; the waiting deadline; not ready at
  admission; stale epoch and a different engine at dispatch; every body bound and both upload deadlines; the budget;
  stop/restart refusals; the Core ML pass-through); and the real server with the fake sd-server (off by default and
  unchanged; refused without engineSlot; `USAP_SCHEDULER=off`; on, with restart `409` and stop; shutdown with work
  in progress).
* `scripts/ci/image-queue-validate.cjs` in `native-runtime` on all four CPU targets with the real sd-server: §11.2's
  rows, and the D6 memory measurement (studio, engine and client resident memory while the studio holds three
  64 MiB bodies that are never sent to the engine; a stop condition ends it early if the studio passes 2 GiB or
  available memory falls below 1 GiB). The engine is measured only when its process is verified (the PID the guard
  reported, an sd binary whose parent is that guard); the guard is reported separately. A validator-only probe loaded
  into that one test studio (`scripts/ci/image-queue-memprobe.cjs`, `--expose-gc`) adds heap, external and
  `arrayBuffers` figures: after release and a forced garbage collection, `arrayBuffers` must be back near its baseline
  (the bodies are no longer referenced; resident memory alone is not used for that, since Node need not return freed
  memory to the OS). Four cancellation cycles and one 64 MiB body forwarded to the engine then check that retained
  buffers do not grow. Its results are evidence for the memory-versus-disk decision; they are not a default.
* GPU and NPU paths are not exercised; the queue makes no GPU or NPU claim.

