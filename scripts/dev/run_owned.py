#!/usr/bin/env python3
"""run_owned: run one command and make sure every process it starts is gone when this tool exits.

Local development and agent helper (not used by CI, the studio or its tests). Python 3.8+, standard library only.

    python3 scripts/dev/run_owned.py [--timeout S] [--grace S] [--report FILE] [--require-full-containment] -- CMD...

Why: a runner such as `subprocess.run([...], timeout=...)` kills only its direct child on timeout. `node --test` runs
each test file in a child process, and that child survived twice and kept running for days (USAP round 24/25).

What it does
  * The command runs in its own process group / session (POSIX) or Job Object (Windows).
  * Every process of the tree is identified by (pid, kernel start time) and, on Linux, pinned by a pidfd BEFORE it is
    recorded, so a reused PID is never recorded or signalled. Nothing is matched by name or command line.
  * When the command exits, times out, or this tool gets SIGINT/SIGTERM/SIGHUP (Ctrl+Break/close on Windows), the whole
    tree is stopped: graceful signal, a bounded grace period, then a forced kill, then verification.
  * A leftover process after the forced kill is reported and the exit code says so; success is never claimed for it.

Guarantees per platform (reported as "containment" in the JSON report)
  Linux   full (reduced, and reported so, without os.pidfd_open or /proc/<pid>/task/<tid>/children): process group + child subreaper (orphans, including setsid/double-fork escapers, are re-parented to
          this tool and reaped continuously) + pidfd signalling. Not covered: a descendant that makes itself a
          subreaper or moves into another cgroup/container, and SIGKILL of this tool itself (for that, run this tool
          inside `systemd-run --user --wait --collect -p KillMode=control-group -p RuntimeMaxSec=...`).
  macOS   reduced: process group + parent-chain tracking with libproc start times. A descendant that leaves the group
          (setsid) is still tracked if it is seen while its parent lives (one poll = 20 ms); one that double-forks
          faster is re-parented to launchd and can escape. Identity is checked right before each signal (a small
          check-then-signal race remains; macOS has no pidfd).
  Windows full while this tool runs, pending native validation (the dev-tools workflow): the Job Object, created with
          KILL_ON_JOB_CLOSE and without breakaway, contains every descendant; the command starts suspended until it
          is in the job. If this tool is killed, closing the job handle still kills the tree. Not covered: an OUTER job
          (a terminal or CI runner) that allows silent breakaway could let a descendant leave unseen.
  With --require-full-containment the tool refuses to start (exit 125) where containment would be reduced.

Exit codes: the command's own code when the tree ended cleanly; 128+N if it died from signal N (POSIX); 124 timeout
(tree cleaned); 130/143 this tool was interrupted (tree cleaned); 120 survivors remained after the forced kill
(overrides the others); 125 tool error or unsupported containment; 127 the command could not be started. A command
that itself exits with 120, 124, 125 or 127 cannot be told apart from these by the code alone: read the --report.
"""
import argparse, ctypes, ctypes.util, json, os, signal, subprocess, sys, threading, time

VERSION = 1
LINUX = sys.platform.startswith("linux")
MACOS = sys.platform == "darwin"
WINDOWS = os.name == "nt"
POLL = 0.02
EXIT_TIMEOUT, EXIT_SURVIVORS, EXIT_TOOL, EXIT_NOEXEC = 124, 120, 125, 127


class ToolError(Exception):
    pass


