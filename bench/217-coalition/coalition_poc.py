#!/usr/bin/env python3
"""XNU coalition attribution proof of concept for #217 (bench branch only; never merged, never a PR).

Question: can an unprivileged tool tell "processes this run started" from unrelated same-user processes on macOS
(launchd services such as mdworker_shared) using the XNU resource-coalition id plus the immutable per-process ids
(p_uniqueid, p_idversion, p_orig_ppidversion)?  Round 28 showed the lineage-only rule flags launchd services as
"uncertain" on every hosted macOS run.

Safety rules this script enforces by construction:
  * It only ever signals processes that one of ITS OWN fixtures reported (pid + uniqueid + idversion, self-reported
    from inside the process), and only after re-reading those ids immediately before the signal.
  * It never signals anything found only by scanning (candidates are reported, never signalled).
  * Every fixture has a hard lifetime cap (<= 90 s), so nothing outlives the job even if this script crashes.
  * Uses unprivileged APIs only. It also probes whether coalition_create is refused (expected EPERM); if the
    probe unexpectedly succeeds, the new empty coalition is terminated and reaped at once.
  * Exit 0: all safety checks held (control outcomes are reported, matched or not; see CONTROL lines).
    Exit 1: a control outcome differed from its expectation.  Exit 3: a safety check failed (own fixture leaked,
    or an UNCERTAIN state would have been reported as CONFIRMED).

Usage: python3 coalition_poc.py            (driver; macOS for real data, Linux = plumbing simulation only)
"""
import ctypes
import ctypes.util
import errno as E
import json
import os
import random
import signal
import subprocess
import sys
import threading
import time
import zlib

DARWIN = sys.platform == "darwin"
REPORT_FD_ENV = "COALPOC_REPORT_FD"
LIFETIME = 90.0
ME = os.path.abspath(__file__)

# ----------------------------------------------------------------------------------------------- backends
PROC_PIDT_SHORTBSDINFO = 13      # no same-user check (proc_info.c)
PROC_PIDUNIQIDENTIFIERINFO = 17  # no same-user check
PROC_PIDT_BSDINFOWITHUNIQID = 18  # CHECK_SAME_USER -> EPERM for foreign uids: NOT used for scanning (Agent E #1)
PROC_PIDCOALITIONINFO = 20       # no same-user check
SZOMB = 5


class BsdInfo(ctypes.Structure):
    _fields_ = [("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32), ("pbi_xstatus", ctypes.c_uint32),
                ("pbi_pid", ctypes.c_uint32), ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
                ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32), ("pbi_rgid", ctypes.c_uint32),
                ("pbi_svuid", ctypes.c_uint32), ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32), ("pbi_nfiles", ctypes.c_uint32),
                ("pbi_pgid", ctypes.c_uint32), ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32), ("pbi_start_tvsec", ctypes.c_uint64),
                ("pbi_start_tvusec", ctypes.c_uint64)]


class ShortInfo(ctypes.Structure):
    _fields_ = [("pbsi_pid", ctypes.c_uint32), ("pbsi_ppid", ctypes.c_uint32), ("pbsi_pgid", ctypes.c_uint32),
                ("pbsi_status", ctypes.c_uint32), ("pbsi_comm", ctypes.c_char * 16), ("pbsi_flags", ctypes.c_uint32),
                ("pbsi_uid", ctypes.c_uint32), ("pbsi_gid", ctypes.c_uint32), ("pbsi_ruid", ctypes.c_uint32),
                ("pbsi_rgid", ctypes.c_uint32), ("pbsi_svuid", ctypes.c_uint32), ("pbsi_svgid", ctypes.c_uint32),
                ("pbsi_rfu", ctypes.c_uint32)]


class UniqInfo(ctypes.Structure):
    _fields_ = [("p_uuid", ctypes.c_uint8 * 16), ("p_uniqueid", ctypes.c_uint64), ("p_puniqueid", ctypes.c_uint64),
                ("p_idversion", ctypes.c_int32), ("p_orig_ppidversion", ctypes.c_int32),
                ("p_reserve2", ctypes.c_uint64), ("p_reserve3", ctypes.c_uint64)]


class BsdWithUniq(ctypes.Structure):
    _fields_ = [("pbsd", BsdInfo), ("p_uniqidentifier", UniqInfo)]


class CoalInfo(ctypes.Structure):
    _fields_ = [("coalition_id", ctypes.c_uint64 * 2), ("reserved1", ctypes.c_uint64),
                ("reserved2", ctypes.c_uint64), ("reserved3", ctypes.c_uint64)]


class QueryError(Exception):
    def __init__(self, what, err):
        super().__init__(f"{what}: {E.errorcode.get(err, err)}")
        self.what, self.err = what, err


