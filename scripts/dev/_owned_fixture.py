"""Fixture for test_run_owned.py: builds a small process tree and then waits (or does what MODE says).

    python3 _owned_fixture.py MODE PIDFILE [LEVEL]

Every process appends its pid to PIDFILE before doing anything else. Modes (comma-separated flags):
  tree        root -> child -> grandchild, all sleep
  ignoreterm  the child and grandchild ignore SIGTERM (POSIX)
  escape      the grandchild leaves the group: setsid (POSIX) / DETACHED_PROCESS + new group (Windows)
  exit7       the root starts the child, then exits with code 7 at once
  exit0       the root starts the child, then exits with code 0 at once
  breakaway   (Windows) the child tries CREATE_BREAKAWAY_FROM_JOB and writes "breakaway-ok" or "breakaway-refused"
  orphancheck the root starts a "guard" that starts an "engine" and exits; the root kills the engine and exits 0 when
              it is gone within 1.5 s (as seen by kill(pid, 0)), else 3 (POSIX)
  execlate    the child is seen first, then (after 1 s) replaces itself with /bin/sleep (exec; POSIX)
  slowdoublefork the root stays; the child waits 0.6 s, starts a new-session grandchild and exits, so the grandchild
              is re-parented to launchd/init while the run goes on (POSIX)
  launchd     (macOS) the child asks launchd to start an unrelated job (`launchctl submit`) and writes "launchd:LABEL"
"""
import os, signal, subprocess, sys, time

mode, pidfile = sys.argv[1], sys.argv[2]
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
    if level == 0:
        note(str(os.getpid()))
        guard = subprocess.Popen([sys.executable, __file__, mode, pidfile, "1"], stdout=subprocess.PIPE)
        engine = int(guard.stdout.readline())
        guard.wait()
        time.sleep(0.2)
        os.kill(engine, signal.SIGKILL)
        end = time.time() + 1.5
        while time.time() < end:
            try:
                os.kill(engine, 0)
            except ProcessLookupError:
                sys.exit(0)
            time.sleep(0.02)
        sys.exit(3)
    if level == 1:  # the guard: start the engine, print its pid, exit
        e = subprocess.Popen([sys.executable, "-c", "import time\nwhile True: time.sleep(1)"])
        print(e.pid, flush=True)
        os._exit(0)

note(str(os.getpid()))
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
