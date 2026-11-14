# Step 9.9f, second substage: memory-aware model-load admission (design)

Status: **design only, in review. Nothing is implemented.** The planned setting `memoryAdmission` is off by
default, and turning on enforcement needs a separate owner approval after observe-mode evidence (§10).

Scope: whether, and how, the studio refuses to **start the text engine with a model** when memory is likely
insufficient. Builds on the Step 9.9d warn-only check (`services/memory-check.cjs`). Part of
[STEP9_9_SCHEDULING.md](STEP9_9_SCHEDULING.md) stage 9.9f.

Out of scope for this substage:
- per-request chat admission;
- image, speech and voice job queues (9.9f-3);
- GPU and VRAM enforcement;
- image-model admission (§3.3);
- P4-2;
- any change to the 9.9d estimate, the `memoryCheck: warn` default, thread counts, context selection or the
  load profiles;
- any UI change.

Goal: a load that would very likely fail or freeze the machine can be refused before anything is started,
with a clear message and an explicit per-request override. A refusal must never happen on a doubtful reading,
and must never block the existing recovery paths.

## 1. Today (main `568003f`)

The text-model load path (`POST /api/llm/start` → `routes/llm.cjs` → `services/llm-engine.cjs`):

1. The route runs `startLlm(body)` inside `runExclusiveLlmOperation`, a single FIFO chain for every text-engine
   operation: start, stop-then-kill, benchmark, the chat out-of-memory retry and the supervisor restart.
2. `startLlmAttempts` validates the model (name, path, `.gguf`, architecture). It then tries each backend
   candidate with two load profiles, `requested` then `safe` (context ≤ 4096, q4_0 cache, no GPU layers). It
   stops early only on a start cancellation.
3. For each attempt, `startLlmWithBackend`:
   1. calls `assertNoOtherActiveRuntime` (decision B, one heavy model; `409 MODEL_ALREADY_ACTIVE`);
   2. stops the previous engines: `killBackend()` (image), `killOpenVinoWorker()` and `killLlm()`;
   3. picks a port and computes `llmSettings` (context, cache types, layers, load mode);
   4. runs **the 9.9d check**, `memoryAdvisor.beforeLoad("text", …)`;
   5. spawns llama-server, with no `await` between the check and the spawn.
4. On failure, the route sets `llmError` and calls `killLlm()`. The response carries an additive `memoryCheck`
   field when the check ran.

Facts this design depends on:

* **Releasing the previous engine.**
  * `killLlm` → `terminateLlmProc` waits for the child's exit (SIGTERM, then SIGKILL) and for the port to be
    free.
  * `killBackend` (image) waits a **fixed 2 s**, sends SIGKILL and resolves **without waiting for the exit**.
  * `killOpenVinoWorker` waits 0.8 s, then sends SIGKILL, also without waiting.
  * So "the stop returned" does not prove that the previous process's memory has been released.
* **Available-memory sources** (`hardware.budget.freeRamSource()`):

  | OS | Source | Read when |
  |---|---|---|
  | Linux | `mem-available`: `/proc/meminfo` MemAvailable through `os.freemem()` | live, at the call |
  | Windows | `available-physical` (`os.freemem()`) | live; the commit limit is not considered |
  | macOS | `vm-stat`: free + inactive + speculative pages | a **cached** reading, polled every 5 s and rounded to GB, so it can predate the previous engine's exit |
  | macOS, before the first poll | `os-free-pages` | free pages only, which reads low (flagged `macos-available-memory-pessimistic`) |

  None of them are aware of cgroup or container limits.
* **The 9.9d estimate.**
  * The *lower bound* is the measured size of the model file plus the vision projector.
  * The *estimate* adds the KV cache at the chosen context and cache types, computed from the GGUF header, plus
    a fixed 256 MiB allowance.
  * The verdicts:

    | Verdict | When |
    |---|---|
    | `may-not-fit` | available < lower bound |
    | `tight` | available < estimate + margin, where margin = max(512 MiB, 5 % of RAM) |
    | `likely-fits` | otherwise |
    | `unknown` | GPU offload outside Apple Silicon, any missing or implausible reading, missing metadata |

  * Apple Silicon with offload is assessed as `unified`, not `unknown`.
