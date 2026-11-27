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
  macOS   reduced (model N2', validated on hosted macOS 15 arm64/Intel): identity is the kernel's p_uniqueid (kept across
          exec, never reused); the root starts only after its identity and coalition are read and is kept as an
          unreaped zombie until verification ends, so its pid, group and session id stay reserved. A process is owned
          only with positive lineage: the pinned root's session, a known parent confirmed by the child's immutable
          p_orig_ppidversion, or a provenance-backed original parent (orphans re-parented to launchd); parent links
          also require the root's coalition. Descendants are signalled only through proc_signal_with_audittoken (pid +
          identity version: a reused or exec'd pid gets ESRCH), never by plain kill(pid); without that call (macOS <
          14.2) only the pinned root and its group are signalled and the run is never "confirmed". Verification
          classifies every live process: launchd services are in other coalitions (excluded); a same-coalition process
          with no lineage either way makes the run "uncertain" and is never signalled. Not covered: work started via
          launchd (open, launchctl, XPC), setuid helpers, an escaper whose ancestry was never seen (uncertain).
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
# libproc flavors without a same-user check (xnu proc_info.c): 13 SHORTBSDINFO, 17 UNIQIDENTIFIERINFO, 20 COALITIONINFO.
_PROC_PIDT_SHORTBSDINFO, _PROC_PIDUNIQIDENTIFIERINFO, _PROC_PIDCOALITIONINFO, _SZOMB = 13, 17, 20, 5


class _ShortInfo(ctypes.Structure):
    _fields_ = [("pbsi_pid", ctypes.c_uint32), ("pbsi_ppid", ctypes.c_uint32), ("pbsi_pgid", ctypes.c_uint32),
                ("pbsi_status", ctypes.c_uint32), ("pbsi_comm", ctypes.c_char * 16), ("pbsi_flags", ctypes.c_uint32),
                ("pbsi_uid", ctypes.c_uint32), ("pbsi_gid", ctypes.c_uint32), ("pbsi_ruid", ctypes.c_uint32),
                ("pbsi_rgid", ctypes.c_uint32), ("pbsi_svuid", ctypes.c_uint32), ("pbsi_svgid", ctypes.c_uint32),
                ("pbsi_rfu", ctypes.c_uint32)]


class _UniqInfo(ctypes.Structure):
    _fields_ = [("p_uuid", ctypes.c_uint8 * 16), ("p_uniqueid", ctypes.c_uint64), ("p_puniqueid", ctypes.c_uint64),
                ("p_idversion", ctypes.c_int32), ("p_orig_ppidversion", ctypes.c_int32),
                ("p_reserve2", ctypes.c_uint64), ("p_reserve3", ctypes.c_uint64)]


class _CoalInfo(ctypes.Structure):
    _fields_ = [("coalition_id", ctypes.c_uint64 * 2), ("reserved1", ctypes.c_uint64), ("reserved2", ctypes.c_uint64),
                ("reserved3", ctypes.c_uint64)]


class _QueryError(OSError):
    """A process could not be read for a reason other than "gone" (never treated as gone)."""


def _mac_explained(u, root_u, prov):
    """True only if u's provenance chains back to the root (an entry without provenance is corrupted evidence)."""
    seen = set()
    while u is not None and u not in seen:
        if u == root_u:
            return True
        seen.add(u)
        if u not in prov:
            return False
        u = prov[u]
    return False


def _mac_link_ok(child, parent_uniq, parent_idv, idvs):
    """A ppid link must agree with the immutable p_orig_ppidversion (on macOS ppid is the original parent or launchd;
    this guards against a parent pid reused between two reads). exec bumps idversion, so every seen version counts."""
    return child["orig_ppidversion"] in (idvs.get(parent_uniq, set()) | {parent_idv})


