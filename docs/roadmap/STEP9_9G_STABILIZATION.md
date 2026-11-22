# Step 9.9g: reliability stabilization and activation readiness (plan)

Status: **planned** (added by owner decision; thresholds accepted by the owner on 2026-11-22, with the refinements below). Part of [STEP9_9_SCHEDULING.md](STEP9_9_SCHEDULING.md) and
[STEP9_BACKEND_PLAN.md](STEP9_BACKEND_PLAN.md). Documentation only: this step adds no code and changes no default.

## 1. Why this step

Most Step 9.9 features are implemented and merged, and most are **off by default**: the chat, voice, transcription
and image queues, chat timeouts, memory admission, the thread budget, cross-engine load coordination (`engineSlot`) and
the stale-file report. Before any of them is proposed for activation, the CI signal, the engine lifecycle and the
cancellation paths they depend on need to be dependable. Recent work showed why:

* a port race in the image engine with `engineSlot` on, found from one Windows failure (#170, fixed in #171);
* intermittent timing failures, mostly on macOS Intel runners, that a passing rerun does not explain (#151, #160 and
  the CI issues in section 3);
* activation gates that already exist but are spread across documents (the transcription queue's stale-file gates,
  `engineSlot`'s block on #120).

9.9g collects these into one checklist with measurable criteria.

**Readiness is not activation.** Meeting the criteria here makes a feature *eligible* for an activation proposal. Each
activation (any default change) is still a separate owner decision with its own PR, evidence and rollback. Nothing in
this step turns a feature on.

**Step 9.10 (benchmarks and regression thresholds) is unchanged** and stays a separate step. 9.9g measures
correctness and reliability, not speed; 9.10 may reuse the four-platform evidence from g6 but sets its own baselines.

## 2. Workstreams

The thresholds below were accepted by the owner on 2026-11-22. The evidence rules in this section apply to every
workstream.

**Evidence rules**

* **Known critical defects are fixed, not outvoted.** A pass rate or a run count never makes a known critical defect
  (lost user data, a wrong answer, a security bypass, an orphaned engine, a limit exceeded) acceptable.
* **A relevant recurrence resets monitoring.** A failure of the monitored kind on the monitored path restarts its count
  from zero; the issue stays open or is reopened.
* **Only completed, first-attempt results count.** Missing results, skipped checks or steps, cancelled runs and reruns
  are not successful evidence. A rerun can add information but never turns a failure into a pass.
* **Limitations need explicit acceptance.** A known gap counts as a limitation only once the owner has accepted it in
  writing, with its scope and what covers it instead.
* **Normal CI only.** Evidence comes from ordinary pushes and pull requests; no extra runs are triggered to reach a
  count.
* **Qualifying native run:** a native-runtime run on a real engine in which every step of the relevant validator ran to
  completion on all four platforms (Windows x64, Linux x64, macOS Apple Silicon, macOS Intel), with no FAIL row. A run
  where a platform skipped or did not finish a relevant step does not qualify and breaks a consecutive series.

### g1. CI reliability

Goal: a red check means a real problem, and a rerun is never needed to merge.

| Criterion | Measure |
|---|---|
| First-attempt pass rate | Each applicable check passes on the first attempt in at least 98% of its last 50 runs on `main` and pull requests, counted separately per check and per runner |
| Known flakes | Every open CI issue is either fixed with negative controls, or reaches its closure-review threshold (as #160 did: at least 16 runs on 16 commits with 3 pushes to `main` and zero failures), or has a documented, owner-accepted limitation |
| No unexplained reruns | 10 consecutive pushes to `main` green on the first attempt |
| Diagnostics before changes | No judge, timing limit or assertion is relaxed to make a flake pass; a test change needs evidence that the failure is not a product defect |
| Runner health tracked | First-attempt failure rate per runner and day is recorded, so a degraded runner pool is seen as such (a hypothesis until shown) |

Issues: #151, #127, #108, #109, #110 (see section 3). #160 closed after its closure review on 2026-11-22.

### g2. Engine lifecycle and port management

Goal: engines start, stop and replace each other without races, orphans or port conflicts.

| Criterion | Measure |
|---|---|
| Native lifecycle | The engine-lifecycle validator (R1–R5: text and image loads in both orders, three concurrent image loads, stop during a load, no orphans) passes with `engineSlot` on in test servers in 10 consecutive qualifying native runs |
| Port selection | The #170 tests (late bind, bounded release wait, verified backup ports) pass on Linux and macOS; Windows runs the unit tests and R2 |
| Unexplained exits | #120 is explained, or closed by closure review with the post-#171 evidence |
| Orphans | Zero engine or worker processes left alive in any native run |
| Controls | Each lifecycle guarantee has a negative control that removes it and is caught |

Issues: #120, #105, #107, #31, #32, #33; #170 stays open until its closure review (approved threshold: at least 16 first-attempt runs on 16 commits with 3 pushes to `main`, at least 10 qualifying native runs with Windows R2 passing, zero relevant failures).

### g3. Cancellation and concurrency safety

Goal: a stop, a cancel or a client leaving always ends the work within a stated time, and concurrent requests never
exceed the stated limits.

| Criterion | Measure |
|---|---|
| Bounded cancellation | Every cancellation path has a test with an explicit bound (for example, a stop during an image load answers `409 ENGINE_START_CANCELLED` within 2 s), and a negative control that removes the cancellation check fails it |
| Chat abort | The native chat-timeouts checks (abort stops computation, cancel confirmation) pass in 10 consecutive qualifying native runs |
| Limits hold | Queue and slot limits (one forwarded job, bounded waiting, never two heavy engines) hold in tests and native runs, each with a meaningful negative control (one that removes the guarantee, not just a timing change) |
| Not yet possible | Cancelling a running image generation (#64) or transcription (#41) is documented as a limitation until implemented |

Issues: #133, #115, #108, #64, #41, #105.

### g4. Temporary-file ownership and cleanup

Goal: files the studio creates are owned, bounded and recoverable after a hard stop, and user files are never touched.

| Criterion | Measure |
|---|---|
| Report first | The stage R1 stale-file report (off by default) gives correct counts on all four platforms in its tests |
| No silent deletion | No stage deletes anything without a separately approved design and implementation; user files and files outside the data folder are never candidates |
| Ownership | A file is removed only when its owner is provably gone; an expired lease alone is never proof |
| Active owners protected | A file held by a running job, engine or upload is never a candidate, including one whose owner started after the scan began |
| Race-safe accounting | Counts and sizes stay correct when files are created, renamed or removed during a scan, with tests for each race |
| Windows hard stop | After a forced stop on Windows (open handles, locked files), recovery and the report are validated natively; a file that can't be opened is reported, never forced |
| Space safety | Uploads keep a free-space floor on the data volume, checked before a large upload is accepted, with a refusal test |
| Transcription queue gates | The activation gates in [STEP9_9F_WHISPER_QUEUE.md §7](STEP9_9F_WHISPER_QUEUE.md) are met before the transcription queue is proposed for activation |

Issues: #131 (aggregate upload admission).

### g5. Security and request validation

Goal: features that accept new input are validated and bounded before they are activated.

| Criterion | Measure |
|---|---|
| Request validation design | The image-request validation design (#169) is reviewed; any production validation is a separate approved implementation |
| Input bounds | Every request path a candidate feature adds has appropriate size, time and count bounds, each with a refusal test and a negative control that removes the bound and is caught |
| No regressions | Existing security tests (Origin and Host checks, early 413, refusal close) pass unchanged |
| Error hygiene | Errors a candidate feature returns contain no host paths or raw engine output (#38, #39, #57) |

Issues: #131, #81, #57, #39, #38.

### g6. Four-platform regression validation

Goal: every candidate feature is shown to work, and to change nothing when off, on Windows x64, Linux x64, macOS
Apple Silicon and macOS Intel with real engines.

| Criterion | Measure |
|---|---|
| On in test servers | The feature runs on in native test servers, with its validator passing in 10 consecutive qualifying native runs |
| Off is unchanged | With the feature off, behaviour and API responses match `main` (contract tests, render tests) |
| Global rollback | `USAP_SCHEDULER=off` turns the feature off, and the feature's own setting turns it off, each verified by a test |
| Platform gaps | Any check that can't run on a platform (for example the port hand-over on Windows) is listed with what covers it there |

Issues: #99 (Windows Kokoro), #110, #115.

### g7. Activation readiness review

Goal: one review per feature that decides whether it may be *proposed* for activation.

For each candidate feature, a short readiness record lists:

1. the g1–g6 criteria that apply and the evidence for each (links to runs and tests), counted under the evidence rules in section 2;
2. the open issues that block it, and those the owner has explicitly accepted as limitations;
3. the default it would change, the rollback (setting and `USAP_SCHEDULER=off`), and what users would notice;
4. the dependencies (for example, the image queue runs only with `engineSlot` on, so it can't be activated first).

The owner then decides, per feature: not ready, ready (eligible for a proposal), or ready with conditions. An
activation itself is a separate PR and approval; this review never changes a default.

## 3. Open issues by workstream

| Issue | Summary | Workstream |
|---|---|---|
| #151 | json-413 concurrent test: a client received no answer (macOS Intel) | g1 |
| #127 | Windows test cleanup EBUSY | g1 |
| #108, #109, #110 | unexplained CI timeouts (macOS ARM64 chat timeouts, Windows render, macOS Intel chat-queue validator) | g1 |
| #170 | image engine port choice with `engineSlot` on (fixed in #171; open for closure review) | g2 |
| #120 | Windows R2: image engine exits with code 0 after concurrent loads | g2 |
| #105 | text and image model loads not serialized without `engineSlot` | g2, g3 |
| #107 | sticky text-engine load settings | g2 |
| #31, #32, #33 | orphan on guard kill; crash-recovery policy; resource-aware recovery | g2 |
| #133, #115 | native chat-timeouts cancel and abort checks (Windows, macOS Intel) | g3 |
| #64, #41 | cancelling a running image generation or transcription | g3 |
| #131 | aggregate connection admission for Whisper queue uploads | g4, g5 |
| #81, #57, #39, #38 | untrusted-text tokens, host paths, raw errors | g5 |
| #99 | Windows Kokoro load error 13 | g6 |

## 4. Dependencies and order

* g1 comes first: the other workstreams' evidence counts only from runs that g1 considers trustworthy.
* g2 and g3 come before any `engineSlot` activation proposal. The image queue depends on `engineSlot`, so its review
  follows.
* g4 comes before the transcription queue's activation proposal.
* g5 applies to any feature that accepts new input (the queues, and image request validation if implemented).
* g6 runs for every candidate; g7 closes each candidate's review.
* Step 9.10 can start independently; its benchmarks don't wait for 9.9g, and 9.9g doesn't wait for them.

## 5. Out of scope

Turning any feature on; production request validation, connection enforcement, automatic deletion and capacity
pilots without separate approval; Steps 9.10–9.12 and optional cloud modules.
