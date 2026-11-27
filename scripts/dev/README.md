# Developer tools (local only)

These scripts are for people and agents working on USAP locally. They are not used by the studio, its tests or CI
(except the advisory `dev-tools` workflow that tests them).

## run_owned.py: run a command and stop everything it started

A local test runner that uses `subprocess.run([...], timeout=...)` kills only its direct child when it times out.
`node --test` runs each test file in a child process, and twice such a child kept running for days after its runner
was killed. `run_owned.py` owns the whole process tree and stops it on every exit path.

```
python3 scripts/dev/run_owned.py --timeout 600 --grace 5 --report run.json -- node --test scripts/tests/json-413.test.cjs
```

| Option | Meaning |
|---|---|
| `--timeout S` | stop the tree after S seconds (exit 124) |
| `--grace S` | time between the graceful and the forced stop (default 5) |
| `--report FILE` | write a JSON report: containment, identity mode, root exit, signals sent, survivors, warnings |
| `--require-full-containment` | refuse to start (exit 125) where containment would be reduced (macOS) |

Every run ends with a certification in the report: **confirmed** (every owned process is gone, checked by a clean final
rescan; Windows: the job is empty), **survivors** (known processes are still alive) or **uncertain** (ownership could not
be completed: a discovery error during the stop, processes still appearing when the kill rounds ran out, or a possible
unseen escaper on macOS). The tool reports success only when the run is confirmed. Every doubt is also a typed entry in
the report's `reason_codes` (for example `signal_denied`, `signal_unsafe`, `query_error`, `lineage_candidate`); any code
rules out "confirmed" and no option waives one. A signal that fails is never taken as termination: the other processes
are still stopped, and a process still running after a denied signal is a survivor (exit 120).

Exit codes (a command that itself exits 120, 121, 124, 125 or 127 is told apart only by the report): the command's own
code when confirmed; 128+N if it died from signal N; 124 timeout; 130/143 this tool was interrupted; **120 processes
survived the forced stop** (overrides the others); **121 not certified (uncertain)**; 125 tool error or containment
refused; 127 the command could not be started.

### What is guaranteed where

| Platform | Containment | How | Not covered |
|---|---|---|---|
| Linux | full (reduced, and reported so, if `os.pidfd_open` or `/proc/<pid>/task/<tid>/children` is missing) | own session/process group, child subreaper (escaped descendants are re-parented to the tool and reaped continuously; a full `/proc` cross-check once a second and on every stop round), pidfd: a process is pinned before it is recorded and signalled only through its pidfd | a descendant that makes itself a subreaper or joins another cgroup/container; SIGKILL of the tool itself (run the tool inside `systemd-run --user --wait --collect -p KillMode=control-group -p RuntimeMaxSec=…` for that) |
| macOS | **reduced** (model N2′, validated on hosted macOS 15 arm64 and Intel) | identity is the kernel's unique process id (never reused, kept across `exec`); the root starts only after its identity and coalition are read and is kept as an unreaped zombie until verification, so its pid, group and session id stay reserved. A process is owned only with positive lineage: the pinned root's session, a known parent confirmed by the child's original-parent version, or a known original parent after re-parenting to launchd; parent links also require the root's coalition. Descendants are signalled only through `proc_signal_with_audittoken` (pid + identity version, so a reused or `exec`'d pid is refused), never by plain `kill(pid)`. Verification classifies every live process: launchd services are in other coalitions and are ignored | work started through launchd (`open`, `launchctl`, XPC) and setuid helpers are outside the proof; a same-coalition process with no lineage either way (for example an orphan another program of the same terminal or CI job creates during the run, or an escaper whose ancestry was never seen) makes the run **uncertain** (exit 121) and is never signalled; without `proc_signal_with_audittoken` (macOS before 14.2) only the root and its group are signalled and the run is never confirmed; SIGKILL of the tool |
| Windows | full while the tool runs, **pending native validation** by the `dev-tools` workflow | a Job Object with kill-on-close and without breakaway; the command starts suspended and runs only once it is in the job; graceful Ctrl+Break, then the job is terminated and verified empty; if the tool is killed, closing its job handle still kills the tree | an outer job (terminal, CI runner) that allows silent breakaway could let a descendant leave unseen |

Processes are identified by pid and kernel start time, pinned by a pidfd (Linux), by the kernel's unique process id
(macOS) or contained by the job (Windows). Nothing is ever matched by name or command line, so unrelated processes
(other sessions, editors, services) are never touched. A plain `kill(pid)` is used only where the pid cannot be reused
before the call: the tool's own unreaped child (Linux without pidfd, the pinned macOS root and its group).
Use one `run_owned.py` per command; on Linux it adopts orphans of its own tree only because it starts nothing else.

### Rules for local harness scripts
- Start test runners through `run_owned.py`, not `subprocess.run(..., timeout=...)`; never stop leftovers by name
  (`pkill -f`): the surviving child's command line is not what you expect.
- Give `node --test` a `--test-timeout`, so a hang fails by name.
- A mutation that starts a server, timer or child process closes it in the same `finally`.
- Remove a work copy only after the tree is gone.

### Self-tests
`python3 -B scripts/dev/test_run_owned.py -v` builds real process trees (three levels, SIGTERM-ignoring and escaping
descendants, a `node --test` file that hangs on an open server) and checks by identity that none survives. Negative
controls show the failures are real: a plain timeout leaves the tree; SIGKILL of the tool leaves it on POSIX (the
stated limit). Fault injection checks that a denied or failing signal, an unreadable process or a failing process
list never ends in "confirmed"; macOS cases cover `exec`, re-parented session escapers, an unrelated launchd job (not
signalled, not blocking), an unrelated same-coalition orphan (uncertain, not signalled), stale identities and simulated
PID reuse. Cases a platform cannot support are skipped with the reason. The `dev-tools` workflow runs them on Linux,
Windows and both macOS runners.
