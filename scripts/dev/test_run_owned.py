"""Self-tests for run_owned.py (unittest; Python 3.8+). Run: python3 -B scripts/dev/test_run_owned.py -v

Every case builds a real process tree (_owned_fixture.py), runs it through the CLI in its own process, and then checks
by IDENTITY (POSIX: pid + kernel start time, recorded the moment the pid appears; Windows: an open process handle,
which also pins the pid) that no process of the tree survived. Negative controls show that the failure each case
guards against is real (a plain timeout kill leaves the tree behind). Cases that need a guarantee the platform does
not give are skipped with the reason, never passed. Every process a case creates is stopped at the end of the case,
by identity only; nothing is matched by name.
"""
import errno, json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

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
        if MACOS:  # the kernel's p_uniqueid: never reused, kept across exec
            st = self.mac.info(pid); return st and st["uniqueid"]
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
                elif MACOS:  # identity-bound (pid + identity version), never a plain kill(pid)
                    q = self.mac.info(pid)
                    if q and q["uniqueid"] == self.seen[pid]: self.mac.token_signal(pid, q["idversion"], signal.SIGKILL)
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
if ro.LINUX:
    o.known[v.pid] = dict(start=-1, fd=None, ppid=0, pgid=0)  # the same pid, another identity
else:  # macOS: a stale entry (another uniqueid) and a root identity every process here would pass on age and coalition
    o.root_id = dict(uniqueid=0, idversion=0, uid=os.getuid(), ruid=os.getuid(), coal=o.coal(os.getpid()))
    o.known[v.pid] = dict(uniqueid=-1, idversion=-1, ppid=0, pgid=0); o.prov[-1] = None; o.idvs[-1] = {-1}
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
if ro.MACOS:  # not pinned (never spawned): the session id is no evidence; age and coalition alone never are
    o.root_id = dict(uniqueid=0, idversion=0, uid=os.getuid(), ruid=os.getuid(), coal=o.coal(os.getpid()))
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

    # ── N2' (macOS ownership) ──
    @unittest.skipIf(WINDOWS, "POSIX exec")
    def test_exec_after_discovery_is_still_stopped(self):
        """The child is seen, then execs: macOS bumps its identity version (uniqueid stays); it must still be stopped."""
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,execlate"), background=True)
        self.read_pids(2); code = p.wait(timeout=60); r = load(rep)
        self.assertEqual((code, r["certification"]), (ro.EXIT_TIMEOUT, "confirmed"), r)
        self.assertEqual(self.ident.alive_all(), [], r)

    @unittest.skipIf(WINDOWS, "POSIX sessions")
    def test_orphaned_session_escaper_with_a_seen_parent_is_stopped(self):
        """A grandchild starts a new session and is re-parented (launchd / subreaper) while the run goes on."""
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("slowdoublefork"), background=True)
        self.read_pids(3); code = p.wait(timeout=60); r = load(rep)
        self.assertEqual((code, r["certification"]), (ro.EXIT_TIMEOUT, "confirmed"), r)
        self.assertEqual(self.ident.alive_all(), [], r)

    @unittest.skipUnless(MACOS, "macOS launchd")
    def test_mac_unrelated_launchd_job_neither_uncertain_nor_signalled(self):
        """Round 28: launchd-started same-user processes made every macOS run 'uncertain'. A launchd job (another
        coalition) started on the tree's behalf must neither be signalled nor block "confirmed"."""
        label = None
        try:
            p, rep = self.tool("--timeout", "4", "--grace", "1", "--", *self.fixture("tree,launchd"), background=True)
            _, notes = self.read_pids(3)
            code = p.wait(timeout=60); r = load(rep)
            label = next((n.split(":", 1)[1] for n in notes if n.startswith("launchd:")), None)
            self.assertTrue(label, "launchctl submit worked")
            out = subprocess.run(["launchctl", "list", label], capture_output=True, text=True).stdout
            jpid = next((int(x.split("=")[1].strip(" ;")) for x in out.splitlines() if '"PID"' in x), None)
            self.assertEqual((code, r["certification"]), (ro.EXIT_TIMEOUT, "confirmed"), r)
            self.assertTrue(jpid, out)
            self.assertNotIn(jpid, [s.get("pid") for s in r["signalled"]], "the launchd job was not signalled")
            self.assertIsNotNone(self.ident.mac.info(jpid), "the launchd job still runs (not ours)")
        finally:
            if label: subprocess.run(["launchctl", "remove", label], capture_output=True)

    @unittest.skipUnless(MACOS, "macOS coalition")
    def test_mac_same_coalition_unrelated_orphan_is_uncertain_and_never_signalled(self):
        sib = os.path.join(self.dir, "sibling")
        p, rep = self.tool("--timeout", "4", "--grace", "1", "--", *self.fixture("tree"), background=True)
        self.read_pids(3)
        helper = os.path.join(self.dir, "sibling.py")
        with open(helper, "w") as f:  # started by the TEST (not the tool's tree); its parent exits -> an orphan
            f.write("import subprocess, sys\n"
                    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(40)'], start_new_session=True,"
                    " stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                    "open(sys.argv[1], 'w').write(str(p.pid))\n")
        subprocess.run([sys.executable, helper, sib], timeout=30)
        with open(sib) as f: spid = int(f.read().split()[0])
        self.ident.record(spid)
        rc = p.wait(timeout=60); r = load(rep)
        self.assertEqual((rc, r["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "lineage_candidate" and c.get("pid") == spid for c in r["reason_codes"]), r)
        self.assertNotIn(spid, [s.get("pid") for s in r["signalled"]])
        self.assertTrue(self.ident.alive(spid), "never signalled (the tearDown stops it by identity)")

    @unittest.skipUnless(MACOS, "macOS audit token")
    def test_mac_stale_identity_and_simulated_pid_reuse_are_refused(self):
        v = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); self.ident.record(v.pid)
        try:
            o = ro.MacOwner(); q = o._q(v.pid)
            self.assertIsNotNone(o.sig_tok, "proc_signal_with_audittoken exists on this runner")
            self.assertEqual(o.token_signal(v.pid, q["idversion"] + 1, signal.SIGTERM), 3, "stale version: ESRCH")
            o.known[v.pid] = dict(uniqueid=q["uniqueid"] + 1, idversion=q["idversion"], ppid=0, pgid=0)  # reused pid
            self.assertFalse(o.signal(v.pid, signal.SIGTERM)); time.sleep(0.2)
            self.assertIsNone(v.poll(), "neither the stale token nor the foreign identity reached it")
            o.known[v.pid] = dict(uniqueid=q["uniqueid"], idversion=q["idversion"], ppid=0, pgid=0)
            self.assertTrue(o.signal(v.pid, signal.SIGTERM)); self.assertIsNotNone(v.wait(timeout=10))
        finally:
            if v.poll() is None: v.kill()
            v.wait()

    @unittest.skipUnless(MACOS, "macOS audit token")
    def test_mac_without_the_identity_bound_call_nothing_else_is_signalled(self):
        r = self.snippet(f"""
orig = ro.MacOwner.__init__
def init(self): orig(self); self.sig_tok = None
ro.MacOwner.__init__ = init
seen = []
ok, okpg = ro.os.kill, ro.os.killpg
ro.os.kill = lambda pid, sig: (seen.append(pid), ok(pid, sig))[1]
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree,escape", {self.pids!r}], timeout=3, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"], root=rep["root"]["pid"], killed=sorted(set(seen)))))
""", timeout=90)
        self.assertIn((r["code"], r["cert"]), ((ro.EXIT_SURVIVORS, "survivors"), (ro.EXIT_UNCERTAIN, "uncertain")), r)
        self.assertTrue(any(c["code"] == "signal_unsafe" for c in r["codes"]), r)
        self.assertEqual([p for p in r["killed"] if p != r["root"]], [], "plain kill() only for the pinned root")

    @unittest.skipUnless(MACOS, "macOS libproc")
    def test_mac_process_list_failure_is_uncertain(self):
        r = self.snippet(f"""
orig = ro.MacOwner._all
def a(self):
    if getattr(self, "stopping", False): raise ro._QueryError(5, "injected proc_listallpids failure")
    return orig(self)
ro.MacOwner._all = a
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree", {self.pids!r}], timeout=2, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"])))
""", timeout=90)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "scan_error" for c in r["codes"]), r)
        self.assertEqual(self.ident.alive_all(), [])

    def test_n2_classifier_requires_positive_lineage(self):
        """Pure N2' rules (no system calls; all platforms): coalition, age, user or name never prove ownership."""
        me, uid = 99999, 501
        root = dict(uniqueid=100, idversion=1000, uid=uid, ruid=uid, coal=[7, 8])
        known, prov, idvs = {100, 110}, {100: None, 110: 100}, {100: {1000}, 110: {1010, 1011}}
        def rec(**kw):
            d = dict(pid=5000, ppid=1, uid=uid, ruid=uid, uniqueid=200, idversion=2000, orig_ppidversion=0, coal=[7, 8])
            d.update(kw); return d
        pre = rec(pid=40, uniqueid=50, idversion=500)  # an older (pre-root) live process
        procs = {40: pre, 4100: rec(pid=4100, uniqueid=110, idversion=1011)}
        cls = lambda p: ro.mac_classify(p, procs, root, known, prov, idvs, me, uid)[0]
        self.assertEqual(cls(rec()), "candidate")                                    # same coalition, no lineage
        self.assertEqual(cls(rec(coal=[9, 10])), "excluded")                         # another coalition (launchd jobs)
        self.assertEqual(cls(rec(coal=[0, 0])), "error")                             # coalition 0
        self.assertEqual(cls(rec(coal=None, coal_err=1)), "error")                   # unreadable coalition
        self.assertEqual(cls(rec(uniqueid=None)), "error")                           # incomplete identity
        self.assertEqual(cls(rec(uniqueid=60)), "excluded")                          # older than the root
        self.assertEqual(cls(rec(uid=0, ruid=0)), "excluded")                        # another user
        self.assertEqual(cls(rec(ppid=40)), "excluded")                              # descendant of an older process
        self.assertEqual(cls(rec(orig_ppidversion=1010)), "unadmitted")              # original parent ours (pre-exec idv)
        self.assertEqual(cls(rec(orig_ppidversion=1010, idversion=900)), "candidate")  # impossible order: not adopted
        self.assertEqual(cls(rec(orig_ppidversion=1010, coal=[9, 10])), "excluded")  # orig link, foreign coalition
        self.assertEqual(cls(rec(ppid=4100, orig_ppidversion=1011)), "unadmitted")   # parent link confirmed
        self.assertEqual(cls(rec(ppid=4100, orig_ppidversion=4242)), "error")        # parent pid reused: link broken
        self.assertEqual(cls(rec(uniqueid=110)), "owned")
        corrupt = dict(prov); del corrupt[110]
        self.assertEqual(ro.mac_classify(rec(uniqueid=110), procs, root, known, corrupt, idvs, me, uid)[0], "error")
        self.assertEqual(ro.mac_classify(rec(orig_ppidversion=1010), procs, root, known, corrupt, idvs, me, uid)[0], "candidate")

    def test_static_guard_plain_kill_only_where_proven_safe(self):
        """Every os.kill / os.killpg call site is in a function with a stated safety argument: Linux reduced mode
        (the tool's own child), the pinned macOS root and its process group."""
        import ast
        with open(TOOL, encoding="utf8") as fh: tree = ast.parse(fh.read())
        sites = {}
        for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
            for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
                for node in ast.walk(fn):
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("kill", "killpg") \
                            and isinstance(node.func.value, ast.Name) and node.func.value.id == "os":
                        key = (cls.name, fn.name, node.func.attr); sites[key] = sites.get(key, 0) + 1
        self.assertEqual(sites, {("LinuxOwner", "_deliver", "kill"): 1, ("MacOwner", "_deliver", "kill"): 1, ("MacOwner", "_signal_group", "killpg"): 1})

    @staticmethod
    def synthetic_mac(procs, pinned=True):
        """A MacOwner without libproc (all platforms): scan()/verify() run on a synthetic process table."""
        o = ro.MacOwner.__new__(ro.MacOwner)
        o.uncertain_reasons, o.warnings, o.escaped_seen = [], [], []
        o.lock = __import__("threading").Lock()
        o.root, o.pinned, o.root_exited_flag, o.uid = 4000, pinned, False, 501
        o.root_id = dict(uniqueid=100, idversion=1000, uid=501, ruid=501, coal=[7, 8])
        o.known = {4000: dict(uniqueid=100, idversion=1000, ppid=1, pgid=4000)}
        o.prov, o.idvs, o.ever, o.sig_tok = {100: None}, {100: {1000}}, {100}, object()
        o._census = lambda record_errors=True, floor=None: {k: dict(v) for k, v in procs.items()}
        return o

    def test_n2_scan_admits_only_with_positive_lineage_and_the_root_coalition(self):
        def rec(pid, uniq, idv, ppid, sid, orig, coal=(7, 8)):
            return dict(pid=pid, uniqueid=uniq, idversion=idv, ppid=ppid, pgid=pid, sid=sid, uid=501, ruid=501,
                        comm="x", orig_ppidversion=orig, coal=list(coal))
        procs = {4000: rec(4000, 100, 1000, 1, 4000, 0),
                 4100: rec(4100, 110, 1010, 4000, 4000, 1000),             # session of the pinned root
                 4200: rec(4200, 120, 1020, 1, 4200, 1010),                # setsid orphan, original parent 4100 (admitted first)
                 4300: rec(4300, 130, 1030, 1, 4300, 4242),                # same coalition, no lineage: never admitted
                 4400: rec(4400, 140, 1040, 4100, 4400, 1010, (9, 9)),     # lineage but another coalition: not admitted
                 4500: rec(4500, 150, 1050, 4100, 4500, 7777),             # ppid link that disagrees with orig_ppidversion
                 4600: rec(4600, 160, 1060, 1, 4000, 9999),                # only the pinned root's session links it
                 3000: rec(3000, 50, 500, 1, 3000, 0)}                     # older than the root
        o = self.synthetic_mac(procs)
        o.scan(); o.scan()
        self.assertEqual(sorted(o.known), [4000, 4100, 4200, 4600], o.known)
        self.assertEqual((o.prov[110], o.prov[120]), (100, 110))
        self.assertTrue(any(c["code"] == "coalition_mismatch" and c["pid"] == 4400 for c in o.reason_codes))
        o2 = self.synthetic_mac(procs, pinned=False)  # not pinned: the session id is no evidence
        o2.scan()
        self.assertEqual(sorted(o2.known), [4000, 4100, 4200], o2.known)
        found = sorted(o.verify())
        self.assertIn(4300, found)
        codes = {(c["code"], c.get("pid")) for c in o.reason_codes}
        self.assertIn(("lineage_candidate", 4300), codes)
        self.assertIn(("identity_error", 4500), codes)  # broken parent link: an error, never ownership

    # ── macOS group signal after the root exited: EPERM is harmless only without a live member (round 32) ──
    def group_case(self, procs, killpg_exc, census_exc=None, prior=()):
        o = self.synthetic_mac(procs)
        o.notes, o.root_exited_flag = [], True
        o.reason_codes = [dict(c) for c in prior]
        table = {4000: None, **procs}  # 4000: the zombie root (reads as gone)
        o.census_calls = 0
        def all_():
            o.census_calls += 1; return sorted(table)
        o._all = all_
        def q(pid, floor=None):
            if census_exc is not None and (pid == 4100 or not procs): raise census_exc
            return None if table.get(pid) is None else dict(table[pid])
        o._q = q
        orig = ro.os.killpg
        def fake_killpg(pgid, sig):
            self.assertEqual(pgid, 4000, "only the pinned root's group is ever signalled")
            raise killpg_exc
        ro.os.killpg = fake_killpg
        try:
            o._signal_group(signal.SIGKILL)
        finally:
            ro.os.killpg = orig
        return o

    @staticmethod
    def grp_rec(pid, pgid, uniq):
        return dict(pid=pid, uniqueid=uniq, idversion=uniq * 10, ppid=1, pgid=pgid, sid=4000, uid=501, ruid=501,
                    comm="x", orig_ppidversion=0, coal=[7, 8])

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_eperm_with_a_live_member_is_never_suppressed(self):
        o = self.group_case({4100: self.grp_rec(4100, 4000, 110), 4200: self.grp_rec(4200, 4200, 120)},
                            PermissionError(errno.EPERM, "denied"))
        codes = [c for c in o.reason_codes if c["code"] == "group_signal_denied"]
        self.assertTrue(codes, o.reason_codes); self.assertEqual(codes[0]["members"], [4100])
        self.assertEqual(o.notes, [])

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_eperm_with_only_the_zombie_root_is_a_note_not_a_reason(self):
        o = self.group_case({4200: self.grp_rec(4200, 4200, 120)}, PermissionError(errno.EPERM, "nothing to signal"))
        self.assertEqual(o.reason_codes, []); self.assertEqual(o.notes[0]["event"], "killpg_eperm_no_live_member")

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_eperm_with_an_unreadable_group_is_uncertain(self):
        o = self.group_case({}, PermissionError(errno.EPERM, "x"), census_exc=ro._QueryError(errno.EIO, "list failed"))
        self.assertTrue(any(c["code"] == "group_membership_unknown" for c in o.reason_codes), o.reason_codes)
        self.assertEqual(o.notes, [])

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_eperm_with_one_unreadable_process_is_uncertain(self):
        o = self.group_case({4100: self.grp_rec(4100, 4100, 110)}, PermissionError(errno.EPERM, "x"),
                            census_exc=ro._QueryError(errno.EAGAIN, "identity changed during the query"))
        self.assertTrue(any(c["code"] == "group_membership_unknown" for c in o.reason_codes), o.reason_codes)

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_eperm_when_not_pinned_is_never_classified(self):
        o = self.synthetic_mac({}); o.notes, o.root_exited_flag, o.pinned, o.reason_codes = [], True, False, []
        calls = []
        orig = ro.os.killpg; ro.os.killpg = lambda pg, sg: calls.append(pg)
        try: o._signal_group(signal.SIGKILL)
        finally: ro.os.killpg = orig
        self.assertEqual((calls, o.notes, o.reason_codes), ([], [], []), "an unpinned group id is never signalled")

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_missing_is_harmless_and_other_errors_are_reasons(self):
        o = self.group_case({}, ProcessLookupError(errno.ESRCH, "no group"))
        self.assertEqual((o.reason_codes, o.notes, o.census_calls), ([], [], 0), "ESRCH: nothing to inspect")
        o = self.group_case({}, OSError(errno.EINVAL, "bad"))
        self.assertTrue(any(c["code"] == "group_signal_error" for c in o.reason_codes), o.reason_codes)

    @unittest.skipIf(WINDOWS, "POSIX process groups")
    def test_group_harmless_eperm_never_waives_an_earlier_denial(self):
        prior = [{"code": "signal_denied", "pid": 4300, "sig": "SIGKILL", "errno": 1}]
        o = self.group_case({}, PermissionError(errno.EPERM, "x"), prior=prior)
        self.assertIn(prior[0], o.reason_codes)

    @unittest.skipUnless(MACOS, "XNU killpg semantics")
    def test_mac_zombie_only_group_really_returns_eperm_and_is_harmless(self):
        """The native mechanism of the round-31 false 'uncertain': a group whose only member is an unreaped zombie."""
        z = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)  # leader of its own group
        try:
            end = time.time() + 10
            while time.time() < end and os.waitid(os.P_PID, z.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                time.sleep(0.02)
            with self.assertRaises(PermissionError, msg="XNU: killpg on a zombie-only group returns EPERM"):
                os.killpg(z.pid, 0 or signal.SIGTERM)
            o = ro.MacOwner(); o.root, o.pinned, o.root_exited_flag = z.pid, True, True
            o._signal_group(signal.SIGTERM)
            self.assertEqual(o.reason_codes if hasattr(o, "reason_codes") else [], [])
            self.assertEqual([n["event"] for n in o.notes], ["killpg_eperm_no_live_member"])
            o2 = ro.MacOwner(); o2.root, o2.pinned, o2.root_exited_flag = 99998, True, True  # no such group: ESRCH
            o2._signal_group(signal.SIGTERM)
            self.assertEqual((getattr(o2, "reason_codes", []), o2.notes), ([], []))
        finally:
            z.wait()

    KILLPG_LOG = """
log = []
orig_killpg = ro.os.killpg
def killpg(pgid, sig):
    try:
        r = {inject}
        log.append("ok"); return r
    except OSError as e:
        log.append(type(e).__name__); raise
ro.os.killpg = killpg
"""

    @unittest.skipUnless(MACOS, "XNU killpg semantics")
    def test_mac_zombie_only_group_run_is_confirmed(self):
        """End to end: the root exits leaving only a new-session child, so its group holds just the zombie root."""
        r = self.snippet(self.KILLPG_LOG.format(inject="orig_killpg(pgid, sig)") + f"""
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "soloexit", {self.pids!r}], timeout=20, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"], notes=rep["notes"], log=log,
                      signalled=[x.get("pid") for x in rep["signalled"]], diag=rep.get("attribution_diagnostics"))))
""", timeout=90, expect=2)
        sys.stderr.write("attribution_diagnostics: " + json.dumps(r.get("diag"), separators=(",", ":")) + "\n")  # evidence, pass or fail
        self.assertEqual((r["code"], r["cert"], r["codes"]), (0, "confirmed", []), r)
        self.assertIn("PermissionError", r["log"], "XNU returned EPERM for the zombie-only group")
        self.assertTrue(any(n["event"] == "killpg_eperm_no_live_member" for n in r["notes"]), r)
        pids, _ = self.read_pids(2, wait=1)
        self.assertIn(pids[1], r["signalled"], "the owned new-session child was stopped by its own signal")
        self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(MACOS, "XNU killpg semantics")
    def test_mac_group_eperm_with_live_members_is_uncertain(self):
        r = self.snippet(self.KILLPG_LOG.format(inject="(_ for _ in ()).throw(PermissionError(1, 'injected EPERM'))") + f"""
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "tree,ignoreterm", {self.pids!r}], timeout=2, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"], survivors=rep["survivors"], log=log)))
""", timeout=90)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "group_signal_denied" and c.get("members") for c in r["codes"]), r)
        self.assertEqual(r["survivors"], []); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(MACOS, "XNU killpg semantics")
    def test_mac_group_inspection_error_is_uncertain(self):
        r = self.snippet(f"""
def boom(self): raise ro._QueryError(5, "injected group inspection failure")
ro.MacOwner._group_members = boom
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "soloexit", {self.pids!r}], timeout=20, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"])))
""", timeout=90, expect=2)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "group_membership_unknown" for c in r["codes"]), r)
        self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(MACOS, "macOS spawn")
    def test_mac_root_whose_identity_cannot_be_read_is_never_released(self):
        r = self.snippet(f"""
orig = ro.MacOwner.coal
n = dict(c=0)
def coal(self, pid):
    n["c"] += 1
    if n["c"] == 1: raise ro._QueryError(5, "injected coalition read failure at spawn")
    return orig(self, pid)
ro.MacOwner.coal = coal
code, rep = ro.run([sys.executable, "-B", {FIX!r}, "marker,tree", {self.pids!r}], timeout=5, grace=1, env=dict(os.environ))
print(json.dumps(dict(code=code, cert=rep["certification"], codes=rep["reason_codes"], rc=rep["root"]["rc"],
                      ran=os.path.exists({self.pids!r} + ".ran"), warnings=rep["warnings"])))
""", timeout=60, expect=0)
        self.assertEqual((r["code"], r["cert"]), (ro.EXIT_TOOL, "uncertain"), r)
        self.assertTrue(any(c["code"] == "root_identity" for c in r["codes"]), r)
        self.assertFalse(r["ran"], "the command never ran")
        self.assertEqual(r["rc"], ro.EXIT_NOEXEC, "the unreleased root exited 127 and was reaped")
        self.assertFalse(os.path.exists(self.pids), "no process of the tree ever started")

    def test_n2_orphan_of_an_exited_original_parent_is_admitted(self):
        """Agent E r31 B1: the original parent has exited (and was pruned from the live set) before its setsid orphan
        is first scanned; the persistent admission record must still link the orphan to us."""
        def rec(pid, uniq, idv, ppid, sid, orig, coal=(7, 8)):
            return dict(pid=pid, uniqueid=uniq, idversion=idv, ppid=ppid, pgid=pid, sid=sid, uid=501, ruid=501,
                        comm="x", orig_ppidversion=orig, coal=list(coal))
        procs = {4000: rec(4000, 100, 1000, 1, 4000, 0), 4100: rec(4100, 110, 1010, 4000, 4000, 1000)}
        o = self.synthetic_mac(procs)
        o.scan(); self.assertIn(4100, o.known)
        del procs[4100]; o.alive = lambda: None  # the intermediate exits ...
        with o.lock: o.known.pop(4100)          # ... and is pruned from the live set, as alive() does
        procs[4200] = rec(4200, 120, 1020, 1, 4200, 1010)  # its setsid child, re-parented to launchd, seen only now
        procs[4300] = rec(4300, 130, 1030, 1, 4300, 1011)  # a stranger with no such link
        o.scan()
        self.assertIn(4200, o.known); self.assertNotIn(4300, o.known)
        self.assertEqual(o.prov[120], 110)
        self.assertEqual(ro.mac_classify(procs[4200], procs, o.root_id, o.ever, o.prov, o.idvs, 1, 501)[0], "owned")

    # ── macOS attribution diagnostics (round 33): evidence only, never a behaviour change (all platforms) ──
    class _ZombieLib:
        """Fake libproc for the one zombie read at root exit: returns (uniqueid, idversion), a size error, or raises."""
        def __init__(self, uniq=100, idv=None, n=None, err=0, boom=False):
            self.uniq, self.idv, self.n, self.err, self.boom, self.calls = uniq, idv, n, err, boom, []
        def proc_pidinfo(self, pid, flavor, arg, ref, size):
            self.calls.append((pid, flavor, arg))
            if self.boom: raise RuntimeError("injected")
            if self.n is not None: ro.ctypes.set_errno(self.err); return self.n
            ref._obj.p_uniqueid, ref._obj.p_idversion = self.uniq, self.idv
            return size

    @staticmethod
    def dg_rec(pid, uniq, idv, ppid, sid, orig, coal=(7, 8), puniq=None, **kw):
        d = dict(pid=pid, uniqueid=uniq, idversion=idv, ppid=ppid, pgid=pid, sid=sid, uid=501, ruid=501, comm="x",
                 orig_ppidversion=orig, coal=None if coal is None else list(coal), puniqueid=puniq)
        d.update(kw); return d

    def dg_exit(self, o, procs, lib=None):
        """The root exits: reap() would see it (WNOWAIT) and take the one zombie read; the zombie reads as gone."""
        o.lib = lib or self._ZombieLib(idv=procs[4000]["idversion"])
        o._dg_step(); o.root_exited_flag = True; o._dg_exit()  # as reap() does: one step, then the exit
        del procs[4000]
        with o.lock: o.known.pop(4000, None)

    def dg_unobserved_exec(self, orig=1005, exit_idv=1005, procs_extra=None):
        """H1 shape: the root is seen at 1000, execs to 1005 unseen, forks a setsid child and exits."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs)
        o.scan()                                   # root seen at 1000 only
        procs[4000]["idversion"] = exit_idv        # exec, never observed
        self.dg_exit(o, procs, self._ZombieLib(idv=exit_idv))
        procs[4200] = R(4200, 120, 1030, 1, 4200, orig, puniq=100)
        procs.update(procs_extra or {})
        o.scan(); found = o.verify()
        return o, procs, found, o.diag_record()

    def dg_cand(self, diag, uniq):
        c = [x for x in diag["observed"]["candidates"] if x["uniqueid"] == uniq]
        i = [x for x in diag["inferred"]["candidates"] if x["uniqueid"] == uniq]
        self.assertEqual((len(c), len(i)), (1, 1), diag); return c[0], i[0]

    def test_dg_matching_versions_admit_and_record_the_exec_history(self):
        """Controls 1 + 7 (positive): every root version seen in order; the orphan of the post-exec root is admitted."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs)
        o._dg_root(procs[4000], "spawn"); o.scan()
        procs[4000]["idversion"] = 1005; o.scan()                    # exec observed by a scan
        self.dg_exit(o, procs)
        procs[4200] = R(4200, 120, 1030, 1, 4200, 1005, puniq=100)    # orphan forked at 1005
        o.scan()
        self.assertIn(4200, o.known); self.assertEqual(o.verify(), [])
        d = o.diag_record(); obs = d["observed"]
        self.assertEqual(ro.validate_attribution_diagnostics(d), [], d)
        self.assertEqual([(h["value"], h["source"]) for h in obs["root_idversion_history"]], [(1000, "spawn"), (1005, "scan")])
        seqs = [h["first_seq"] for h in obs["root_idversion_history"]]
        self.assertEqual(seqs, sorted(seqs)); self.assertLess(seqs[0], seqs[1])
        self.assertEqual((obs["root_exit_read"], obs["root_exit_idversion"], obs["root_reap_status"]), ("read", 1005, "exit_observed"))
        self.assertGreater(obs["root_exit_seq"], seqs[1])
        self.assertEqual((obs["candidates"], obs["root_in_ever"], obs["root_prov_present"], obs["root_idvs_count"]), ([], True, True, 2))
        self.assertIsNone(d["diag_error"])

    def test_dg_unobserved_root_exec_version_is_reported_with_its_signature(self):
        """Controls 2, 7, 8, 11: the round-32 Intel shape. The verdict is unchanged (lineage_candidate, never signalled);
        the record shows which predicate failed and the facts that tell H1 apart."""
        o, procs, found, d = self.dg_unobserved_exec()
        self.assertEqual(found, [4200]); self.assertNotIn(4200, o.known)
        self.assertIn(("lineage_candidate", 4200), {(c["code"], c.get("pid")) for c in o.reason_codes})
        self.assertEqual(ro.validate_attribution_diagnostics(d), [], d)
        c, i = self.dg_cand(d, 120)
        self.assertEqual((c["idversion"], c["orig_ppidversion"], c["puniqueid"], c["puniqueid_eq_root"], c["ppid"]), (1030, 1005, 100, True, 1))
        self.assertEqual((c["class"], c["reason_code"], c["failed_predicate"]), ("candidate", "lineage_candidate", "no_positive_lineage"))
        self.assertEqual((c["session"], c["parent_link"], c["original_parent"], c["coalition_match"], c["consistency"]),
                         ("sid_other", "ppid_launchd", "no_admitted_match", "same", "consistent"))
        self.assertEqual((c["first_seen_root_alive"], c["first_seen_parent"], c["first_seen_vs_root_exit"], c["first_seen_admitted"]),
                         (False, "launchd", "after_exit_observed", False))
        self.assertGreater(c["first_seen_seq"], d["observed"]["root_exit_seq"])
        self.assertEqual([h["value"] for h in d["observed"]["root_idversion_history"]], [1000])
        self.assertEqual((i["orig_ppidversion_relation"], i["orig_ppidversion_vs_root_exit_idversion"]), ("above_max_observed", "equal"))
        self.assertEqual(set(i["readings"]), {"orig_version_not_in_root_history", "orig_version_is_root_exit_version",
                                              "first_seen_without_live_root", "puniqueid_names_root"})

    def test_dg_original_parent_version_mismatch(self):
        """Control 2: a version the root was never seen at, and not its exit version either."""
        _, _, found, d = self.dg_unobserved_exec(orig=1003, exit_idv=1005)
        self.assertEqual(found, [4200])
        c, i = self.dg_cand(d, 120)
        self.assertEqual((c["orig_ppidversion"], c["original_parent"]), (1003, "no_admitted_match"))
        self.assertEqual((i["orig_ppidversion_relation"], i["orig_ppidversion_vs_root_exit_idversion"]), ("above_max_observed", "different"))
        self.assertNotIn("orig_version_is_root_exit_version", i["readings"])

    def test_dg_missing_root_version_history(self):
        """Control 3: the root was never observed alive (already a zombie at the first census): nothing is invented."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs)
        self.dg_exit(o, procs, self._ZombieLib(n=0, err=ro.errno.ESRCH))
        procs[4200] = R(4200, 120, 1030, 1, 4200, 1005, puniq=100)
        o.scan(); o.verify(); d = o.diag_record()
        self.assertEqual(ro.validate_attribution_diagnostics(d), [], d)
        obs = d["observed"]; c, i = self.dg_cand(d, 120)
        self.assertEqual((obs["root_idversion_history"], obs["root_last_alive_seq"], obs["root_exit_read"], obs["root_exit_idversion"]),
                         ([], None, "gone", None))
        self.assertIsNotNone(obs["root_first_unseen_seq"])
        self.assertEqual((i["orig_ppidversion_relation"], i["orig_ppidversion_vs_root_exit_idversion"]), ("root_history_empty", "unavailable"))
        self.assertIn("root_history_missing", i["readings"])
        o2 = self.synthetic_mac({4000: R(4000, 100, 1000, 1, 4000, 0)}); o2.idvs = {}  # admission versions lost
        self.assertEqual(o2.diag_record()["observed"]["root_idvs_count"], 0)

    def test_dg_missing_orphan_original_parent_version(self):
        """Control 4: a missing orig_ppidversion stays null (never 0) and is an identity error, as before."""
        _, _, found, d = self.dg_unobserved_exec(orig=None)
        self.assertEqual(found, [4200])
        c, i = self.dg_cand(d, 120)
        self.assertEqual((c["orig_ppidversion"], c["class"], c["failed_predicate"], c["original_parent"], c["reason_code"]),
                         (None, "error", "incomplete_identity", "orig_unavailable", "identity_error"))
        self.assertEqual((i["orig_ppidversion_relation"], i["orig_ppidversion_vs_root_exit_idversion"]), ("unavailable", "unavailable"))

    def test_dg_missing_parent_admission_record(self):
        """Control 5: the original parent's version is known but its admission record (provenance) is missing."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0), 4100: R(4100, 110, 1010, 4000, 4000, 1000)}
        o = self.synthetic_mac(procs); o.scan(); self.assertIn(4100, o.known)
        del procs[4100]; o.known.pop(4100); del o.prov[110]          # corrupted record: 110 no longer explained
        procs[4200] = R(4200, 120, 1030, 1, 4200, 1010, puniq=110)
        o.verify(); d = o.diag_record(); c, i = self.dg_cand(d, 120)
        self.assertEqual((c["class"], c["original_parent"], c["puniqueid_eq_root"]), ("candidate", "version_known_owner_unexplained", False))
        self.assertEqual(i["orig_ppidversion_relation"], "above_max_observed")
        o3 = self.synthetic_mac({4000: R(4000, 100, 1000, 1, 4000, 0)}); o3.ever = set(); o3.prov = {}
        self.assertEqual((o3.diag_record()["observed"]["root_in_ever"], o3.diag_record()["observed"]["root_prov_present"]), (False, False))

    def test_dg_stale_admission_record_and_link_seen_while_root_alive(self):
        """Controls 6 + 8: a parent link that disagrees with orig_ppidversion while the root is alive (H2 shape): the
        child is first seen BEFORE the exit, under the live root, and the broken link is named."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0), 4200: R(4200, 120, 1030, 4000, 4200, 999, puniq=100)}
        o = self.synthetic_mac(procs); o.scan()
        self.assertNotIn(4200, o.known)
        o.verify(); d = o.diag_record(); c, i = self.dg_cand(d, 120)
        self.assertEqual((c["class"], c["failed_predicate"], c["parent_link"], c["consistency"]),
                         ("error", "broken_lineage_link", "parent_known_link_mismatch", "not_checked"))
        self.assertEqual((c["first_seen_parent"], c["first_seen_root_alive"], c["first_seen_vs_root_exit"]), ("root", True, "root_exit_not_observed"))
        first = c["first_seen_seq"]
        self.dg_exit(o, procs); procs[4200]["ppid"] = 1; o.scan(); o.scan()  # re-seen as an orphan: the FIRST sighting stays
        d = o.diag_record(); c, _ = self.dg_cand(d, 120)
        self.assertEqual((c["first_seen_seq"], c["first_seen_parent"], c["first_seen_root_alive"], c["first_seen_vs_root_exit"]),
                         (first, "root", True, "before_exit_observed"))

    def test_dg_query_returning_no_information(self):
        """Control 9: an empty census, an unread coalition and a vanished zombie are recorded as such."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs); o.scan()
        procs.clear(); o.verify()
        d = o.diag_record(); self.assertEqual(ro.validate_attribution_diagnostics(d), [], d)
        self.assertEqual(d["observed"]["candidates"], [])
        _, _, found, d = self.dg_unobserved_exec(procs_extra={4300: R(4300, 130, 1040, 1, 4300, 4242, coal=None)})
        c, _ = self.dg_cand(d, 130)
        self.assertEqual((c["class"], c["failed_predicate"], c["coalition_match"]), ("error", "coalition_unreadable", "not_read"))

    def test_dg_query_failure_or_inconsistent_identity(self):
        """Control 10: a failing census keeps scan_error; a zombie read that fails or names another process is kept
        out of the evidence (no idversion invented)."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs); o.scan()
        def fail(record_errors=True, floor=None): raise ro._QueryError(ro.errno.EAGAIN, "injected")
        o._census = fail; o.verify()
        self.assertIn("scan_error", [c["code"] for c in o.reason_codes])
        self.assertEqual(ro.validate_attribution_diagnostics(o.diag_record()), [])
        for lib, want in ((self._ZombieLib(uniq=999, idv=1005), "identity_mismatch"), (self._ZombieLib(n=-1, err=ro.errno.EPERM), "error"),
                          (self._ZombieLib(boom=True), "error")):
            o = self.synthetic_mac({4000: R(4000, 100, 1000, 1, 4000, 0)})
            o.lib = lib; o.root_exited_flag = True; o._dg_exit()
            obs = o.diag_record()["observed"]
            self.assertEqual((obs["root_exit_read"], obs["root_exit_idversion"]), (want, None), lib.__dict__)
            self.assertEqual(lib.calls, [(4000, ro._PROC_PIDUNIQIDENTIFIERINFO, 1)])
        o._dg_exit(); self.assertEqual(len(lib.calls), 1, "the zombie read happens once per run")

    def test_dg_failed_predicate_matches_the_classifier(self):
        """Control 11: on every row of the classifier table the diagnostic class/predicate is the classifier's own, and
        the sub-outcomes never contradict it."""
        me, uid = 99999, 501
        root = dict(uniqueid=100, idversion=1000, uid=uid, ruid=uid, coal=[7, 8])
        known, prov, idvs = {100, 110}, {100: None, 110: 100}, {100: {1000}, 110: {1010, 1011}}
        def rec(**kw):
            d = dict(pid=5000, ppid=1, uid=uid, ruid=uid, uniqueid=200, idversion=2000, orig_ppidversion=0, coal=[7, 8], sid=5000)
            d.update(kw); return d
        procs = {40: rec(pid=40, uniqueid=50, idversion=500), 4100: rec(pid=4100, uniqueid=110, idversion=1011),
                 4101: rec(pid=4101, uniqueid=110, idversion=1012)}  # 110 now at an exec version not yet in idvs
        rows = [rec(ppid=4101, orig_ppidversion=1012), rec(), rec(coal=[9, 10]), rec(coal=[0, 0]), rec(coal=None, coal_err=1), rec(uniqueid=None), rec(uniqueid=60),
                rec(uid=0, ruid=0), rec(ppid=40), rec(orig_ppidversion=1010), rec(orig_ppidversion=1010, idversion=900),
                rec(ppid=4100, orig_ppidversion=1011), rec(ppid=4100, orig_ppidversion=4242), rec(uniqueid=110), rec(ppid=777)]
        seen = set()
        for p in rows:
            cls, why = ro.mac_classify(p, procs, root, known, prov, idvs, me, uid)
            e = ro.mac_attribution_explain(p, procs, root, known, prov, idvs, me, uid, True, 4000)
            self.assertEqual((e["class"], e["failed_predicate"]), (cls, ro._DG_WHY.get(why, "other")), p)
            self.assertNotEqual(e["consistency"], "inconsistent", (p, e)); seen.add(e["failed_predicate"])
            errs = []; ro._dg_check(e, ("obj", ro._DG_CAND_SCHEMA), "e", errs); self.assertEqual(errs, [], e)
        self.assertTrue({"no_positive_lineage", "coalition_zero", "coalition_unreadable", "incomplete_identity", "unadmitted_original_parent",
                         "unadmitted_parent", "broken_lineage_link", "lineage_gap"} <= seen, seen)
        e = ro.mac_attribution_explain(rec(orig_ppidversion=1010), procs, root, known, prov, idvs, me, uid, True, 4000)
        self.assertEqual((e["original_parent"], e["consistency"]), ("matches_admitted_idv_gt", "consistent"))

    def test_dg_output_size_bounds_and_truncation(self):
        """Control 12: bounded lists with explicit counts; the worst case stays under the size bound; the validator
        rejects unknown keys, wrong types, unknown values and oversized lists."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0)}
        o = self.synthetic_mac(procs)
        for v in range(1000, 1020): procs[4000]["idversion"] = v; o.scan()
        self.dg_exit(o, procs)
        for n in range(300):
            procs[10000 + n] = R(10000 + n, 1000 + n, 5000 + n, 1, 10000 + n, 3_000_000_000 + n, puniq=2 ** 63 + n)
        o.scan(); o.verify(); d = o.diag_record(); obs = d["observed"]
        self.assertEqual(ro.validate_attribution_diagnostics(d), [], d)
        self.assertEqual((len(obs["root_idversion_history"]), obs["root_idversion_history_truncated"]), (ro._DG_HIST_MAX, True))
        self.assertEqual((obs["first_seen_count"], obs["first_seen_drops"] > 0), (ro._DG_SEEN_MAX, True))
        self.assertEqual((len(obs["candidates"]), obs["candidates_dropped"]), (ro._DG_CAND_MAX, 300 - ro._DG_CAND_MAX))
        self.assertTrue(any(c["first_seen_seq"] == "unknown_truncated" for c in obs["candidates"]) or all(type(c["first_seen_seq"]) is int for c in obs["candidates"]))
        size = len(ro.json.dumps(d, separators=(",", ":"))); self.assertLessEqual(size, ro._DG_JSON_MAX)
        orig_max = ro._DG_JSON_MAX
        try:
            ro._DG_JSON_MAX = size - 1  # the size bound itself is enforced (not only the list bounds)
            self.assertIn("diag: larger than the size bound", ro.validate_attribution_diagnostics(d))
            self.assertEqual(o.diag_record(), {"schema": 1, "diag_error": "validation_failed"})
        finally:
            ro._DG_JSON_MAX = orig_max
        print(f"  worst-case attribution_diagnostics size: {size} bytes (bound {ro._DG_JSON_MAX})", file=sys.stderr)
        bad = []
        x = json.loads(json.dumps(d)); x["observed"]["cmdline"] = 1; bad.append(x)
        x = json.loads(json.dumps(d)); x["observed"]["root_reap_status"] = "free text"; bad.append(x)
        x = json.loads(json.dumps(d)); x["observed"]["candidates"].append(dict(x["observed"]["candidates"][0])); bad.append(x)
        x = json.loads(json.dumps(d)); x["observed"]["root_idvs_count"] = True; bad.append(x)
        x = json.loads(json.dumps(d)); x["observed"]["root_exit_seq"] = "5"; bad.append(x)
        x = json.loads(json.dumps(d)); x["observed"]["candidates"][0]["comm"] = "Python"; bad.append(x)
        x = json.loads(json.dumps(d)); x["schema"] = None; bad.append(x)
        x = {"schema": 1, "diag_error": None, "observed": {"root_idversion_history": [{"value": 2 ** 2000, "first_seq": 1, "source": "scan"}]}}; bad.append(x)
        for b in bad: self.assertTrue(ro.validate_attribution_diagnostics(b), b if len(str(b)) < 300 else str(b)[:300])
        o.__dict__["_dg_state"]["hist"].append({"value": 7, "first_seq": 0, "source": "bogus"})  # corrupted state
        self.assertEqual(o.diag_record(), {"schema": 1, "diag_error": "validation_failed"})
        o.__dict__["_dg_state"]["hist"].append({"value": "x", "first_seq": 0, "source": "scan"})  # cannot even be built
        self.assertEqual(o.diag_record(), {"schema": 1, "diag_error": "exception"})

    def test_dg_sensitive_text_is_never_reported(self):
        """Control 13: names, command lines, environments and paths never reach the diagnostics."""
        M = "SENSITIVE_MARKER_7f3a"
        extra = dict(comm=M, cmdline=[M], env={M: M}, cwd="/" + M, path="/" + M, url="https://" + M)
        _, _, found, d = self.dg_unobserved_exec(procs_extra={4300: self.dg_rec(4300, 130, 1040, 1, 4300, 4242, **extra)})
        self.assertIn(4300, found)
        blob = json.dumps(d); self.assertNotIn(M, blob); self.assertNotIn("Python", blob)
        def leaves(x):
            if isinstance(x, dict):
                for v in x.values(): yield from leaves(v)
            elif isinstance(x, list):
                for v in x: yield from leaves(v)
            else: yield x
        for v in leaves(d): self.assertTrue(v is None or type(v) in (int, bool, str), v)
        self.assertEqual(ro.validate_attribution_diagnostics(d), [])

    def dg_scenario(self, mode):
        """One H1-shaped run with the diagnostics normal / disabled / raising; returns the decision-relevant state."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0), 4100: R(4100, 110, 1010, 4000, 4000, 1000)}
        o = self.synthetic_mac(procs)
        o._q = lambda pid, floor=None: dict(procs[pid]) if pid in procs else None
        calls = {"census": 0, "deliver": 0, "coal": 0}
        census = o._census
        def counted(record_errors=True, floor=None):
            calls["census"] += 1; return census(record_errors, floor)
        o._census = counted
        o._deliver = lambda *a: calls.__setitem__("deliver", calls["deliver"] + 1)
        o.coal = lambda pid: (calls.__setitem__("coal", calls["coal"] + 1), [7, 8])[1]
        saved = {}
        if mode != "normal":
            def boom(*a, **kw): raise RuntimeError("injected diagnostics fault")
            for name in ("_dg_step", "_dg_root", "_dg_scan", "_dg_exit", "_dg_reap", "_dg_cand"):
                saved[name] = getattr(ro.MacOwner, name)
                setattr(ro.MacOwner, name, ro._diag_safe(boom) if mode == "raising" else (lambda self, *a, **kw: None))
        try:
            o.scan(); o.scan()
            procs[4000]["idversion"] = 1005
            self.dg_exit(o, procs)
            procs[4200] = R(4200, 120, 1030, 1, 4200, 1005, puniq=100)    # H1: unseen root version
            procs[4300] = R(4300, 130, 1040, 1, 4300, 1000)               # admitted via the observed version
            o.scan(); o.alive(); found = o.verify(); o.signal(4100, signal.SIGTERM)
            state = dict(known=sorted(o.known), prov=dict(o.prov), ever=sorted(o.ever), idvs={k: sorted(v) for k, v in o.idvs.items()},
                         found=found, codes=list(o.reason_codes), reasons=list(o.uncertain_reasons), escaped=list(o.escaped_seen),
                         notes=list(getattr(o, "notes", [])), calls=dict(calls))
            return state, o.diag_record()
        finally:
            for name, fn in saved.items(): setattr(ro.MacOwner, name, fn)

    def test_dg_verdict_cleanup_and_signals_unchanged(self):
        """Controls 14 + 15: diagnostics on, off, or failing on every hook give the same ownership state, reasons,
        candidates and signals, and add no census, coalition read or signal."""
        on, d_on = self.dg_scenario("normal")
        off, _ = self.dg_scenario("disabled")
        bad, d_bad = self.dg_scenario("raising")
        self.assertEqual(on, off); self.assertEqual(on, bad)
        self.assertEqual(on["found"], [4200]); self.assertIn(4300, on["known"])
        self.assertEqual(on["calls"]["deliver"], 1, "only the explicit signal to the known process")
        self.assertIsNone(d_on["diag_error"]); self.assertEqual(d_bad["diag_error"], "exception")
        self.assertEqual(ro.validate_attribution_diagnostics(d_bad), [])

    def test_dg_report_key_never_changes_the_exit_code(self):
        """Control 14 (driver): an owner without diagnostics reports null; one whose diag_record raises still gives the
        same exit code and certification."""
        orig = ro.make_owner
        try:
            ro.make_owner = lambda: self.Fake()
            c1, r1 = ro.run(["unused"], timeout=1, grace=0.05)
            f = self.Fake(); f.diag_record = lambda: (_ for _ in ()).throw(RuntimeError("x")); ro.make_owner = lambda: f
            c2, r2 = ro.run(["unused"], timeout=1, grace=0.05)
        finally:
            ro.make_owner = orig
        self.assertIsNone(r1["attribution_diagnostics"])
        self.assertEqual(r2["attribution_diagnostics"], {"schema": 1, "diag_error": "exception"})
        self.assertEqual((c1, r1["certification"]), (c2, r2["certification"]))

    def test_dg_static_write_only_and_no_signals(self):
        """Control 15 (static): outside the diagnostics, MacOwner only CALLS self._dg_* as statements (their result is
        never used, so no decision can read them); the diagnostics never signal, add reasons/notes or query processes,
        apart from the one zombie read in _dg_exit."""
        import ast
        with open(TOOL, encoding="utf8") as fh: tree = ast.parse(fh.read())
        mac = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "MacOwner"][0]
        forbidden = {"kill", "killpg", "_deliver", "token_signal", "_reason", "_coal_into", "_q", "_census", "_all", "coal",
                     "signal", "_signal_group", "sig_tok", "waitid", "waitpid"}
        def attrs(node): return {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)}
        for fn in [n for n in mac.body if isinstance(n, ast.FunctionDef)]:
            if fn.name.startswith("_dg") or fn.name == "diag_record":
                self.assertFalse(attrs(fn) & forbidden, (fn.name, attrs(fn) & forbidden))
                n_pidinfo = sum(1 for n in ast.walk(fn) if isinstance(n, ast.Attribute) and n.attr == "proc_pidinfo")
                self.assertEqual(n_pidinfo, 1 if fn.name == "_dg_exit" else 0, fn.name)
                continue
            uses = [n for n in ast.walk(fn) if isinstance(n, ast.Attribute) and n.attr.startswith("_dg")]
            stmt_calls = [n.value.func for n in ast.walk(fn) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                          and isinstance(n.value.func, ast.Attribute) and n.value.func.attr.startswith("_dg_")]
            self.assertEqual(len(uses), len(stmt_calls), f"{fn.name} reads diagnostic state")
        for name in ("mac_attribution_explain", "_dg_relation"):
            fn = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name][0]
            self.assertFalse(attrs(fn) & forbidden, name)
            calls = {n.func.id for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
            self.assertTrue(calls <= {"mac_classify", "_mac_explained", "_mac_link_ok", "_dg_int", "type", "isinstance", "any",
                                      "max", "min", "dict", "int", "len"}, calls)

    # ── certification layers, each on its own (a fake owner: no processes are started or signalled) ──
    class Fake:
        containment, identity_mode = "full", "fake"
        def __init__(self, reasons=(), scan_fails=False, alive_fails=False, clean=True, live=(), raise_for=(), immortal=(), appear_at=None):
            self.uncertain_reasons, self.warnings, self.root, self.root_status = list(reasons), [], -1, 0
            self.scan_fails, self.alive_fails, self.clean = scan_fails, alive_fails, clean
            self.certification_basis = "fake"
            self.live, self.raise_for, self.immortal, self.calls = set(live), set(raise_for), set(immortal), []
            self.appear_at, self.stop_scans = appear_at, 0
        def spawn(self, cmd, cwd, env): return -1
        def reap(self): pass
        def scan(self):
            if self.scan_fails and getattr(self, "stopping", False): raise OSError("fake discovery failure")
            if getattr(self, "stopping", False):
                self.stop_scans += 1
                if self.stop_scans == self.appear_at: self.live.add(9)  # a process found only by a later rescan
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
    def test_layer_second_clean_rescan_is_required(self):
        """A process that appears only at the settle rescan after a clean scan must still be found and stopped."""
        f = self.Fake(appear_at=4)
        cert, rep = self.stop_with(f)
        self.assertIn((9, signal.SIGKILL), f.calls, f"the second rescan found it: scans={f.stop_scans}")
        self.assertEqual(cert, "confirmed", rep)

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
