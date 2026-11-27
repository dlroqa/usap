"""Self-tests for run_owned.py (unittest; Python 3.8+). Run: python3 -B scripts/dev/test_run_owned.py -v

Every case builds a real process tree (_owned_fixture.py), runs it through the CLI in its own process, and then checks
by IDENTITY (POSIX: pid + kernel start time, recorded the moment the pid appears; Windows: an open process handle,
which also pins the pid) that no process of the tree survived. Negative controls show that the failure each case
guards against is real (a plain timeout kill leaves the tree behind). Cases that need a guarantee the platform does
not give are skipped with the reason, never passed. Every process a case creates is stopped at the end of the case,
by identity only; nothing is matched by name.
"""
import json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "run_owned.py")
FIX = os.path.join(HERE, "_owned_fixture.py")
sys.path.insert(0, HERE)
import run_owned as ro  # noqa: E402

LINUX, MACOS, WINDOWS = ro.LINUX, ro.MACOS, ro.WINDOWS


def load(path):
    with open(path, encoding="utf8") as f:
        return json.load(f)


class Ident:
    """Identity of processes seen by a test: survives PID reuse (start time / open handle)."""

    def __init__(self):
        self.seen = {}
        self.mac = ro.MacOwner() if MACOS else None
        if WINDOWS:
            import ctypes
            from ctypes import wintypes as w
            self.k = ctypes.WinDLL("kernel32", use_last_error=True)
            self.k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; self.k.OpenProcess.restype = w.HANDLE
            self.k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]; self.k.WaitForSingleObject.restype = w.DWORD
            self.k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]; self.k.TerminateProcess.restype = w.BOOL
            self.k.CloseHandle.argtypes = [w.HANDLE]

    def start(self, pid):
        if LINUX:
            st = ro._linux_stat(pid); return st and st[2]
        if MACOS:
            st = self.mac.info(pid); return st and st[2]
        return None

    def record(self, pid):
        if pid in self.seen: return
        if WINDOWS:
            h = self.k.OpenProcess(0x00100000 | 0x0001 | 0x1000, False, pid)  # SYNCHRONIZE | TERMINATE | QUERY_LIMITED
            self.seen[pid] = h or None
        else:
            self.seen[pid] = self.start(pid)

    def alive(self, pid):
        v = self.seen.get(pid)
        if v is None: return False
        if WINDOWS: return self.k.WaitForSingleObject(v, 0) == 0x102  # WAIT_TIMEOUT: still running
        return self.start(pid) == v

    def alive_all(self):
        return [p for p in self.seen if self.alive(p)]

    def cleanup(self):
        """Stop what a case left behind (negative controls), by identity only."""
        for pid in self.alive_all():
            try:
                if WINDOWS: self.k.TerminateProcess(self.seen[pid], 1)
                elif hasattr(os, "pidfd_open"):
                    fd = os.pidfd_open(pid)
                    try:
                        if self.alive(pid): signal.pidfd_send_signal(fd, signal.SIGKILL)
                    finally: os.close(fd)
                elif self.alive(pid):
                    os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
        end = time.time() + 5
        while self.alive_all() and time.time() < end: time.sleep(0.05)
        if WINDOWS:
            for h in self.seen.values():
                if h: self.k.CloseHandle(h)


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="run-owned-")
        self.pids = os.path.join(self.dir, "pids")
        self.ident = Ident()

    def tearDown(self):
        self.ident.cleanup()
        left = self.ident.alive_all()
        shutil.rmtree(self.dir, ignore_errors=True)
        self.assertEqual(left, [], "the case's own cleanup left processes")

    def read_pids(self, n, wait=15):
        end = time.time() + wait
        while True:
            try:
                with open(self.pids, encoding="utf8") as f:
                    lines = [x.strip() for x in f if x.strip()]
            except FileNotFoundError:
                lines = []
            for x in lines:
                if x.isdigit(): self.ident.record(int(x))
            if sum(x.isdigit() for x in lines) >= n or time.time() > end:
                return [int(x) for x in lines if x.isdigit()], [x for x in lines if not x.isdigit()]
            time.sleep(0.02)

    def tool(self, *args, timeout=60, background=False):
        rep = os.path.join(self.dir, "report.json")
        cmd = [sys.executable, "-B", TOOL, "--report", rep, *args]
        if background:
            return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE), rep
        p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)
        report = load(rep) if os.path.exists(rep) else None
        return p.returncode, report, p.stderr.decode(errors="replace")

    def fixture(self, mode):
        return [sys.executable, "-B", FIX, mode, self.pids]

    # ── cases ──
    def test_success_leftover_child_is_stopped(self):
        code, rep, err = self.tool("--grace", "2", "--", *self.fixture("exit0"))
        pids, _ = self.read_pids(2, wait=1)
        self.assertEqual(code, 0, err); self.assertEqual(rep["survivors"], [])
        self.assertGreaterEqual(len(pids), 2); self.assertEqual(self.ident.alive_all(), [])
        self.assertTrue(any("left descendants" in w for w in rep["warnings"]), rep["warnings"])
        self.assertEqual(rep["certification"], "confirmed", rep)

    def test_root_exit_code_is_preserved(self):
        code, rep, err = self.tool("--grace", "2", "--", *self.fixture("exit7"))
        self.assertEqual(code, 7, err); self.assertEqual(rep["root"]["rc"], 7); self.assertEqual(rep["certification"], "confirmed", rep)
        self.read_pids(2, wait=1); self.assertEqual(self.ident.alive_all(), [])

    def test_timeout_stops_a_three_level_tree(self):
        p, rep = self.tool("--timeout", "3", "--grace", "2", "--", *self.fixture("tree"), background=True)
        pids, _ = self.read_pids(3)
        code = p.wait(timeout=60)
        r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT, p.stderr.read().decode()); self.assertTrue(r["timed_out"]); self.assertEqual(r["survivors"], []); self.assertEqual(r["certification"], "confirmed", r)
        self.assertEqual(len(pids), 3); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipIf(WINDOWS, "POSIX signals")
    def test_sigterm_ignoring_descendants_are_killed_after_grace(self):
        p, rep = self.tool("--timeout", "2", "--grace", "1", "--", *self.fixture("tree,ignoreterm"), background=True)
        self.read_pids(3); code = p.wait(timeout=60); r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT); self.assertTrue(any(s.get("sig") == "KILL" for s in r["signalled"]), r["signalled"])
        self.assertEqual(self.ident.alive_all(), [])

    def test_escaping_grandchild_is_stopped(self):
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,escape"), background=True)
        pids, _ = self.read_pids(3); code = p.wait(timeout=60); r = load(rep)
        self.assertEqual(len(pids), 3)
        self.assertEqual(self.ident.alive_all(), [], r)
        self.assertEqual(code, ro.EXIT_TIMEOUT)
        if MACOS: self.assertTrue(r["escaped_seen"], "macOS reports the escaper it caught")

    @unittest.skipUnless(WINDOWS, "Windows Job Object")
    def test_windows_breakaway_is_refused(self):
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,breakaway"), background=True)
        _, notes = self.read_pids(3); p.wait(timeout=60)
        self.assertIn("breakaway-refused", notes); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipIf(WINDOWS, "POSIX signal to the tool")
    def test_tool_sigterm_stops_the_tree(self):
        p, rep = self.tool("--grace", "1", "--", *self.fixture("tree,ignoreterm"), background=True)
        self.read_pids(3); time.sleep(0.3); p.send_signal(signal.SIGTERM); code = p.wait(timeout=60)
        self.assertEqual(code, 128 + signal.SIGTERM); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(WINDOWS, "Windows: closing the job handle kills the tree")
    def test_windows_tool_killed_job_close_kills_tree(self):
        p, rep = self.tool("--", *self.fixture("tree,escape"), background=True)
        self.read_pids(3); time.sleep(0.5); p.kill(); p.wait(timeout=30)
        end = time.time() + 10
        while self.ident.alive_all() and time.time() < end: time.sleep(0.1)
        self.assertEqual(self.ident.alive_all(), [], "KILL_ON_JOB_CLOSE")

    @unittest.skipIf(WINDOWS, "POSIX")
    def test_limit_tool_sigkill_leaves_the_tree(self):
        """Documented limit (negative control): SIGKILL of the tool cannot be handled in-process."""
        p, rep = self.tool("--", *self.fixture("tree"), background=True)
        self.read_pids(3); time.sleep(0.3); p.kill(); p.wait(timeout=30); time.sleep(0.3)
        self.assertTrue(self.ident.alive_all(), "expected survivors: this is the limit the docs state")

    def test_unstartable_command_is_127(self):
        code, rep, err = self.tool("--", os.path.join(self.dir, "no-such-program"))
        self.assertEqual(code, ro.EXIT_NOEXEC, err)

    def test_require_full_containment(self):
        code, rep, err = self.tool("--require-full-containment", "--grace", "1", "--", *self.fixture("exit0"))
        if MACOS:
            self.assertEqual(code, ro.EXIT_TOOL); self.assertFalse(os.path.exists(self.pids), "refused before starting")
        else:
            self.assertEqual(code, 0, err); self.assertEqual(rep["containment"], "full")

    @unittest.skipUnless(LINUX, "Linux subreaper")
    def test_linux_adopted_orphans_are_reaped_while_running(self):
        code, rep, err = self.tool("--timeout", "20", "--", *self.fixture("orphancheck"))
        self.assertEqual(code, 0, f"a killed orphan must not stay a zombie that looks alive: {err}")

    @unittest.skipUnless(LINUX and hasattr(os, "pidfd_open"), "Linux pidfd")
    def test_linux_identity_mismatch_is_never_signalled(self):
        victim = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.ident.record(victim.pid)
        snippet = ("import sys, os, signal; sys.path.insert(0, %r); import run_owned as ro\n"
                   "o = ro.LinuxOwner(); pid = %d\n"
                   "o.known[pid] = {'start': -1, 'fd': None, 'ppid': 0, 'pgid': 0}\n"
                   "print(o.signal(pid, signal.SIGTERM))") % (HERE, victim.pid)
        out = subprocess.run([sys.executable, "-B", "-c", snippet], capture_output=True, text=True, timeout=30).stdout.strip()
        time.sleep(0.2)
        self.assertEqual(out, "False"); self.assertIsNone(victim.poll(), "the process with another identity was not signalled")
        victim.kill(); victim.wait()

    def snippet(self, code, timeout=60, expect=3):
        try:
            return self._snippet(code, timeout)
        finally:
            self.read_pids(expect, wait=2)  # record what it started even if it failed, so tearDown stops it

    def _snippet(self, code, timeout):
        out = subprocess.run([sys.executable, "-B", "-c", f"import sys, os, json, signal, subprocess, time; sys.path.insert(0, {HERE!r}); import run_owned as ro\n" + code],
                             capture_output=True, text=True, timeout=timeout)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    @unittest.skipIf(WINDOWS, "POSIX parent/group adoption")
    def test_stale_parent_entry_never_adopts_an_unrelated_child(self):
        """L1: a recorded pid that now belongs to another process (stale entry) must not vouch for that process's child."""
        r = self.snippet(f"""
# an unrelated tree: started through an intermediate that exits, so it is NOT a child of this (owner) process
subprocess.run([sys.executable, "-c", "import subprocess, sys; subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)", sys.executable, {FIX!r}, "tree", {self.pids!r}])
end = time.time() + 10
while time.time() < end:
    if not os.path.exists({self.pids!r}): time.sleep(0.02); continue
    with open({self.pids!r}) as f:
        if sum(1 for x in f if x.strip()) >= 1: break
    time.sleep(0.02)
with open({self.pids!r}) as f: vpid = int(f.readline())
class V: pid = vpid
v = V()
o = ro.LinuxOwner() if ro.LINUX else ro.MacOwner()
o.root = -1
o.known[v.pid] = dict(start=-1 if ro.LINUX else (0, 0), fd=None, ppid=0, pgid=0)  # the same pid, another identity
end = time.time() + 10
while time.time() < end:
    if not os.path.exists({self.pids!r}): time.sleep(0.02); continue
    with open({self.pids!r}) as f:
        if sum(1 for x in f if x.strip()) >= 3: break
    time.sleep(0.02)
# scan() WITHOUT a prune first: the stale entry is still present, so the parent re-check itself is what protects
for _ in range(10): o.scan(); time.sleep(0.02)
adopted = sorted(p for p in o.known if p != v.pid)
o.alive()  # and the prune removes the stale entry
print(json.dumps(dict(adopted=adopted, stale_left=v.pid in o.known)))
""")
        pids, _ = self.read_pids(3)
        self.assertEqual(r["adopted"], [], "nothing of the unrelated tree was adopted")
        self.assertFalse(r["stale_left"], "the stale entry is pruned")

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_id_without_a_live_member_is_never_adopted(self):
        """L2: once no verified member holds the root's group id, a process in a group with that id is not ours."""
        r = self.snippet(f"""
# an unrelated group (its own session: pgid == its pid), not a child of this (owner) process
subprocess.run([sys.executable, "-c", "import subprocess, sys; subprocess.Popen(sys.argv[1:], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)", sys.executable, {FIX!r}, "tree", {self.pids!r}])
end = time.time() + 10
while time.time() < end:
    if not os.path.exists({self.pids!r}): time.sleep(0.02); continue
    with open({self.pids!r}) as f:
        if sum(1 for x in f if x.strip()) >= 3: break
    time.sleep(0.02)
with open({self.pids!r}) as f: gpid = int(f.readline())
o = ro.LinuxOwner() if ro.LINUX else ro.MacOwner()
o.root = gpid  # as if our root had been reaped and its pid/group id reused by this unrelated group
for _ in range(10): o.alive(); o.scan(); time.sleep(0.02)
print(json.dumps(dict(adopted=sorted(o.known))))
""")
        self.read_pids(3)
        self.assertEqual(r["adopted"], [], "an unrelated group with the same id was not adopted")

    def test_unexpected_error_in_the_tool_still_stops_the_tree(self):
        """L3: an internal error (here: scan raising) must still stop every process and report 125."""
        cls = "WinOwner" if WINDOWS else ("LinuxOwner" if LINUX else "MacOwner")
        r = self.snippet(f"""
n = dict(c=0); orig = ro.{cls}.scan
def boom(self):
    n["c"] += 1
    orig(self)
    if os.path.exists({self.pids!r}):
        with open({self.pids!r}) as f:
            if sum(1 for x in f if x.strip()) >= 3: raise RuntimeError("injected")
ro.{cls}.scan = boom
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=30, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, survivors=rep["survivors"], warnings=rep["warnings"], certification=rep["certification"])))
""")
        self.read_pids(3, wait=1)
        self.assertEqual(r["code"], ro.EXIT_TOOL, r); self.assertEqual(r["survivors"], []); self.assertEqual(r["certification"], "uncertain", r)
        self.assertTrue(any("injected" in w for w in r["warnings"]), r)
        self.assertEqual(self.ident.alive_all(), [])

    def test_no_descendants_is_confirmed(self):
        code, rep, err = self.tool("--", sys.executable, "-c", "pass")
        self.assertEqual(code, 0, err); self.assertEqual(rep["certification"], "confirmed", rep)

    def test_root_exits_before_its_child_is_observed(self):
        """The macOS arm64 failure: the root forks and exits at once; its child forks later. All must be found."""
        for i in range(5):  # repeated: the race is timing-dependent
            code, rep, err = self.tool("--timeout", "20", "--grace", "1", "--", *self.fixture("fastexit"))
            self.read_pids(3, wait=3)
            self.assertEqual(self.ident.alive_all(), [], f"run {i}: {rep}")
            self.assertIn(code, (0, ro.EXIT_UNCERTAIN), err)
            if code == 0: self.assertEqual(rep["certification"], "confirmed")
            if os.path.exists(self.pids): os.unlink(self.pids)

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_descendant_in_a_new_group_is_stopped(self):
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,newgroup"), background=True)
        self.read_pids(3); code = p.wait(timeout=60); r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT, r); self.assertEqual(r["certification"], "confirmed", r); self.assertEqual(self.ident.alive_all(), [])

    def test_unseen_session_escaper_is_never_confirmed(self):
        """A grandchild that starts a new session after its parent and the root have exited. Linux (subreaper) and
        Windows (job) must stop it; macOS may not be able to prove it ours, but must then say "uncertain"."""
        code, rep, err = self.tool("--timeout", "20", "--grace", "1", "--", *self.fixture("doublefork"))
        self.read_pids(3, wait=3)
        left = self.ident.alive_all()
        if MACOS and left:
            self.assertEqual(code, ro.EXIT_UNCERTAIN, rep); self.assertEqual(rep["certification"], "uncertain", rep)
        else:
            self.assertEqual(left, [], rep); self.assertIn(code, (0, ro.EXIT_UNCERTAIN)); self.assertNotEqual(rep["certification"], "survivors")
        self.assertFalse(code == 0 and left, "never success while a descendant lives")

    def test_forking_during_cleanup_is_never_a_silent_success(self):
        p, rep = self.tool("--timeout", "2", "--grace", "1", "--", *self.fixture("tree,forkloop"), background=True)
        self.read_pids(2); code = p.wait(timeout=90); r = load(rep)
        time.sleep(0.5)  # the short-lived children end on their own
        self.assertIn(r["certification"], ("confirmed", "survivors", "uncertain"))
        if r["certification"] == "confirmed":
            self.assertEqual(code, ro.EXIT_TIMEOUT); self.assertEqual(self.ident.alive_all(), [])
        else:
            self.assertIn(code, (ro.EXIT_SURVIVORS, ro.EXIT_UNCERTAIN))

    @unittest.skipIf(WINDOWS, "POSIX discovery")
    def test_discovery_error_during_the_stop_is_uncertain(self):
        cls = "LinuxOwner" if LINUX else "MacOwner"
        r = self.snippet(f"""
orig = ro.{cls}.scan
def flaky(self):
    if getattr(self, "stopping", False): raise OSError("injected stop-phase discovery failure")
    orig(self)
ro.{cls}.scan = flaky
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=2, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, certification=rep["certification"], reasons=rep["uncertain_reasons"])))
""")
        self.assertEqual(r["code"], ro.EXIT_UNCERTAIN, r); self.assertEqual(r["certification"], "uncertain")
        self.assertEqual(self.ident.alive_all(), [], "known processes were still stopped")

    # ── D1: a failed signal is never taken as termination; one failure never stops the others (fault injection) ──
    DENY = """
import errno
cls = ro.LinuxOwner if ro.LINUX else ro.MacOwner
orig_deliver = cls._deliver
calls = dict(denied=0, kill_target=0)
def target():
    try:
        with open({pids!r}) as f: lines = [x.strip() for x in f if x.strip()]
        return int(lines[2]) if len(lines) >= 3 else None
    except FileNotFoundError: return None
def deliver(self, pid, k, sig):
    if pid == target() and calls["denied"] < {limit}:
        calls["denied"] += 1
        raise PermissionError(errno.EPERM, "injected EPERM")
    return orig_deliver(self, pid, k, sig)
cls._deliver = deliver
orig_kill, orig_killpg = ro.os.kill, ro.os.killpg
def kill(pid, sig):
    if pid == target(): calls["kill_target"] += 1
    return orig_kill(pid, sig)
ro.os.kill = kill
code, rep = ro.run([sys.executable, "-B", {fix!r}, "tree,escape", {pids!r}], timeout=3, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], survivors=[s["pid"] for s in rep["survivors"]],
                      codes=rep["reason_codes"], calls=calls, target=target(), signalled=rep["signalled"])))
"""

    @unittest.skipIf(WINDOWS, "POSIX signals")
    def test_d1_persistent_eperm_is_a_survivor_and_others_are_stopped(self):
        r = self.snippet(self.DENY.format(pids=self.pids, fix=FIX, limit=10 ** 6), timeout=90)
        t = r["target"]
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_SURVIVORS, "survivors"), r)
        self.assertEqual(r["survivors"], [t], r)
        self.assertTrue(any(c["code"] == "signal_denied" and c["pid"] == t for c in r["codes"]), r)
        self.assertGreaterEqual(r["calls"]["denied"], 2, "TERM and the KILL rounds were all attempted")
        self.assertEqual(r["calls"]["kill_target"], 0, "no plain kill() fallback after a denied signal")
        self.assertEqual([p for p in self.ident.alive_all() if p != t], [], "every other process was stopped")
        self.assertTrue(self.ident.alive(t), "the denied process really survived (the tearDown stops it by identity)")

    @unittest.skipIf(WINDOWS, "POSIX signals")
    def test_d1_denied_then_gone_is_uncertain_not_confirmed(self):
        r = self.snippet(self.DENY.format(pids=self.pids, fix=FIX, limit=1), timeout=90)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertEqual(r["survivors"], [], r)
        self.assertTrue(any(c["code"] == "signal_denied" for c in r["codes"]), "the code is sticky")
        self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipIf(WINDOWS, "POSIX signals")
    def test_d1_negative_control_empty_deny_set_is_confirmed(self):
        r = self.snippet(self.DENY.format(pids=self.pids, fix=FIX, limit=0), timeout=90)
        self.assertEqual((r["code"], r["cert"], r["codes"]), (ro.EXIT_TIMEOUT, "confirmed", []), r)
        self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(LINUX, "Linux /proc")
    def test_d1_unreadable_proc_entry_is_never_assumed_gone(self):
        r = self.snippet(f"""
import builtins
state = dict(on=False)
real_open = builtins.open
def fake_open(path, *a, **kw):  # injected at the open() inside _linux_stat itself (module-level name)
    if state["on"] and isinstance(path, str) and path.endswith("/stat") and path.startswith("/proc/"):
        with real_open({self.pids!r}) as f: lines = [x.strip() for x in f if x.strip()]
        if len(lines) >= 3 and path == "/proc/%s/stat" % lines[2]:
            raise PermissionError(13, "injected EACCES")
    return real_open(path, *a, **kw)
ro.open = fake_open
orig_stop = ro._stop_tree
def stop(owner, grace, report):
    state["on"] = True
    return orig_stop(owner, grace, report)
ro._stop_tree = stop
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=3, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"])))
""", timeout=90)
        self.assertNotEqual(r["cert"], "confirmed", r)
        self.assertTrue(any(c["code"] == "query_error" for c in r["codes"]), r)
        self.assertEqual(self.ident.alive_all(), [], "the unreadable process was still stopped through its pidfd")

    @unittest.skipUnless(LINUX and hasattr(os, "pidfd_open"), "Linux pidfd")
    def test_d1_unpinnable_candidate_is_never_silently_dropped(self):
        """pidfd_open failing (EMFILE) for a grandchild: it can be neither pinned nor signalled, so never "confirmed"."""
        r = self.snippet(f"""
import errno
orig = ro.os.pidfd_open
seen = dict(root=None, allow=set(), deny=set())
def pidfd_open(pid, *a):  # decided at first sight by lineage (race-free): root and its child allowed, deeper denied
    if pid != os.getpid() and pid not in seen["allow"] and pid not in seen["deny"]:
        if seen["root"] is None:
            seen["root"] = pid; seen["allow"].add(pid)
        else:
            st = ro._linux_stat(pid)
            (seen["allow"] if st and st[0] == seen["root"] else seen["deny"]).add(pid)
    if pid in seen["deny"]: raise OSError(errno.EMFILE, "injected EMFILE")
    return orig(pid, *a)
ro.os.pidfd_open = pidfd_open
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=3, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"], denied=sorted(seen["deny"]))))
""", timeout=90)
        self.assertTrue(r["denied"], r)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "query_error" and c.get("errno") == 24 for c in r["codes"]), r)

    @unittest.skipUnless(LINUX, "Linux reduced mode")
    def test_reduced_mode_never_kills_a_grandchild_by_pid(self):
        """Without pidfd, kill(pid) may only reach the tool's OWN child at the moment of the call (it is that child's
        only reaper, same thread): a grandchild is reported (signal_unsafe) until it is re-parented to the tool."""
        r = self.snippet(f"""
ro._pidfd_works = lambda: False
orig_kill = ro.os.kill
seen = []
def kill(pid, sig):
    st = ro._linux_stat(pid)
    seen.append([pid, bool(st) and st[0] == os.getpid()])
    return orig_kill(pid, sig)
ro.os.kill = kill
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=3, grace=1, env=dict(os.environ))
with open({self.pids!r}) as f: pids = [int(x) for x in f if x.strip().isdigit()]
print(json.dumps(dict(code=code, cert=rep["certification"], mode=rep["identity_mode"], codes=rep["reason_codes"], killed=seen, pids=pids)))
""", timeout=90)
        self.assertEqual(r["mode"], "starttime-race")
        self.assertNotEqual(r["cert"], "confirmed", r)
        self.assertTrue(r["killed"], r)
        self.assertTrue(all(own for _, own in r["killed"]), f"every kill(pid) target was the tool's own child: {r['killed']}")
        self.assertTrue(any(c["code"] == "signal_unsafe" for c in r["codes"]), r)

    # ── certification layers, each on its own (a fake owner: no processes are started or signalled) ──
    class Fake:
        containment, identity_mode = "full", "fake"
        def __init__(self, reasons=(), scan_fails=False, alive_fails=False, clean=True, live=(), raise_for=(), immortal=()):
            self.uncertain_reasons, self.warnings, self.root, self.root_status = list(reasons), [], -1, 0
            self.scan_fails, self.alive_fails, self.clean = scan_fails, alive_fails, clean
            self.certification_basis = "fake"
            self.live, self.raise_for, self.immortal, self.calls = set(live), set(raise_for), set(immortal), []
        def spawn(self, cmd, cwd, env): return -1
        def reap(self): pass
        def scan(self):
            if self.scan_fails and getattr(self, "stopping", False): raise OSError("fake discovery failure")
        def alive(self):
            if self.alive_fails and getattr(self, "stopping", False): raise RuntimeError("fake alive failure")
            return sorted(self.live)
        def signal(self, pid, sig):
            self.calls.append((pid, sig))
            if pid in self.raise_for: raise RuntimeError("fake signal failure")
            if pid not in self.immortal: self.live.discard(pid)
            return True
        def describe(self, pid): return {"pid": pid}
        def root_exited(self): return True
        def root_result(self): return 0, None
        def close(self): pass

    def stop_with(self, owner):
        report = {"warnings": [], "signalled": [], "survivors": []}
        return ro._stop_tree(owner, 0.05, report), report

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_stop_clean_fake_is_confirmed(self):
        self.assertEqual(self.stop_with(self.Fake())[0], "confirmed")

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_stop_owner_reason_is_uncertain(self):
        cert, rep = self.stop_with(self.Fake(reasons=["owner doubt"]))
        self.assertEqual(cert, "uncertain"); self.assertIn("owner doubt", rep["uncertain_reasons"])

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_stop_discovery_error_is_recorded_as_reason(self):
        cert, rep = self.stop_with(self.Fake(scan_fails=True))
        self.assertEqual(cert, "uncertain"); self.assertTrue(any("fake discovery failure" in r for r in rep["uncertain_reasons"]), rep)

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_d1_one_failing_signal_does_not_stop_the_others(self):
        f = self.Fake(live=(1, 2, 3), raise_for=(1,), immortal=(1,))
        cert, rep = self.stop_with(f)
        self.assertEqual(cert, "survivors", rep)
        self.assertTrue({2, 3} <= {p for p, _ in f.calls}, f.calls)
        self.assertEqual([s["pid"] for s in rep["survivors"]], [1])
        self.assertTrue(any(c["code"] == "signal_error" and c["pid"] == 1 for c in rep["reason_codes"]), rep)

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_d1_stop_failure_sweeps_known_processes(self):
        orig_mk, orig_stop = ro.make_owner, ro._stop_tree
        f = self.Fake(live=(5,))
        try:
            ro.make_owner = lambda: f
            def boom(owner, grace, report): raise RuntimeError("injected stop failure")
            ro._stop_tree = boom
            code, rep = ro.run(["unused"], timeout=1, grace=0.05)
        finally:
            ro.make_owner, ro._stop_tree = orig_mk, orig_stop
        self.assertEqual((code, rep["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"), rep)
        self.assertIn((5, signal.SIGKILL), f.calls, "the sweep sent SIGKILL to the known process")
        self.assertTrue(any(c["code"] == "stop_failed" for c in rep["reason_codes"]), rep)

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_d1_survivors_outrank_reasons(self):
        cert, rep = self.stop_with(self.Fake(reasons=["owner doubt"], live=(7,), immortal=(7,)))
        self.assertEqual(cert, "survivors")

    def test_layer_no_option_waives_a_reason(self):
        """There is no waiver: the CLI has exactly these options, and any reason code forbids "confirmed"."""
        with open(TOOL, encoding="utf8") as fh: src = fh.read()
        self.assertNotIn("waive", src.lower().replace("never waive", "").replace("waives one", "").replace("waivable", ""))
        orig = ro.make_owner
        try:
            f = self.Fake(); f.reason_codes = [{"code": "signal_denied", "pid": 1}]
            ro.make_owner = lambda: f
            code, rep = ro.run(["unused"], timeout=1, grace=0.05)
        finally:
            ro.make_owner = orig
        self.assertEqual((code, rep["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"), rep)

    def test_layer_run_owner_reason_is_121(self):
        orig = ro.make_owner
        try:
            ro.make_owner = lambda: self.Fake(reasons=["owner doubt"])
            code, rep = ro.run(["unused"], timeout=1, grace=0.05)
        finally:
            ro.make_owner = orig
        self.assertEqual((code, rep["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"))

    @unittest.skipIf(WINDOWS, "POSIX stop path")
    def test_layer_run_stop_failure_is_uncertain_121(self):
        orig = ro.make_owner
        try:
            ro.make_owner = lambda: self.Fake(alive_fails=True)
            code, rep = ro.run(["unused"], timeout=1, grace=0.05)
        finally:
            ro.make_owner = orig
        self.assertEqual((code, rep["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"), rep)

    def test_negative_control_plain_timeout_leaves_descendants(self):
        """The incident: a plain subprocess timeout kills only the direct child."""
        try:
            subprocess.run(self.fixture("tree"), timeout=3)
        except subprocess.TimeoutExpired:
            pass
        pids, _ = self.read_pids(3, wait=2)
        self.assertTrue(self.ident.alive_all(), "the grandchildren survive a plain timeout")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_node_test_runner_child_does_not_survive(self):
        leak = os.path.join(self.dir, "leak.test.cjs")
        with open(leak, "w") as f:
            f.write("const t=require('node:test');const n=require('node:net');const fs=require('node:fs');"
                    f"t('hang',async()=>{{fs.appendFileSync({json.dumps(self.pids)},process.pid+'\\n');n.createServer().listen(0,'127.0.0.1');await new Promise(()=>{{}});}});")
        code, rep, err = self.tool("--timeout", "4", "--grace", "2", "--", shutil.which("node"), "--test", leak)
        pids, _ = self.read_pids(1, wait=1)
        self.assertEqual(code, ro.EXIT_TIMEOUT, err); self.assertTrue(pids, "the per-file test process ran")
        self.assertEqual(self.ident.alive_all(), [], rep)


if __name__ == "__main__":
    print(f"run_owned self-tests on {sys.platform}, Python {sys.version.split()[0]}", flush=True)
    unittest.main(verbosity=2)
