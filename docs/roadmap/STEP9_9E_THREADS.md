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
(run 43419228555, commit `99760e4`). It uses the native-runtime models: Qwen2.5 0.5B Q4_K_M (CPU, 2048 context,
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
| Image + chat (outside the studio, decision B) | image 57.5 s (+89%); chat 30.5 s (+787%) | image 44.8 s (+6%); chat 45.2 s (+1793%) | image 115.5 s (+226%); chat 55.7 s (+2090%) | **not measured**: the job reached its 170-minute limit before this last window |

Percentages for "at 2 threads" compare with the same workload alone at its default threads, except transcription
(compared with transcription alone at 2 threads; both are nearly identical).

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

## 3. Proposed policy (for approval; not implemented)

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
   with it until the transcription ends.
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
* macOS Intel image + chat (outside the studio) was not measured (time limit); it can't happen in the studio today.

## 5. macOS Intel image thread cap

Keep the current cap (at most the logical CPUs; 4 on the runner). Alone, image generation keeps all 4 logical
CPUs at 99.9% for 289 s per image, and nothing here suggests a different count would be faster. Overlaps on macOS
Intel slow the per-job engine sharply (transcription up to 99x, voice +93%) while image speed changes little
(−9% to +82%). Step 9.11 (an optimized Intel image engine with AVX instead of the SSE3-only slice) could shorten
image jobs severalfold, which shortens every overlap window; repeat these measurements after 9.11 before tuning
any Intel-specific share.

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
