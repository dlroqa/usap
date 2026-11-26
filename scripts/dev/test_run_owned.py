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

    def test_root_exit_code_is_preserved(self):
        code, rep, err = self.tool("--grace", "2", "--", *self.fixture("exit7"))
        self.assertEqual(code, 7, err); self.assertEqual(rep["root"]["rc"], 7)
        self.read_pids(2, wait=1); self.assertEqual(self.ident.alive_all(), [])

    def test_timeout_stops_a_three_level_tree(self):
        p, rep = self.tool("--timeout", "3", "--grace", "2", "--", *self.fixture("tree"), background=True)
        pids, _ = self.read_pids(3)
        code = p.wait(timeout=60)
        r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT, p.stderr.read().decode()); self.assertTrue(r["timed_out"]); self.assertEqual(r["survivors"], [])
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
print(json.dumps(dict(code=code, survivors=rep["survivors"], warnings=rep["warnings"])))
""")
        self.read_pids(3, wait=1)
        self.assertEqual(r["code"], ro.EXIT_TOOL, r); self.assertEqual(r["survivors"], [])
        self.assertTrue(any("injected" in w for w in r["warnings"]), r)
        self.assertEqual(self.ident.alive_all(), [])

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