class DarwinBackend:
    name = "darwin-libproc"

    def __init__(self):
        assert ctypes.sizeof(BsdInfo) == 136 and ctypes.sizeof(UniqInfo) == 56
        assert ctypes.sizeof(BsdWithUniq) == 192 and ctypes.sizeof(CoalInfo) == 40 and ctypes.sizeof(ShortInfo) == 64
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listallpids.restype = ctypes.c_int
        self.sig_tok = getattr(self.lib, "proc_signal_with_audittoken", None)
        if self.sig_tok is not None:
            self.sig_tok.argtypes = [ctypes.c_void_p, ctypes.c_int]
            self.sig_tok.restype = ctypes.c_int

    def pids(self):
        n = self.lib.proc_listallpids(None, 0)
        if n <= 0:
            raise QueryError("proc_listallpids(count)", ctypes.get_errno())
        buf = (ctypes.c_int * (n + 256))()
        got = self.lib.proc_listallpids(buf, ctypes.sizeof(buf))
        if got <= 0:
            raise QueryError("proc_listallpids", ctypes.get_errno())
        return [buf[i] for i in range(got) if buf[i] > 0]

    def _pidinfo(self, pid, flavor, st, what):
        ctypes.set_errno(0)
        r = self.lib.proc_pidinfo(pid, flavor, 0, ctypes.byref(st), ctypes.sizeof(st))
        if r != ctypes.sizeof(st):
            err = ctypes.get_errno() or (-1 if r > 0 else 0)
            raise QueryError(f"{what} r={r}", err)
        return st

    def coal(self, pid):
        c = self._pidinfo(pid, PROC_PIDCOALITIONINFO, CoalInfo(), "COALITIONINFO")
        return [int(c.coalition_id[0]), int(c.coalition_id[1])]

    def info(self, pid):
        """Flavors 17 + 13 + 17 (both readable for any uid). The uniqueid is read before and after the short info;
        a mismatch means the pid was reused in between -> EAGAIN (counted as a hard error -> UNCERTAIN)."""
        u1 = self._pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, UniqInfo(), "UNIQIDENTIFIERINFO")
        p = self._pidinfo(pid, PROC_PIDT_SHORTBSDINFO, ShortInfo(), "SHORTBSDINFO")
        u = self._pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, UniqInfo(), "UNIQIDENTIFIERINFO")
        if u1.p_uniqueid != u.p_uniqueid or int(p.pbsi_pid) != pid:
            raise QueryError("identity changed during query", E.EAGAIN)
        try:
            sid = os.getsid(pid)
        except OSError as ex:
            sid = -ex.errno
        return {"pid": int(p.pbsi_pid), "ppid": int(p.pbsi_ppid), "pgid": int(p.pbsi_pgid), "sid": sid,
                "uid": int(p.pbsi_uid), "ruid": int(p.pbsi_ruid), "status": int(p.pbsi_status),
                "comm": p.pbsi_comm.decode("utf-8", "replace"), "start": 0,
                "uniqueid": int(u.p_uniqueid), "puniqueid": int(u.p_puniqueid), "idversion": int(u.p_idversion),
                "orig_ppidversion": int(u.p_orig_ppidversion)}

    def signal_by_token(self, pid, idversion, sig):
        if self.sig_tok is None:
            return "absent"
        tok = (ctypes.c_uint32 * 8)()
        tok[5], tok[7] = pid, idversion & 0xFFFFFFFF
        return int(self.sig_tok(ctypes.byref(tok), sig))

    def coalition_create_probe(self):
        libc = ctypes.CDLL(None, use_errno=True)
        fn = getattr(libc, "coalition_create", None)
        if fn is None:
            return {"available": False}
        fn.argtypes = [ctypes.POINTER(ctypes.c_uint64), ctypes.c_uint32]
        fn.restype = ctypes.c_int
        cid = ctypes.c_uint64(0)
        ctypes.set_errno(0)
        r = fn(ctypes.byref(cid), 0)  # flags 0 = resource coalition, non-privileged role
        out = {"available": True, "ret": r, "errno": E.errorcode.get(ctypes.get_errno(), ctypes.get_errno())}
        if r == 0:  # unexpected: clean up the empty coalition at once
            out["created_cid"] = int(cid.value)
            for name in ("coalition_terminate", "coalition_reap"):
                f = getattr(libc, name, None)
                if f is not None:
                    f.argtypes = [ctypes.c_uint64, ctypes.c_uint32]
                    out[name] = int(f(cid.value, 0))
        return out


class LinuxSimBackend:
    """Plumbing simulation only: coalition := hash of /proc/<pid>/cgroup; idversion := starttime ticks.
    It exercises fixtures, reporting, verification and cleanup locally. It says NOTHING about XNU."""
    name = "linux-sim"

    def pids(self):
        return [int(d) for d in os.listdir("/proc") if d.isdigit()]

    def _stat(self, pid):
        try:
            with open(f"/proc/{pid}/stat") as f:
                s = f.read()
        except OSError as ex:
            raise QueryError("stat", ex.errno or E.ESRCH)
        comm = s[s.index("(") + 1:s.rindex(")")]
        f = s[s.rindex(")") + 2:].split()
        return comm, f

    def coal(self, pid):
        try:
            with open(f"/proc/{pid}/cgroup") as fh:
                return [zlib.crc32(fh.read().encode()), 0]
        except OSError as ex:
            raise QueryError("cgroup", ex.errno or E.ESRCH)

    def info(self, pid):
        comm, f = self._stat(pid)
        try:
            st = os.stat(f"/proc/{pid}")
            sid = os.getsid(pid)
        except OSError as ex:
            raise QueryError("stat2", ex.errno or E.ESRCH)
        start = int(f[19])
        return {"pid": pid, "ppid": int(f[1]), "pgid": int(f[2]), "sid": sid, "uid": st.st_uid, "ruid": st.st_uid,
                "status": SZOMB if f[0] == "Z" else 2, "comm": comm[:15], "start": start,
                "uniqueid": start * 4194304 + pid, "puniqueid": 0, "idversion": start * 4194304 + pid,
                "orig_ppidversion": 0}

    def signal_by_token(self, pid, idversion, sig):
        return "absent"

    def coalition_create_probe(self):
        return {"available": False, "note": "linux-sim"}