def mac_classify(p, procs, root, known_uniq, prov, idvs, me, my_uid):
    """N2' classification of one LIVE process for certification (pure: no system calls). known_uniq is every uniqueid
    ever admitted (an exited original parent still counts as evidence). Returns (class, reason):
      owned      known, with provenance back to the root
      unadmitted provably ours (positive lineage) but not admitted by scan: a survivor nobody stopped -> uncertain
      candidate  same coalition, started after the root, no positive lineage: cannot be proven ours or foreign
      excluded   provably not ours (another coalition, another user, older than the root, or a pre-root ancestor)
      error      incomplete or corrupted identity, unreadable coalition, coalition 0, a broken lineage link
    Coalition membership, start order, user or name alone are never ownership evidence; only lineage is."""
    if p.get("pid") in (0, 1, me):
        return "excluded", "system or self"
    if any(p.get(k) is None for k in ("uniqueid", "idversion", "uid", "ruid", "ppid", "orig_ppidversion")):
        return "error", "incomplete identity"
    if p["uniqueid"] in known_uniq:
        return ("owned", "known") if _mac_explained(p["uniqueid"], root["uniqueid"], prov) else ("error", "provenance missing")
    if p["uid"] != root["uid"] and p["ruid"] != root["uid"]:
        return "excluded", "another user"
    if p["uniqueid"] < root["uniqueid"]:
        return "excluded", "older than the root"
    c = p.get("coal")
    if p.get("coal_err") or c is None:
        return "error", "coalition unreadable"
    if c[0] == 0:
        return "error", "coalition 0"
    if c[0] != root["coal"][0]:
        return "excluded", "another coalition"
    by_idv = {v: u for u, vs in idvs.items() if u in known_uniq and _mac_explained(u, root["uniqueid"], prov) for v in vs}
    u = by_idv.get(p["orig_ppidversion"])
    if u is not None and p["idversion"] > p["orig_ppidversion"]:
        return "unadmitted", "original parent is ours"
    q, hops = p, 0
    while q["ppid"] not in (0, 1) and hops < 64:
        par = procs.get(q["ppid"])
        if par is None or par.get("uniqueid") is None:
            return "error", "lineage gap"
        if par["uniqueid"] in known_uniq:
            if _mac_explained(par["uniqueid"], root["uniqueid"], prov) and _mac_link_ok(q, par["uniqueid"], par["idversion"], idvs):
                return "unadmitted", "parent is ours"
            return "error", "broken lineage link"
        if par["uniqueid"] < root["uniqueid"]:
            return "excluded", "descendant of an older process"
        q, hops = par, hops + 1
    return "candidate", "same coalition, no lineage to the root"