* **Loading mode.** The studio starts llama-server with `--mmap` (or `--load-mode mmap`) by default, so weights
  are paged in from the file on demand.
  * A model larger than available memory can therefore still start and run, very slowly, with heavy page-ins.
  * `mlock` (CPU only) and `mmap: false` make the weights fully resident.
* **Existing memory refusals.**
  * The Step 9.6 restart policy (`restart-policy.cjs`) already refuses an *automatic restart* after an
    out-of-memory exit, or when free memory is below the model's size.
  * The chat route's out-of-memory retry (`retryLowerContext`, at most once per request) restarts the engine one
    step down the context ladder through `startLlm`, without the `restart` flag.
* **The original WebUI** sends a fixed list of fields to `/api/llm/start`, so it cannot send a new field. On any
  non-OK response, it throws `data.error` and shows it as a load error. Its "unload the active model first"
  dialog is a client-side check, so a new 409 code does not trigger it.
* **Text and image starts are not serialized with each other.** `assertNoOtherActiveRuntime` runs before the
  stop awaits and looks only at ready or spawned processes. A concurrent start of the other engine kind inside
  that window is therefore not excluded by the current code. This is pre-existing; §6.3 says how admission
  treats it, and a deterministic test must confirm the window before it is relied on or fixed.

## 2. Configuration and precedence

```
memoryAdmission: "off" | "observe" | "enforce"     default "off"
```

| Source | Precedence | Notes |
|---|---|---|
| `USAP_SCHEDULER=off` | 1 (wins) | Forces admission off, as it does for every 9.9 stage. Rollback to the legacy scheduling behaviour. |
| `USAP_MEMORY_ADMISSION` | 2 | `off`, `observe` or `enforce`, exact lowercase. Anything else is **ignored and logged**, and the next source applies. |
| `app/config/scheduler.json` `"memoryAdmission"` | 3 | The same validation. |
| Default | 4 | `off` |

* **Dependency on 9.9d.** Admission uses only the 9.9d assessment. If the effective `memoryCheck` is `off`,
  admission is forced `off` too, with one log line. The `memoryCheck: warn` default is unchanged, and
  `observe` or `enforce` never turn the check on by themselves.
* **Read once at startup**, like `chatTimeouts`. A change needs a server restart. No API can change the mode.
* **The request body** can carry only the per-request override (§5). It can never enable, disable or change the
  mode, and never affects another request.
* **`off` is the current code path exactly.** The responses, the `memoryCheck` field, `/api/resources`, the logs
  and the timing stay byte-identical. That includes a request that sends the override field: it is ignored and
  not echoed.

## 3. Scope and the decision point

### 3.1 Text-model loads (this substage)

The admission decision replaces nothing; it runs **at the existing 9.9d call site** in `startLlmWithBackend`. The
ordering on that path is fixed as follows (the times are labels for tests):

| Step | What happens | Requirement |
|---|---|---|
| T0 | `assertNoOtherActiveRuntime` | unchanged |
| T1, release | `killBackend()`, `killOpenVinoWorker()`, `killLlm()` | Admission records `releasedAt`, and whether **each process that existed before T1 has been seen to exit** (`exitCode` or `signalCode` set, or the `exit` event). An unconfirmed exit means the release is unconfirmed. |
| T2, measurement | Available and total RAM | Taken **after T1**. Linux and Windows read live. On macOS, a fresh `vm_stat` read is taken at T2 in observe and enforce (one short child process; `off` keeps the cached path), because the 5 s cache can predate T1. The result is `measuredAt`, `source`, and `ageMs` = time from the reading to T4. |
| T3, estimate | The 9.9d `textRequirement` from the final `llmSettings`: context, cache types, layers, projector, load mode | Unchanged estimator. The load mode (`mmap`, `mlock`, `none`) is now recorded, because it changes how reliable `may-not-fit` is (§4). |
| T4, decision | `allowed`, `would-refuse` (observe), `refused` (enforce), `forced` or `exempt` (§4, §5, §6) | Synchronous, immediately before the spawn. |
| T5, spawn | llama-server starts | There is no `await` between T4 and T5 (true today; a test keeps it so). A refusal at T4 means nothing is spawned and no port is bound. |

Each `(backend, profile)` attempt passes through T0–T5 on its own, so the decision uses that attempt's settings.
A **refusal at T4 ends the whole start**, like a cancellation:
- no `safe` profile is tried, and no other backend;
- the lower bound (the file sizes) is the same for every profile, so a smaller context cannot turn
  `may-not-fit` into a fit.