B = DarwinBackend() if DARWIN else LinuxSimBackend()


def safe(fn, *a):
    try:
        return fn(*a), None
    except QueryError as ex:
        return None, {"what": ex.what, "errno": E.errorcode.get(ex.err, ex.err)}


def selfinfo(**extra):
    d, err = safe(B.info, os.getpid())
    c, cerr = safe(B.coal, os.getpid())
    d = d or {"pid": os.getpid()}
    d.update(coal=c, err=err or cerr, t=time.monotonic(), **extra)
    return d


# ----------------------------------------------------------------------------------------------- fixtures
def report(rec):
    fd = int(os.environ[REPORT_FD_ENV])
    os.write(fd, (json.dumps(rec, separators=(",", ":")) + "\n").encode())


def wait_reparented(limit=2.0, orig=None):
    """True once the original parent is gone (macOS: ppid becomes 1; Linux may use a subreaper instead)."""
    orig = orig if orig is not None else os.getppid()
    t = time.monotonic() + limit
    while os.getppid() == orig and orig != 1 and time.monotonic() < t:
        time.sleep(0.002)
    return os.getppid() != orig or orig == 1


def spawn_fixture(role, label, **kw):
    fd = int(os.environ[REPORT_FD_ENV])
    return subprocess.Popen([sys.executable, ME, "fixture", role, label], pass_fds=(fd,), stdin=subprocess.DEVNULL,
                            **kw)


def fixture(role, label):
    deadline = time.monotonic() + LIFETIME
    if role == "sleeper":  # generic long-lived owned process
        report(selfinfo(role=role, label=label, phase="start"))
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    if role == "orphan":  # waits until reparented to launchd, then re-reports its own ids
        orig = os.getppid()
        report(selfinfo(role=role, label=label, phase="start"))
        ok = wait_reparented(2.0, orig)
        report(selfinfo(role=role, label=label, phase="after_reparent", reparented=ok))
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    if role == "orphaner":  # intermediate: start an orphan (optionally in a new session), then exit at once
        report(selfinfo(role=role, label=label, phase="start"))
        spawn_fixture("orphan", label, start_new_session=label.endswith("setsid"))
        os._exit(0)
    if role == "parent_of":  # stays alive above a grandchild
        report(selfinfo(role=role, label=label, phase="start"))
        spawn_fixture("sleeper", label + ".gc")
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    if role == "execer":  # reports, then becomes /bin/sleep (coalition/ids across exec)
        report(selfinfo(role=role, label=label, phase="pre_exec"))
        os.execv("/bin/sleep", ["sleep", str(int(LIFETIME))])
    if role == "pspawner":  # posix_spawn path
        report(selfinfo(role=role, label=label, phase="start"))
        pid = os.posix_spawn("/bin/sleep", ["sleep", str(int(LIFETIME))], dict(os.environ))
        report({"role": "pspawned", "label": label + ".child", "pid": pid, "phase": "spawned_by_parent",
                "t": time.monotonic()})
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    if role == "churner":  # fast spawn / reparent / exit
        report(selfinfo(role=role, label=label, phase="start"))
        n = 150
        for i in range(n):
            c = os.fork()
            if c == 0:
                g = os.fork()
                if g == 0:
                    orig = os.getppid()
                    before = selfinfo(role="churn", label=f"churn{i}", phase="start")
                    ok = wait_reparented(0.5, orig)
                    after = selfinfo(role="churn", label=f"churn{i}", phase="after_reparent", reparented=ok)
                    report({"role": "churn", "label": f"churn{i}", "pid": os.getpid(), "phase": "pair",
                            "before": before, "after": after})
                    time.sleep(random.uniform(0, 0.03))
                    os._exit(0)
                os._exit(0)
            os.waitpid(c, 0)
            time.sleep(random.uniform(0, 0.01))
        report({"role": role, "label": label, "pid": os.getpid(), "phase": "done", "n": n, "t": time.monotonic()})
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    if role == "root":
        report(selfinfo(role=role, label=label, phase="start"))
        spawn_fixture("sleeper", "direct")
        spawn_fixture("parent_of", "gparent")
        if sys.version_info >= (3, 11):
            spawn_fixture("sleeper", "same_session_newpgrp", process_group=0)
        else:
            report({"role": "skipped", "label": "same_session_newpgrp", "why": "python<3.11"})
        spawn_fixture("sleeper", "setsid_seen", start_new_session=True)
        spawn_fixture("orphaner", "orphan_same_session")
        spawn_fixture("orphaner", "orphan_setsid")
        spawn_fixture("execer", "exec")
        spawn_fixture("pspawner", "pspawn")
        spawn_fixture("sleeper", "token_target")
        spawn_fixture("sleeper", "stale_target")
        spawn_fixture("churner", "churn")
        if DARWIN:  # launchd-mediated work started on our behalf (expected: a different coalition; out of scope)
            lab = f"com.usap.coalpoc.{os.getpid()}"
            r = subprocess.run(["launchctl", "submit", "-l", lab, "--", "/bin/sleep", str(int(LIFETIME))],
                               capture_output=True, text=True, timeout=20)
            report({"role": "launchd_job", "label": lab, "rc": r.returncode, "err": r.stderr[-300:],
                    "phase": "submitted", "t": time.monotonic()})
        while time.monotonic() < deadline:
            time.sleep(0.5)
        return
    raise SystemExit(f"unknown role {role}")


