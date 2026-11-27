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
  macOS   reduced: the root is kept as an unreaped zombie until verification ends, so its pid, group and session id
          stay reserved; every descendant that keeps the root's session is owned (os.getsid), even after it is
          re-parented to launchd or changes group; a setsid escaper is tracked if seen while its parent lives. An
          escaper not seen in time cannot be proven ours: a lineage check then reports "uncertain" (exit 121) and
          signals nothing it cannot prove is ours. Identity is checked right before each signal (no pidfd on macOS).
  Windows full while this tool runs, pending native validation (the dev-tools workflow): the Job Object, created with
          KILL_ON_JOB_CLOSE and without breakaway, contains every descendant; the command starts suspended until it
          is in the job. If this tool is killed, closing the job handle still kills the tree. Not covered: an OUTER job
          (a terminal or CI runner) that allows silent breakaway could let a descendant leave unseen.
  With --require-full-containment the tool refuses to start (exit 125) where containment would be reduced.

Certification (report "certification"): "confirmed" every owned process is gone, verified by a clean final rescan
(Windows: the job is empty); "survivors" known owned processes are still alive; "uncertain" ownership could not be
completed (a discovery error during the stop, processes still appearing when the kill rounds ran out, a possible unseen
escaper on macOS). Success is reported only with "confirmed".
Every doubt is also a typed entry in report "reason_codes" (signal_denied, signal_error, signal_unsafe, query_error,
group_signal_denied, stop_failed, kill_rounds_unclean, ...). Any code forbids "confirmed"; no option waives one. A
signal that fails is never taken as termination: one process's failure never stops the others being signalled, and a
process that still runs after a denied signal is a survivor (120).
Exit codes: the command's own code when certified; 128+N if it died from signal N (POSIX); 124 timeout; 130/143 this
tool was interrupted; 120 survivors (overrides all others); 125 tool error or unsupported containment; 127 the command
could not be started; 121 not certified ("uncertain"). A command
that itself exits with 120, 121, 124, 125 or 127 cannot be told apart from these by the code alone: read the --report.
"""
import argparse, ctypes, ctypes.util, errno, json, os, select, signal, subprocess, sys, threading, time

VERSION = 1
LINUX = sys.platform.startswith("linux")
MACOS = sys.platform == "darwin"
WINDOWS = os.name == "nt"
POLL = 0.02
EXIT_TIMEOUT, EXIT_SURVIVORS, EXIT_UNCERTAIN, EXIT_TOOL, EXIT_NOEXEC = 124, 120, 121, 125, 127


class ToolError(Exception):
    pass


class _UnsafeTarget(Exception):
    """No race-free way to signal this process on this system (it is reported, never signalled)."""


class _ReadFailed(Exception):
    """A process could not be read right before a signal (not a signal failure)."""

    def __init__(self, err):
        super().__init__(str(err))
        self.err = err


class ReasonsMixin:
    """Typed, machine-readable reasons (report "reason_codes"). Every code also adds a human sentence to
    uncertain_reasons, and ANY code forbids "confirmed": there is no option, default or timeout that waives one.
      signal_denied  a signal to a known, identity-checked process failed with EPERM (it may still run)
      signal_error   a signal failed with another OS error
      query_error    a process could not be read (not "gone": EACCES, EMFILE, ...), so it is never assumed gone
      signal_unsafe  no race-free signalling primitive for that process here (it was NOT signalled)
      stop_failed    the stop path itself raised; a best-effort identity-checked sweep followed
      kill_rounds_unclean  the kill rounds ended without two consecutive clean scans"""

    def _reason(self, code, msg, **kw):
        codes = self.__dict__.setdefault("reason_codes", [])
        rec = dict(code=code, **kw)
        if rec not in codes:
            codes.append(rec)
        if msg not in self.uncertain_reasons:
            self.uncertain_reasons.append(msg)


def _signame(sig):
    try:
        return signal.Signals(sig).name
    except (ValueError, AttributeError):
        return str(sig)


# ── Linux ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def _linux_stat(pid):
    """(ppid, pgid, starttime) from /proc, or None if gone. Any other read failure (EACCES, EMFILE, ...) RAISES: a
    process that cannot be read is never assumed gone (D4/D1: a false "gone" could certify a live process)."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            s = f.read().decode("latin1")
    except (FileNotFoundError, ProcessLookupError):  # the process is gone
        return None
    r = s[s.rindex(")") + 2:].split()
    if r[0] == "Z":
        return None  # a zombie no longer runs; its identity is irrelevant for containment
    return int(r[1]), int(r[2]), int(r[19])


