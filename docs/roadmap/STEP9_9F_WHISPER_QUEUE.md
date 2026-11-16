# Step 9.9f-3: Whisper transcription queue (design)

Status: **design only, planned.** Nothing here is implemented. The transcription queue will be **off by default**, and
neither implementation nor default activation is approved. This expands §5.2 of
[STEP9_9F_WORKLOAD_QUEUES.md](STEP9_9F_WORKLOAD_QUEUES.md). The voice queue (§11 there) is its model, and
`services/job-queue.cjs` is the primitive it reuses.

All limits below are **provisional design targets**. They are not final defaults.

## 1. Today (verified in code and measured)

### 1.1 Code path
`POST /api/speech/transcribe` (`routes/speech.cjs`) works like this:
1. It reads the whole body into memory: `readBinaryBody` in `serve.cjs` buffers the chunks, joins them with
   `Buffer.concat`, and has a 1 GiB limit.
2. It then joins `runExclusiveSpeechOperation`, an **unbounded** promise chain.
3. `transcribeWavBuffer` (`services/speech-engine.cjs`) writes the audio to `app/transcriptions/.speech-<stamp>-<name>.wav`
   and spawns a supervised `whisper-cli` with `-t` capped by the logical-CPU cap.
4. The temporary WAV is deleted when whisper-cli exits or fails to start. The transcript is saved unless `save=false`.

Other facts from the code:
- The WebUI (`app/frontend/src/services/api.js`, `transcribeSpeech`) sends a raw WAV body (`Content-Type: audio/wav`)
  with query parameters and an `AbortSignal`. Dictation uses `save=false`.
- No multipart body is used by any client.
- `readJsonResponse` shows `data.error` for **any** non-OK status, so new statuses with a JSON `{ ok: false, error }`
  body are displayed by the original WebUI without changes.
- Node 22's `server.requestTimeout` is 300 s (`serve.cjs` sets only `server.timeout = 0`), so a whole request
  must arrive within 300 s. `headersTimeout` is 60 s.
- On SIGINT/SIGTERM the server stops the engines and exits. whisper-cli is supervised, so its guard ends it when
  the server goes away.

### 1.2 Baseline (measured)
Measured on 2026-11-15, locally on Linux, with the real `serve.cjs` and a whisper-cli stand-in that holds until it is
released:

| Case | Today |
|---|---|
| 1 running + 4 waiting uploads of 64 MB | Server RSS went from 63 MB to **583 MB** while they waited: each body is held in memory, about 2× its size. |
| Their start order | w1, w3, w2, w4: **by body completion**, not by arrival. |
| Client disconnects mid-upload | The job never runs and no file is left. The next job works. |
| Client disconnects while **waiting** | **It still runs, and the transcript is saved.** |
| Client disconnects while **running** | whisper-cli runs to the end, and the transcript is saved. |
| `Content-Length: 2 GiB` declared, 1 MB sent | **No answer** until Node's 300 s request timeout: the limit counts only received bytes. |
| Server killed during a transcription | The temporary WAV (8 MB) **stays, even after a restart**: there is no sweep. |
| 10 concurrent requests | All accepted (no bound). whisper-cli runs strictly one at a time. |

## 2. Settings and rollback

- The switch is `transcriptionQueue`: `USAP_TRANSCRIPTION_QUEUE=on` or `app/config/scheduler.json`
  `"transcriptionQueue": "on"`. **The default is off.** The environment wins, and `USAP_SCHEDULER=off` forces it off.
- When off, the service is **not created**, and the route is exactly today's handler: buffering, order, statuses and
  files all as in §1.
- Numeric settings use the `jobQueueSetting` pattern. An invalid value is **ignored and logged, never clamped**:

| Setting | Provisional default | Allowed range |
|---|---|---|
| Waiting jobs (`transcriptionQueueLimit`) | 4 | 1–16 |
| Longest queue wait (`…MaxWaitMs`) | 10 min | 1 s – 1 h |
| Aggregate upload reservation (`…StorageBudgetBytes`) | 2 GiB | 64 MiB – 64 GiB |
| Upload inactivity deadline (`…UploadIdleMs`) | 30 s | 5–120 s |
| Whole-upload deadline (`…UploadMaxMs`) | 240 s | 30–290 s, kept below Node's 300 s request timeout so USAP answers first |
| Per-upload ceiling | 1 GiB (today's limit) | **not raisable** |

- One transcription runs at a time, with no parallel whisper-cli.

## 3. Admission and FIFO order

**Order is the arrival order of admitted requests, assigned atomically at admission, before any body byte is read.**
Admission is a synchronous step on the event loop: there is one server process, so no two requests can interleave.

At arrival, the checks run in this order:
1. **Over the size limit.** If `Content-Length` is greater than 1 GiB, answer **413 `UPLOAD_TOO_LARGE`** at once and
   close.
2. **Queue full.** If running + waiting (uploading or uploaded) ≥ 1 + limit, answer **429 `QUEUE_FULL`** with
   `Retry-After`, without reading the body.
3. **Storage.** Reserve storage (§4). If the reservation fails, answer **507 `INSUFFICIENT_STORAGE`**, without reading
   the body.
4. **Admit.** Otherwise the job takes its FIFO position and its upload starts streaming to disk (§5). It streams
   **while** it waits.

A job may start transcribing only when its upload is **complete and verified**: all bytes received, equal to
`Content-Length` when one was given, within the ceiling, and starting with a `RIFF…WAVE` header.

**Head-of-line rule.** When the running turn reaches a job whose upload is still in progress, that job holds the turn
and waits for its own upload, never longer than the inactivity deadline (30 s without bytes) and the whole-upload
deadline (240 s from admission). So one slow client can delay those behind it by at most 240 s, and it can never hold
resources indefinitely. Later jobs never overtake an earlier admitted one.

Ends of an upload. Each outcome releases its FIFO position **and** its storage reservation **exactly once**, deletes
any partial file, and lets the next job proceed:

| Outcome | Answer |
|---|---|
| **Stalled** (inactivity deadline) | **408 `UPLOAD_TIMEOUT`** (`phase: "idle"`) |
| **Too slow** (whole-upload deadline) | **408 `UPLOAD_TIMEOUT`** (`phase: "total"`) |
| **Disconnected** | No answer (the client left); counted as `clientGone` |
| **Over the ceiling mid-stream**, or more bytes than `Content-Length` | **413 `UPLOAD_TOO_LARGE`** |
| **Fewer bytes than `Content-Length`** (connection ended) | Treated as disconnected |
| **Not WAV** (first 12 bytes) | The same status and message as today (500, "accepts WAV audio only"), but early |
| **Write failure** (ENOSPC, EIO, permission) | **507 `INSUFFICIENT_STORAGE`** for ENOSPC; 500 `UPLOAD_WRITE_FAILED` otherwise |
| **Queue wait exceeded** (10 min from admission, for jobs never started) | **503 `QUEUE_TIMEOUT`** with `Retry-After` |

## 4. Storage reservations

- **Budget.** One in-process ledger covers every byte that an upload may still write or that a file still holds:
  - files being uploaded;
  - uploaded files waiting;
  - the file of the running job until whisper-cli **exits**.
- **Reservation size:**
  - With `Content-Length`, the reservation is that value, which must be ≤ 1 GiB.
  - Without it (chunked), it starts at 64 MiB and grows in 64 MiB steps as bytes arrive. When growth fails, the
    upload ends with **507** and is deleted.
  - `Content-Length` is never trusted as proof of size. The received byte count is enforced against both the declared
    length and the ceiling.
- **Atomic.** A reservation is granted only if `reserved + request ≤ budget` **and** the free space is enough. The
  free-space test is `statfs(uploadDir).bavail × bsize − reserved − safety margin ≥ request`, with a margin of
  256 MiB or 2% of the volume, whichever is smaller. Both are checked and booked in one synchronous step.
- **Released** exactly once, when the file is deleted, on every outcome.
- **Portable and low-capacity storage (USB, FAT/exFAT):**
  - The effective budget is `min(configured budget, free space − margin)`, evaluated at each reservation. On a nearly
    full stick, uploads are refused up front with 507 instead of failing mid-write.
  - FAT32 can't hold files of 4 GiB or more. That doesn't apply under the 1 GiB ceiling, but it is documented.
  - If `statfs` is unavailable, only the configured budget applies, and an ENOSPC during writing ends that upload with
    507.
- **Memory** per upload is bounded and independent of size: a stream pipeline with Node's default highWaterMark,
  about 64 KiB of buffers per upload. The 1 + 4 jobs therefore use well under 1 MiB of buffers, compared with the
  583 MB measured today.

## 5. Streaming, backpressure and file safety

- **Streaming:** `stream.pipeline(req, byteCounter, fileWriteStream)`. Backpressure is native: a slow disk pauses
  `req`, and TCP slows the client. No body is ever concatenated.
- **Deadlines.** The inactivity timer resets on each received chunk. The whole-upload timer runs from admission. Both
  end the request with `req.destroy()` after answering.
- **No multipart.** The route keeps today's raw-WAV contract. A `multipart/*` body is refused early with today's
  "WAV only" error, not parsed.
- **Directory.** A **dedicated, USAP-owned upload directory**, `<data root>/cache/speech-uploads/`, which is
  `app/cache/speech-uploads` in portable mode and the per-user data root in installed mode, resolved by
  `paths.cjs`.
  - It is created at first use with mode `0700` (POSIX). Neither `transcriptions/` nor any OS temporary directory is
    used.
  - The directory is checked with `lstat` (not a symlink) and must resolve inside the data root.
- **File names** are generated, never derived from the client's filename:
  `<instanceId>-<seq>-<16 random hex>.upload`. Path traversal is therefore impossible by construction.
- **Opening a file:** `fs.open(path, "wx", 0o600)`, i.e. `O_CREAT|O_EXCL`, adding `O_NOFOLLOW` where the platform
  has it. After opening, `fstat` must show a regular file in that directory. Windows has no `O_NOFOLLOW`, so it relies
  on the exclusive create plus the `lstat` check of the directory.
- **Handing a file to whisper-cli:** the path is passed by argument. Today's `.speech-*.wav` copy in `transcriptions/`
  is **no longer written** when the queue is on (one disk copy instead of one plus two memory copies). whisper-cli's
  output (`-of`) goes to the same upload directory and is deleted after it is read.
- **Partial writes:** every failure path closes the descriptor first and then deletes the file. A delete that fails is
  recorded for the sweep (§7).

## 6. Disconnects, running jobs, shutdown and crash

- **Disconnect while waiting**, upload complete or not: the job leaves the queue at once. Its file and reservation are
  released, it **never reaches whisper-cli**, and nothing is saved.
- **Disconnect while running:** whisper-cli is **not** cancelled (as today and as for voice). The job keeps its turn
  **and** its reservation **until the worker process has exited**, as seen by the supervisor (`exit`), not when the
  HTTP response closes. The transcript is saved as today unless `save=false`.
  - Job-specific running cancellation would need its own design and approval.
- **`/api/speech/stop`:** refuses waiting jobs with **409 `ENGINE_NOT_READY`** (as the voice queue does) and leaves
  the running one.
- **Whisper settings:** the logical-CPU cap and the 9.9e thread budget are unchanged. Inference settings are
  untouched.
- **Shutdown** (SIGINT/SIGTERM):
  - New admissions stop.
  - Open uploads are destroyed, and their files deleted.
  - The running whisper-cli is stopped by the existing shutdown path (its supervisor guard).
  - This instance's files are deleted after the worker exits.
- **Crash** (SIGKILL, power loss, USB pulled):
  - The guard ends whisper-cli when the server's IPC channel closes (Step 9.6).
  - Leftover files are removed by the startup sweep (§7). Nothing is resumed.

## 7. Stale-file cleanup (separate, narrow fix)

This is designed here but is **a separate change with its own review and PR approval**, because it would also run
with the queue off (for today's `.speech-*` leftovers).

- **Scope:** only the dedicated `cache/speech-uploads/` directory, plus, for today's layout, `transcriptions/` files
  that match `^\.speech-.*\.(wav|txt|json)$` exactly.
  - Nothing else is touched: no OS temporary directories, no user transcripts, no chat attachments, no models.
- **Ownership:** each server writes `cache/speech-uploads/<instanceId>.owner` with `{ pid, processStartTime,
  dataRoot }` at start, and deletes it at clean exit. A file is **abandoned** only if all of these hold:
  - its name matches the strict pattern;
  - its owner file is missing, or names a PID that is not running, or one whose start time differs (PID reuse);
  - it is older than 10 minutes.
- **Other instances:** files of a live instance are never touched, for example a second portable copy launched on
  another port from the same USB data root.
- **Safety:**
  - Entries are read with `lstat`, and anything that isn't a regular file is skipped and never followed.
  - The sweep never leaves the directory.
  - It runs once at startup, and is cheap: the directory holds at most a few files.
- **Undeletable files** (a Windows file lock, permissions) are logged, counted in the report, and retried at the next
  start. Startup never fails because of the sweep.
- **Portable and installed:** both resolve the directory through `paths.cjs`, so the same rules apply.

## 8. Reporting

In `/api/resources`, **only when the queue is on**, as additive keys:
- `engines.speech.queue = { running, waiting, uploading, known, limit }`;
- `transcriptionQueue = { mode, limit, maxWaitSeconds, storage: { budgetBytes, reservedBytes }, counts }`, where
  `counts` covers admitted, completed, full, timedOut, uploadTimedOut, tooLarge, insufficientStorage, clientGone and
  refused.

It reports numbers and fixed words only: **no paths, file names, transcripts or languages**. Error bodies never
contain filesystem paths; the existing `publicPaths` and redaction rules apply.

## 9. Error contract

Every refusal is JSON `{ ok: false, error, code }`, which the original WebUI shows as an error (§1.1). **None of these
appears with the queue off**, except where noted.

| Status | Code | When |
|---|---|---|
| 413 | `UPLOAD_TOO_LARGE` | Over 1 GiB (declared or received). Today this is 413 only after reading. |
| 429 | `QUEUE_FULL` | 1 + limit jobs admitted. With `Retry-After`. |
| 507 | `INSUFFICIENT_STORAGE` | The reservation can't be granted, or ENOSPC while writing. With `Retry-After` when other uploads hold the budget. |
| 408 | `UPLOAD_TIMEOUT` | Inactivity or whole-upload deadline (`phase: "idle" \| "total"`). |
| 503 | `QUEUE_TIMEOUT` | Waited 10 min without starting. With `Retry-After`. |
| 409 | `ENGINE_NOT_READY` | Waiting job refused by `/api/speech/stop`. |
| 500 | (today's message) | Backend inference failure, and non-WAV input, unchanged. |

The codes keep storage exhaustion, queue capacity, upload faults and inference failures apart.

## 10. Tests

### 10.1 Deterministic (`node --test`, all four OS)
These use a whisper-cli stand-in that logs start and end and holds until released, an injectable `statfs`, and
scripted slow and disconnecting clients:
- **Off:** byte-identical to today, including §1.2's behaviour and no new `/api/resources` keys.
- **On, admission and order:**
  - FIFO by admission even when a later upload finishes first;
  - head-of-line wait bounded by the idle and total deadlines;
  - 413 before reading for an oversized `Content-Length`;
  - 413 mid-stream for more bytes than declared or more than the ceiling;
  - 429 with `Retry-After`.
- **On, storage:**
  - 507 from the budget;
  - 507 from injected low free space;
  - ENOSPC mid-write giving 507 and a deleted file;
  - chunked uploads growing their reservation;
  - every reservation released exactly once (ledger back to 0).
- **On, disconnects and deadlines:**
  - a disconnect while uploading or waiting never reaches the worker and saves nothing;
  - a disconnect while running keeps the turn and reservation until the worker's `exit`;
  - the stall and total upload deadlines;
  - `QUEUE_TIMEOUT`.
- **On, stop and memory:**
  - `/api/speech/stop` refuses waiting jobs;
  - constant server RSS with 4 × 64 MB waiting.
- **File safety:**
  - a symlinked upload directory is refused;
  - generated names only;
  - `0600` and `0700` modes (POSIX).
- **Rollback:** `USAP_SCHEDULER=off` gives legacy behaviour.
- **Sweep** (separate PR): owner rules, PID reuse, live other instance, symlinks, undeletable files, and only the
  strict pattern.

### 10.2 Native CPU (linux-x64, windows-x64, macos-arm64, macos-x86_64)
A `scripts/ci/transcription-queue-validate.cjs` step in `native-runtime`, on its own test servers with the queue on
only there. It uses the real whisper-cli and the already pinned `ggml-tiny.en.bin` and `jfk.wav`.
- **Baseline:** today's behaviour (§1.2) with the real engine.
- **Queue on:**
  - capacity, 429 and FIFO by admission;
  - a waiting disconnect never reaching whisper-cli;
  - a running disconnect holding the turn until exit;
  - 507 with a small configured budget;
  - 413 before reading;
  - server RSS with large waiting uploads;
  - `-t` still ≤ logical CPUs;
  - no orphaned whisper-cli;
  - no files left in the upload directory.
- **Rollback:** `USAP_SCHEDULER=off`.
- **GPU/NPU** paths are recorded as UNAVAILABLE. CPU results say nothing about them.

## 11. Compatibility

- The route, query parameters, request body and success body are unchanged.
- The WebUI is unchanged.
- The model and transcript directories are unchanged; the upload directory is new and lives under `cache/`.
- Offline and portable operation are unchanged; there is no cloud or external service.

## 12. Open decisions for the owner

1. Confirm the provisional values in §2.
2. Approve the stale-file sweep (§7) as its own PR, including the narrow legacy `.speech-*` pattern.
3. Approve the implementation PR (default off) after this design.
4. Any future running-job cancellation for whisper-cli (not proposed).
