# Step 9.9e: thread budget (design, not implemented)

Status: **Planned**. This is a design proposal backed by measurements. Nothing in it is implemented or turned on,
and no thread count changes until the owner approves an implementation separately. It builds on the scheduler
(`services/scheduler.cjs`, `GET /api/resources`, `limits.threads: "off"`) from
[STEP9_9_SCHEDULING.md](STEP9_9_SCHEDULING.md); there is no new service or framework.

## 1. How threads are chosen today

| Engine | Process | Threads today | When fixed | Measured OS threads (CI) |
|---|---|---|---|---|
| Text (llama.cpp) | persistent `llama-server` | `min(16, logical CPUs)`; a start request may ask for up to 64. `--poll 30` (worker threads busy-wait between tasks) | at engine start | 13–20 |
| Image (stable-diffusion.cpp) | persistent `sd-server` | setting (default 8), at most 4 with a GPU, at most the logical CPUs (#9) | at engine start | 14–36 |
| Speech (whisper.cpp) | `whisper-cli`, one process per job | `min(8, logical CPUs)`, passed as `-t`; a request may pass `threads` | per job | 4–31 |
| Voice (Kokoro) | Node worker, one process per job | **not set**: kokoro-js 1.2.1 forwards only `dtype`, `device` and `progress_callback`, and transformers.js 3.8.1 sets no thread option, so onnxruntime-node 1.21 uses its defaults (intra-op threads = physical cores, spinning on) | per job | 11–18 |

OS thread counts include I/O, HTTP and idle threads, so they are an upper bound, not compute threads. Only the
llama.cpp and sd.cpp `--threads` values and the whisper `-t` value are known exactly; Kokoro's compute threads
are **unknown** (the ONNX Runtime default is documented, not observed).

Because of decision B (one heavy model at a time), at most one persistent engine (text **or** image) exists. The
overlaps the studio can produce are therefore: a busy heavy engine (a chat streaming, an image generating) plus a
per-job transcription or voice job, or transcription plus voice. Chat plus image can't happen in the studio today.

## 2. Measurements

Tooling: `scripts/ci/thread-bench.cjs`, run by `.github/workflows/thread-bench.yml` on the 4 native targets
(run 43419228555 on `99760e4`, the tables below unless noted; repeated as run 43444789975, see Repeatability). It uses the native-runtime models: Qwen2.5 0.5B Q4_K_M (CPU, 2048 context,
128 tokens per chat), whisper tiny.en (JFK sample, 11 s), Kokoro 82M q8 (one sentence) and SD 1.5 Q4_0 (CPU,
256x256, 4 steps). It runs each workload alone (one warm-up, then 5 timed runs; 3 for image), then each pair with
the longer job in front (5 or 3 runs) and the other running back to back behind it. Image + chat ran with a second
llama-server started outside the studio from the studio's own logged command line (decision B).

Runners (GitHub-hosted VMs, CPU only; shared hosts, so absolute numbers are not user-hardware numbers):

| Target | CPU | Physical / logical reported | RAM |
|---|---|---|---|
| Linux x64 | Xeon 6975P-C | 2 / 4 | 15.3 GB |
| Windows x64 | EPYC 9V45 | 2 / 4 | 16.0 GB |
| macOS arm64 | Apple M1 (Virtual) | **1** / 3 | 7.0 GB |
| macOS Intel | Core i7-8700B | 2 / 4 | 14.0 GB |

### Alone

Median of 5 (image: 3), with the coefficient of variation (CV) in brackets.

| Workload | Linux | Windows | macOS arm64 | macOS Intel |
|---|---|---|---|---|
| Chat, 128 tokens | 2.25 s, 35.8 tok/s (0.01) | 1.37 s, 64.7 tok/s (0.07) | 1.28 s, 56.9 tok/s (0.19) | 2.93 s, 31.7 tok/s (0.46: one outlier of 7.1 s) |
| Chat at threads = physical cores | 2.30 s, 34.8 tok/s | 1.41 s, 61.3 tok/s | 2.20 s, 32.8 tok/s (1 thread) | 3.62 s, 25.4 tok/s |
| Transcription | 0.78 s | 1.14 s | 5.37 s | 1.47 s |
| Transcription, 2 threads | 0.76 s | 1.13 s | 6.02 s | 1.59 s |
| Voice | 3.66 s | 4.42 s | 6.22 s | 10.10 s |
| Image | 30.4 s | 42.1 s | 35.5 s | 288.6 s |

### Together

Median, with the change against running alone.

| Pair (front + behind) | Linux | Windows | macOS arm64 | macOS Intel |
|---|---|---|---|---|
| Chat + transcription | chat 96.6 s (+4199%, 0.8 tok/s); transcription 13.1 s (+1588%) | chat 3.86 s (+181%); transcription 1.30 s (+14%) | chat 50.7 s (+3861%); transcription 38.0 s (+608%) | chat 2.73 s (−7%); transcription 24.6 s (+1577%, n=1) |
| Chat + transcription at 2 threads | chat 24.7 s (+999%); transcription 2.31 s (+203%) | chat 2.33 s (+70%); transcription 1.52 s (+35%) | chat 17.4 s (+1258%); transcription 9.9 s (+64%) | chat 2.39 s (−19%); transcription 13.9 s (+778%, n=1) |
| Chat + voice | chat 17.8 s (+690%); voice 6.2 s (+70%) | chat 2.14 s (+56%); voice 5.8 s (+31%) | chat 4.55 s (+256%); voice 9.6 s (+55%) | chat 25.0 s (+751%); voice 18.2 s (+80%) |
| Image + transcription | image 57.7 s (+90%); transcription 4.0 s (+419%) | image 51.1 s (+21%); transcription 6.4 s (+459%) | image 120.7 s (+240%); transcription 38.3 s (+614%) | image 262 s (−9%); transcription 145 s (+9789%) |
| Image + transcription at 2 threads | image 48.2 s (+59%); transcription 1.30 s (+70%) | image 48.8 s (+16%); transcription 6.4 s (+472%) | image 82.2 s (+132%); transcription 9.6 s (+59%) | image 279 s (−3%); transcription 115 s (+7146%) |
| Image + voice | image 40.2 s (+32%); voice 6.8 s (+86%) | image 55.2 s (+31%); voice 11.0 s (+149%) | image 50.2 s (+42%); voice 9.0 s (+44%) | image 524 s (+82%); voice 19.5 s (+93%) |
| Image + chat (outside the studio, decision B) | image 57.5 s (+89%); chat 30.5 s (+787%) | image 44.8 s (+6%); chat 45.2 s (+1793%) | image 115.5 s (+226%); chat 55.7 s (+2090%) | run 1 stopped at its 170-minute limit before this window; **run 2**: image 1587.7 s (+581% against 233.1 s alone in the same run); chat 752 s, 0.2 tok/s (182x slower) |

Percentages for "at 2 threads" compare with the same workload alone at its default threads, except transcription
(compared with transcription alone at 2 threads; both are nearly identical).

### Repeatability (two runs)

The design PR ran the benchmark twice on the same code (run 43419228555 on `99760e4` and run 43444789975 on
`af1fd43`; the second commit changed only documentation). GitHub assigned different hardware to two targets:

| Target | Run 1 CPU | Run 2 CPU | Medians, run 2 vs run 1 (cells within ±15%) |
|---|---|---|---|
| Linux x64 | Xeon 6975P-C | Xeon Platinum 8573C | −49% to +84% (3 of 21); chat alone 2.25 → 1.94 s, image alone 30.4 → 39.0 s |
| Windows x64 | EPYC 9V45 | EPYC 9V74 | +12% to +90%, every cell slower (1 of 21); image alone 42.1 → 63.5 s |
| macOS arm64 | M1 (Virtual) | M1 (Virtual) | −29% to +29% (15 of 21) |
| macOS Intel | i7-8700B | i7-8700B | −37% to +47% (12 of 19 comparable cells; run 1 lacks the decision-B window); image alone 288.6 → 233.1 s |

Absolute times are therefore not comparable across runs on Linux and Windows. Every qualitative finding repeated:
chat + transcription collapses on Linux in both runs (96.6 s and 78.9 s against about 2 s alone); transcription at
2 threads improves chat on Linux (24.7 s and 16.5 s), Windows (2.33 s and 2.82 s against 3.86 s and 5.92 s at the
default) and macOS arm64 (17.4 s and 14.0 s); on macOS Intel, transcription stays badly starved next to an image
in both runs (145 s and 138 s at default threads, 115 s and 104 s at 2) while the image itself is unaffected or
faster; the decision-B pair (image + chat) slows chat 6–28x on Linux, Windows and macOS arm64 and 182x on macOS
Intel (run 2).
Thresholds in an implementation must come from same-run comparisons (policy off and on in one job), never from
these absolute numbers. Full per-run tables: `ci-evidence` artifacts of both runs (14-day retention on GitHub; the
owner's local copy keeps them).

Variability: alone, CV was ≤ 0.07 except chat on macOS (0.19 arm64, 0.46 Intel with one outlier). In overlaps CV
was 0.1–0.4, and macOS Intel's chat + transcription windows completed only one background transcription, so those
two cells are weak evidence. Hosted runners share hardware; repeated runs are needed before any number is used as a
threshold.

CPU and memory: every overlap kept the CPU at 96–100% busy (all logical cores). The lowest available RAM in any
window was 2.8 GB (macOS arm64, 7 GB total); no window came near memory pressure. Largest resident memory seen:
text engine 0.5–0.7 GB, image engine 1.8–2.2 GB, whisper-cli 0.17–0.35 GB, Kokoro worker 0.34–0.48 GB.

### What the numbers say

1. **Oversubscription is the cost, not memory.** Each engine starts as many threads as there are logical CPUs, so
   two busy engines ask for twice the CPU. With llama.cpp's busy-waiting workers (`--poll 30`) the result can be
   catastrophic (chat on Linux and macOS arm64 runs 40x slower next to transcription), and it depends heavily on
   the OS scheduler (Windows +181%, macOS Intel chat unaffected but transcription 16x slower).
2. **Reducing the per-job engine's threads helps most where it hurts most.** Transcription at 2 threads while chat
   runs: Linux chat 96.6 s to 24.7 s and transcription 13.1 s to 2.3 s; macOS arm64 chat 50.7 s to 17.4 s and
   transcription 38.0 s to 9.9 s; image + transcription on Linux and macOS arm64 improves for both. On Windows chat
   improves (3.86 s to 2.33 s) while transcription is slightly slower (1.30 s to 1.52 s); on macOS Intel it changes
   little. It doesn't remove contention: chat is still 10x slower on Linux, because llama.cpp keeps all its threads.
   Alone, transcription at 2 threads is as fast as at the default (0.76 vs 0.78 s Linux, 1.13 vs 1.14 s Windows) or
   slightly slower (macOS: +8% Intel, +12% arm64), so it should be reduced only while something else is busy.
3. **A physical-core limit for the persistent engines would change single-engine speed.** Chat with threads =
   physical cores: −3% Linux, −5% Windows, −20% macOS Intel, and −42% on the macOS arm64 runner, which reports 1
   physical core for 3 vCPUs. Physical counts from VMs aren't reliable, and Apple Silicon has no SMT. So the budget
   shouldn't lower the text or image engine's own count when it runs alone.
4. **Kokoro behaves like a full-width CPU job** (11–18 OS threads, 39–90% of the CPU alone) and slows a chat by
   56–751%. The studio can't control it without changing the worker.

## 3. Proposed policy (owner-approved direction; not implemented)

**What it is and isn't.** The budget is an **advisory scheduling heuristic**, not enforcement. It decides only the
thread count of a per-job engine at the moment that job starts. It never limits, pauses or restarts the persistent
text or image engine, whose counts stay as they are today, so the total number of busy threads can still exceed
the logical CPUs while a heavy engine and a per-job engine overlap. It reduces oversubscription; it doesn't
prevent it. One heavy model at a time (decision B) and the macOS Intel image thread cap stay unchanged, and the
initial default is `limits.threads: "off"`.

**Budget.** `B` = logical CPU count (what every engine already sizes itself by). Physical cores are reported and
used only as an advisory input, because the measurements show they are unreliable on VMs and lowering to them
costs single-engine speed. No CPU capacity is assumed beyond what the OS reports; if the count is unknown,
the policy does nothing (today's counts).

**"Busy".** The heavy engine is busy while a chat is running (`chat.active > 0`) or an image is generating; a
loaded but idle engine is not busy (the measurements show an idle loaded engine costs a transcription nothing).
A per-job engine is busy while its job runs.

**Rules.**

1. **A single active workload keeps today's count, exactly.** Nothing changes when nothing else is busy.
2. **Persistent engines (llama.cpp, sd.cpp) always start with today's count.** Their threads are fixed at start,
   the studio never restarts an engine to rebalance, and starting a model while a short per-job job runs would
   otherwise leave the model slow long after the job ended.
3. **A per-job workload that starts while another CPU workload is busy gets fewer threads:**
   `t = max(1, min(default, 2, B − 1))`. With 4 or more logical CPUs that is 2 (the measured value), with 3 it is
   2, with 2 it is 1, and with 1 it is 1 (no change possible). For whisper this is the `-t` value of that job; a job
   already running keeps its count (no mid-job change), so a chat that starts after a transcription still competes
   with it until the transcription ends. The WebUI always sends its own `threads` setting (1–32; default
   `min(8, navigator.hardwareConcurrency)`, 4 only when the browser reports no CPU count; see "Whisper thread
   defaults" below) with a transcription, so the reduction applies to the requested value:
   `t = max(1, min(requested, 2, B − 1))`; alone,
   the requested value is used unchanged, as today. Whether another workload is busy comes from server state
   (running chats, an image generation, a Kokoro job), never from the request.
   On macOS Intel the measurements show little benefit next to an image (transcription is starved either way);
   the rule still applies there, and the implementation's benchmark must report that platform separately.
4. **Kokoro is unmanaged in 9.9e.** It is counted as a busy CPU workload (so a transcription next to it gets the
   reduced count) and reported as `threads: { known: false }`. Controlling it needs a separate, measured worker
   change (§4).
5. **Many logical CPUs.** The fixed 2 is measured on 3–4-logical-CPU runners only. On larger machines it may be
   too small; Step 9.10 should measure 8–16-core hardware before a larger share (for example `floor(B / 4)`) is
   considered. Until then the cap stays 2.

**Interaction with other stages.**

* One heavy model at a time (decision B) stays. The budget never allows a second heavy model.
* Chat queue: independent. The queue (off by default) serializes chats within the text engine; the budget only
  looks at whether a chat is running. With the queue off, several chats still share one engine (`--parallel 1`),
  which the budget sees as "busy".
* Memory check (9.9d): independent; thread counts don't change its estimate.
* 9.9f admission and timeouts: unchanged and still separate.

**Reporting (additive).** `GET /api/resources` would show `limits.threads: "on"` and, per engine,
`threads: { configured, passed, known }` (Kokoro `known: false`), plus the count given to the last per-job job.
The server log would get one line when a job gets a reduced count. No UI change.

**Rollback.** `threads: "off"` (setting in `scheduler.json`, `USAP_THREADS=off`, and `USAP_SCHEDULER=off`)
skips the adjustment entirely, so every engine gets today's count. Proposed default for the first implementation:
**off**, with an activation decision after measurements on real user hardware.

**Testing an implementation.**

* Unit: the rule table for 1, 2, 3, 4 and 16 logical CPUs; unknown counts; busy/idle combinations; Kokoro unknown.
* Server (fake engines that record their arguments): with `threads: off`, and with `on` but only one workload busy,
  the `--threads` / `-t` arguments of llama.cpp, sd.cpp and whisper are byte-identical to `main`; with `on` and
  chat busy, a transcription gets `-t 2`; no engine is ever restarted.
* Native: `thread-bench` with the setting off and on; single-workload medians must not move beyond run-to-run
  variation (≤ 5% on the 3 more stable targets), and overlap results recorded per OS.

## 4. Follow-ups this design depends on (each needs separate approval)

* **Kokoro thread control.** The worker would build the model with
  `StyleTextToSpeech2Model.from_pretrained(..., { session_options: { intraOpNumThreads, interOpNumThreads: 1 } })`
  and construct `KokoroTTS` itself, since `KokoroTTS.from_pretrained` drops session options. It must be measured
  alone first (its default is physical cores, so an explicit value could change single-job speed), and the
  `kokoro-js`/transformers.js versions are ranges today (`^1.2.1`, `^3.5.1`; see #22), so the call must be pinned
  or guarded against API changes.
* **llama.cpp `--poll`.** The busy-wait setting is the likely reason overlaps collapse on Linux and macOS. Lowering
  it while other work is possible could help more than any thread split, but it changes the persistent engine's
  start arguments and may cost single-chat speed. Measure separately before proposing anything.
* **Larger machines** (8–16+ cores) and real Apple Silicon (not a 3-vCPU VM), as part of Step 9.10.
* macOS Intel image + chat (outside the studio) was measured only in run 2 (run 1 hit its time limit): chat 182x
  slower and the image 6.8x slower. It can't happen in the studio today, and these numbers support keeping
  decision B.

## 4a. Measurement tooling and trigger policy

`scripts/ci/thread-bench.cjs` is measurement tooling, kept apart from the runtime tests: it lives in `scripts/ci/`,
not `scripts/tests/`, isn't part of `node --test`, judges nothing (it fails only if it can't run), and is not a
required check. `.github/workflows/thread-bench.yml` runs it **manually only** (`workflow_dispatch`; inputs `reps`,
default 5, and `image_reps`, default 3), because a run takes about 30 minutes on Linux, Windows and macOS arm64 and
up to 5.5 hours on macOS Intel (timeout 330 minutes there, 170 elsewhere). It ran on pull requests only while this
design was measured. GitHub can dispatch a workflow only once it exists on the default branch, so after the design
merges it is run from `main` (or with `--ref` for a branch). The models are the pinned native-runtime models, and
the artifacts (`thread-bench-<target>`) carry the raw JSONL, a summary table and the studio log.

## 5. macOS Intel image thread cap

Keep the current cap (at most the logical CPUs; 4 on the runner). Alone, image generation keeps all 4 logical
CPUs at 99.9% for 289 s per image, and nothing here suggests a different count would be faster. Overlaps on macOS
Intel slow the per-job engine sharply (transcription up to 99x, voice +93%) while image speed changes little
(−9% to +82%). Step 9.11 (an optimized Intel image engine with AVX instead of the SSE3-only slice) could shorten
image jobs severalfold, which shortens every overlap window; repeat these measurements after 9.11 before tuning
any Intel-specific share.

## 5a. Recorded follow-ups (each needs its own review or approval)

A logical-CPU cap for whisper requests (a request for 4 threads on the 3-vCPU macOS arm64 runner made a
transcription alone take 21.8 s, against about 5.3 s at the server default of 3 threads in the design runs; these
were different runs, see "Whisper thread defaults" below; pre-existing, unchanged); Kokoro ONNX Runtime thread
control; llama.cpp `--poll` behaviour; further macOS Intel image optimization (Step
9.11); an explicit `approximate` indicator for macOS memory readings (§6); Step 9.9f memory enforcement and
running-request timeouts; P4-2 chat-screen attachment integration. None is part of this design or of the
whisper-only implementation.

## 6. Separate assessment: an `approximate` marker for macOS memory readings (not part of this design)

Today the 9.9d memory check labels available RAM `basis: "measured"` with `source: "vm-stat"` on macOS, and adds
the reason `macos-available-memory-pessimistic` only before the first `vm_stat` poll. The `vm_stat` value is free
+ inactive + speculative pages, polled every 5 s and rounded to 0.01 GB: a reasonable estimate, but not an exact
measurement (inactive pages are not all reclaimable, and the value can be 5 s old).

Proposal: add `quality` to `available.ramBytes`: `"os-estimate"` on Linux (`MemAvailable`) and Windows (available
physical memory), `"approximate"` for `vm-stat`, `"pessimistic"` for macOS free pages only.

* Compatibility: one additive field in `memoryCheck.available.ramBytes` and `memory.checks`; no verdict, code or
  existing field changes. Clients that ignore unknown fields are unaffected. Our own tests that compare whole
  objects need the field added.
* Tests: unit cases per source, the server test checks the field, and `memory-check-report.cjs` prints it.
  Native rows would show `approximate` on both macOS targets.
* Not done here: it changes the 9.9d implementation, so it needs its own approval and PR.

## 7. Whisper-only implementation results (#96; off by default)

The approved part (§3 rule 3 for whisper only; `USAP_THREADS`, default off) was compared with the policy off and on
in the same job on each target (run 43475991621, `thread-bench --set whisper`, transcriptions explicitly requesting
4 threads: equal to the logical CPUs on Linux, Windows and macOS Intel, one more than the 3 vCPUs on macOS arm64).
Medians, change from off to on:

| Window | Workload | Linux x64 | Windows x64 | macOS arm64 | macOS Intel |
|---|---|---|---|---|---|
| chat + transcription | chat | −51% | −36% | −74% | +1% |
| chat + transcription | transcription | −71% | **+21%** | −89% | −25% (n = 1 per mode) |
| voice + transcription | voice | −22% | +2% | −24% | −30% |
| voice + transcription | transcription | −49% | +1% | −85% | −32% |
| image + transcription | image | −22% | −4% | −31% | 0% |
| image + transcription | transcription | −47% | +1% | −86% | −23% |

* **Alone, nothing changes.** The server logs show a reduction only for transcriptions that overlapped another job:
  on Linux and both Macs the count is exactly the overlapping background jobs minus the one per window that
  started after the front job finished (117/120, 30/33, 34/37); Windows 45/51; off, none. Differences in the
  alone rows (−22% to +17%) are run-to-run noise with identical `-t` values.
* **Not universally beneficial.** Linux and macOS arm64 gain in every overlap; macOS Intel gains for transcription
  and voice only; on **Windows a transcription behind a running chat is about 21% slower** (1.31 → 1.58 s) while
  the chat is 36% faster, and the other Windows overlaps change by 4% or less.
* **Weak evidence:** overlap CVs reach 0.5–1.3 on macOS arm64, and macOS Intel's chat + transcription completed one
  background transcription per mode. Two runs earlier on the same targets showed run-to-run differences of up to
  90% from different host CPUs (§2 Repeatability).
* **Activation:** not approved. Before any default change: broader benchmarks, an analysis of the Windows
  regression, and lower- and higher-core machines than the 3–4-vCPU runners measured here.


## 8. Whisper thread defaults and the logical-CPU cap measurement (measurement only; nothing changed)

**Whisper thread defaults (as implemented; unchanged).**

* Server: `min(8, logical CPUs)` (`os.cpus().length`), used when a request sends no `threads` value. A request
  (`POST /api/speech/transcribe?threads=…`, or `threads` in `POST /api/speech/start`) may ask for 1–32, and that
  value is passed to `whisper-cli -t` unchanged (the optional 9.9e budget can only lower it during an overlap).
* WebUI: `min(8, navigator.hardwareConcurrency)`, saved in the browser; **4 only when the browser reports no CPU
  count**. 4 is not an unconditional default. The user can set 1–32.
* So a transcription can ask for more threads than the server has: an API client, a user-set value, a browser that
  hides or reduces its CPU count, or a LAN client whose browser runs on a machine with more CPUs than the server.
  The image engine already caps its threads at the logical CPUs (§5, #9); whisper has no such cap.

**Same-job sweep** (`thread-bench --set whisper-sweep`, manual workflow input `set=whisper-sweep`): one transcription
at a time (whisper tiny.en, the 11 s JFK sample), nothing else busy, the requested thread counts rotated each round
so each runs equally often in each position, one uncounted warm-up per count. Each block is run with no other engine
loaded and again with the text engine loaded and idle; both blocks agree. Every job was checked against the studio
log: the `-t` passed and whisper.cpp's own `n_threads = N / M` line matched the request, and whisper.cpp's own
total time shows the same differences as the HTTP wall time. No transcription failed.

Run 43540326157 (12 rounds) and run 43542533359 (8 rounds); medians, no other engine loaded:

| Requested threads | macOS arm64 (3 vCPU) | macOS Intel (4) | Linux x64 (4) | Windows x64 (4) |
|---|---|---|---|---|
| 2 | 5.18 s | 1.74 s | 0.74 s | 1.38 s |
| 3 (= arm64 server default) | 4.88 s | 1.45 s | 0.73 s | 1.26 s |
| 4 (= server default on 4 vCPU) | **20.96 s, ×4.29** (95% CI 3.72–4.75 vs 3) | 1.37 s | 0.69 s | 1.15 s |
| 5 (run 2, vs default) | ×7.5 | ×1.20 | ×1.03 | ×1.05 |
| 6 (run 2) | ×14.3 | ×1.38 | ×1.03 | ×1.03 |
| 8 (run 2) | ×25.2 (116.8 s vs 4.63 s) | ×1.57 | ×1.08 | ×1.05 |

* **Up to the logical CPU count, more threads is faster or equal** on every target (Linux, Windows, macOS Intel
  5–20% faster at 4 than at 2–3; macOS arm64 2 vs 3 within noise, CV 0.15–0.18).
* **Above the logical CPU count, every target is slower**, and the size depends heavily on the build: 3–10% on
  Linux and Windows, 13–57% on macOS Intel, and a super-linear cliff on macOS arm64 (×4 at one thread over, ×25 at
  8 on 3 vCPUs). The cliff is in every rotation position (20.4–22.3 s at 4 threads), so it is not an ordering effect.
* The macOS arm64 `whisper-cli` is the Homebrew ggml build: `use gpu = 1`, the paravirtual Metal device (MTL0), BLAS
  and an OpenMP CPU thread pool. It is not a pure CPU run, and hosted-runner Metal is paravirtual, so the size of the
  cliff on real Apple Silicon is unmeasured. All four builds report `OPENMP = 1`.
* Limits: hosted 3–4-vCPU virtual machines only; Linux and Windows hosts had different CPU models between runs
  (compare within a run); macOS has no CPU affinity API, so only `hw.ncpu`/`hw.activecpu` (3) are recorded; one
  model (tiny.en) and one 11 s sample; no machine with more than 4 logical CPUs; no GPU or NPU validation.

**Mechanism check** (run 43549674698, 8 rounds, the measurement studio started with `OMP_WAIT_POLICY=PASSIVE`, which
whisper-cli inherits): the macOS arm64 cliff is unchanged (4 threads ×4.0–4.6, 6 threads ×12.9–14.4 vs 3), so OpenMP
spin-waiting does not explain it. On macOS Intel the slowdown at 6 threads fell from ×1.34–1.38 to ×1.21–1.22, and on
Linux from ×1.03–1.04 to ×1.01–1.02 (Windows ×1.03 → ×1.02, within noise), so spin-waiting is part of the smaller cost
there. (The first Windows attempt failed before measuring: Kokoro's model load in the unchanged engine-validation
step returned `system error number 13`; the re-run of that job passed with no failed check.) The cause of the
macOS arm64 cliff is **not identified** (candidates: ggml's own barrier waiting for a descheduled thread, the
Metal/CPU split of this build, or the virtual machine's scheduler). The measured fact is only that requesting
more threads than the logical CPUs is slower on every target, and much slower on macOS arm64.

**Proposed follow-up (not implemented; needs separate approval).** Cap the `-t` of each transcription at the
server's logical CPU count, before the optional 9.9e budget; keep any request at or below the cap unchanged;
report the requested and used counts (numbers only) additively; provide a setting to turn the cap off. No engine
restart; llama.cpp, sd.cpp and Kokoro unchanged; the 9.9e budget stays off by default. Whether the cap is on by
default is a separate owner decision.
