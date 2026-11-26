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
unseen escaper on macOS). The tool reports success only when the run is confirmed.

Exit codes (a command that itself exits 120, 121, 124, 125 or 127 is told apart only by the report): the command's own
code when confirmed; 128+N if it died from signal N; 124 timeout; 130/143 this tool was interrupted; **120 processes
survived the forced stop** (overrides the others); **121 not certified (uncertain)**; 125 tool error or containment
refused; 127 the command could not be started.

### What is guaranteed where

| Platform | Containment | How | Not covered |
|---|---|---|---|
| Linux | full (reduced, and reported so, if `os.pidfd_open` or `/proc/<pid>/task/<tid>/children` is missing) | own session/process group, child subreaper (escaped descendants are re-parented to the tool and reaped continuously; a full `/proc` cross-check once a second and on every stop round), pidfd: a process is pinned before it is recorded and signalled only through its pidfd | a descendant that makes itself a subreaper or joins another cgroup/container; SIGKILL of the tool itself (run the tool inside `systemd-run --user --wait --collect -p KillMode=control-group -p RuntimeMaxSec=…` for that) |
| macOS | **reduced** | own session; the root is kept as an unreaped zombie until verification, so its pid, group and session id stay reserved; every descendant still in the root's session is owned (even after re-parenting or `setpgid`); setsid escapers seen while their parent lives are tracked; identity checked right before each signal | a descendant that calls `setsid` and loses its parent before the tool sees it cannot be proven ours: the run is then reported **uncertain** (exit 121) and that process is not signalled; a small check-then-signal race (no pidfd on macOS); a backward wall-clock step during the run (start times are wall-clock); SIGKILL of the tool. Same-user jobs that launchd starts during the run can make a run "uncertain" (fail-closed false positive) |
| Windows | full while the tool runs, **pending native validation** by the `dev-tools` workflow | a Job Object with kill-on-close and without breakaway; the command starts suspended and runs only once it is in the job; graceful Ctrl+Break, then the job is terminated and verified empty; if the tool is killed, closing its job handle still kills the tree | an outer job (terminal, CI runner) that allows silent breakaway could let a descendant leave unseen |

Processes are identified by pid and kernel start time (Linux, macOS) or contained by the job (Windows). Nothing is
ever matched by name or command line, so unrelated processes (other sessions, editors, services) are never touched.
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
stated limit). Cases a platform cannot support are skipped with the reason. The `dev-tools` workflow runs them on
Linux, Windows and both macOS runners.