A GPU attempt is assessed as `unknown` (never refused). If it fails and the start falls back to CPU, the CPU
attempt is assessed and may be refused. That is intended, and the message says so.

**The cost of deciding after T1:** if the request reloads the model that is already loaded, it has been stopped
before the refusal. Deciding before T1 would have to subtract the previous engine's memory, which none of the
readings can measure reliably, so the design accepts that cost.
- The end state after a refusal is the same as after any failed start today: no text engine, `llmError` set.
- Switching to a different model already requires unloading first (`MODEL_ALREADY_ACTIVE`). A refusal on that
  path therefore never unloads anything the user didn't unload.

### 3.2 Benchmarks

`POST /api/llm/benchmark` starts engines through `startLlmWithBackend`, and then reloads the winner through
`startLlm`. These are user-initiated loads, so they are assessed the same way. The first refusal ends the
benchmark with the same error, and observe mode records each assessment. Benchmark loads use a context ≤ 2048,
so the lower bound decides.

### 3.3 Not in this substage

* **Image-model loads.** The working memory of sd.cpp is unknown (`compute-memory-unknown`), and the image and
  OpenVINO stops don't wait for the process to exit. The only sound rule would be "files alone > available,
  measured after a confirmed release". It needs its own measurements and an independent approval: **a separate
  follow-up**. Image loads keep the 9.9d warning only.
* **Per-request admission** for chat (the KV cache is pre-allocated at load) or for image, speech and voice jobs
  (no estimates; this overlaps the 9.9f-3 queues).
* **GPU and VRAM.** Discrete-GPU offload stays `unknown` and is never refused.

## 4. Confidence, and when a refusal is allowed

The 9.9d verdict says *what* the numbers suggest. Admission adds a **confidence** for how far those numbers can be
trusted. In `enforce`, a load is refused only when **both** hold:

1. the verdict is `may-not-fit`; and
2. the confidence is `high`.

A verdict of `tight`, `unknown` or `likely-fits` is never refused, whatever the confidence. Neither is any
assessment whose confidence is below `high`.

### 4.1 Confidence rules

The confidence is `high` only when **every** condition below holds. Otherwise it is `low`, with a list of the
reasons that failed:

| # | Condition | Why |
|---|---|---|
| C1 | `memoryPool` is `system-ram`: a CPU backend, or `gpuLayers` 0 | GPU offload is unassessed; Apple Silicon unified memory has a Metal working-set limit nobody measures (`unified` → low) |
| C2 | The release was confirmed at T1 (every earlier engine process was seen to exit) | Otherwise the reading includes the previous model |
| C3 | The reading was taken after T1, with `ageMs` ≤ 2000, from a live source (`mem-available`, `available-physical`, or a fresh `vm-stat` taken at T2) | A stale or cached reading (`os-free-pages`, the 5 s macOS cache) is not a basis for a refusal |
| C4 | The reading is plausible: 0 ≤ free ≤ total and total > 0 (already checked by 9.9d) | — |
| C5 | No other heavy workload is starting or running: no image engine or OpenVINO process, no start of them in progress, no image generation, transcription or voice job running | Their memory use is changing and isn't measured |
| C6 | **Linux:** no cgroup memory limit below the host's total (cgroup v2 `memory.max`, v1 `memory.limit_in_bytes`) | `MemAvailable` ignores container limits. A detected limit gives `low` (warn only) until a cgroup-aware reading exists and has been validated. An unreadable cgroup is treated the same way. |
| C7 | **The shortfall is clear:** lower bound − available ≥ max(1 GiB, 10 % of the lower bound). **Provisional:** to be set from the observe evidence (§10), never below this. | A file a few MB larger than the reading is within the noise of the reading |
| C8 | **Load mode:** with `mmap` (the default), C7 alone isn't enough until §10 has shown that such loads fail or freeze in practice. Until then, `mmap` loads are `low`, and only `mlock` or `mmap: false` loads (weights must be resident) can be `high`. | With mmap, a model larger than available memory can still run by paging from disk; refusing it is a usability change that needs evidence first |

C8 means that, as designed, the **first `enforce` release would refuse only loads that must be resident**. Widening
it to `mmap` loads is a separate owner decision, backed by observe evidence.

### 4.2 OS and platform differences

