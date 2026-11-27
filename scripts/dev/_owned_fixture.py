"""Fixture for test_run_owned.py: builds a small process tree and then waits (or does what MODE says).

    python3 _owned_fixture.py MODE PIDFILE [LEVEL]

Every process appends an authenticated record of its own pid and kernel identity to PIDFILE before doing anything else
(_owned_ident.write_own_record; round 38: the test never admits a bare pid). Modes (comma-separated flags):
  tree        root -> child -> grandchild, all sleep
  ignoreterm  the child and grandchild ignore SIGTERM (POSIX)
  escape      the grandchild leaves the group: setsid (POSIX) / DETACHED_PROCESS + new group (Windows)
  exit7       the root starts the child, then exits with code 7 at once
  exit0       the root starts the child, then exits with code 0 at once
  breakaway   (Windows) the child tries CREATE_BREAKAWAY_FROM_JOB and writes "breakaway-ok" or "breakaway-refused"
  orphancheck the root starts a "guard" that starts an "engine"; the root pins the engine with a pidfd while the guard
              still holds it unreaped, lets the guard exit, kills the engine through the pidfd and exits 0 when it is
              reaped within 1.5 s (pidfd signal 0 -> ESRCH), else 3; 4 without pidfd; 5 if the guard died before the
              pidfd was proven pinned (Linux). The engine records itself and ends after 120 s
  execlate    the child is seen first, then (after 1 s) replaces itself with /bin/sleep (exec; POSIX)
  slowdoublefork the root stays; the child waits 0.6 s, starts a new-session grandchild and exits, so the grandchild
              is re-parented to launchd/init while the run goes on (POSIX)
  launchd     (macOS) the child asks launchd to start an unrelated job (`launchctl submit`) and writes "launchd:LABEL"
  marker      the root creates PIDFILE.ran as soon as it runs (proves whether the command was released at all)
  soloexit    the root starts a NEW-SESSION child, waits until it wrote its pid, then exits 0: the root's group is
              left with no live member (only the zombie root)
  solo        one process: records itself and sleeps 40 s (an orphan the test starts through a helper)
  recordparent PIDFILE PPID   not a tree: records the identity of its PARENT, which must be PPID and is blocked waiting
              for this process (a node test process, which cannot read its own kernel identity)
"""
import os, signal, subprocess, sys, time
import _owned_ident as oi  # this script's own directory is sys.path[0]

mode, pidfile = sys.argv[1], sys.argv[2]
if mode == "recordparent":
    oi.write_parent_record(pidfile, int(sys.argv[3]))
    sys.exit(0)
level = int(sys.argv[3]) if len(sys.argv) > 3 else 0
flags = set(mode.split(","))
WINDOWS = os.name == "nt"


def note(text):
    with open(pidfile, "a", encoding="utf8") as f:
        f.write(text + "\n")