# ── Linux ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def _linux_stat(pid):
    """(ppid, pgid, starttime) from /proc, or None if gone."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            s = f.read().decode("latin1")
    except OSError:  # gone, unreadable, or a transient error: never treated as ours
        return None
    r = s[s.rindex(")") + 2:].split()
    if r[0] == "Z":
        return None  # a zombie no longer runs; its identity is irrelevant for containment
    return int(r[1]), int(r[2]), int(r[19])


class LinuxOwner:
    containment = "full"

    def __init__(self):
        self.identity_mode = "pidfd" if hasattr(os, "pidfd_open") else "starttime-race"
        self.children_file = os.path.exists(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
        self.warnings = []
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise ToolError(f"prctl(PR_SET_CHILD_SUBREAPER) failed: errno {ctypes.get_errno()}")
        if self.identity_mode != "pidfd" or not self.children_file:
            self.containment = "reduced"
            if self.identity_mode != "pidfd":
                self.warnings.append("os.pidfd_open unavailable: identity is checked right before each signal (race)")
            if not self.children_file:
                self.warnings.append("/proc/<pid>/task/<tid>/children unavailable: descendants found by group and parent scan only")
        self.known = {}  # pid -> {"start", "fd", "ppid", "pgid"}
        self.lock = threading.Lock()
        self.root = None
        self.root_status = None

    def spawn(self, cmd, cwd, env):
        r, w = os.pipe()  # exec failure is reported through the pipe (exit 127)
        pid = os.fork()
        if pid == 0:
            try:
                os.close(r)
                for sn in ("SIGPIPE", "SIGXFSZ"):  # Python ignores these; the command gets the defaults (as subprocess does)
                    if hasattr(signal, sn): signal.signal(getattr(signal, sn), signal.SIG_DFL)
                os.setsid()
                os.set_inheritable(w, False)
                if cwd: os.chdir(cwd)
                os.execvpe(cmd[0], cmd, env)
            except BaseException as e:  # noqa: BLE001
                try: os.write(w, f"{type(e).__name__}: {e}".encode()[:500])
                finally: os._exit(EXIT_NOEXEC)
        os.close(w)
        err = b""
        while True:
            chunk = os.read(r, 4096)
            if not chunk: break
            err += chunk
        os.close(r)
        self.root = pid
        self._adopt(pid, expect_ppid=os.getpid())
        if err:
            raise ToolError(f"could not start the command: {err.decode(errors='replace')}")
        return pid

    def _adopt(self, pid, expect_ppid=None, expect_pgid=None):
        """Record pid only if it is still the process we saw: pin first (pidfd), then confirm its parent or group."""
        if pid in self.known or pid == os.getpid():
            return
        fd = None
        if self.identity_mode == "pidfd":
            try:
                fd = os.pidfd_open(pid)
            except (ProcessLookupError, OSError):
                return
        st = _linux_stat(pid)
        ok = st is not None and ((expect_ppid is not None and st[0] == expect_ppid) or (expect_pgid is not None and st[1] == expect_pgid))
        # The candidate is pinned now. Its parent / group must STILL be ours: a parent that is still the recorded process
        # (start time unchanged) was its parent when we read it (a live pid cannot be reused); a group that a verified
        # live member still holds cannot have been reallocated (the kernel does not reuse a pid used as a group id).
        if ok and expect_ppid is not None and expect_ppid != os.getpid():
            ok = self._still_ours(expect_ppid)
        if ok and expect_pgid is not None:
            ok = any(k["pgid"] == expect_pgid and self._still_ours(q, pgid=expect_pgid) for q, k in list(self.known.items()) if q != pid)
        if not ok:
            if fd is not None: os.close(fd)
            return
        with self.lock:
            self.known[pid] = {"start": st[2], "fd": fd, "ppid": st[0], "pgid": st[1]}

    def _still_ours(self, pid, pgid=None):
        k = self.known.get(pid)
        if not k: return False
        st = _linux_stat(pid)
        return st is not None and st[2] == k["start"] and (pgid is None or st[1] == pgid)

    def _children_of(self, pid):
        out = []
        try:
            for t in os.listdir(f"/proc/{pid}/task"):
                try:
                    with open(f"/proc/{pid}/task/{t}/children") as f:
                        out += [int(x) for x in f.read().split()]
                except (FileNotFoundError, ProcessLookupError):
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
        return out

    def scan(self):
        """Adopt descendants: children of owned processes and of this tool (subreaper orphans), and the root's group."""
        me = os.getpid()
        for pid in list(self.known) + [me]:
            if self.children_file:
                for c in self._children_of(pid):
                    self._adopt(c, expect_ppid=pid)
        with os.scandir("/proc") as it:  # group members and parent links (also the fallback without children files)
            for e in it:
                if not e.name.isdigit(): continue
                pid = int(e.name)
                if pid in self.known or pid == me: continue
                st = _linux_stat(pid)
                if st is None: continue
                if st[1] == self.root:
                    self._adopt(pid, expect_pgid=self.root)
                elif st[0] in self.known or st[0] == me:
                    self._adopt(pid, expect_ppid=st[0])

    def reap(self):
        """The only wait in this tool: reap every child (the root and adopted orphans), keep the root's status."""
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            if pid == self.root:
                self.root_status = status
            self._forget(pid)

    def _forget(self, pid):
        with self.lock:
            k = self.known.pop(pid, None)
        if k and k["fd"] is not None:
            os.close(k["fd"])

    def alive(self):
        out = []
        for pid, k in list(self.known.items()):
            st = _linux_stat(pid)
            if st is None or st[2] != k["start"]:
                self._forget(pid)  # pruned every loop: a dead entry never vouches for a parent or a group
            else:
                k["ppid"], k["pgid"] = st[0], st[1]
                out.append(pid)
        return out

    def signal(self, pid, sig):
        k = self.known.get(pid)
        if not k: return False
        try:
            if k["fd"] is not None:
                signal.pidfd_send_signal(k["fd"], sig)  # pinned: cannot reach another process
            else:
                st = _linux_stat(pid)
                if st is None or st[2] != k["start"]: return False
                os.kill(pid, sig)
            return True
        except ProcessLookupError:
            return False

    def root_exited(self):
        return self.root_status is not None

    def root_result(self):
        s = self.root_status
        if s is None: return None, None
        if os.WIFSIGNALED(s): return None, os.WTERMSIG(s)
        return os.WEXITSTATUS(s), None

    def describe(self, pid):
        k = self.known.get(pid, {})
        return {"pid": pid, "start": k.get("start"), "ppid": k.get("ppid"), "pgid": k.get("pgid")}

    def close(self):
        for pid in list(self.known): self._forget(pid)