class MacOwner(ReasonsMixin):
    """macOS, model N2' (validated natively on hosted macOS 15 arm64 and Intel by the bench PoC, run 45913017857):
      * Identity is the kernel's p_uniqueid (never reused within a boot, kept across exec); p_idversion changes on
        exec and is re-read before every signal. Queries use libproc flavors 13/17/20, which work for any user.
      * The root is started stopped on a pipe until its identity and coalition are read, then kept as an UNREAPED
        zombie until verification ends (waitid WNOWAIT), so its pid, process group and session id stay reserved.
      * A process is admitted (owned) only with POSITIVE lineage: the pinned root's session; or a known parent whose
        identity matches the child's immutable p_orig_ppidversion; or a provenance-backed original-parent version
        (an orphan re-parented to launchd). Admission by parent or original parent also requires the root's
        coalition. Coalition, start order, user or name alone never prove ownership.
      * Signals: descendants only through proc_signal_with_audittoken (the kernel matches pid AND identity version,
        so an exited or reused pid gets ESRCH). kill()/killpg() are used only for the pinned root and its group, which
        cannot be reused while the root is our unreaped child. Without the audit-token call (macOS < 14.2) nothing
        else is signalled and the run cannot be "confirmed".
      * Verification classifies every live process (mac_classify) on two censuses: a same-coalition process with no
        lineage either way ("candidate"), or any identity error, makes the run "uncertain"; it is never signalled."""
    containment = "reduced"

    def __init__(self):
        assert ctypes.sizeof(_ShortInfo) == 64 and ctypes.sizeof(_UniqInfo) == 56 and ctypes.sizeof(_CoalInfo) == 40
        self.lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listallpids.restype = ctypes.c_int
        self.sig_tok = getattr(self.lib, "proc_signal_with_audittoken", None)
        if self.sig_tok is not None:
            self.sig_tok.argtypes = [ctypes.c_void_p, ctypes.c_int]
            self.sig_tok.restype = ctypes.c_int
        if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
            raise ToolError("os.waitid with WNOWAIT is required on macOS")
        self.identity_mode = "libproc-uniqueid+audit-token" if self.sig_tok is not None else "libproc-uniqueid-no-token"
        self.warnings = ["macOS: work started through launchd (open, launchctl, XPC), setuid helpers and an escaper "
                         "whose ancestry was never seen are outside the ownership proof; such a run is never 'confirmed' "
                         "when an unexplained same-coalition process remains"]
        if self.sig_tok is None:
            self.warnings.append("proc_signal_with_audittoken unavailable (macOS < 14.2): only the root and its process "
                                 "group can be signalled safely; the run cannot be 'confirmed'")
        self.uncertain_reasons = []
        self.certification_basis = ("macos: N2' - root coalition + uniqueid lineage (pinned-root session, parent link "
                                    "checked against orig_ppidversion, provenance-backed original parent) + audit-token "
                                    "signals; unexplained same-coalition processes or identity errors -> uncertain")
        self.known = {}       # LIVE owned processes: pid -> {"uniqueid", "idversion", "ppid", "pgid"} (signals, survivors)
        self.ever = set()     # every uniqueid ever admitted, never pruned: original-parent evidence outlives the parent
        self.prov = {}        # uniqueid -> uniqueid of the known process that admitted it (root: None)
        self.idvs = {}        # uniqueid -> every idversion seen (exec bumps it)
        self.lock = threading.Lock()
        self.root = None
        self.root_id = None   # {"uniqueid", "idversion", "uid", "ruid", "coal"} read before the root may run
        self.root_status = None
        self.root_exited_flag = False
        self.pinned = False   # True while the root exists unreaped (alive or zombie) and only this tool can reap it
        self.escaped_seen = []
        self.uid = os.getuid()

    # identity ------------------------------------------------------------------------------------------------------
    def _pidinfo(self, pid, flavor, st):
        ctypes.set_errno(0)
        n = self.lib.proc_pidinfo(pid, flavor, 0, ctypes.byref(st), ctypes.sizeof(st))
        if n == ctypes.sizeof(st):
            return st
        err = ctypes.get_errno()
        if err == errno.ESRCH or (n == 0 and err == 0):
            return None  # gone (with arg 0 a zombie is reported as ESRCH too)
        raise _QueryError(err or errno.EIO, f"proc_pidinfo({pid}, {flavor}) returned {n}")

    def _q(self, pid, floor=None):
        """Identity of a live process: dict, or None if gone/zombie. Raises _QueryError if it cannot be read. The
        uniqueid is read before and after the other fields: a mismatch means the pid changed hands in between.
        With floor, a process older than floor (uniqueid < floor: started before the root, so never ours) is only
        returned as {"pid", "uniqueid", "older": True} after one call (discovery scans stay cheap)."""
        u1 = self._pidinfo(pid, _PROC_PIDUNIQIDENTIFIERINFO, _UniqInfo())
        if u1 is None: return None
        if floor is not None and int(u1.p_uniqueid) < floor:
            return {"pid": pid, "uniqueid": int(u1.p_uniqueid), "older": True}
        s = self._pidinfo(pid, _PROC_PIDT_SHORTBSDINFO, _ShortInfo())
        if s is None: return None
        try: sid = os.getsid(pid)
        except ProcessLookupError: return None
        except OSError: sid = None
        u2 = self._pidinfo(pid, _PROC_PIDUNIQIDENTIFIERINFO, _UniqInfo())
        if u2 is None: return None
        if u1.p_uniqueid != u2.p_uniqueid or int(s.pbsi_pid) != pid:
            raise _QueryError(errno.EAGAIN, f"identity of {pid} changed during the query")
        if int(s.pbsi_status) == _SZOMB: return None
        return {"pid": pid, "ppid": int(s.pbsi_ppid), "pgid": int(s.pbsi_pgid), "sid": sid, "uid": int(s.pbsi_uid),
                "ruid": int(s.pbsi_ruid), "comm": s.pbsi_comm.decode("ascii", "replace")[:16],
                "uniqueid": int(u2.p_uniqueid), "idversion": int(u2.p_idversion), "orig_ppidversion": int(u2.p_orig_ppidversion)}

    def coal(self, pid):
        c = self._pidinfo(pid, _PROC_PIDCOALITIONINFO, _CoalInfo())
        return None if c is None else [int(c.coalition_id[0]), int(c.coalition_id[1])]

    def info(self, pid):
        """Compatibility helper (tests): the identity dict of a live process or None; read errors give None."""
        try: return self._q(pid)
        except OSError: return None

    def _all(self):
        n = self.lib.proc_listallpids(None, 0)
        if n <= 0:
            raise _QueryError(ctypes.get_errno() or errno.EIO, "proc_listallpids failed")
        buf = (ctypes.c_int * (n + 256))()
        n = self.lib.proc_listallpids(buf, ctypes.sizeof(buf))
        if n <= 0:
            raise _QueryError(ctypes.get_errno() or errno.EIO, "proc_listallpids failed")
        return [buf[i] for i in range(n) if buf[i] > 0]

    # spawn ---------------------------------------------------------------------------------------------------------
    def spawn(self, cmd, cwd, env):
        _ensure_sigchld_default()
        r_err, w_err = os.pipe()  # exec failure is reported through this pipe (exit 127); close-on-exec by default
        r_go, w_go = os.pipe()    # the root waits here until its identity has been read
        pid = os.fork()
        if pid == 0:
            try:
                os.close(r_err); os.close(w_go)
                for sn in ("SIGPIPE", "SIGXFSZ"):
                    if hasattr(signal, sn): signal.signal(getattr(signal, sn), signal.SIG_DFL)
                os.setsid()
                if os.read(r_go, 1) != b"g":  # the tool went away before releasing us: do not run unowned
                    os._exit(EXIT_NOEXEC)
                os.close(r_go)
                if cwd: os.chdir(cwd)
                os.execvpe(cmd[0], cmd, env)
            except BaseException as e:  # noqa: BLE001
                try: os.write(w_err, f"{type(e).__name__}: {e}".encode()[:500])
                finally: os._exit(EXIT_NOEXEC)
        os.close(w_err); os.close(r_go)
        self.root = pid
        self.pinned = True  # our child, not reaped by anyone but close()
        try:
            q, c = self._q(pid), self.coal(pid)
            if q is None or c is None:
                raise _QueryError(errno.ESRCH, "the root vanished before it was released")
            self.root_id = {"uniqueid": q["uniqueid"], "idversion": q["idversion"], "uid": q["uid"], "ruid": q["ruid"], "coal": c}
            if c[0] == 0:
                self._reason("coalition_zero", "the root's coalition id is 0: ownership cannot be proven", pid=pid)
            with self.lock:
                self.known[pid] = {"uniqueid": q["uniqueid"], "idversion": q["idversion"], "ppid": q["ppid"], "pgid": q["pgid"]}
                self.ever.add(q["uniqueid"])
                self.prov[q["uniqueid"]] = None
                self.idvs[q["uniqueid"]] = {q["idversion"]}
        except OSError as e:  # never run the command unowned: the root is not released (it exits 127 at once)
            self._reason("root_identity", f"the root's identity could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
            os.close(w_go); os.close(r_err)
            raise ToolError(f"the command was not released: its identity could not be read ({type(e).__name__})")
        os.write(w_go, b"g"); os.close(w_go)
        err = b""
        while True:
            chunk = os.read(r_err, 4096)
            if not chunk: break
            err += chunk
        os.close(r_err)
        if err:
            raise ToolError(f"could not start the command: {err.decode(errors='replace')}")
        return pid

    # discovery -----------------------------------------------------------------------------------------------------
    def _census(self, record_errors=True, floor=None):
        """{pid: identity} of every live process readable now. Unreadable ones are recorded (never assumed gone)."""
        procs = {}
        for pid in self._all():
            try:
                q = self._q(pid, floor)
            except OSError as e:
                if record_errors:
                    self._reason("query_error", f"a process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
                continue
            if q is not None:
                procs[pid] = q
        return procs

    def _coal_into(self, q):
        if "coal" in q or "coal_err" in q:
            return
        try:
            q["coal"] = self.coal(q["pid"])
        except OSError as e:
            q["coal"], q["coal_err"] = None, e.errno

    def scan(self):
        if self.root_id is None:
            return
        me, ru = os.getpid(), self.root_id["uniqueid"]
        procs = self._census(floor=ru)
        for q in procs.values():  # every identity version a known process shows (exec bumps it)
            if not q.get("older") and q["uniqueid"] in self.idvs:
                self.idvs[q["uniqueid"]].add(q["idversion"])
        changed = True
        while changed:
            changed = False
            known_u = {k["uniqueid"]: p for p, k in self.known.items()}
            by_idv = {v: u for u, vs in self.idvs.items()
                      if u in self.ever and _mac_explained(u, ru, self.prov) for v in vs}  # includes exited parents
            for pid, q in procs.items():
                if pid == me or q.get("older") or q["uniqueid"] in known_u or q["uniqueid"] < ru:
                    continue
                par = procs.get(q["ppid"])
                via = None
                if self.pinned and q["sid"] == self.root:  # session of the pinned root: positive (cannot be joined)
                    via = ("session", ru)
                elif par is not None and not par.get("older") and par["uniqueid"] in known_u and _mac_link_ok(q, par["uniqueid"], par["idversion"], self.idvs):
                    via = ("parent", par["uniqueid"])
                elif by_idv.get(q["orig_ppidversion"]) is not None and q["idversion"] > q["orig_ppidversion"]:
                    via = ("original parent", by_idv[q["orig_ppidversion"]])
                if via is None:
                    continue
                self._coal_into(q)
                if q.get("coal") is None:
                    if q.get("coal_err") is not None:
                        self._reason("query_error", "a lineage-linked process's coalition could not be read", pid=pid, errno=q["coal_err"])
                    continue
                if q["coal"][0] != self.root_id["coal"][0]:
                    if via[0] != "session":  # coalition is required for parent / original-parent admission
                        self._reason("coalition_mismatch", "a lineage-linked process is in another coalition (not admitted)", pid=pid)
                        continue
                    self._reason("coalition_mismatch", "a member of the root's session is in another coalition", pid=pid)
                with self.lock:
                    self.known[pid] = {"uniqueid": q["uniqueid"], "idversion": q["idversion"], "ppid": q["ppid"], "pgid": q["pgid"]}
                    self.ever.add(q["uniqueid"])
                    self.prov[q["uniqueid"]] = via[1]
                    self.idvs.setdefault(q["uniqueid"], set()).add(q["idversion"])
                if via[0] != "session":
                    self.escaped_seen.append(pid)
                changed = True

    def reap(self):
        """Never reaps the root before cleanup ends: its exit is only observed (WNOWAIT), so it stays pinned."""
        if self.root is None or self.root_exited_flag: return
        try:
            r = os.waitid(os.P_PID, self.root, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            self._reason("root_unpinned", "the root was reaped elsewhere: its ids are no longer pinned", pid=self.root)
            self.root_exited_flag = True; self.pinned = False; return
        if r is not None and r.si_pid == self.root:
            self.root_exited_flag = True

    def alive(self):
        out = []
        for pid, k in list(self.known.items()):
            try:
                q = self._q(pid)
            except OSError as e:  # cannot verify that a known process is gone: it stays a survivor
                self._reason("query_error", f"a known process could not be read: {type(e).__name__}", pid=pid, errno=e.errno)
                out.append(pid)
                continue
            if q is None or q["uniqueid"] != k["uniqueid"]:
                with self.lock: self.known.pop(pid, None)  # gone, a zombie, or the pid now belongs to another process
            else:
                k.update(idversion=q["idversion"], ppid=q["ppid"], pgid=q["pgid"])
                self.idvs.setdefault(k["uniqueid"], set()).add(q["idversion"])
                out.append(pid)
        return out

    # signals -------------------------------------------------------------------------------------------------------
    def token_signal(self, pid, idversion, sig):
        """proc_signal_with_audittoken with a token naming (pid, identity version): 0 or an errno (ESRCH if the pid
        no longer holds that exact process image). Returns None if the call does not exist on this system."""
        if self.sig_tok is None:
            return None
        tok = (ctypes.c_uint32 * 8)()
        tok[5], tok[7] = pid, idversion & 0xFFFFFFFF
        return int(self.sig_tok(ctypes.byref(tok), sig))

    def _deliver(self, pid, k, sig):
        """The only place a signal is sent to one process (fault injection point for the tests)."""
        if pid == self.root and self.pinned and not self.root_exited_flag:
            os.kill(pid, sig)  # our own unreaped child: its pid cannot be reused (only close() reaps it)
            return
        r = self.token_signal(pid, k["idversion"], sig)
        if r is None:
            raise _UnsafeTarget(pid)
        if r != 0:
            raise OSError(r, os.strerror(r))  # ESRCH -> ProcessLookupError, EPERM -> PermissionError

    def signal(self, pid, sig):
        k = self.known.get(pid)
        if not k: return False
        delivered = False
        for _ in range(2):  # a second try only if the process exec'd in between (same uniqueid, new idversion)
            try:
                q = self._q(pid)
            except OSError as e:
                self._reason("query_error", f"a known process could not be read before a signal: {type(e).__name__}", pid=pid, errno=e.errno)
                break
            if q is None or q["uniqueid"] != k["uniqueid"]:
                break
            self.idvs.setdefault(k["uniqueid"], set()).add(q["idversion"])
            try:
                self._deliver(pid, dict(k, idversion=q["idversion"]), sig)
                delivered = True
                break
            except _UnsafeTarget:
                self._reason("signal_unsafe", "no identity-bound signal call on this system: a known process was not "
                             "signalled", pid=pid, sig=_signame(sig))
                break
            except ProcessLookupError:
                continue  # exited, or exec'd since the read: re-read once
            except PermissionError as e:
                self._reason("signal_denied", f"a signal to a known process was denied (EPERM): {_signame(sig)}", pid=pid, sig=_signame(sig), errno=e.errno)
                break
            except OSError as e:
                self._reason("signal_error", f"a signal to a known process failed: {type(e).__name__}", pid=pid, sig=_signame(sig), errno=e.errno)
                break
        if self.root_exited_flag and self.pinned and sig in (signal.SIGTERM, signal.SIGKILL):
            try: os.killpg(self.root, sig)  # the root's group: reserved while the root is our unreaped zombie
            except ProcessLookupError: pass
            except OSError as e:  # never silent: a member of our group may not have been signalled
                self._reason("group_signal_denied", f"a signal to the root's process group failed: {type(e).__name__}", pgid=self.root, sig=_signame(sig), errno=e.errno)
        return delivered

    # verification --------------------------------------------------------------------------------------------------
    def verify(self):
        """Two censuses; every live process is classified (mac_classify). Candidates and errors make the run
        "uncertain" and are reported, never signalled; an unadmitted process with positive lineage is a survivor
        nobody stopped and also forbids "confirmed"."""
        if self.root_id is None:
            self._reason("root_identity", "the root's identity was never read: ownership cannot be verified"); return []
        if self.sig_tok is None:
            self._reason("token_unavailable", "proc_signal_with_audittoken is unavailable: descendants could not be "
                         "signalled safely, so this run is not certified")
        me, found = os.getpid(), {}
        for i in range(2):
            if i: time.sleep(0.1)
            try:
                procs = self._census()
            except OSError as e:
                self._reason("scan_error", f"the process list could not be read: {type(e).__name__}", errno=e.errno); return []
            known_u = {k["uniqueid"] for k in self.known.values()}
            for pid, q in procs.items():
                if q["uniqueid"] in known_u or pid == me:
                    continue
                if q["uniqueid"] >= self.root_id["uniqueid"] and (q["uid"] == self.uid or q["ruid"] == self.uid):
                    self._coal_into(q)
                cls, why = mac_classify(q, procs, self.root_id, self.ever, self.prov, self.idvs, me, self.uid)
                if cls in ("candidate", "error", "unadmitted"):
                    found[(pid, q["uniqueid"])] = {"pid": pid, "comm": q["comm"], "ppid": q["ppid"], "class": cls, "why": why,
                                                   "coal": q.get("coal")}
        for d in sorted(found.values(), key=lambda d: d["pid"])[:20]:
            code = {"candidate": "lineage_candidate", "error": "identity_error", "unadmitted": "unadmitted_owned"}[d["class"]]
            self._reason(code, f"not provable either way, reported and never signalled: {d['class']} ({d['why']})", **d)
        return sorted({d["pid"] for d in found.values()})

    # results -------------------------------------------------------------------------------------------------------
    def root_exited(self):
        return self.root_exited_flag

    def root_result(self):
        s = self.root_status
        if s is None: return None, None
        if os.WIFSIGNALED(s): return None, os.WTERMSIG(s)
        return os.WEXITSTATUS(s), None

    def describe(self, pid):
        k = self.known.get(pid, {})
        return {"pid": pid, "uniqueid": k.get("uniqueid"), "idversion": k.get("idversion"), "ppid": k.get("ppid"), "pgid": k.get("pgid")}

    def close(self):
        """Reap the root last (after verification)."""
        if self.root is None or self.root_status is not None:
            return
        end = time.monotonic() + 5
        while True:
            try:
                pid, status = os.waitpid(self.root, os.WNOHANG)
            except ChildProcessError:
                self._reason("root_unpinned", "the root was reaped elsewhere", pid=self.root); break
            if pid == self.root:
                self.root_status = status; break
            if time.monotonic() > end:
                self._reason("root_unreaped", "the root could not be reaped", pid=self.root); break
            time.sleep(POLL)
        self.pinned = False


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