def spawn(next_level, extra=0, escape=False):
    args = [sys.executable, __file__, mode, pidfile, str(next_level)]
    if WINDOWS:
        cf = extra | ((0x00000008 | 0x00000200) if escape else 0)  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        return subprocess.Popen(args, creationflags=cf, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if escape:
        return subprocess.Popen(args, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if "orphancheck" in flags:
    # Round 40 (F1): the engine is signalled only through a pidfd taken while its pid is provably pinned. The guard keeps
    # the engine as its own unreaped child (it never waits) and stays alive until the root holds the pidfd, so nothing can
    # reap the engine and its pid cannot be reused before the pidfd exists. No plain kill(pid) on this path.
    if level == 0:
        oi.write_own_record(pidfile)
        if not (hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")):
            note("nopidfd"); sys.exit(4)  # never a plain kill: the test skips (run_owned stops the engine as its own)
        guard = subprocess.Popen([sys.executable, __file__, mode, pidfile, "1"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        engine = int(guard.stdout.readline())
        try:
            fd = os.pidfd_open(engine)  # the guard is alive and blocked on its stdin: the engine is still its child
        except OSError:
            fd = None
        if fd is not None and guard.poll() is not None:  # round 41: the pin is proven only if the guard outlived the open
            os.close(fd); note("unpinned"); sys.exit(5)  # (an outside actor killed it): never signal, fail loudly
        guard.stdin.close()  # only now may the guard exit (the engine is then adopted by the tool's subreaper)
        guard.wait()
        if fd is None:
            note("nopidfd"); sys.exit(4)
        time.sleep(0.2)
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        end = time.time() + 1.5
        while time.time() < end:  # signal 0 through the pidfd: succeeds while the engine is alive or an unreaped zombie
            try:
                signal.pidfd_send_signal(fd, 0)
            except ProcessLookupError:  # reaped (by the tool's subreaper): what the test checks
                os.close(fd); sys.exit(0)
            time.sleep(0.02)
        sys.exit(3)
    if level == 1:  # the guard: start the engine, print its pid, hold it unreaped until the root has pinned it
        # Round 41: the engine (level 2) writes its own authenticated record, so the case can verify and stop it on every
        # path (exit 3/4/5, a traceback); it also ends by itself after 120 s (each check of it takes ~2 s).
        e = subprocess.Popen([sys.executable, __file__, mode, pidfile, "2"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        e.stdout.readline()  # the engine has written its record: the root learns the pid only after that
        print(e.pid, flush=True)
        sys.stdin.read()  # EOF when the root has the pidfd (or when the root has died)
        os._exit(0)
    # level 2 (the engine) falls through: it writes its record with the shared call below, then waits there

if "marker" in flags and level == 0:
    open(pidfile + ".ran", "w").close()
oi.write_own_record(pidfile)
if "orphancheck" in flags:  # level 2, the engine: recorded; tell the guard, then live at most 120 s
    print("recorded", flush=True)
    time.sleep(120); os._exit(0)
if "solo" in flags:
    time.sleep(40); sys.exit(0)
if "ignoreterm" in flags and level > 0 and not WINDOWS:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
def wait_lines(n, limit=15):  # the root leaves only once its child has written its pid (no race on slow runners)
    end = time.time() + limit
    while time.time() < end:
        try:
            with open(pidfile, encoding="utf8") as f:
                if sum(1 for x in f if x.strip()) >= n: return
        except FileNotFoundError:
            pass
        time.sleep(0.02)


if "fastexit" in flags:  # the root forks and exits at once; the child forks its own child 200 ms later
    if level == 0:
        spawn(1); os._exit(0)
    if level == 1:
        time.sleep(0.2); spawn(2)
    while True: time.sleep(1)
if "doublefork" in flags:  # an unseen setsid escaper: the middle process starts a new-session grandchild and exits
    if level == 0:
        spawn(1); os._exit(0)
    if level == 1:
        spawn(2, escape=True); os._exit(0)
    while True: time.sleep(1)
if "soloexit" in flags:
    if level == 0:
        spawn(1, escape=True); wait_lines(2); sys.exit(0)
    while True: time.sleep(1)
if "slowdoublefork" in flags:
    if level == 0:
        spawn(1)
    elif level == 1:
        time.sleep(0.6); spawn(2, escape=True); os._exit(0)
    while True: time.sleep(1)
if "execlate" in flags and level == 1 and not WINDOWS:
    time.sleep(1.0)
    os.execv("/bin/sleep", ["sleep", "60"])
if "launchd" in flags and level == 1:
    label = "com.usap.runowned.test.%d" % os.getpid()
    if subprocess.run(["launchctl", "submit", "-l", label, "--", "/bin/sleep", "60"]).returncode == 0:
        note("launchd:" + label)
if "newgroup" in flags and level == 2 and not WINDOWS:
    os.setpgid(0, 0)  # leaves the root's group (stays in its session)
if "forkloop" in flags and level == 1:  # ignores TERM and keeps starting short-lived children through the cleanup
    if not WINDOWS: signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.3)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.05)
if level == 0:
    spawn(1)
    if "exit7" in flags:
        wait_lines(2); sys.exit(7)
    if "exit0" in flags:
        wait_lines(2); sys.exit(0)
elif level == 1:
    if "breakaway" in flags and WINDOWS:
        try:
            p = spawn(9, extra=0x01000000)  # CREATE_BREAKAWAY_FROM_JOB
            note("breakaway-ok")
            p.kill()
        except OSError:
            note("breakaway-refused")
    spawn(2, escape="escape" in flags)
while True:
    time.sleep(1)