# ── macOS ────────────────────────────────────────────────────────────────────────────────────────────────────────────
class _BsdInfo(ctypes.Structure):
    _fields_ = [("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32), ("pbi_xstatus", ctypes.c_uint32),
                ("pbi_pid", ctypes.c_uint32), ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
                ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32), ("pbi_rgid", ctypes.c_uint32),
                ("pbi_svuid", ctypes.c_uint32), ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32), ("pbi_nfiles", ctypes.c_uint32),
                ("pbi_pgid", ctypes.c_uint32), ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32), ("pbi_start_tvsec", ctypes.c_uint64),
                ("pbi_start_tvusec", ctypes.c_uint64)]


class MacOwner:
    containment = "reduced"
    identity_mode = "libproc-start-check"

    def __init__(self):
        self.lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listallpids.restype = ctypes.c_int
        self.warnings = ["macOS: a descendant that leaves the process group and is re-parented to launchd before it is seen can escape"]
        self.proc = None
        self.known = {}
        self.lock = threading.Lock()
        self.root = None
        self.root_status = None
        self.escaped_seen = []

    def info(self, pid):
        b = _BsdInfo()
        n = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))  # PROC_PIDTBSDINFO
        if n != ctypes.sizeof(b) or b.pbi_status == 5:  # SZOMB
            return None
        return int(b.pbi_ppid), int(b.pbi_pgid), (int(b.pbi_start_tvsec), int(b.pbi_start_tvusec))

    def spawn(self, cmd, cwd, env):
        try:
            p = subprocess.Popen(cmd, cwd=cwd, env=env, start_new_session=True)
        except OSError as e:
            raise ToolError(f"could not start the command: {e}") from e
        self.proc = p
        self.root = p.pid
        st = self.info(p.pid)
        if st: self.known[p.pid] = {"start": st[2], "ppid": st[0], "pgid": st[1]}
        return p.pid

    def _all(self):
        n = self.lib.proc_listallpids(None, 0)
        buf = (ctypes.c_int * (n + 64))()
        n = self.lib.proc_listallpids(buf, ctypes.sizeof(buf))
        return [buf[i] for i in range(max(0, n)) if buf[i] > 0]

    def scan(self):
        me = os.getpid()
        for pid in self._all():
            if pid in self.known or pid == me: continue
            st = self.info(pid)
            if st is None: continue
            # same rules as Linux (no pidfd here): a parent that is still the recorded process, or a group a verified
            # live member still holds; the candidate's identity is re-read afterwards and must be unchanged
            ok = (st[0] in self.known and self._still_ours(st[0])) or \
                 (st[1] == self.root and any(k["pgid"] == self.root and self._still_ours(q, pgid=self.root) for q, k in list(self.known.items())))
            if not ok or self.info(pid) != st: continue
            with self.lock:
                self.known[pid] = {"start": st[2], "ppid": st[0], "pgid": st[1]}
            if st[1] != self.root:
                self.escaped_seen.append(pid)

    def _still_ours(self, pid, pgid=None):
        k = self.known.get(pid); st = self.info(pid) if k else None
        return st is not None and st[2] == k["start"] and (pgid is None or st[1] == pgid)

    def reap(self):
        if self.root_status is None and self.proc is not None:
            rc = self.proc.poll()
            if rc is not None: self.root_status = rc

    def alive(self):
        out = []
        for pid, k in list(self.known.items()):
            st = self.info(pid)
            if st is None or st[2] != k["start"]:
                with self.lock: self.known.pop(pid, None)
            else:
                k["ppid"], k["pgid"] = st[0], st[1]
                out.append(pid)
        return out

    def signal(self, pid, sig):
        k = self.known.get(pid)
        st = self.info(pid) if k else None
        if not k or st is None or st[2] != k["start"]:
            return False
        try:
            os.kill(pid, sig); return True
        except ProcessLookupError:
            return False

    def root_exited(self):
        return self.root_status is not None

    def root_result(self):
        rc = self.root_status
        if rc is None: return None, None
        return (None, -rc) if rc < 0 else (rc, None)

    def describe(self, pid):
        k = self.known.get(pid, {})
        return {"pid": pid, "start": list(k["start"]) if k.get("start") else None, "ppid": k.get("ppid"), "pgid": k.get("pgid")}

    def close(self):
        pass


