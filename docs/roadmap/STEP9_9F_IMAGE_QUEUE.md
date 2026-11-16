# Step 9.9f-3: image-generation queue (design)

Status: **design only, not implemented.** Nothing in this document is turned on, and implementation needs separate
approval. It expands §5.3 of [STEP9_9F_WORKLOAD_QUEUES.md](STEP9_9F_WORKLOAD_QUEUES.md), using the CPU measurements
of sd-server and the voice and Whisper queues ([STEP9_9F_WHISPER_QUEUE.md](STEP9_9F_WHISPER_QUEUE.md)) as models.
All limits are **provisional design targets**, not final defaults.

## 1. Today (verified in code on main and measured)

### 1.1 Code path

* The WebUI (`app/frontend/src/services/api.js`) sends `POST /sdapi/v1/txt2img` or `/sdapi/v1/img2img` to the studio
  with a JSON body. For img2img, the chosen file is base64-encoded **as is** (no resize, no size limit), so the body
  is about 1.34× the file size.
* `services/image-engine.cjs` `proxyImageBackendRequest` forwards every request to sd-server **at once**:
  `req.pipe(proxyReq)`, `timeout: 0`, no body limit, no studio-side order. `/v1/*` (OpenAI-style clients) takes the
  same path. The only state is the 9.9e counter `generationsInFlight`, which counts but never limits. It drops by
  one when the **client** connection closes, even though the engine is still working.
* When the client leaves, the proxy does not destroy the upstream request. The upstream response is still piped to
  the closed client connection, so it is no longer read.
* `POST /api/openvino-generate` (OpenVINO NPU worker) is a separate route and a separate process. Core ML goes
  through the same proxy.
* `generationState.active` follows sd-server's log lines and lags at the start of a job. `/api/restart-backend`
  answers `409 "generation in progress"` while it is true.
* WebUI error display: on a non-OK answer it shows `detail` (or `error.message`). It replaces any message that does
  not begin with `Generation failed` by a generic "server is not responding or crashed" text. The studio's usual
  error shape `{ ok: false, error: "<text>", code }` therefore shows only as `Generation failed (HTTP <status>)`.

### 1.2 Measured (real sd-server, CPU, 256×256, 4 steps, SD 1.5 Q4_0, through the proxy)

| | Linux x64 | Windows x64 | macOS ARM64 | macOS Intel |
|---|---|---|---|---|
| one request | 36 s | 36 s | 27 s | 343 s |
| two concurrent | 37 / 73 s | 34 / 68 s | 40 / 67 s (partial overlap, no gain) | 292 / 585 s |
| peak RSS | ≈2.0 GB | ≈1.9 GB | ≈1.9 GB | ≈2.0 GB |

* sd-server serializes generation itself. A second concurrent request gives **no throughput gain**.
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

* at most **one** generation forwarded to the engine at a time;
* a small, bounded number of waiting jobs, in FIFO order;
* waiting jobs **held in the studio**, so a client that leaves while waiting costs nothing on the engine;
* honest status, including a running job whose client left.

Non-goals:

* cancelling a running generation (#64);
* more than one running job;
* any change when the queue is off;
* GPU or NPU claims;
* WebUI changes.

## 3. Settings and rollback

* `imageQueue: off | on`, default **off**. It is set with `USAP_IMAGE_QUEUE` or `app/config/scheduler.json`
  `{ "imageQueue": "on" }`; the environment wins. `USAP_SCHEDULER=off` forces it off, and the reason is reported
  (`forcedOffBy: "scheduler-off"`).
* It turns on **only together with `engineSlot: on`** (#105, earlier owner decision 2). Otherwise it stays off and
  the server logs why, so the queue can rely on knowing which engine owns the slot.
* Limits: `imageQueueLimit` 1–8 (proposed default **2** waiting) and `imageQueueMaxWaitMs`. The wait limit uses
  `job-queue.cjs`'s existing range of 1 s to 60 min; the proposed default is **60 min** (decision D2).
* Off: the queue is not created, and the proxy path is today's code, unchanged.

## 4. Admission and body handling

1. **Admission at arrival, before the body is read.** It covers `POST /sdapi/v1/txt2img|img2img` and the `/v1/images`
   generation and edit routes (decision D1). Read-only routes (`GET` models, options, progress) are never queued.
   * A full queue answers `429 QUEUE_FULL` with `Retry-After`.
   * A declared `Content-Length` over the ceiling answers `413` and closes at once, with no discard.
2. **The body is read in full, within bounds, before the job can run.** Holding the request unread is not possible:
   Node's `requestTimeout` (300 s) runs until the whole request is received, so a held upload would fail during a
   long wait. The body is small JSON plus at most one base64 image, so it is held **in memory**, not on disk.
   It follows the Whisper queue's one-account rule (§13.2 there):
   * one cumulative **byte ceiling** from arrival, proposed **64 MiB** (decision D6), covering upload and any
     discard after a refusal;
   * one absolute **upload deadline** from arrival (proposed 120 s) and an **idle limit** (30 s, from the last byte);
   * a refusal never starts a new deadline, and immediate close keeps the documented reset tradeoff.

   Worst-case memory is (limit + 1) × ceiling, so 192 MiB with the proposed defaults.
3. **Validation stays with sd-server.** The studio checks only size and that the body is valid JSON (`400`
   otherwise). It does not reinterpret prompts or settings.
4. **FIFO.** A place is assigned at admission. A job runs when it reaches the front and its body is complete. A job
   whose upload is still in progress keeps its place and runs when the upload ends, as with Whisper.

## 5. Dispatch and the running job

* **Engine check at dispatch.** With the slot on, a job is forwarded only if the image engine owns the slot and is
  ready. Otherwise it is refused with the existing `409 ENGINE_NOT_READY`; nothing waits for a load (decision D3).
  The queue never holds the image lifecycle chain while a job waits.
* **Forwarding** is today's proxy request with the buffered body: `timeout: 0` and no running-job deadline, because
  CPU jobs can legitimately take more than an hour.
* **The running place is released when the engine answers, not when the client leaves.** It is released exactly once
  when the upstream response ends or the upstream request fails or closes.
* **Client leaves while running:** the upstream request is kept. The upstream response is read and discarded with a
  byte cap (proposed 256 MiB), so the end of the job is still observed. Status shows the job as abandoned
  (decision D4). If the cap is exceeded, the upstream request is destroyed. The running place is then held until
  `generationState` reports idle, which is the lagging fallback and is documented as such.
* **Client leaves while waiting:** the job leaves the queue at once and is never forwarded. This is the main gain
  over today, measured as one full job of CPU.
* **Stop or restart:** `/api/stop-backend` and `/api/restart-backend` refuse **waiting** jobs with
  `409 ENGINE_NOT_READY`, as the voice and Whisper queues do. The forwarded job ends through the existing stop path
  with the engine's own error. With the queue on, restart's existing `409 "generation in progress"` also applies
  while a forwarded job is unsettled, which closes the window where the log lags at the start of a job.

## 6. Errors and WebUI compatibility

* Every queue answer keeps the studio shape `{ ok: false, error, code }` and adds an A1111-style `detail` that begins
  with `Generation failed:`. For example: `Generation failed: the image queue is full. Try again in about 40 s.`
  The unchanged WebUI then shows the real reason instead of a generic message (§1.1).
* Codes: `429 QUEUE_FULL` (+ `Retry-After`), `503 QUEUE_TIMEOUT` (+ `Retry-After`), `409 ENGINE_NOT_READY`, `413`
  (body over the ceiling), `408` (upload deadline or idle limit), `400` (body is not JSON).
* A successful answer is the engine's answer, passed through byte for byte as today.
* Queue answers on `/sdapi` and `/v1` are new for scripted A1111 and OpenAI clients. They only appear when the
  queue is on (earlier owner decision 5).

## 7. Reporting

When on, `/api/resources` gets additive `engines.image.queue` data:
`{ running, waiting, limit, known: true, abandoned }`, plus `limits.imageQueue` with the active settings and any
ignored values. When off, nothing changes (today's "unknown" stays). `generationsInFlight` keeps its 9.9e meaning.

## 8. Limits of the design

* It orders only requests that go **through the studio**. A local program that calls sd-server's loopback port
  directly bypasses the queue, as it does today.
* `/api/openvino-generate` (NPU worker) stays unchanged until it is measured (decision D5). Core ML requests go
  through the same proxy, so they are ordered too, but this is not validated on CI.
* A running job cannot be cancelled except by stopping the engine (#64). On macOS Intel with realistic settings,
  one job can exceed the 60 min maximum wait, so the job behind it gets `503 QUEUE_TIMEOUT`. Reaching the end of the
  wait time costs only that waiting job; the running job is not affected.
* Concurrency of upload connections is not limited by this design. The aggregate admission proposed in #131 should
  cover the image queue too.

## 9. Tests (before any default change)

### 9.1 Deterministic (`node --test`, all four OS, fake sd-server)

* Off, and `USAP_SCHEDULER=off`: byte-identical proxy behaviour, and no new `/api/resources` keys.
* Refused to turn on without `engineSlot`, with the reason logged.
* FIFO; 1 running; 429 at the limit with `Retry-After`; 503 at the wait limit.
* A client that leaves while waiting is never forwarded (the fake engine sees 0 requests).
* A client that leaves while running: the place is held until the fake engine answers, the answer is discarded within
  its cap, the job shows as abandoned, and everything settles exactly once.
* Body bounds: declared over the ceiling, chunked over the ceiling, slow drip, silent client, an early refusal
  followed by a drip. Assert server-side bytes read and close times, as in the Whisper tests.
* Stop or restart with waiting jobs refuses them (`409`); the running job ends with the engine's error.
* Error bodies carry `detail` beginning `Generation failed:`, and the WebUI error helper displays it (unit test of
  the existing helper, without changing it).
* Every test is time-bounded, cleans up in `finally`, and leaves no timers or processes behind.

### 9.2 Native CPU (linux-x64, windows-x64, macos-arm64, macos-x86_64; real sd-server, 256×256, 4 steps)

* Default off: same answers as today.
* On, with slot on:
  * two requests run one after the other through the queue;
  * a third waiting request whose client leaves never reaches the engine (engine CPU idle after the first two);
  * a running request whose client leaves keeps the place until the engine finishes;
  * stop refuses waiting jobs;
  * `USAP_SCHEDULER=off` rollback.
* Record times and peak RSS per platform. macOS Intel gets a longer job budget in CI, not a weaker assertion.

## 10. Open decisions for the owner

* **D1 Routes.** `/sdapi/v1/txt2img|img2img` plus `/v1/images` generation and edits (**recommended**, because all go
  to the same engine and an unqueued route would let work slip in behind the queue), or `/sdapi` only.
* **D2 Waiting deadline.** 60 min, the maximum of the shared primitive (**recommended**), or shorter. A count limit
  alone would need a change to `job-queue.cjs`, which is not proposed.
* **D3 Engine not ready at dispatch.** Refuse with `409 ENGINE_NOT_READY` (**recommended**, same as the other queues),
  or wait for a load that is already in progress.
* **D4 Abandoned running job.** Show it as `abandoned: true` in `/api/resources` only, with no UI change in this
  stage (**recommended**).
* **D5 Other backends.** OpenVINO NPU unchanged until measured (**recommended**); Core ML ordered through the proxy
  but not validated on CI.
* **D6 Body ceiling.** 64 MiB (**recommended**: an image file of about 45 MiB), or lower. Bodies over the ceiling get
  `413` only when the queue is on.

## 11. Rollout

1. This design is reviewed and merged (docs only).
2. The implementation goes in a separate PR, off by default, requiring `engineSlot` on, with the tests in §9 on all
   four OS. It needs separate approval.
3. Turning it on by default is a later decision, after the aggregate connection admission (#131) and GPU/NPU
   measurements.