# ----------------------------------------------------------------------------------------------- driver
class Reports:
    def __init__(self, rfd):
        self.recs, self.lock = [], threading.Lock()
        threading.Thread(target=self._read, args=(rfd,), daemon=True).start()

    def _read(self, rfd):
        buf = b""
        while True:
            chunk = os.read(rfd, 65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    rec = json.loads(line)
                except ValueError:
                    rec = {"bad_line": line[:200].decode("utf-8", "replace")}
                with self.lock:
                    self.recs.append(rec)

    def snapshot(self):
        with self.lock:
            return list(self.recs)

    def wait_for(self, pred, timeout):
        t = time.monotonic() + timeout
        while time.monotonic() < t:
            if pred(self.snapshot()):
                return True
            time.sleep(0.05)
        return False


def census():
    """One full scan. Returns ({pid: rec}, [errors]). Each rec has info + coal (or an error)."""
    procs, errs = {}, []
    for pid in B.pids():
        d, err = safe(B.info, pid)
        c, cerr = safe(B.coal, pid)
        if d is None:
            errs.append({"pid": pid, **err})
            continue
        d["coal"], d["coal_err"] = c, cerr
        procs[pid] = d
    return procs, errs


class Tracker:
    """Certifier knowledge built ONLY from scans (never from fixture reports): processes seen with a known parent."""

    def __init__(self, root):
        self.root = root
        self.known_uniq = {root["uniqueid"]}
        self.known_idv = {root["idversion"]}
        self.scans = 0

    def update(self, procs):
        self.scans += 1
        changed = True
        while changed:
            changed = False
            for p in procs.values():
                if p["uniqueid"] in self.known_uniq:
                    continue
                par = procs.get(p["ppid"])
                if par is not None and par["uniqueid"] in self.known_uniq and p["idversion"] > self.root["idversion"]:
                    self.known_uniq.add(p["uniqueid"])
                    self.known_idv.add(p["idversion"])
                    changed = True


def post_root(p, root):
    """Started after the root: XNU idversion is a monotonic counter (Agent A); Linux sim uses start ticks."""
    return p["idversion"] >= root["idversion"] if DARWIN else p["start"] >= root["start"]


def classify(p, procs, root, tracker, mode, me, inject_fail=()):
    """-> 'owned' | 'candidate' | 'excluded' | 'error'.  mode: 'lineage' (round-28 rule) or 'coalition' (N2')."""
    if p["pid"] in (me, 0, 1):
        return "excluded"
    if p["pid"] in inject_fail:
        return "error"
    if p["uniqueid"] in tracker.known_uniq:  # known first: the root and seen descendants are owned (Agent E #2)
        return "owned"
    if p["uid"] != root["uid"] and p["ruid"] != root["uid"]:
        return "excluded"
    if not post_root(p, root):
        return "excluded"
    if mode == "coalition":
        if p["coal"] is None or p["coal_err"]:
            return "error"
        if p["coal"][0] == 0:
            return "error"
        if p["coal"][0] != root["coal"][0]:
            return "excluded"
        if DARWIN and p["orig_ppidversion"] in tracker.known_idv:
            return "owned"  # provably ours across reparenting (original parent was seen as ours)
    # chain to pid 1 only through post-root processes?  A pre-existing live ancestor => someone else's descendant.
    q, hops = p, 0
    while q["ppid"] not in (0, 1) and hops < 64:
        par = procs.get(q["ppid"])
        if par is None:
            return "error"
        if par["uniqueid"] in tracker.known_uniq:
            return "owned"
        if not post_root(par, root):
            return "excluded"
        q, hops = par, hops + 1
    return "candidate"


def certify(procs, errs, root, tracker, mode, me, inject_fail=()):
    cls = {pid: classify(p, procs, root, tracker, mode, me, inject_fail) for pid, p in procs.items()}
    owned = sorted(pid for pid, c in cls.items() if c == "owned" and procs[pid]["status"] != SZOMB)
    cand = sorted(pid for pid, c in cls.items() if c == "candidate" and procs[pid]["status"] != SZOMB)
    bad = sorted(pid for pid, c in cls.items() if c == "error")
    # discovery errors on pids that are gone are ESRCH races (harmless); any other error is uncertainty
    hard_errs = [e for e in errs if e["errno"] not in ("ESRCH",)]
    if owned:
        state = "SURVIVORS"
    elif cand or bad or hard_errs:
        state = "UNCERTAIN"
    else:
        state = "CONFIRMED"
    return {"state": state, "owned": owned, "candidates": cand, "errors": bad, "scan_errors": hard_errs[:10],
            "classes": cls}


def verify_and_signal(gt, sig, log):
    """Signal only a fixture-reported process whose (pid, uniqueid, idversion, uid) still match right now."""
    d, err = safe(B.info, gt["pid"])
    if d is None:
        log.append({"pid": gt["pid"], "label": gt.get("label"), "sig": sig, "result": "gone", "err": err})
        return "gone"
    if (d["uniqueid"], d["idversion"], d["uid"]) != (gt["uniqueid"], gt["idversion"], gt["uid"]):
        log.append({"pid": gt["pid"], "label": gt.get("label"), "sig": sig, "result": "identity-mismatch-refused"})
        return "refused"
    if d["status"] == SZOMB:
        log.append({"pid": gt["pid"], "label": gt.get("label"), "sig": sig, "result": "zombie"})
        return "zombie"
    try:
        os.kill(gt["pid"], sig)
        res = "sent"
    except ProcessLookupError:
        res = "gone"
    except PermissionError:
        res = "eperm"
    log.append({"pid": gt["pid"], "label": gt.get("label"), "sig": sig, "result": res})
    return res


def main():
    out = {"backend": B.name, "platform": sys.platform, "python": sys.version.split()[0], "uname": {k: getattr(os.uname(), k) for k in ("sysname", "release", "version", "machine")},
           "controls": [], "signals": []}
    controls = out["controls"]

    def control(name, expected, observed, note=""):
        ok = expected == observed if not callable(expected) else bool(expected(observed))
        controls.append({"name": name, "expected": expected if not callable(expected) else "predicate",
                         "observed": observed, "ok": ok, "note": note})
        print(f"CONTROL {'PASS' if ok else 'FAIL'} {name}: observed={observed!r} {note}", flush=True)

    state = {}
    rc = 2
    try:
        rc = run(out, control, state)
    except BaseException as ex:  # never lose the first-attempt evidence
        import traceback
        out["crash"] = traceback.format_exc()[-4000:]
        control("poc_completed_without_crash", True, False, repr(ex)[:300])
        rc = 2
    finally:
        emergency_cleanup(out, state)
        try:
            os.makedirs("coalpoc-out", exist_ok=True)
            with open("coalpoc-out/result.json", "w") as fh:
                json.dump(out, fh, indent=1, default=str)
        except OSError:
            pass
        print("RESULT_JSON_BEGIN")
        print(json.dumps(out, default=str))
        print("RESULT_JSON_END")
        print(f"SUMMARY backend={B.name} rc={rc} controls={sum(c['ok'] for c in controls)}/{len(controls)} "
              f"safety_ok={out.get('safety_ok')} leaked={out.get('leaked_fixtures')} "
              f"outside={out.get('signals_outside_ground_truth')} crash={'crash' in out}", flush=True)
    return rc


def emergency_cleanup(out, state):
    """After a crash (or as a final net): signal ONLY self-reported fixtures whose identity still matches, and
    remove ONLY our own launchd label. A no-op on the normal path (everything is already gone)."""
    reps = state.get("reps")
    recs = reps.snapshot() if reps else []
    log = out.setdefault("emergency_signals", [])
    for r in recs:
        if "uniqueid" in r and "pid" in r and r.get("pid") != os.getpid():
            d, _ = safe(B.info, r["pid"])
            if d and d["uniqueid"] == r["uniqueid"] and d["status"] != SZOMB:
                verify_and_signal(r, signal.SIGKILL, log)
    for r in recs:
        if r.get("role") == "launchd_job" and r.get("rc") == 0 and DARWIN:
            subprocess.run(["launchctl", "remove", r["label"]], capture_output=True, timeout=20)


def run(out, control, state):
    controls = out["controls"]
    me = os.getpid()
    # ---- probes: own chain, privileged targets, missing pid, coalition_create
    chain, pid = [], me
    for _ in range(40):
        d, err = safe(B.info, pid)
        c, cerr = safe(B.coal, pid)
        chain.append({"pid": pid, "comm": d and d["comm"], "uid": d and d["uid"], "coal": c, "err": err or cerr,
                      "idversion": d and d["idversion"]})
        if d is None or d["ppid"] in (0, pid):
            break
        pid = d["ppid"]
    out["ancestor_chain"] = chain
    print("ANCESTORS", json.dumps(chain), flush=True)
    for label, p in (("launchd_pid1", 1), ("kernel_pid0", 0)):
        c, cerr = safe(B.coal, p)
        out[f"probe_{label}"] = {"coal": c, "err": cerr}
    all_pids = set(B.pids())
    missing = next(p for p in range(99998, 100, -1) if p not in all_pids)
    c, cerr = safe(B.coal, missing)
    control("missing_identity_query_fails", True, c is None and cerr is not None, f"pid={missing} err={cerr}")
    out["coalition_create_probe"] = B.coalition_create_probe()
    print("COALITION_CREATE", json.dumps(out["coalition_create_probe"]), flush=True)

    # ---- baseline census
    base, base_errs = census()
    out["baseline"] = {"n": len(base), "errors": len(base_errs),
                       "error_kinds": sorted({e["errno"] for e in base_errs}, key=str)}
    out["baseline"]["foreign_uid_processes"] = sum(1 for p in base.values() if p["uid"] != os.getuid())
    out["baseline"]["coal_errors_by_uid_class"] = {
        "same_uid": sum(1 for p in base.values() if p["coal_err"] and p["uid"] == os.getuid()),
        "other_uid": sum(1 for p in base.values() if p["coal_err"] and p["uid"] != os.getuid())}

    # ---- start the owned tree
    rfd, wfd = os.pipe()
    os.set_inheritable(wfd, True)
    os.environ[REPORT_FD_ENV] = str(wfd)
    reps = state["reps"] = Reports(rfd)
    root_p = spawn_fixture("root", "root")
    reps.wait_for(lambda rs: any(r.get("role") == "root" for r in rs), 20)
    root = next(r for r in reps.snapshot() if r.get("role") == "root")
    tracker = Tracker(root)
    # unrelated-but-same-coalition controls started by the DRIVER (not under root), after root:
    sib_p = spawn_fixture("sleeper", "sibling")                      # live chain to the pre-existing driver
    sib_orph_p = spawn_fixture("orphaner", "sibling_orphan_setsid")  # same coalition, orphaned, not ours

    # concurrent scanner (certifier knowledge comes only from here)
    stop_scan = threading.Event()
    seen_churn = {}

    def scanner():
        while not stop_scan.is_set():
            procs, _ = census()
            tracker.update(procs)
            for p in procs.values():
                if post_root(p, root):
                    seen_churn.setdefault(p["uniqueid"], (p["pid"], p["coal"], tracker.scans))
            time.sleep(0.01)

    th = threading.Thread(target=scanner, daemon=True)
    th.start()
    need = {"direct", "gparent.gc", "same_session_newpgrp", "setsid_seen", "orphan_same_session", "orphan_setsid",
            "exec", "pspawn.child", "token_target", "stale_target", "sibling", "sibling_orphan_setsid"}
    got_all = reps.wait_for(lambda rs: need <= {r.get("label") for r in rs} and
                            any(r.get("role") == "churner" and r.get("phase") == "done" for r in rs) and
                            sum(1 for r in rs if r.get("role") == "orphan" and r.get("phase") == "after_reparent") >= 3,
                            60)
    time.sleep(1.0)
    stop_scan.set()
    th.join(5)
    control("all_fixtures_reported", True, got_all)
    recs = reps.snapshot()
    out["reports"] = [r for r in recs if r.get("role") != "churn"]

    # ---- ground truth: everything a fixture reported about itself (latest record wins), plus exec/pspawn/launchd
    gt = {}
    for r in recs:
        if r.get("role") in ("churn", "churner_done") or "uniqueid" not in r:
            continue
        if r.get("phase") in ("start", "after_reparent", "pre_exec"):
            gt[r["label"] + ("" if r["role"] != "orphaner" else ".mid")] = r
    for r in recs:  # posix_spawned child: accept only if its LIVE parent is still our identity-checked pspawner
        if r.get("role") == "pspawned":
            d, _ = safe(B.info, r["pid"])
            par = gt.get("pspawn")
            pd = par and safe(B.info, par["pid"])[0]
            if d and pd and d["ppid"] == par["pid"] and pd["uniqueid"] == par["uniqueid"]:
                d["label"] = r["label"]
                gt[r["label"]] = d
            else:
                out.setdefault("gt_rejected", []).append({"label": r["label"], "pid": r["pid"]})
    lj = next((r for r in recs if r.get("role") == "launchd_job"), None)
    launchd = {"submit": lj}
    if lj and lj.get("rc") == 0:
        time.sleep(1.0)
        q = subprocess.run(["launchctl", "list", lj["label"]], capture_output=True, text=True, timeout=20)
        lpid = None
        for line in q.stdout.splitlines():
            if '"PID"' in line:
                lpid = int(line.split("=")[1].strip(" ;"))
        launchd["pid"] = lpid
        if lpid:
            d, err = safe(B.info, lpid)
            c, cerr = safe(B.coal, lpid)
            launchd.update(info=d, coal=c, err=err or cerr)
    out["launchd_job"] = launchd

    # ---- facts: coalition across fork, setsid, reparent, exec, posix_spawn
    rc = root["coal"]
    facts = {}
    for lab, r in sorted(gt.items()):
        d, _ = safe(B.info, r["pid"])
        c, _ = safe(B.coal, r["pid"])
        facts[lab] = {"pid": r["pid"], "self_reported_coal": r.get("coal"), "live_coal": c,
                      "same_as_root": (c or r.get("coal")) == rc, "ppid_now": d and d["ppid"],
                      "sid_now": d and d["sid"], "orig_ppidversion": r.get("orig_ppidversion"),
                      "puniqueid": r.get("puniqueid"), "comm_now": d and d["comm"]}
    out["facts"] = facts
    orph = [r for r in recs if r.get("role") == "orphan" and r.get("phase") == "after_reparent"]
    mids = {r["label"]: r for r in recs if r.get("role") == "orphaner"}
    starts = {r["label"]: r for r in recs if r.get("role") == "orphan" and r.get("phase") == "start"}
    for r in orph:
        s, m = starts.get(r["label"]), mids.get(r["label"])
        facts[r["label"]].update(
            reparented=r.get("reparented"), coal_before=s and s.get("coal"), coal_after=r.get("coal"),
            puniqueid_before=s and s.get("puniqueid"), puniqueid_after=r.get("puniqueid"),
            mid_uniqueid=m and m.get("uniqueid"), mid_idversion=m and m.get("idversion"),
            orig_ppidversion_after=r.get("orig_ppidversion"))
    ours = ["direct", "gparent.gc", "same_session_newpgrp", "setsid_seen", "orphan_same_session", "orphan_setsid",
            "exec", "pspawn.child"]
    control("owned_tree_shares_root_coalition", True,
            all(facts.get(k, {}).get("same_as_root") for k in ours), "fork/setpgid/setsid/reparent/exec/spawn")
    control("coalition_unchanged_by_reparent", True,
            all(r.get("reparented") and starts.get(r["label"], {}).get("coal") == r.get("coal") for r in orph) and
            len(orph) >= 2)
    if DARWIN:
        control("orig_ppidversion_survives_reparent", True,
                all(mids.get(r["label"]) and r.get("orig_ppidversion") == mids[r["label"]].get("idversion")
                    for r in orph if r["label"] != "sibling_orphan_setsid") and len(orph) >= 2,
                "orphan.orig_ppidversion == intermediate.idversion")
        control("root_coalition_nonzero", True, bool(rc and rc[0] != 0), f"root coal={rc}")
        control("launchd_job_in_other_coalition", lambda v: v in (True, "not-run"),
                (launchd.get("coal") != rc) if launchd.get("coal") else "not-run",
                f"launchd job coal={launchd.get('coal')} (limitation: launchd-mediated work is out of scope)")
        cc = out["coalition_create_probe"]
        control("coalition_create_refused_unprivileged", lambda v: v in ("refused", "absent"),
                "absent" if not cc.get("available") else ("refused" if cc.get("ret") != 0 else "SUCCEEDED"))

    # churn: did any fast descendant change coalition across reparent?  how many did the scanner see?
    pairs = [r for r in recs if r.get("role") == "churn" and r.get("phase") == "pair"]
    changed = [p["label"] for p in pairs if p["before"].get("coal") != p["after"].get("coal")]
    seen_coal_mismatch = [v for v in seen_churn.values() if v[1] is not None and v[1] != rc]
    out["churn"] = {"spawned_reports": len(pairs), "coal_changed": changed[:10],
                    "reparented": sum(1 for p in pairs if p["after"].get("reparented")),
                    "scanner_scans": tracker.scans, "post_root_uniq_seen": len(seen_churn),
                    "post_root_seen_other_coalition": len(seen_coal_mismatch)}
    control("churn_no_coalition_change", 0, len(changed), f"pairs={len(pairs)}")

    # ---- certification BEFORE cleanup, both rules, same scan
    procs, errs = census()
    tracker.update(procs)
    gt_uniq = {r["uniqueid"] for r in gt.values()}
    sib_uniq = {gt[k]["uniqueid"] for k in ("sibling", "sibling_orphan_setsid", "sibling_orphan_setsid.mid")
                if k in gt}
    mode_cls = {}
    for mode in ("lineage", "coalition"):
        cert = certify(procs, errs, root, tracker, mode, me)
        cls = mode_cls[mode] = cert.pop("classes")
        fp = [{"pid": pid, "comm": procs[pid]["comm"], "ppid": procs[pid]["ppid"], "coal": procs[pid]["coal"]}
              for pid in cert["candidates"] if procs[pid]["uniqueid"] not in gt_uniq]
        lost = [lab for lab, r in gt.items() if r["uniqueid"] not in sib_uniq and r["pid"] in procs and
                procs[r["pid"]]["uniqueid"] == r["uniqueid"] and cls.get(r["pid"]) == "excluded" and
                procs[r["pid"]]["status"] != SZOMB]
        wrong = [lab for lab, r in gt.items() if r["uniqueid"] in sib_uniq and cls.get(r["pid"]) == "owned"]
        out[f"pre_cleanup_{mode}"] = {**cert, "foreign_candidates": fp, "attribution_lost": lost,
                                      "sibling_wrongly_owned": wrong}
        print(f"PRE {mode}", json.dumps(out[f"pre_cleanup_{mode}"])[:3000], flush=True)
        control(f"pre_cleanup_{mode}_sees_survivors", "SURVIVORS", cert["state"])
        control(f"pre_cleanup_{mode}_root_counted_owned", True, root["pid"] in cert["owned"])
        control(f"pre_cleanup_{mode}_no_attribution_loss", [], lost)
        control(f"pre_cleanup_{mode}_sibling_not_owned", [], wrong, "deliberately unrelated same-coalition process")
    lpid = launchd.get("pid")
    if DARWIN and lpid and lpid in procs:  # catches a certifier that drops the coalition check (mutant M5)
        control("launchd_job_lineage_candidate_coalition_excluded", ("candidate", "excluded"),
                (mode_cls["lineage"].get(lpid), mode_cls["coalition"].get(lpid)))
    control("coalition_rule_excludes_all_foreign_non_sibling", [],
            [f for f in out["pre_cleanup_coalition"]["foreign_candidates"]],
            "launchd services etc. must not be candidates under N2' (round-28 false positives)")

    # injected query failure on an owned pid -> must not become CONFIRMED
    missing_gt = [k for k in ("root", "direct", "token_target", "stale_target") if k not in gt]
    control("required_fixtures_in_ground_truth", [], missing_gt)
    if missing_gt:
        raise RuntimeError(f"required fixtures missing from ground truth: {missing_gt}")
    inj = certify(procs, errs, root, tracker, "coalition", me, inject_fail=(gt["direct"]["pid"],))
    control("injected_query_failure_not_confirmed", lambda s: s != "CONFIRMED", inj["state"])

    # ---- identity controls before signalling
    tt = gt["token_target"]
    wrong_tuple = dict(tt, uniqueid=tt["uniqueid"] + 1)
    control("wrong_identity_refused", "refused", verify_and_signal(wrong_tuple, 0, out["signals"]))
    st = gt["stale_target"]
    verify_and_signal(st, signal.SIGKILL, out["signals"])
    t0 = time.monotonic()
    while time.monotonic() - t0 < 5 and safe(B.info, st["pid"])[0] and \
            safe(B.info, st["pid"])[0]["status"] != SZOMB:
        time.sleep(0.05)
    time.sleep(0.3)
    control("stale_identity_not_signalled", lambda v: v in ("gone", "zombie", "refused"),
            verify_and_signal(st, signal.SIGTERM, out["signals"]))
    if DARWIN:
        stale = B.signal_by_token(tt["pid"], tt["idversion"] + 1, signal.SIGTERM)
        alive_after_stale = safe(B.info, tt["pid"])[0] is not None
        good = B.signal_by_token(tt["pid"], tt["idversion"], signal.SIGTERM) if stale != "absent" else "absent"
        time.sleep(0.5)
        dd = safe(B.info, tt["pid"])[0]
        out["signals"].append({"pid": tt["pid"], "label": "token_target", "sig": "SIGTERM(token,stale)",
                               "result": f"ret={stale}"})
        out["signals"].append({"pid": tt["pid"], "label": "token_target", "sig": "SIGTERM(token,good)",
                               "result": f"ret={good}", "sent_if_zero": True})
        out["audit_token_signal"] = {"stale_ret": stale, "alive_after_stale": alive_after_stale, "good_ret": good,
                                     "target_after_good": dd and dd["status"]}
        control("audit_token_stale_refused", lambda v: v == "absent" or (v[0] == E.ESRCH and v[1]),
                stale if stale == "absent" else (stale, alive_after_stale), "ESRCH expected for stale idversion")

    # ---- cleanup of OUR tree only (ground truth minus siblings), then certify; siblings left alive on purpose
    def kill_set(labels):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for lab in labels:
                if lab in gt:
                    verify_and_signal(gt[lab], sig, out["signals"])
            time.sleep(1.0)
    own_labels = [k for k in gt if gt[k]["uniqueid"] not in sib_uniq]
    kill_set(["root"] + [k for k in own_labels if k != "root"])
    root_p.wait(timeout=10)
    if lj and lj.get("rc") == 0:  # always remove our own submitted job, whether or not its pid was found
        out["launchd_job"]["remove"] = subprocess.run(["launchctl", "remove", lj["label"]], capture_output=True,
                                                      text=True, timeout=20).returncode
    time.sleep(1.0)
    procs, errs = census()
    tracker.update(procs)
    mid = certify(procs, errs, root, tracker, "coalition", me)
    mid.pop("classes")
    out["post_own_cleanup_coalition"] = mid
    print("POST-OWN", json.dumps(mid)[:2000], flush=True)
    so = gt.get("sibling_orphan_setsid")
    control("same_coalition_foreign_orphan_is_uncertain", ("UNCERTAIN", True),
            (mid["state"], bool(so) and so["pid"] in mid["candidates"]),
            f"sibling orphan pid={so and so['pid']} must be a candidate, never signalled by the certifier")

    # ---- remove the driver's own siblings, then final certification
    kill_set([k for k in gt if gt[k]["uniqueid"] in sib_uniq])
    for p in (sib_p, sib_orph_p):
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    time.sleep(1.0)
    final, clean = None, 0
    for _ in range(4):  # CONFIRMED needs two consecutive clean scans; otherwise never reported as CONFIRMED
        procs, errs = census()
        tracker.update(procs)
        final = certify(procs, errs, root, tracker, "coalition", me)
        final.pop("classes")
        clean = clean + 1 if final["state"] == "CONFIRMED" else 0
        if clean >= 2:
            break
        time.sleep(0.5)
    if final["state"] == "CONFIRMED" and clean < 2:
        final["state"], final["note"] = "UNCERTAIN", "no two consecutive clean scans"
    final["candidate_detail"] = [{"pid": p, "comm": procs[p]["comm"], "ppid": procs[p]["ppid"]}
                                 for p in final["candidates"] if p in procs]
    out["final_coalition"] = final
    print("FINAL", json.dumps(final)[:2000], flush=True)
    # injected query failure on a live process after cleanup: must turn the result into UNCERTAIN, never CONFIRMED
    inj2 = certify(procs, errs, root, tracker, "coalition", me, inject_fail=(os.getppid(),))
    control("injected_query_failure_after_cleanup_uncertain", ("UNCERTAIN", True),
            (inj2["state"], os.getppid() in inj2["errors"]))
    control("final_state_reported", lambda s: s in ("CONFIRMED", "UNCERTAIN"), final["state"],
            "CONFIRMED expected unless unrelated same-coalition orphans exist (then UNCERTAIN, fail closed)")

    # ---- overhead
    t_w, t_c = time.perf_counter(), time.process_time()
    n_scan = 30
    for _ in range(n_scan):
        census()
    w, c = (time.perf_counter() - t_w) / n_scan, (time.process_time() - t_c) / n_scan
    t_c2 = time.process_time()
    for _ in range(n_scan):
        for p in B.pids():
            safe(B.coal, p)
    c2 = (time.process_time() - t_c2) / n_scan
    out["overhead"] = {"pids": len(procs), "full_scan_wall_ms": round(w * 1000, 2),
                       "full_scan_cpu_ms": round(c * 1000, 2), "coal_only_scan_cpu_ms": round(c2 * 1000, 2),
                       "cpu_at_1hz_pct": round(c * 100, 3), "nproc": os.cpu_count(), "loadavg": os.getloadavg()}
    print("OVERHEAD", json.dumps(out["overhead"]), flush=True)

    # ---- safety: none of our fixture-reported processes may be alive; no signal outside ground truth
    alive = []
    for lab, r in gt.items():
        d, _ = safe(B.info, r["pid"])
        if d and d["uniqueid"] == r["uniqueid"] and d["status"] != SZOMB:
            alive.append(lab)
    out["leaked_fixtures"] = alive
    signalled_pids = {s["pid"] for s in out["signals"] if s["result"] == "sent"}
    outside = sorted(signalled_pids - {r["pid"] for r in gt.values()})
    out["signals_outside_ground_truth"] = outside
    safety_ok = not alive and not outside and not (final["state"] == "CONFIRMED" and
                                                     (final["candidates"] or final["errors"]))
    out["safety_ok"] = safety_ok
    if not safety_ok:
        return 3
    return 0 if all(c["ok"] for c in controls) else 1


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "fixture":
        fixture(sys.argv[2], sys.argv[3])
    else:
        sys.exit(main())