# ── Windows ──────────────────────────────────────────────────────────────────────────────────────────────────────────
class WinOwner:
    containment = "full"
    identity_mode = "job-object"

    def __init__(self):
        from ctypes import wintypes as w
        self.w = w
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k = k
        self.nt = ctypes.WinDLL("ntdll")
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]; k.CreateJobObjectW.restype = w.HANDLE
        k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]; k.SetInformationJobObject.restype = w.BOOL
        k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]; k.QueryInformationJobObject.restype = w.BOOL
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]; k.AssignProcessToJobObject.restype = w.BOOL
        k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]; k.TerminateJobObject.restype = w.BOOL
        k.CloseHandle.argtypes = [w.HANDLE]; k.CloseHandle.restype = w.BOOL
        k.GenerateConsoleCtrlEvent.argtypes = [w.DWORD, w.DWORD]; k.GenerateConsoleCtrlEvent.restype = w.BOOL
        self.nt.NtResumeProcess.argtypes = [w.HANDLE]; self.nt.NtResumeProcess.restype = ctypes.c_long

        class LIMIT(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", w.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", w.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class EXT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", LIMIT), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        class ACCT(ctypes.Structure):
            _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64), ("ThisPeriodTotalUserTime", ctypes.c_int64),
                        ("ThisPeriodTotalKernelTime", ctypes.c_int64), ("TotalPageFaultCount", w.DWORD), ("TotalProcesses", w.DWORD),
                        ("ActiveProcesses", w.DWORD), ("TotalTerminatedProcesses", w.DWORD)]
        self.ACCT = ACCT
        self.job = k.CreateJobObjectW(None, None)
        if not self.job:
            raise ToolError(f"CreateJobObjectW failed: {ctypes.get_last_error()}")
        info = EXT()
        info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE (no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK)
        if not k.SetInformationJobObject(self.job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise ToolError(f"SetInformationJobObject failed: {ctypes.get_last_error()}")
        self.warnings = []
        self.proc = None
        self.known = {}
        self.root = None
        self.root_status = None

    def spawn(self, cmd, cwd, env):
        flags = 0x00000004 | 0x00000200  # CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP
        try:
            p = subprocess.Popen(cmd, cwd=cwd, env=env, creationflags=flags)
        except OSError as e:
            raise ToolError(f"could not start the command: {e}") from e
        self.proc = p
        self.root = p.pid
        h = self.w.HANDLE(int(p._handle))
        if not self.k.AssignProcessToJobObject(self.job, h):
            err = ctypes.get_last_error()
            p.kill()
            raise ToolError(f"AssignProcessToJobObject failed: {err}")
        if self.nt.NtResumeProcess(h) != 0:  # only now, inside the job, may it run
            p.kill()
            raise ToolError("NtResumeProcess failed")
        return p.pid

    def active(self):
        a = self.ACCT()
        if not self.k.QueryInformationJobObject(self.job, 1, ctypes.byref(a), ctypes.sizeof(a), None):  # BasicAccounting
            raise ToolError(f"QueryInformationJobObject failed: {ctypes.get_last_error()}")
        return int(a.ActiveProcesses)

    def scan(self):
        pass  # the job contains every descendant; nothing to discover

    def reap(self):
        if self.root_status is None and self.proc is not None:
            rc = self.proc.poll()
            if rc is not None: self.root_status = rc

    def alive(self):
        return list(range(self.active()))  # a count of contained processes (job processes have no tracked pids here)

    def graceful(self):
        try:
            if self.k.GenerateConsoleCtrlEvent(1, self.root):  # CTRL_BREAK_EVENT to the command's process group
                return True
        except OSError:
            pass
        self.warnings.append("CTRL_BREAK not delivered (no shared console): forced stop only")
        return False

    def force(self):
        if not self.k.TerminateJobObject(self.job, 1):
            raise ToolError(f"TerminateJobObject failed: {ctypes.get_last_error()}")

    def root_exited(self):
        return self.root_status is not None

    def root_result(self):
        return self.root_status, None

    def describe(self, i):
        return {"job_process": i}

    def close(self):
        self.k.CloseHandle(self.job)


# ── driver ───────────────────────────────────────────────────────────────────────────────────────────────────────────
def make_owner():
    if LINUX: return LinuxOwner()
    if MACOS: return MacOwner()
    if WINDOWS: return WinOwner()
    raise ToolError(f"unsupported platform {sys.platform}")


def run(cmd, timeout=None, grace=5.0, cwd=None, env=None, require_full=False):
    """Returns (exit_code, report). CLI use only: in-process use would make the caller a subreaper (Linux) whose own
    children this tool would reap. The tree is stopped on EVERY exit path, including an unexpected error in the tool."""
    report = {"version": VERSION, "platform": sys.platform, "containment": None, "identity_mode": None, "root": None,
              "timed_out": False, "interrupted": None, "signalled": [], "survivors": [], "escaped_seen": [], "warnings": []}
    try:
        owner = make_owner()
    except (ToolError, OSError) as e:
        report["warnings"].append(str(e)); return EXIT_TOOL, report
    report["containment"], report["identity_mode"] = owner.containment, owner.identity_mode
    if require_full and owner.containment != "full":
        report["warnings"] += owner.warnings + ["--require-full-containment: refused before starting the command"]
        return EXIT_TOOL, report
    stop = {"sig": None}
    old = {}
    if threading.current_thread() is threading.main_thread():
        def h(sig, _f): stop["sig"] = stop["sig"] or sig
        for s in [x for x in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK") if hasattr(signal, x)]:
            try: old[s] = signal.signal(getattr(signal, s), h)
            except (OSError, ValueError): pass
    code, survivors, noexec, failure = None, False, False, None
    try:
        try:
            owner.spawn(cmd, cwd, env if env is not None else os.environ.copy())
            deadline = time.monotonic() + timeout if timeout else None
            while True:
                owner.reap(); owner.alive(); owner.scan()
                if owner.root_exited(): break
                if stop["sig"]: report["interrupted"] = int(stop["sig"]); break
                if deadline and time.monotonic() > deadline: report["timed_out"] = True; break
                time.sleep(POLL)
        except ToolError as e:
            noexec = "could not start" in str(e)
            failure = str(e)
        except BaseException as e:  # noqa: BLE001 - an unexpected error must still stop the tree
            failure = f"internal error: {type(e).__name__}: {e}"
        finally:
            try:
                try: left_after_exit = owner.root_exited() and not report["timed_out"] and len(owner.alive()) > 0
                except Exception:  # noqa: BLE001 - only a warning depends on it; never skip the stop
                    left_after_exit = False
                survivors = _stop_tree(owner, grace, report)
                if left_after_exit:
                    report["warnings"].append("the command exited and left descendants running; they were stopped")
            except BaseException as e:  # noqa: BLE001
                report["warnings"].append(f"stopping the tree failed: {type(e).__name__}: {e}")
                survivors = True
    finally:
        for s, prev in old.items():
            try: signal.signal(getattr(signal, s), prev)
            except (OSError, ValueError): pass
    rc, sig = owner.root_result()
    report["root"] = {"pid": owner.root, "rc": rc, "signal": sig}
    report["warnings"] += owner.warnings
    report["escaped_seen"] = list(getattr(owner, "escaped_seen", []))
    if failure: report["warnings"].append(failure)
    try: owner.close()
    except Exception:  # noqa: BLE001
        pass
    if survivors: return EXIT_SURVIVORS, report
    if failure: return (EXIT_NOEXEC if noexec else EXIT_TOOL), report
    if report["interrupted"]: return 128 + report["interrupted"], report
    if report["timed_out"]: return EXIT_TIMEOUT, report
    if sig: return 128 + sig, report
    return (rc if rc is not None else EXIT_TOOL), report


def _stop_tree(owner, grace, report):
    """Graceful stop, bounded grace, forced stop, verification. Signals are blocked meanwhile (POSIX). Discovery and
    reaping are best-effort here: an error in them is recorded once and never stops the known processes being signalled."""
    errs = set()
    def safe(fn):
        try: fn()
        except Exception as e:  # noqa: BLE001
            m = f"during stop: {fn.__name__}: {type(e).__name__}: {e}"
            if m not in errs: errs.add(m); report["warnings"].append(m)
    blocked = set()
    if hasattr(signal, "pthread_sigmask"):
        blocked = {getattr(signal, s) for s in ("SIGINT", "SIGTERM", "SIGHUP") if hasattr(signal, s)}
        signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    try:
        if WINDOWS:
            if owner.active():
                owner.graceful()
                end = time.monotonic() + grace
                while owner.active() and time.monotonic() < end: time.sleep(POLL)
                if owner.active(): owner.force(); report["signalled"].append("TerminateJobObject")
            end = time.monotonic() + 10
            while owner.active() and time.monotonic() < end: time.sleep(POLL)
            safe(owner.reap)
            n = owner.active()
            report["survivors"] = [{"job_process": i} for i in range(n)]
            return n > 0
        safe(owner.reap); safe(owner.scan)
        for pid in owner.alive():
            if owner.signal(pid, signal.SIGTERM): report["signalled"].append({"pid": pid, "sig": "TERM"})
        end = time.monotonic() + grace
        while time.monotonic() < end:
            safe(owner.reap); safe(owner.scan)
            if not owner.alive(): break
            time.sleep(POLL)
        for _ in range(3):  # anything started during the grace period is killed too
            safe(owner.reap); safe(owner.scan)
            left = owner.alive()
            if not left: break
            for pid in left:
                if owner.signal(pid, signal.SIGKILL): report["signalled"].append({"pid": pid, "sig": "KILL"})
            end = time.monotonic() + 5
            while owner.alive() and time.monotonic() < end:
                safe(owner.reap); time.sleep(POLL)
        safe(owner.reap)
        left = owner.alive()
        report["survivors"] = [owner.describe(p) for p in left]
        return bool(left)
    finally:
        if blocked: signal.pthread_sigmask(signal.SIG_UNBLOCK, blocked)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run a command and stop every process it started (see the module docstring).")
    ap.add_argument("--timeout", type=float, default=None, help="seconds; then the tree is stopped (exit 124)")
    ap.add_argument("--grace", type=float, default=5.0, help="seconds between the graceful and the forced stop (default 5)")
    ap.add_argument("--report", help="write the JSON report to this file")
    ap.add_argument("--require-full-containment", action="store_true", help="refuse (exit 125) where containment is reduced")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        ap.error("no command given (use: run_owned.py [options] -- CMD...)")
    code, report = run(cmd, timeout=a.timeout, grace=a.grace, require_full=a.require_full_containment)
    if a.report:
        with open(a.report, "w", encoding="utf8") as f: json.dump(report, f, indent=1)
    if code in (EXIT_SURVIVORS, EXIT_TOOL) or report["warnings"]:
        sys.stderr.write("run_owned: " + json.dumps({k: report[k] for k in ("containment", "survivors", "warnings")}) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
