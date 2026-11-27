"""Process identity records for test_run_owned.py (test support only; run_owned.py never imports this module).

Round 38 (DD-R37-LATE-IDENT): the tests used to read a bare pid from the fixture's pid file and only then look up the
identity of whatever process held that pid, possibly long after the fixture process had exited, so a reused pid could
be taken for the fixture and later be killed by the test's cleanup. Now every fixture process records ITSELF, as its
first action, while it is certainly alive and certainly itself:

    R1 <pid> <identity> <parent-pid|-> <parent-identity|-> <mac>

  identity  the kernel's identity of the writing process, read by the process about itself:
            Linux  "L<starttime>"     /proc/<pid>/stat field 22 (clock ticks since boot; with the pid unique per boot)
            macOS  "M<p_uniqueid>"    libproc flavor 17 (never reused within a boot; kept across exec)
            Windows "W<creation>"     GetProcessTimes creation FILETIME (100 ns; with the pid unique per process object)
  parent    the (pid, identity) of the fixture process that started it (passed down through PARENT_ENV), or "-" for a
            process started by the tool / the test itself
  mac       HMAC-SHA256 over the other fields with the test case's own random key (KEY_ENV), which only processes
            started by that case inherit: a record from another case, a stale file, a truncated or edited line, or a
            line any other process wrote does not authenticate

A record is never ownership evidence on its own: test_run_owned.Ident admits a pid only when the record authenticates,
its parent claim names a record it already admitted, and the process now at that pid has exactly the recorded identity
(alive, pinned before any signal) or no process holds it (exited: kept as evidence, never signalled). A different
identity at that pid means the pid was reused: the replacement is never admitted and never signalled.
"""
import errno, hashlib, hmac, os, re, sys

KEY_ENV = "RUN_OWNED_TEST_KEY"
PARENT_ENV = "RUN_OWNED_TEST_PARENT"
TAG = "R1"
LINUX, MACOS, WINDOWS = sys.platform.startswith("linux"), sys.platform == "darwin", os.name == "nt"
PREFIX = "L" if LINUX else ("M" if MACOS else ("W" if WINDOWS else "?"))
_IDENT_RE = re.compile(r"^[LMW][0-9]{1,20}$")
_PID_RE = re.compile(r"^[1-9][0-9]{0,9}$")
_MAC_RE = re.compile(r"^[0-9a-f]{64}$")


class IdentityError(OSError):
    """The identity of a process could not be read for a reason other than "no such process" (never taken as gone)."""


class RecordError(ValueError):
    """A pid-file line that is not a complete, authentic record (the reason is the message)."""


# ── reading an identity ──────────────────────────────────────────────────────────────────────────────────────────────
def _linux_identity(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            s = f.read().decode("latin1")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as e:
        raise IdentityError(e.errno or errno.EIO, f"/proc/{pid}/stat: {e}")
    r = s[s.rindex(")") + 2:].split()
    if r[0] in ("Z", "X"):
        return None  # a zombie no longer runs (and cannot be signalled into doing anything)
    return "L%d" % int(r[19])


_mac_lib = None


def _mac_identity(pid):
    global _mac_lib
    import ctypes, ctypes.util
    if _mac_lib is None:
        lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)
        lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        lib.proc_pidinfo.restype = ctypes.c_int
        _mac_lib = lib
    buf = (ctypes.c_uint8 * 56)()  # struct proc_uniqidentifierinfo: p_uuid[16], p_uniqueid (u64), ...
    ctypes.set_errno(0)
    n = _mac_lib.proc_pidinfo(pid, 17, 0, buf, 56)
    if n == 56:
        return "M%d" % int.from_bytes(bytes(buf[16:24]), "little")
    err = ctypes.get_errno()
    if err == errno.ESRCH or (n == 0 and err == 0):
        return None  # gone (a zombie is reported as ESRCH too)
    raise IdentityError(err or errno.EIO, f"proc_pidinfo({pid}, 17) returned {n}")


class _Win:
    SYNCHRONIZE, TERMINATE, QUERY_LIMITED = 0x00100000, 0x0001, 0x1000
    ERROR_INVALID_PARAMETER = 87

    def __init__(self):
        import ctypes
        from ctypes import wintypes as w
        self.ctypes = ctypes
        k = self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k.OpenProcess.restype = w.HANDLE
        k.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4; k.GetProcessTimes.restype = w.BOOL
        k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]; k.WaitForSingleObject.restype = w.DWORD
        k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]; k.TerminateProcess.restype = w.BOOL
        k.CloseHandle.argtypes = [w.HANDLE]; k.CloseHandle.restype = w.BOOL
        self.w = w

    def open(self, pid, access):
        """A handle, or None if no process has that pid; raises IdentityError for any other failure (e.g. denied)."""
        h = self.k.OpenProcess(access, False, pid)
        if h:
            return h
        err = self.ctypes.get_last_error()
        if err == self.ERROR_INVALID_PARAMETER:
            return None
        raise IdentityError(err, f"OpenProcess({pid}) failed: {err}")

    def identity(self, h):
        """The identity of the process object behind h (the handle pins it: no pid lookup, no race)."""
        t = [self.w.FILETIME() for _ in range(4)]
        if not self.k.GetProcessTimes(h, *[self.ctypes.byref(x) for x in t]):
            raise IdentityError(self.ctypes.get_last_error(), "GetProcessTimes failed")
        return "W%d" % ((t[0].dwHighDateTime << 32) | t[0].dwLowDateTime)

    def exited(self, h):
        r = self.k.WaitForSingleObject(h, 0)
        if r == 0x102: return False   # WAIT_TIMEOUT: running
        if r == 0: return True        # WAIT_OBJECT_0: ended
        raise IdentityError(self.ctypes.get_last_error(), f"WaitForSingleObject returned {r:#x}")  # never taken as ended

    def close(self, h):
        if h: self.k.CloseHandle(h)