| Topic | Effect | Handling |
|---|---|---|
| Memory-mapped weights | Pages load lazily and can be evicted. "Files > available" means paging, not certain failure | C8 |
| Linux page cache | `MemAvailable` already counts reclaimable cache. A model that was just unloaded stays cached and counts as available | Fine for the decision. Recorded in reports |
| Containers, cgroups | The host-wide reading overstates what the container can use, which means missed refusals (false negatives), not false refusals; a refusal would still be on a misleading basis | C6: no refusal at all when a limit is detected |
| Windows commit limit | `available-physical` ignores the commit charge. A small pagefile can make allocations fail with physical memory free (a missed refusal). A large pagefile lets a load "succeed" while paging heavily | Measure the available reading against the commit limit at load in observe mode (§10). The confidence rules don't change until that's measured |
| macOS available memory | free + inactive + speculative can be pessimistic (compressed memory and purgeable pages aren't counted) | C3 needs a fresh reading. §10 compares it with real loads. If it proves pessimistic, darwin stays `low` |
| Apple Silicon unified memory | The GPU shares RAM, and the Metal working-set limit isn't measured | C1: `unified` is always `low` |
| Discrete GPU or VRAM | Not assessed | `unknown`; never refused |

### 4.3 Missing, stale and changing measurements

* **No reading** (unavailable, implausible or an error): the verdict is `unknown`, which is never refused.
  Observe records `measurement: "missing"`.
* **A stale reading** (taken before T1, older than 2 s, or the macOS cache): the confidence is `low`, and observe
  records `measurement: "stale"`. Never refused.
* **Memory changes between T2 and T5:** another program can allocate or free memory in that window, and nothing
  can prevent it. T2 → T5 is kept short and synchronous after the fresh read. The message says that closing
  other programs and trying again is the user's choice; there is **no automatic retry or re-measure loop**.

## 5. The per-request override

```
POST /api/llm/start   { …existing fields…, "memoryOverride": true }
```

* **Scope: one request.** It lifts a `refused` decision for that start only, recorded as `forced`. It doesn't
  change the mode, it isn't stored anywhere, and it doesn't affect any later or concurrent request.
* **Accepted value:** only the JSON boolean `true` as a top-level field of the `/api/llm/start` body. Any other
  value (`"true"`, `1`, a nested field) is treated as absent: observe and enforce report it as
  `override: { requested: true, accepted: false, reason: "invalid-value" }`. That gives no new 400 for existing
  clients. `off` ignores it entirely.
* **Never from anything else:**
  * prompt text or chat messages (the chat route never reads it);
  * model metadata or GGUF header fields;
  * persisted model settings (`lastSettings`, `preferredBackend`);
  * `scheduler.json`, an environment variable, query strings or headers.
* **Never carried forward:**
  * The field is removed from the request **before** `llmLastStartRequest` is saved, so a supervisor restart
    never inherits it (restarts are exempt anyway, §6.4).
  * It is never written to the model settings file.
  * The chat route's out-of-memory retry builds its own settings and never carries it.
  * A benchmark accepts it for its own run only.
* **Authorization:**
  * The override travels on the same route as the load itself, so it is only accepted on requests that have
    already passed the existing gates:
    * the Origin and Host policy;
    * `Content-Type: application/json` (S-9), so a cross-site form can't send it;
    * the Step 9.5 LAN sign-in, a session cookie or `Authorization: Bearer` when the server is reachable from
      the network.
  * The studio has a single access credential and no roles, and a signed-in client can already load and unload
    any model, so no further privilege is needed.
  * The report records where the override came from (`via: "local" | "network"`, from the same peer and Host
    test the sign-in exemption uses).
  * Owner decision, offered as an option: a stricter setting that accepts the override only from local
    requests. It is not proposed as the default.
* **Compatibility:**
  * The original WebUI never sends the field, so its behaviour is unchanged until a separately approved UI change
    adds a "load anyway" action.
  * Existing API clients that don't send it see `off` and `observe` exactly as today, and in `enforce` see the
    refusal described in §6.1.
* **Reporting:** the start response and `/api/resources` record `admission.decision: "forced"`, the verdict,
  the confidence and the sizes. They contain no paths, file names, model names or tokens. The log line is
  `[memory] admission: forced (may-not-fit, high confidence; override from local request)`.

## 6. Failure and recovery behaviour

### 6.1 The refusal

```
HTTP 409
{ "ok": false, "code": "MEMORY_INSUFFICIENT",
  "error": "The model's files (7.6 GB) are larger than the memory available now (5.1 GB), so it was not loaded.
            Close other programs and try again, choose a smaller model, or load it anyway (override).",
  "memoryCheck": { …the 9.9d assessment, unchanged… },
  "admission": { "mode": "enforce", "decision": "refused", "confidence": "high", "overridable": true } }
```

* **Why 409:** `/api/llm/start` already answers 409 for a state conflict (`MODEL_ALREADY_ACTIVE`), and the chat
  route answers 409 for engine states. The refusal is a conflict with the machine's current state that the user
  can resolve. The WebUI already shows `error` for any non-OK start.
* **Rejected alternatives:**
  * 503 suggests a server fault and an automatic retry.
  * 507 is a WebDAV storage code.
  * 413 is about request size.
* **A stable code:** clients must key on `code: "MEMORY_INSUFFICIENT"`, not on the status. Its meaning doesn't
  change across versions.
* **State after a refusal:** the same as after a failed start today.
  * `llmError` is set to the message.
  * No process and no bound port.
  * `getActiveHeavyRuntime()` is null.
  * Nothing is persisted: `updateLlmModelSettings` and `llmLastStartRequest` only run on success.
  * The restart history is unchanged.
  * The next load works normally (tested).

### 6.2 Simultaneous load requests

* **Text with text:** loads are already serialized by `runExclusiveLlmOperation`, FIFO. Each request is assessed
  at its own T1–T4, after the one before it has finished, so a refusal of one never affects another.
* **A stop request during a load:** `POST /api/llm/stop` → `stopLlmNow()` cancels the start in progress (start
  token). If the cancellation arrives before T4, the start ends as `ENGINE_START_CANCELLED` and no admission
  decision is recorded. T4 → T5 has no await, so the cancellation can't land between the decision and the spawn.

### 6.3 Text and image at the same time

* The text/image race is pre-existing (§1), and admission doesn't fix it.
* Admission treats any image or OpenVINO process, start in progress or generation as "another heavy workload".
  C5 fails, so the confidence is `low` and nothing is refused.
* That rule can produce **no false refusal** from a concurrent image load, only a missed one.
* Serializing heavy-model loads across engines is a separate fix (to be filed as an issue), outside this
  substage.

### 6.4 Exempt paths, assessed only

Admission never refuses these:
- **the supervisor's automatic restart** after an unexpected stop (`startLlm(…, { restart: true })`), which
  already has its own memory rule in `restart-policy.cjs`;
- **the chat route's out-of-memory retry** (`retryLowerContext`), which is marked with an internal start option,
  never a body field;
- **the `safe` profile fallback of a start that was not refused.**

They are the existing recovery paths. Refusing them would leave no engine, or fight the recovery logic. Observe and
enforce record their assessment with `decision: "exempt"` and the path's name. Admission adds no restart, no retry
and no new attempt anywhere.

### 6.5 Errors inside admission

* If the admission code itself throws, the load **continues** (as 9.9d does), recorded as `decision: "allowed"`
  with `reasons: ["admission-error"]`.
* Fail-open is deliberate. A bug in an optional safety layer must not stop users from loading models, and the
  Step 9.6 restart policy and the out-of-memory messages still apply.

## 7. Observability

All of this is additive and present only when the mode is not `off`. It contains only numbers and fixed words.

* **The `memoryCheck` assessment** gains an `admission` object:
  * `mode`;
  * `decision`: `allowed`, `would-refuse`, `refused`, `forced` or `exempt`;
  * `confidence` and `confidenceReasons`, the failed C-rules as fixed words;
  * `measurement`: `fresh`, `stale` or `missing`, with `ageMs` and `source`;
  * `release`: `confirmed` or `unconfirmed`;
  * `loadMode`;
  * `path`: `start`, `benchmark`, `restart`, `oom-retry` or `profile-fallback`;
  * `override`.
* **`GET /api/resources`** gains `memoryAdmission`:
  * `{ mode, counts: { allowed, wouldRefuse, refused, forced, exempt }, lowConfidenceByReason: { … }, last }`;
  * plus `limits.memoryAdmission`.
* **One log line per decision**, as in 9.9d, without names or paths.

## 8. Rollback

* `memoryAdmission: off` (the default), `USAP_MEMORY_ADMISSION=off`, `memoryCheck: off` or `USAP_SCHEDULER=off`
  each restore today's behaviour exactly. Tests assert byte-identical responses.
* `observe` never changes a decision. It is identical to `off` except for the additive report and the fresh
  macOS reading taken at T2.
* No new background service. The macOS `vm_stat` read runs only during a load.

## 9. Tests

### 9.1 Deterministic tests (all 4 OS, `node --test`)

These use fake `budget` readings, injected `sizeOf` and GGUF metadata, fake child processes with controllable exit
events, and a fake clock. The fake llama server is reused for the spawn and for chat after a load.

| Area | Cases |
|---|---|
| Verdict × mode | `likely-fits`, `tight`, `may-not-fit` and `unknown` × `off`, `observe` and `enforce`: only `may-not-fit` with `high` confidence refuses, and only in `enforce` |
| Confidence | Each C1–C8 rule failing on its own gives `low` and no refusal; all passing gives `high`. The boundaries of C7 (exactly 1 GiB, 10 %), the C3 age (2000 ms against 2001 ms) and the C8 load modes |
| Measurements | Missing, implausible (free > total), throwing reader, stale (taken before T1), the macOS cached reading and `os-free-pages`, a fresh macOS read failing |
| Release ordering | The previous process exits late: the release is unconfirmed, so no refusal. A text engine stopped by `killLlm`: confirmed. The image engine killed without an exit event: unconfirmed. The measurement is never taken before T1 (an ordering assertion with a recorded call sequence) |
| Concurrent loads | Two text starts queued (each assessed after the previous finished); a stop during a load before and after T4; an image start or a running generation during a text load (C5, no refusal); no await between T4 and T5 (a spy) |
| Unload and reload | Reloading the same model when the reload would be refused: state after refusal; a later load succeeds; nothing persisted; `llmLastStartRequest` unchanged |
| Override | `true` accepted only in enforce, recorded `forced`; invalid values (`"true"`, `1`, nested) ignored and reported; `off` ignores and doesn't echo it; stripped before `llmLastStartRequest`; never read from model settings, metadata, chat bodies, env or config; a forced load followed by a crash → the restart is `exempt` and carries no override; `via` local against network (LAN harness with a token) |
| Authorization | Over LAN without a token: 401 before admission runs; with a foreign Origin: 403; wrong Content-Type: 415. The override is never evaluated on a refused request |
| Observe | Every decision path (`allowed`, `would-refuse`, `exempt`) loads normally; responses equal `off` apart from the additive fields |
| Off and rollback | `off`, `USAP_SCHEDULER=off`, `memoryCheck: off` (forces admission off): byte-identical responses, `/api/resources` and logs; invalid `USAP_MEMORY_ADMISSION` and `scheduler.json` values ignored and logged; env wins over the file |
| Exemptions | Supervisor restart, chat out-of-memory retry and the `safe` profile fallback are never refused, even when inflated to `may-not-fit` with `high` |
| Failure and cancellation | A refusal ends the start (no `safe` profile, no other backend); `ENGINE_START_CANCELLED` still wins; an admission exception → load continues with `admission-error`; error bodies contain no paths, names or tokens; the 409 body shape and code are stable |
| Benchmark | Refused on the first attempt → benchmark ends with `MEMORY_INSUFFICIENT`; observe records each attempt |

Mutation checks, as for 9.9f-1, must show that the tests fail when:
- the confidence gate is removed;
- `tight` is refused;
- the release check is skipped;
- the override leaks into `llmLastStartRequest`;
- an exempt path is refused.

### 9.2 Native CPU tests (4 platforms: linux-x64, windows-x64, macos-arm64, macos-x86_64)

These run in the existing `native-runtime` job, with a real small GGUF model on the CPU backend.

* **No runner's real memory is ever exhausted.**
  * A test-only setting, `USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES` (a positive integer; any other value is
    ignored), adds bytes to the lower bound. It can make a refusal more likely, never less likely, so it can't
    serve as a bypass. The studio has no test-mode flag today, so the setting is documented as test-only.
  * Its use is logged at startup and recorded in every report (`testInflation: true`).
* **Checks with inflation, in `enforce`, `mlock` or `mmap: false`:**
  * refused with 409 `MEMORY_INSUFFICIENT`;
  * no llama-server process spawned (process list and port checked);
  * then `memoryOverride: true` → loads and answers a short chat;
  * then a SIGKILL of the engine → the supervisor restart is `exempt`.
* **The same inflation with `mmap`** → `low` confidence (C8), allowed.
* **`observe`** → `would-refuse`, and the model loads and chats.
* **`off`** → byte-identical to main.
* **Measured on each OS and recorded as evidence, not as pass/fail limits:**
  * 9.9d estimate against the engine's resident memory after load and after one chat;
  * the available reading at T2 against the drop observed after load;
  * the age of the macOS fresh reading;
  * on Linux, cgroup detection on the hosted runner (expected: no limit);
  * on Windows, the commit limit and commit charge at load.
* **Honest reporting:**
  * Anything that can't be set up on a platform (for example cgroup detection on macOS) is `UNSUPPORTED`, never
    passed.
  * GPU, Metal offload and NPU paths are not exercised and are reported as unvalidated.

### 9.3 Playwright

No UI change. One behaviour test: a 409 `MEMORY_INSUFFICIENT` from a stubbed start shows the existing load-error
display with the server's message, and the "unload the active model" dialog doesn't appear.

## 10. Rollout and the evidence required before enforcement

1. **Design review:** this document (docs-only PR).
2. **Default-off implementation:** `off`, `observe` and `enforce` with every rule above, the override, and the
   tests in §9. A separate PR, not merged without approval. `enforce` exists but stays off.
3. **Observe-mode evidence collection:** on the native matrix, and on owner-run hardware (low-RAM laptop, USB
   storage, macOS Apple Silicon and Intel, Windows with a small pagefile), using `/api/resources` and local logs.
   Nothing leaves the machine; evidence stays local.
4. **False-positive analysis:** for every `would-refuse` with `high` confidence, did the load actually:
   - fail;
   - freeze or swap heavily (page-in rate, tokens per second against the normal rate, time to first token); or
   - work normally?

   Then decide C7's final threshold and whether C8 may ever admit `mmap` loads.
5. **A separate owner approval** for any `enforce` activation. That covers its default and its scope (for
   example, "only `mlock`/`mmap: false` loads, CPU only").

**The minimum evidence before any real refusal is enabled:**
- Zero cases, across the observe data, where a `high`-confidence `would-refuse` load worked normally.
- The available-memory reading validated on each OS at T2 against the real headroom:
  - macOS fresh `vm_stat` (both architectures);
  - Windows available against commit;
  - Linux `MemAvailable` with and without page cache from a just-unloaded model.
- Release confirmation shown working on each OS: the reading after T1 no longer includes the previous engine.
- The cgroup detection verified in a limited Linux container (locally, not on hosted runners).
- The override and exemption paths verified natively on all 4 platforms.

## 11. Related: measurements before 9.9f-1 chat timeouts can be turned on by default

Step 9.9f-1 ([STEP9_9F_TIMEOUTS.md](STEP9_9F_TIMEOUTS.md)) stays `chatTimeouts: off`. Its experimental thresholds
are unchanged (first byte 600 s, idle 120 s, non-streaming 300 s, confirmation 120 s, unresponsive probe 15 s). A
proposal to turn on `observe` or `on` by default needs at least:

* **Slow CPUs and USB-loaded models:**
  * time to the first body chunk, against prompt length, on low-end 4-core CPUs;
  * weights paged in from USB storage;
  * macOS on battery.
* **Long prompts:** the same distribution up to the supported context limit (32k, the top of the context ladder).
* **Output pauses under memory pressure:** the gaps between body chunks while paging, with reasoning models, and
  across context shifts on full contexts.
* **Early cancellation during prompt processing:** how long a cancelled long prompt keeps the engine busy on
  slow CPUs. Hosted runners took 21–60 s for a 2,942-token prompt. This sizes the 120 s confirmation window: too
  short means user-visible 503s.
* **WebUI Stop behaviour** with `on`: how often the next message meets CONFIRMING or UNRESPONSIVE, and how long the
  wait is.
* **Recovery from UNRESPONSIVE:** the time to recover through the probe against a model reload, and that no
  request reached the engine meanwhile.
* **GPU and NPU backends where supported** (Metal, CUDA, Vulkan, ROCm): `/metrics` behaviour and cancellation
  latency. Currently unvalidated; hosted runners are CPU-only.
* **A llama.cpp version bump** must pass the native timeout checks (metric names, cancel behaviour) before a
  default can rely on them.