def _pidfd_works():
    """os.pidfd_open can exist while the kernel lacks it (ENOSYS before Linux 5.3): probe it on our own pid."""
    if not hasattr(os, "pidfd_open"):
        return False
    try:
        os.close(os.pidfd_open(os.getpid()))
        return True
    except OSError:
        return False


def _ensure_sigchld_default():
    """An inherited SIG_IGN for SIGCHLD makes the kernel reap children automatically: the root's status (and, on
    macOS, its pinned pid/group/session) would be lost. This CLI tool restores the default before spawning."""
    if hasattr(signal, "SIGCHLD") and signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN:
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def _pidfd_exited(fd):
    """A pidfd becomes readable when its process has exited (Linux 5.3+)."""
    p = select.poll()
    p.register(fd, select.POLLIN)
    return bool(p.poll(0))


class LinuxOwner(ReasonsMixin):
    containment = "full"

    def __init__(self):
        self.identity_mode = "pidfd" if _pidfd_works() else "starttime-race"
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
        self.uncertain_reasons = []
        self.certification_basis = "linux: subreaper + pidfd + clean final rescan"
        self.lock = threading.Lock()
        self.root = None
        self.root_status = None

    def spawn(self, cmd, cwd, env):
        _ensure_sigchld_default()
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
            except ProcessLookupError:  # gone
                return
            except OSError as e:  # EMFILE, ENOMEM, a policy denial: it may be ours and cannot be pinned -> never silent
                self._reason("query_error", f"a candidate process could not be pinned (pidfd_open): {type(e).__name__}", pid=pid, errno=e.errno)
                return
        try:
            st = _linux_stat(pid)
        except OSError as e:  # unreadable candidate: cannot tell whether it is ours -> never "confirmed"
            if fd is not None: os.close(fd)
            self._reason("query_error", f"a candidate process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
            return
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
        try:
            st = _linux_stat(pid)
        except OSError as e:
            self._reason("query_error", f"a known process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
            return False
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
        except OSError as e:  # unreadable: its children may be ours -> recorded (the /proc walk still runs)
            self._reason("query_error", f"the children of a process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
        return out

    def scan(self):
        """Adopt descendants: children of owned processes and of this tool (subreaper orphans), and the root's group."""
        me = os.getpid()
        for pid in list(self.known) + [me]:
            if self.children_file:
                for c in self._children_of(pid):
                    self._adopt(c, expect_ppid=pid)
        now = time.monotonic()
        if self.children_file and not getattr(self, "stopping", False) and now - getattr(self, "_full_at", 0.0) < 1.0:
            return  # children files of every known process + this tool (subreaper) find every descendant; the full
                    # /proc walk below is a once-a-second cross-check and runs on every scan during the stop
        self._full_at = now
        with os.scandir("/proc") as it:  # group members and parent links (also the fallback without children files)
            for e in it:
                if not e.name.isdigit(): continue
                pid = int(e.name)
                if pid in self.known or pid == me: continue
                try:
                    st = _linux_stat(pid)
                except OSError as err:  # unreadable: it might be one of ours -> recorded, never silently skipped
                    self._reason("query_error", f"a process could not be read during discovery: {type(err).__name__}", pid=pid, errno=err.errno)
                    continue
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
            try:
                st = _linux_stat(pid)
            except OSError as e:  # unreadable: never assumed gone. The pinned pidfd is authoritative when present.
                self._reason("query_error", f"a known process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
                if k["fd"] is not None and _pidfd_exited(k["fd"]):
                    self._forget(pid)  # verified exited through its own pidfd (the read failure stays recorded)
                else:
                    out.append(pid)  # still running (pidfd) or unverifiable (reduced mode): stays a known survivor
                continue
            if st is None or st[2] != k["start"]:
                self._forget(pid)  # pruned every loop: a dead entry never vouches for a parent or a group
            else:
                k["ppid"], k["pgid"] = st[0], st[1]
                out.append(pid)
        return out

    def _deliver(self, pid, k, sig):
        """The only place a signal is sent (fault injection point for the tests)."""
        if k["fd"] is not None:
            signal.pidfd_send_signal(k["fd"], sig)  # pinned: cannot reach another process
        else:
            # Reduced mode (no pidfd). kill(pid) is safe ONLY for our own child: as a subreaper we are its only reaper
            # and reap() runs in this same thread, so its pid cannot be reused before this call. Any other process
            # could be reaped by its own parent and its pid reused between a check and kill(): never signalled
            # (owner rule: no plain kill fallback; fail closed instead).
            try:
                st = _linux_stat(pid)
            except OSError as e:
                raise _ReadFailed(e) from e
            if st is None or st[2] != k["start"]: raise ProcessLookupError(errno.ESRCH, "identity changed")
            if st[0] != os.getpid():
                raise _UnsafeTarget(pid)
            os.kill(pid, sig)

    def signal(self, pid, sig):
        """True only if the signal was delivered. A failed signal is never taken as termination: EPERM/other errors
        are recorded as typed reasons, and the process stays known (a survivor if it still runs)."""
        k = self.known.get(pid)
        if not k: return False
        try:
            self._deliver(pid, k, sig)
            return True
        except _ReadFailed as e:
            self._reason("query_error", f"a known process could not be read before a signal: {type(e.err).__name__}", pid=pid, errno=e.err.errno)
            return False
        except _UnsafeTarget:
            self._reason("signal_unsafe", "reduced mode: a known process that is not our own child cannot be signalled "
                         "without a PID-reuse race; it was not signalled", pid=pid, sig=_signame(sig))
            return False
        except ProcessLookupError:
            return False
        except PermissionError as e:
            self._reason("signal_denied", f"a signal to a known process was denied (EPERM): {_signame(sig)}", pid=pid, sig=_signame(sig), errno=e.errno)
            return False
        except OSError as e:
            self._reason("signal_error", f"a signal to a known process failed: {type(e).__name__}", pid=pid, sig=_signame(sig), errno=e.errno)
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


class MacOwner(ReasonsMixin):
    """macOS: the root is kept as an UNREAPED zombie until verification ends (its exit is seen with waitid WNOWAIT), so
    its pid, group id and session id cannot be reused. Ownership: os.getsid(pid) == root (every descendant that did not
    call setsid, even after it was re-parented to launchd or moved to another group), or a parent that is a known,
    identity-checked process (setsid escapers seen while their parent lives). An escaper that is not seen in time cannot
    be proven ours; a lineage check at verification then reports the run "uncertain" (never "confirmed") and signals
    nothing it cannot prove is ours."""
    containment = "reduced"
    identity_mode = "libproc-start-check"

    def __init__(self):
        self.lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listallpids.restype = ctypes.c_int
        if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
            raise ToolError("os.waitid with WNOWAIT is required on macOS")
        self.warnings = ["macOS: a descendant that calls setsid and is re-parented to launchd before it is seen cannot be "
                         "proven ours; such a run is reported 'uncertain'"]
        self.uncertain_reasons = []
        self.certification_basis = "macos: session of the pinned root + known parents + lineage check"
        self.proc = None
        self.known = {}
        self.lock = threading.Lock()
        self.root = None
        self.root_start = None
        self.root_status = None
        self.root_exited_flag = False
        self.pinned = False  # True while the root exists unreaped (alive or zombie) and no one else could reap it
        self.escaped_seen = []
        self.pre = set()
        self.uid = os.getuid()

    def info(self, pid):
        """(ppid, pgid, start, uid) of a live, non-zombie process, or None."""
        b = _BsdInfo()
        n = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))  # PROC_PIDTBSDINFO
        if n != ctypes.sizeof(b) or b.pbi_status == 5:  # SZOMB
            return None
        return int(b.pbi_ppid), int(b.pbi_pgid), (int(b.pbi_start_tvsec), int(b.pbi_start_tvusec)), (int(b.pbi_uid), int(b.pbi_ruid)), \
            b.pbi_comm.decode("ascii", "replace")[:16]

    def _all(self):
        n = self.lib.proc_listallpids(None, 0)
        buf = (ctypes.c_int * (n + 64))()
        n = self.lib.proc_listallpids(buf, ctypes.sizeof(buf))
        return [buf[i] for i in range(max(0, n)) if buf[i] > 0]

    def spawn(self, cmd, cwd, env):
        for q in self._all():  # pre-spawn snapshot: nothing that already existed can be a candidate later
            st = self.info(q)
            if st: self.pre.add((q, st[2]))
        try:
            p = subprocess.Popen(cmd, cwd=cwd, env=env, start_new_session=True)
        except OSError as e:
            raise ToolError(f"could not start the command: {e}") from e
        self.proc = p
        self.root = p.pid
        st = self.info(p.pid)
        self.pinned = True
        if st:
            self.root_start = st[2]
            self.known[p.pid] = {"start": st[2], "ppid": st[0], "pgid": st[1]}
        return p.pid

    def _sid(self, pid):
        try: return os.getsid(pid)
        except OSError: return None

    def scan(self):
        me = os.getpid()
        for pid in self._all():
            if pid in self.known or pid == me: continue
            st = self.info(pid)
            if st is None: continue
            in_session = self.pinned and self._sid(pid) == self.root  # sound only while the root is pinned
            via_parent = st[0] in self.known and self._still_ours(st[0])
            if not (in_session or via_parent): continue
            if self.info(pid) != st: continue  # identity unchanged across the checks
            with self.lock:
                self.known[pid] = {"start": st[2], "ppid": st[0], "pgid": st[1]}
            if not in_session:
                self.escaped_seen.append(pid)

    def _still_ours(self, pid, pgid=None):
        k = self.known.get(pid); st = self.info(pid) if k else None
        return st is not None and st[2] == k["start"] and (pgid is None or st[1] == pgid)

    def reap(self):
        """Never reaps the root before cleanup ends: its exit is only observed (WNOWAIT), so it stays pinned."""
        if self.proc is None or self.root_exited_flag: return
        try:
            r = os.waitid(os.P_PID, self.root, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            self.uncertain_reasons.append("the root was reaped elsewhere: its ids are no longer pinned"); self.root_exited_flag = True; self.pinned = False; return
        if r is not None and r.si_pid == self.root:
            self.root_exited_flag = True

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
            os.kill(pid, sig)
        except ProcessLookupError:
            return False
        except PermissionError as e:
            self._reason("signal_denied", f"a signal to a known process was denied (EPERM): {_signame(sig)}", pid=pid, sig=_signame(sig), errno=e.errno)
            return False
        except OSError as e:
            self._reason("signal_error", f"a signal to a known process failed: {type(e).__name__}", pid=pid, sig=_signame(sig), errno=e.errno)
            return False
        if self.root_exited_flag and self.pinned and sig in (signal.SIGTERM, signal.SIGKILL):
            try: os.killpg(self.root, sig)  # safe: the pinned zombie keeps this group id ours
            except ProcessLookupError: pass
            except OSError as e:  # never silent: a member of our group may not have been signalled
                self._reason("group_signal_denied", f"a signal to the root's process group failed: {type(e).__name__}", pgid=self.root, sig=_signame(sig), errno=e.errno)
        return True

    def verify(self):
        """Lineage check (fail-closed): a live same-user process started after the root, not ours and not pre-existing,
        whose parent chain reaches launchd (pid 1) only through processes also started after the root, may be an unseen
        setsid escaper. It is reported, never signalled."""
        cands = []
        if self.root_start is None:
            self.uncertain_reasons.append("the root's start time was never read"); return cands
        infos = {}
        for q in self._all():
            st = self.info(q)
            if st: infos[q] = st
        for q, st in infos.items():
            if q in self.known or q == os.getpid() or (q, st[2]) in self.pre or self.uid not in st[3] or st[2] < self.root_start:
                continue
            chain, cur, ok = 0, q, False
            while chain < 64:
                c = infos.get(cur)
                if c is None: break
                if c[0] == 1: ok = True; break
                par = infos.get(c[0])
                if par is None or par[2] < self.root_start or (c[0], par[2]) in self.pre: break  # reaches an older process: not ours
                cur = c[0]; chain += 1
            if ok: cands.append(q)
        if cands:
            det = [{"pid": q, "comm": infos[q][4], "ppid": infos[q][0], "start": list(infos[q][2]), "uid": infos[q][3][0], "ruid": infos[q][3][1]} for q in sorted(cands)[:10]]
            self.uncertain_reasons.append("possible unseen setsid escapers (not signalled): " + json.dumps(det))
        return cands

    def root_exited(self):
        return self.root_exited_flag

    def root_result(self):
        rc = self.root_status
        if rc is None: return None, None
        return (None, -rc) if rc < 0 else (rc, None)

    def describe(self, pid):
        k = self.known.get(pid, {})
        return {"pid": pid, "start": list(k["start"]) if k.get("start") else None, "ppid": k.get("ppid"), "pgid": k.get("pgid")}

    def close(self):
        """Reap the root last (after verification)."""
        if self.proc is not None and self.root_status is None:
            self.pinned = False
            try: self.root_status = self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                self.uncertain_reasons.append("the root could not be reaped")


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
    children this tool would reap. This tool must be the only reaper of its children (no other waitpid(-1), SIGCHLD
    handler or SA_NOCLDWAIT in the process): the own-child signalling argument (Linux reduced mode, the pinned macOS
    root) depends on it. The tree is stopped on EVERY exit path, including an unexpected error in the tool."""
    report = {"version": VERSION, "platform": sys.platform, "containment": None, "identity_mode": None, "root": None,
              "timed_out": False, "interrupted": None, "signalled": [], "survivors": [], "escaped_seen": [], "warnings": [],
              "certification": None, "certification_basis": "", "uncertain_reasons": [], "reason_codes": []}
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
    cert, noexec, failure = "uncertain", False, None
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
                cert = _stop_tree(owner, grace, report)
                if left_after_exit:
                    report["warnings"].append("the command exited and left descendants running; they were stopped")
            except BaseException as e:  # noqa: BLE001
                report["warnings"].append(f"stopping the tree failed: {type(e).__name__}: {e}")
                report["uncertain_reasons"].append(f"stopping the tree failed: {type(e).__name__}")
                report["reason_codes"].append({"code": "stop_failed", "error": type(e).__name__})
                cert = _sweep_after_stop_failure(owner, report)
    finally:
        for s, prev in old.items():
            try: signal.signal(getattr(signal, s), prev)
            except (OSError, ValueError): pass
    try: owner.close()  # macOS reaps the pinned root here, after verification
    except Exception:  # noqa: BLE001
        pass
    for r in getattr(owner, "uncertain_reasons", []):
        if r not in report["uncertain_reasons"]: report["uncertain_reasons"].append(r)
    for c in getattr(owner, "reason_codes", []):
        if c not in report["reason_codes"]: report["reason_codes"].append(c)
    if (report["uncertain_reasons"] or report["reason_codes"]) and cert == "confirmed": cert = "uncertain"
    rc, sig = owner.root_result()
    report["root"] = {"pid": owner.root, "rc": rc, "signal": sig}
    report["warnings"] += owner.warnings
    report["escaped_seen"] = list(getattr(owner, "escaped_seen", []))
    if failure: report["warnings"].append(failure)
    report["certification"] = cert
    if failure and cert == "confirmed": cert = report["certification"] = "uncertain" if not noexec else "confirmed"
    if cert == "survivors": return EXIT_SURVIVORS, report
    if failure: return (EXIT_NOEXEC if noexec else EXIT_TOOL), report
    if cert != "confirmed": return EXIT_UNCERTAIN, report
    if report["interrupted"]: return 128 + report["interrupted"], report
    if report["timed_out"]: return EXIT_TIMEOUT, report
    if sig: return 128 + sig, report
    return (rc if rc is not None else EXIT_TOOL), report


def _sweep_after_stop_failure(owner, report):
    """The stop path raised: one more identity-checked SIGKILL round over the known processes (never anything else).
    Returns "survivors" if a known process still runs, else "uncertain" (never "confirmed")."""
    if WINDOWS:
        return "uncertain"
    try:
        for pid in owner.alive():
            try:
                if owner.signal(pid, signal.SIGKILL): report["signalled"].append({"pid": pid, "sig": "KILL"})
            except Exception:  # noqa: BLE001 - keep going for the others
                pass
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try: owner.reap()
            except Exception: pass  # noqa: BLE001
            if not owner.alive(): break
            time.sleep(POLL)
        left = owner.alive()
        if left:
            report["survivors"] = [owner.describe(p) for p in left]
            return "survivors"
    except Exception:  # noqa: BLE001
        pass
    return "uncertain"


def _stop_tree(owner, grace, report):
    """Graceful stop, bounded grace, forced stop, verification. Returns the certification:
      "confirmed"  every owned process is gone, verified by a clean final rescan (Windows: the job is empty);
      "survivors"  known owned processes are still alive after the forced stop;
      "uncertain"  ownership could not be completed (a discovery error during the stop, processes still appearing when
                   the kill rounds ran out, a platform-specific doubt such as a lineage candidate on macOS).
    Signals are blocked meanwhile (POSIX). Discovery and reaping are best-effort: an error is recorded once, never
    stops the known processes being signalled, and makes the result "uncertain"."""
    reasons = report.setdefault("uncertain_reasons", [])
    codes = report.setdefault("reason_codes", [])
    def note(m):
        if m not in reasons: reasons.append(m)
    def send(pid, sig, name):  # one process's failure never stops the others being signalled (D1)
        try:
            if owner.signal(pid, sig): report["signalled"].append({"pid": pid, "sig": name})
        except Exception as e:  # noqa: BLE001
            note(f"during stop: signal {name}: {type(e).__name__}: {e}")
            codes.append({"code": "signal_error", "pid": pid, "sig": name, "error": type(e).__name__})
    def safe(fn):
        try: fn(); return True
        except Exception as e:  # noqa: BLE001
            m = f"during stop: {fn.__name__}: {type(e).__name__}: {e}"
            if m not in report["warnings"]: report["warnings"].append(m)
            note(m); return False
    blocked = set()
    if hasattr(signal, "pthread_sigmask"):
        blocked = {getattr(signal, s) for s in ("SIGINT", "SIGTERM", "SIGHUP") if hasattr(signal, s)}
        signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    try:
        if WINDOWS:
            try:
                if owner.active():
                    owner.graceful()
                    end = time.monotonic() + grace
                    while owner.active() and time.monotonic() < end: time.sleep(POLL)
                    if owner.active(): owner.force(); report["signalled"].append("TerminateJobObject")
                end = time.monotonic() + 10
                while owner.active() and time.monotonic() < end: time.sleep(POLL)
                safe(owner.reap)
                n = owner.active()
            except Exception as e:  # noqa: BLE001 - the job API failed: cannot certify (closing the job still kills it)
                note(f"job query/terminate failed: {type(e).__name__}: {e}")
                return "uncertain"
            report["survivors"] = [{"job_process": i} for i in range(n)]
            report["certification_basis"] = "windows: job ActiveProcesses == 0"
            return "survivors" if n else ("uncertain" if reasons else "confirmed")
        owner.stopping = True  # every scan from here is a full scan
        safe(owner.reap); safe(owner.scan)
        for pid in owner.alive():
            send(pid, signal.SIGTERM, "TERM")
        end = time.monotonic() + grace
        while time.monotonic() < end:
            safe(owner.reap); safe(owner.scan)
            if not owner.alive(): break
            time.sleep(POLL)
        clean = False
        for _ in range(6):  # kill rounds; each ends with a rescan, so a process started meanwhile is found and killed
            safe(owner.reap); ok = safe(owner.scan)
            left = owner.alive()
            if not left:
                time.sleep(POLL * 2)  # settle, then one more full rescan must also find nothing
                safe(owner.reap); ok2 = safe(owner.scan)
                if ok and ok2 and not owner.alive(): clean = True; break
                continue
            for pid in left:
                send(pid, signal.SIGKILL, "KILL")
            end = time.monotonic() + 5
            while owner.alive() and time.monotonic() < end:
                safe(owner.reap); time.sleep(POLL)
        safe(owner.reap)
        left = owner.alive()
        report["survivors"] = [owner.describe(p) for p in left]
        if hasattr(owner, "verify"): safe(owner.verify)
        for r in getattr(owner, "uncertain_reasons", []): note(r)
        for c in getattr(owner, "reason_codes", []):
            if c not in codes: codes.append(c)
        report["certification_basis"] = getattr(owner, "certification_basis", "")
        if left: return "survivors"
        if not clean:
            note("the kill rounds ended without a clean final rescan")
            codes.append({"code": "kill_rounds_unclean"})
        return "uncertain" if (reasons or codes) else "confirmed"
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
    if code in (EXIT_SURVIVORS, EXIT_UNCERTAIN, EXIT_TOOL) or report["warnings"]:
        sys.stderr.write("run_owned: " + json.dumps({k: report[k] for k in ("certification", "containment", "survivors", "uncertain_reasons", "warnings")}) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