_win = None


def win():
    global _win
    if _win is None: _win = _Win()
    return _win


def identity_of(pid):
    """Identity string of the live (non-zombie) process at pid, or None if there is none. Raises IdentityError when it
    cannot be read. A time-of-check value only: a signal needs a pin (pidfd / audit token / handle) and a re-check."""
    if LINUX: return _linux_identity(pid)
    if MACOS: return _mac_identity(pid)
    if WINDOWS:
        h = win().open(pid, _Win.SYNCHRONIZE | _Win.QUERY_LIMITED)
        if h is None: return None
        try:
            return None if win().exited(h) else win().identity(h)
        finally:
            win().close(h)
    raise IdentityError(errno.ENOSYS, "no process identity on this platform")


# ── records ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def _mac(key, body):
    return hmac.new(key.encode("utf8"), body.encode("ascii"), hashlib.sha256).hexdigest()


def make_record(pid, ident, parent, key):
    """The record line (no newline). parent: (pid, identity) or None."""
    ppid, pident = (str(parent[0]), parent[1]) if parent else ("-", "-")
    body = f"{TAG} {pid} {ident} {ppid} {pident}"
    return f"{body} {_mac(key, body) if key else '-'}"


def parse_record(line, key):
    """(pid, identity, parent) of a complete, authentic record (parent: (pid, identity) or None); else RecordError."""
    parts = line.split(" ")
    if not parts or parts[0] != TAG:
        raise RecordError("not a record")
    if not all(c.isascii() and c.isprintable() for c in line):
        raise RecordError("garbled record (non-ASCII)")
    if len(parts) != 6:
        raise RecordError("truncated or malformed record")
    _, pid, ident, ppid, pident, mac = parts
    if not key:
        raise RecordError("no key for this test case")
    if not _MAC_RE.match(mac) or not hmac.compare_digest(mac, _mac(key, " ".join(parts[:5]))):
        raise RecordError("record does not authenticate (another case, a stale file, an edited or foreign line)")
    if not _PID_RE.match(pid) or not _IDENT_RE.match(ident) or ident[0] != PREFIX:
        raise RecordError("malformed pid or identity")
    if (ppid == "-") != (pident == "-"):
        raise RecordError("half a parent claim")
    if ppid != "-" and (not _PID_RE.match(ppid) or not _IDENT_RE.match(pident) or pident[0] != PREFIX):
        raise RecordError("malformed parent claim")
    return int(pid), ident, (None if ppid == "-" else (int(ppid), pident))


def own_parent_claim():
    v = os.environ.get(PARENT_ENV, "")
    parts = v.split(" ")
    if len(parts) == 2 and _PID_RE.match(parts[0]) and _IDENT_RE.match(parts[1]):
        return int(parts[0]), parts[1]
    return None


def write_own_record(pidfile):
    """First action of a fixture process: append its own record, then name itself as the parent of what it starts.
    Returns its identity. Without a readable own identity it writes nothing and fails (never a bare pid)."""
    pid = os.getpid()
    ident = identity_of(pid)
    if ident is None:
        raise IdentityError(errno.ESRCH, "own identity unreadable")
    line = make_record(pid, ident, own_parent_claim(), os.environ.get(KEY_ENV, ""))
    with open(pidfile, "a", encoding="ascii") as f:
        f.write(line + "\n")
    os.environ[PARENT_ENV] = f"{pid} {ident}"
    return ident


def write_parent_record(pidfile, expected_ppid):
    """For a parent that cannot read its own identity (a node test process): it runs this synchronously, names its own
    pid, and is blocked in that call. Written only if getppid() is that pid before and after the read (POSIX: a dead
    parent would have re-parented us), the parent is alive (Windows: the handle shows it running), and the parent is
    older than this process (a reused pid would belong to a newer process). Anything else writes nothing and fails."""
    me = identity_of(os.getpid())
    if os.getppid() != expected_ppid or me is None:
        raise IdentityError(errno.ESRCH, "not started by the named parent")
    a = identity_of(expected_ppid)
    if a is None or os.getppid() != expected_ppid or identity_of(expected_ppid) != a or int(a[1:]) > int(me[1:]):
        raise IdentityError(errno.ESRCH, "parent identity changed, unreadable or newer than this process")
    line = make_record(expected_ppid, a, None, os.environ.get(KEY_ENV, ""))
    with open(pidfile, "a", encoding="ascii") as f:
        f.write(line + "\n")
