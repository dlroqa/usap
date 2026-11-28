"""Self-tests for run_owned.py (unittest; Python 3.8+; on Linux, stopping a leftover the test did not start itself
needs a pidfd - Python 3.9+ - and without one the case fails as "unverifiable", never a plain kill by pid).
Run: python3 -B scripts/dev/test_run_owned.py -v

Every case builds a real process tree (_owned_fixture.py), runs it through the CLI in its own process, and then checks
by IDENTITY that no process of the tree survived. Each fixture process records its OWN identity (Linux start time,
macOS uniqueid, Windows creation time) as its first action, authenticated with the case's key (_owned_ident.py); the
test admits a pid only when that record authenticates, its parent is admitted, and the process now at that pid has
that identity (round 38: a bare pid read later, possibly after the process ended and its pid was reused, is never
ownership evidence). Cleanup signals only through a pin (pidfd / identity-version token / handle) after a re-check. Negative controls show that the failure each case
guards against is real (a plain timeout kill leaves the tree behind). Cases that need a guarantee the platform does
not give are skipped with the reason, never passed. Every process a case creates is stopped at the end of the case,
by identity only; nothing is matched by name.
"""
import ast, contextlib, errno, json, os, secrets, shutil, signal, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "run_owned.py")
FIX = os.path.join(HERE, "_owned_fixture.py")
PY = getattr(sys, "_base_executable", None) or sys.executable  # the real interpreter (a venv launcher would sit between)
sys.path.insert(0, HERE)
import run_owned as ro  # noqa: E402
import _owned_ident as oi  # noqa: E402

LINUX, MACOS, WINDOWS = ro.LINUX, ro.MACOS, ro.WINDOWS


def load(path):
    with open(path, encoding="utf8") as f:
        return json.load(f)


# ── Real-signal guard for tests that start no processes (round 36) ──────────────────────────────────────────────────
# Rounds 33 and 32 each shipped a test that sent a REAL signal to a made-up target (killpg(4000), killpg(99998)). Every
# test is classified once below (by full name, never by prefix). For every test that is not OWNED, setUp replaces each
# real signalling primitive with a blocker that records the attempt and raises BEFORE any OS call; the attempt also fails
# the test at cleanup even if the code under test swallowed the exception. OWNED tests signal only processes they started
# and recorded by identity (Ident), and are not guarded (their cleanup must work). The guard never signals anything.
_SIG_NAMES = frozenset({"kill", "killpg", "pidfd_send_signal", "pthread_kill"})
_GUARDED = ((os, "kill"), (os, "killpg"), (signal, "pidfd_send_signal"), (signal, "pthread_kill"),
            (ro.MacOwner, "token_signal"), (ro.WinOwner, "force"))
_ABSENT = object()


class RealSignalBlocked(AssertionError):
    """A guarded test tried to send a real signal: raised before any OS call."""


class SignalGuard:
    """allow: optional {name: set of first arguments} that may pass to the real function (a test's OWN targets only)."""

    def __init__(self, allow=None):
        self.allow = {k: frozenset(v) for k, v in (allow or {}).items()}
        self.attempts, self.saved, self.blockers, self.tampered = [], {}, {}, []

    def _blocker(self, name, orig):
        allowed = self.allow.get(name, frozenset())
        def blocked(*a, **kw):
            if a and type(a[0]) is int and a[0] in allowed and a[0] > 0:
                return orig(*a, **kw)  # an explicitly allowed own target (never pid <= 0, never a made-up id)
            self.attempts.append((name,) + tuple(x if isinstance(x, int) else type(x).__name__ for x in a))
            raise RealSignalBlocked(f"real {name}{tuple(self.attempts[-1][1:])} blocked before any OS call")
        blocked.__name__, blocked._signal_guard = "blocked_" + name, self
        return blocked

    def install(self):
        for owner, name in _GUARDED:
            orig = owner.__dict__.get(name, _ABSENT) if isinstance(owner, type) else getattr(owner, name, _ABSENT)
            self.saved[(owner, name)] = orig
            if orig is not _ABSENT:
                call = orig if not isinstance(owner, type) else getattr(owner, name)
                self.blockers[name] = b = self._blocker(name, call)
                setattr(owner, name, b)
        return self

    def active(self):
        return bool(self.blockers) and all(getattr(o, n, _ABSENT) is self.blockers[n] for o, n in _GUARDED if n in self.blockers)

    def restore(self):  # never raises, never signals
        for (owner, name), orig in reversed(list(self.saved.items())):
            cur = getattr(owner, name, _ABSENT) if not isinstance(owner, type) else owner.__dict__.get(name, _ABSENT)
            if name in self.blockers and cur is not self.blockers[name]: self.tampered.append(name)
            if orig is _ABSENT:
                if cur is not _ABSENT: delattr(owner, name)
            else:
                setattr(owner, name, orig)

    def take(self):
        """Hand over (and clear) the recorded attempts: for controls that provoke an attempt on purpose."""
        a, self.attempts = self.attempts, []
        return a

    def verify_and_restore(self):
        self.restore()
        if self.attempts or self.tampered:
            raise RealSignalBlocked(f"blocked real-signal attempts {self.attempts}; patches left in place {self.tampered}")


@contextlib.contextmanager
def signal_floor():
    """A minimal last layer for tests that probe a SignalGuard on purpose: installed UNDER the guard being tested, it
    catches any call the guard lets through, so even a broken guard can never reach the OS. Deliberately independent of
    SignalGuard (own list, own code). Yields the list of calls that reached the floor (expected: none)."""
    hits, saved = [], []
    for owner, name in ((os, "kill"), (os, "killpg"), (signal, "pidfd_send_signal"), (signal, "pthread_kill"),
                        (ro.MacOwner, "token_signal"), (ro.WinOwner, "force")):
        if (name in owner.__dict__) if isinstance(owner, type) else hasattr(owner, name):
            saved.append((owner, name, owner.__dict__[name] if isinstance(owner, type) else getattr(owner, name)))
            def floor(*a, _n=name, **kw):
                hits.append((_n,) + tuple(x if type(x) is int else type(x).__name__ for x in a))
                raise RuntimeError(f"signal floor reached: {_n} (the guard under test let it through)")
            setattr(owner, name, floor)
    try:
        yield hits
    finally:
        for owner, name, orig in saved: setattr(owner, name, orig)


def signal_cache_violations(src):
    """Ways to keep a reference that patching the module attribute would not catch: from-imports of signal functions or
    the raw posix/nt/_signal modules (anywhere), and getattr(os, "kill")-style lookups at import time (module or class
    level: inside a function the lookup happens at call time, so under a guard it finds the blocker)."""
    tree, bad = ast.parse(src), []
    in_function = set()  # nodes whose code runs only when a function is called
    for f in ast.walk(tree):  # a function's body runs at call time; its defaults and decorators run at definition time
        if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for st in f.body: in_function.update(id(x) for x in ast.walk(st))
        elif isinstance(f, ast.Lambda):
            in_function.update(id(x) for x in ast.walk(f.body))
    called = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module in ("os", "posix", "nt", "signal", "_signal") \
                and {a.name for a in n.names} & (_SIG_NAMES | {"*"}): bad.append(("from-import", n.lineno))
        if isinstance(n, ast.Import) and {a.name for a in n.names} & {"posix", "nt", "_signal"}: bad.append(("raw-module", n.lineno))
        if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "getattr" and len(n.args) > 1 and id(n) not in in_function \
                and isinstance(n.args[1], ast.Constant) and n.args[1].value in _SIG_NAMES: bad.append(("getattr", n.lineno))
        if isinstance(n, ast.Attribute) and n.attr in _SIG_NAMES and id(n) not in in_function and id(n) not in called \
                and isinstance(n.value, ast.Name) and n.value.id in ("os", "signal"): bad.append(("alias", n.lineno))
    return bad


def _const_int(v):
    if isinstance(v, ast.UnaryOp) and isinstance(v.op, ast.USub): v = v.operand
    return isinstance(v, ast.Constant) and type(v.value) is int


def constant_signal_targets(src, names):
    """In the named test methods: a constant assigned to an owner's .root, or a constant first argument to kill/killpg/
    _signal_group targets (a made-up id, as in the round-32 killpg(99998))."""
    cls = [c for c in ast.parse(src).body if isinstance(c, ast.ClassDef) and c.name == "Case"][0]
    bad = []
    for fn in (f for f in cls.body if isinstance(f, ast.FunctionDef) and f.name in names):
        for n in ast.walk(fn):
            if isinstance(n, ast.Assign):
                tg = [e for t in n.targets for e in (t.elts if isinstance(t, ast.Tuple) else [t])]
                vs = n.value.elts if isinstance(n.value, ast.Tuple) else [n.value] * len(tg)
                bad += [(fn.name, n.lineno) for t, v in zip(tg, vs) if getattr(t, "attr", None) == "root"
                        and _const_int(v)]
            if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in ("kill", "killpg") and n.args \
                    and _const_int(n.args[0]):
                bad.append((fn.name, n.lineno))
    return bad


# Start no process; use made-up pids/groups, synthetic owners or fake owners. Guarded.
SYNTHETIC_TESTS = frozenset({
    "test_dg_matching_versions_admit_and_record_the_exec_history",
    "test_dg_missing_orphan_original_parent_version",
    "test_dg_missing_parent_admission_record",
    "test_dg_missing_root_version_history",
    "test_dg_original_parent_version_mismatch",
    "test_dg_output_size_bounds_and_truncation",
    "test_dg_portable_scenario_runs_without_posix_signals",
    "test_dg_query_failure_or_inconsistent_identity",
    "test_dg_query_returning_no_information",
    "test_dg_report_key_never_changes_the_exit_code",
    "test_dg_sensitive_text_is_never_reported",
    "test_dg_stale_admission_record_and_link_seen_while_root_alive",
    "test_dg_unobserved_root_exec_version_is_reported_with_its_signature",
    "test_dg_verdict_and_cleanup_unchanged",
    "test_dg_verdict_cleanup_and_signals_unchanged",
    "test_group_eperm_when_not_pinned_is_never_classified",
    "test_group_eperm_with_a_live_member_is_never_suppressed",
    "test_group_eperm_with_an_unreadable_group_is_uncertain",
    "test_group_eperm_with_one_unreadable_process_is_uncertain",
    "test_group_eperm_with_only_the_zombie_root_is_a_note_not_a_reason",
    "test_group_harmless_eperm_never_waives_an_earlier_denial",
    "test_group_missing_is_harmless_and_other_errors_are_reasons",
    "test_guard_active_after_a_failed_assertion_and_restored_exactly",
    "test_guard_blocks_synthetic_pid_group_and_pidfd_before_the_os_call",
    "test_guard_mutations_are_caught_before_signalling",
    "test_guard_synthetic_owner_signal_paths_are_blocked",
    "test_guard_unexpected_attempt_fails_even_if_swallowed",
    "test_layer_d1_one_failing_signal_does_not_stop_the_others",
    "test_layer_d1_stop_failure_sweeps_known_processes",
    "test_layer_d1_survivors_outrank_reasons",
    "test_layer_no_option_waives_a_reason",
    "test_layer_run_owner_reason_is_121",
    "test_layer_run_stop_failure_is_uncertain_121",
    "test_layer_second_clean_rescan_is_required",
    "test_layer_stop_clean_fake_is_confirmed",
    "test_layer_stop_discovery_error_is_recorded_as_reason",
    "test_layer_stop_owner_reason_is_uncertain",
    "test_n2_orphan_of_an_exited_original_parent_is_admitted",
    "test_n2_scan_admits_only_with_positive_lineage_and_the_root_coalition",
    "test_ident_admits_only_authentic_records_verified_against_the_current_holder",
    "test_ident_record_missing_or_ended_first_admits_nothing_alive",
    "test_ident_lineage_requires_an_admitted_parent",
    "test_ident_multiple_fixtures_ending_in_any_order",
    "test_ident_cleanup_after_failure_timeout_and_cancellation",
    "test_ident_unknown_and_unverifiable_are_never_a_clean_cleanup",
    "test_ident_mutation_late_admission_is_caught",
    "test_ident_problems_fail_the_case",
    "test_phase2_exited_tool_is_never_signalled",
    "test_phase2_term_ignoring_tool_is_killed_after_grace",
    "test_phase2_tool_that_never_exits_is_unverifiable",
    "test_phase2_interrupted_cleanup_is_retried",
    "test_phase2_exception_in_one_stop_never_skips_the_others",
    "test_phase2_late_records_after_a_timeout_are_identity_checked",
    "test_phase2_cleanup_is_registered_before_the_test_body",
    "test_phase2_windows_branch_kills_through_the_handle",
    "test_phase2_case_dir_removal_is_bounded_and_reported",
})
# Start their own fixtures (directly or through the tool / a snippet interpreter) and signal only those, by identity. Not guarded.
OWNED_TESTS = frozenset({
    "test_d1_denied_then_gone_is_uncertain_not_confirmed",
    "test_d1_negative_control_empty_deny_set_is_confirmed",
    "test_d1_persistent_eperm_is_a_survivor_and_others_are_stopped",
    "test_d1_unpinnable_candidate_is_never_silently_dropped",
    "test_d1_unreadable_proc_entry_is_never_assumed_gone",
    "test_descendant_in_a_new_group_is_stopped",
    "test_discovery_error_during_the_stop_is_uncertain",
    "test_escaping_grandchild_is_stopped",
    "test_exec_after_discovery_is_still_stopped",
    "test_forking_during_cleanup_is_never_a_silent_success",
    "test_group_id_without_a_live_member_is_never_adopted",
    "test_guard_owned_fixture_cleanup_works_without_the_guard",
    "test_limit_tool_sigkill_leaves_the_tree",
    "test_linux_adopted_orphans_are_reaped_while_running",
    "test_f1_orphancheck_reports_an_unreaped_zombie",
    "test_f1_dead_pidfd_never_reaches_another_process",
    "test_f1_without_pidfd_open_the_fixture_skips_and_never_signals",
    "test_f1_failing_pidfd_open_skips_and_never_signals",
    "test_f1_stale_pidfd_fails_without_any_fallback",
    "test_linux_identity_mismatch_is_never_signalled",
    "test_mac_group_eperm_with_live_members_is_uncertain",
    "test_mac_group_inspection_error_is_uncertain",
    "test_mac_process_list_failure_is_uncertain",
    "test_mac_root_whose_identity_cannot_be_read_is_never_released",
    "test_mac_same_coalition_unrelated_orphan_is_uncertain_and_never_signalled",
    "test_mac_stale_identity_and_simulated_pid_reuse_are_refused",
    "test_mac_unrelated_launchd_job_neither_uncertain_nor_signalled",
    "test_mac_without_the_identity_bound_call_nothing_else_is_signalled",
    "test_mac_zombie_only_group_really_returns_eperm_and_is_harmless",
    "test_mac_zombie_only_group_run_is_confirmed",
    "test_negative_control_plain_timeout_leaves_descendants",
    "test_no_descendants_is_confirmed",
    "test_node_test_runner_child_does_not_survive",
    "test_orphaned_session_escaper_with_a_seen_parent_is_stopped",
    "test_reduced_mode_never_kills_a_grandchild_by_pid",
    "test_require_full_containment",
    "test_root_exit_code_is_preserved",
    "test_root_exits_before_its_child_is_observed",
    "test_sigterm_ignoring_descendants_are_killed_after_grace",
    "test_stale_parent_entry_never_adopts_an_unrelated_child",
    "test_success_leftover_child_is_stopped",
    "test_timeout_stops_a_three_level_tree",
    "test_tool_sigterm_stops_the_tree",
    "test_unexpected_error_in_the_tool_still_stops_the_tree",
    "test_unseen_session_escaper_is_never_confirmed",
    "test_unstartable_command_is_127",
    "test_windows_breakaway_is_refused",
    "test_windows_tool_killed_job_close_kills_tree",
    "test_ident_real_records_admit_the_fixture_and_never_a_reused_pid",
    "test_phase2_normal_exit_sends_no_signal",
    "test_phase2_foreground_timeout_stops_the_tool_and_its_tree",
    "test_phase2_background_wait_timeout_stops_tool_then_fixtures",
    "test_phase2_real_tool_ignoring_term_is_killed",
    "test_phase2_tool_stderr_leaves_no_open_pipe",
})
# No processes and no signalling (classifiers, source checks). Guarded.
PURE_TESTS = frozenset({
    "test_dg_failed_predicate_matches_the_classifier",
    "test_dg_static_write_only_and_no_signals",
    "test_guard_every_test_is_classified_exactly_once",
    "test_guard_no_cached_signal_references",
    "test_n2_classifier_requires_positive_lineage",
    "test_static_guard_plain_kill_only_where_proven_safe",
    "test_static_fixture_signals_only_through_pidfd",
    "test_static_ident_admission_and_signal_paths",
    "test_ident_own_identity_matches_run_owned",
    "test_static_tool_processes_only_through_start",
    "test_static_teardown_stops_tools_before_pinned_cleanup",
    "test_static_untracked_interpreters_inventory",
})


class _Entry:
    """One admitted process. ident: the identity the process recorded about ITSELF at start (or, for a child the test
    holds as an unreaped Popen, read while it was certainly that child). pin: Windows handle opened at admission and
    verified to name that identity. popen: the test's own Popen (stopped through it, never by pid)."""
    __slots__ = ("ident", "pin", "popen")

    def __init__(self, ident, pin=None, popen=None):
        self.ident, self.pin, self.popen = ident, pin, popen


class _RealBackend:
    """The only code through which Ident reaches the OS. Admission compares the CURRENT holder of a pid with the
    identity a record claims; a signal goes only through a pin (pidfd / identity-version audit token / handle) after a
    re-check; there is no plain kill(pid) anywhere (round 38: a check followed by kill(pid) is not atomic)."""

    def __init__(self):
        self.mac = ro.MacOwner() if MACOS else None

    def verify(self, pid, ident):
        """("alive", pin) if the process at pid has exactly ident; ("exited", None) if no process holds pid (or it has
        ended); ("reused", current) if a process with another identity holds it. Raises oi.IdentityError if unreadable."""
        if WINDOWS:
            w = oi.win()
            h = w.open(pid, w.SYNCHRONIZE | w.QUERY_LIMITED)  # query first: a reuser may refuse TERMINATE (never ours)
            if h is None: return "exited", None
            try:
                cur, ended = w.identity(h), w.exited(h)  # through the handle itself: it pins this object, no pid lookup
                if cur != ident: return "reused", cur
                if ended: return "exited", None
                # h keeps this process object (and so its pid) alive: a second open by pid names the same object
                t = w.open(pid, w.SYNCHRONIZE | w.TERMINATE | w.QUERY_LIMITED)
                try:
                    same = t is not None and w.identity(t) == ident
                except BaseException:
                    w.close(t); raise
                if not same:
                    w.close(t); raise oi.IdentityError(errno.EAGAIN, "pinned process changed identity")
                return "alive", t
            finally:
                w.close(h)
        cur = oi.identity_of(pid)
        if cur is None: return "exited", None
        return ("alive", None) if cur == ident else ("reused", cur)

    def alive(self, pid, e):
        if e.popen is not None: return e.popen.poll() is None
        if WINDOWS: return bool(e.pin) and not oi.win().exited(e.pin)
        try:
            return oi.identity_of(pid) == e.ident
        except oi.IdentityError:
            return True  # unreadable is never "gone" (a survivor check must not pass on it); never signalled either

    def stop(self, pid, e):
        """SIGKILL / TerminateProcess the admitted process through a pin. None = stopped or already gone (the pid's
        holder, if any, has another identity and is left alone); otherwise the reason it could not be done safely."""
        if e.popen is not None:
            e.popen.kill()  # the test's own Popen, unreaped (only the test reaps it): its pid cannot have been reused
            return None
        if WINDOWS:
            if not e.pin: return None  # never pinned: it had ended before admission
            w = oi.win()
            if w.exited(e.pin) or w.k.TerminateProcess(e.pin, 1): return None
            return "TerminateProcess failed: %d" % w.ctypes.get_last_error()
        if MACOS:
            try:
                q = self.mac._q(pid)
            except OSError as x:
                return "identity unreadable: %s" % x
            if q is None or "M%d" % q["uniqueid"] != e.ident: return None
            r = self.mac.token_signal(pid, q["idversion"], signal.SIGKILL)  # the kernel matches pid AND idversion
            if r is None: return "no proc_signal_with_audittoken (macOS < 14.2): not signalled"
            return None if r in (0, errno.ESRCH) else "token_signal errno %d" % r
        if LINUX:
            if not hasattr(os, "pidfd_open"): return "no pidfd: the process cannot be pinned (never a plain kill by pid)"
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                return None
            except OSError as x:
                return "pidfd_open errno %s" % x.errno
            try:
                if oi.identity_of(pid) != e.ident: return None  # pinned AFTER our process ended: not ours, untouched
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                return None
            except ProcessLookupError:
                return None
            except OSError as x:
                return "%s: %s" % (type(x).__name__, x)
            finally:
                os.close(fd)
        return "no pinned signal on this platform"

    def release(self, e):
        if WINDOWS and e.pin:
            oi.win().close(e.pin); e.pin = None


class Ident:
    """Processes a test case owns, by identity (round 38, DD-R37-LATE-IDENT). A pid is admitted ONLY by
      * admit_line: a pid-file record the process wrote about itself at start (oi.write_own_record) that authenticates
        with this case's key, whose parent claim names a record already admitted, and whose identity the process now
        at that pid has (alive; Windows: pinned by a handle verified to name it) - or no process holds the pid (exited:
        kept as evidence, never signalled). A different identity there is a reused pid: recorded, never admitted alive,
        never signalled. A bare pid, a truncated/edited/foreign/stale line or an unverifiable one is never admitted.
      * record_child: a Popen the test holds and has not reaped (its pid cannot be reused before the test reaps it).
    Every problem is kept (rejected / unknown / unverifiable) and fails the case: unknown ownership is never a clean
    cleanup."""

    def __init__(self, key="", backend=None):
        self.key = key
        self.b = backend if backend is not None else _RealBackend()
        self.seen = {}      # pid -> _Entry: every admitted process (alive or ended at admission)
        self.claims = {}    # pid -> identity of every authentic, lineage-checked record (parent evidence)
        self.lines = {}     # pid-file line -> admitted pid or None (each line is decided once)
        self.rejected, self.unknown, self.unverifiable, self.reused = [], [], [], []

    @property
    def mac(self):
        return getattr(self.b, "mac", None)

    def _admit(self, pid, entry):  # the ONLY place a pid enters self.seen (static test)
        old = self.seen.get(pid)
        if old is not None: self.b.release(old)
        self.seen[pid] = entry

    def admit_line(self, line):
        """Decide one complete pid-file line; returns the admitted pid or None."""
        if line in self.lines: return self.lines[line]
        self.lines[line] = None
        try:
            pid, ident, parent = oi.parse_record(line, self.key)
        except oi.RecordError as x:
            self.rejected.append((str(x), line[:100])); return None
        if parent is not None and self.claims.get(parent[0]) != parent[1]:
            self.rejected.append(("parent claim names no admitted record (lineage missing or contradictory)", line[:100]))
            return None
        old = self.seen.get(pid)
        if old is not None and old.ident == ident:
            self.lines[line] = pid; return pid
        try:
            state, x = self.b.verify(pid, ident)
        except oi.IdentityError as err:
            self.unknown.append((pid, "identity unreadable: %s" % err)); return None
        if old is not None and self.alive(pid):
            if state == "alive": self.b.release(_Entry(ident, x))
            self.rejected.append(("a live admitted process already holds this pid", line[:100])); return None
        self.claims[pid] = ident
        if state == "reused":
            self.reused.append((pid, ident, x))  # our process has ended; the replacement is never ours
            x = None
        self._admit(pid, _Entry(ident, x if state == "alive" else None))
        self.lines[line] = pid
        return pid

    def record_child(self, popen):
        """Admit the test's own unreaped child (its identity is read while it certainly is that child)."""
        if popen.returncode is not None: raise AssertionError("record_child needs a child the test has not reaped")
        ident = oi.identity_of(popen.pid)
        state, pin = self.b.verify(popen.pid, ident) if ident is not None else ("exited", None)
        if popen.returncode is not None or state == "reused": raise AssertionError("the child changed during admission")
        self.claims[popen.pid] = ident
        self._admit(popen.pid, _Entry(ident, pin if state == "alive" else None, popen))
        return popen.pid

    def alive(self, pid):
        e = self.seen.get(pid)
        return e is not None and self.b.alive(pid, e)

    def alive_all(self):
        return [p for p in self.seen if self.alive(p)]

    def problems(self):
        return [("rejected",) + r for r in self.rejected] + [("unknown",) + u for u in self.unknown] + \
               [("unverifiable",) + u for u in self.unverifiable]

    def cleanup(self):
        """Stop what a case left behind, through pins only; one failure never stops the others."""
        for pid, e in list(self.seen.items()):
            try:
                if not self.b.alive(pid, e): continue
                why = self.b.stop(pid, e)
            except Exception as x:  # noqa: BLE001 - recorded, and the case fails on it
                why = "%s: %s" % (type(x).__name__, x)
            if why: self.unverifiable.append((pid, why))
        end = time.time() + 5
        while self.alive_all() and time.time() < end: time.sleep(0.05)
        for e in self.seen.values():
            if e.popen is not None and e.popen.poll() is not None: e.popen.wait()
        if WINDOWS:
            left = set(self.alive_all())
            for pid, e in self.seen.items():
                if pid not in left: self.b.release(e)


def scan_pidfile(ident, path):
    """Admit every COMPLETE line of a pid file (an unterminated last line may still be being written: left for a later
    read, never admitted). Returns (admitted pids in file order, note lines, record-like line count)."""
    try:
        with open(path, encoding="ascii", errors="replace") as f:
            data = f.read()
    except FileNotFoundError:
        data = ""
    pids, notes, n = [], [], 0
    for x in (s.strip() for s in data.split("\n")[:-1]):
        if not x: continue
        if x.startswith(oi.TAG + " ") or x == oi.TAG or x.isdigit():  # a bare pid is refused by admit_line
            n += 1
            p = ident.admit_line(x)
            if p is not None and p not in pids: pids.append(p)
        else:
            notes.append(x)
    return pids, notes, n


# F1 (round 41): runs the real orphancheck fixture IN this process (runpy) with its pidfd capability altered. Plain
# os.kill/os.killpg are replaced by recorders that write a note and raise BEFORE any OS call; every pidfd_send_signal
# the fixture makes is noted, then passed on. HOW: "absent" (no os.pidfd_open), "oserror" (pidfd_open fails, e.g.
# ENOSYS), "stale" (pidfd_open hands back a pidfd whose process is already gone: the pinned identity no longer exists,
# as after a reap with the number possibly reused). The stale pidfd comes from this wrapper's OWN child, killed through
# its own fresh pidfd and reaped by its own pid. The fixture's guard and engine run unmodified, under the tool.
F1_WRAP = r'''
import os, runpy, signal, subprocess, sys
how, fix, pids = sys.argv[1], sys.argv[2], sys.argv[3]
def note(t):
    with open(pids, "a", encoding="utf8") as f: f.write(t + "\n")
def plain(name):
    def rec(*a, **k):
        note("plainkill:" + name); raise RuntimeError("F1 wrapper: plain " + name + " blocked before any OS call")
    return rec
os.kill, os.killpg = plain("kill"), plain("killpg")
real_open, real_send = os.pidfd_open, signal.pidfd_send_signal
def send(fd, sig, *a):
    note("pidfdsig:%d" % int(sig)); return real_send(fd, sig, *a)
signal.pidfd_send_signal = send
if how == "absent":
    del os.pidfd_open
elif how == "oserror":
    def refuse(pid, *a): raise OSError(38, "simulated: pidfd_open not supported")
    os.pidfd_open = refuse
elif how == "stale":
    def stale(pid, *a):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], stdin=subprocess.DEVNULL)
        fd = real_open(p.pid)  # our own unreaped child: pinned
        real_send(fd, signal.SIGKILL); p.wait(10)  # reaped: fd now names a process that no longer exists
        note("stalepidfd"); return fd
    os.pidfd_open = stale
else:
    raise SystemExit("unknown HOW " + how)
sys.path.insert(0, os.path.dirname(fix)); sys.argv = [fix, "orphancheck", pids]
runpy.run_path(fix, run_name="__main__")
'''


# Round 42 (Phase 2 gap 5): Case methods that start a process directly with subprocess instead of as a tracked tool
# (_start_cmd). Each is the case's own child with its own timeout; what they start is stopped only through pinned records.
# test_static_untracked_interpreters_inventory keeps this list exact.
UNTRACKED_STARTERS = frozenset({
    "_snippet",  # snippet(): run_owned in-process, capture_output pipes
    "test_guard_owned_fixture_cleanup_works_without_the_guard",
    "test_f1_dead_pidfd_never_reaches_another_process",  # F1: its own child, pinned by pidfd; reaped in finally
    "test_f1_orphancheck_reports_an_unreaped_zombie",  # F1: subreaper helper (subprocess.run, 60 s); reaps adopted children
    "test_ident_real_records_admit_the_fixture_and_never_a_reused_pid",
    "test_linux_identity_mismatch_is_never_signalled",
    "test_mac_same_coalition_unrelated_orphan_is_uncertain_and_never_signalled",
    "test_mac_stale_identity_and_simulated_pid_reuse_are_refused",
    "test_mac_unrelated_launchd_job_neither_uncertain_nor_signalled",
    "test_mac_zombie_only_group_really_returns_eperm_and_is_harmless",
    "test_negative_control_plain_timeout_leaves_descendants",
    "test_phase2_tool_stderr_leaves_no_open_pipe",
})


class Case(unittest.TestCase):
    def setUp(self):
        n = self._testMethodName
        if sum(n in c for c in (SYNTHETIC_TESTS, OWNED_TESTS, PURE_TESTS)) != 1:
            self.fail(f"{n} is not classified exactly once (SYNTHETIC_TESTS / OWNED_TESTS / PURE_TESTS)")
        self.signal_guard = None
        if n not in OWNED_TESTS:  # active through the test, its failures and tearDown; checked and restored last
            self.signal_guard = SignalGuard().install()
            self.addCleanup(self.signal_guard.verify_and_restore)
        self.dir = tempfile.mkdtemp(prefix="run-owned-")
        self.pids = os.path.join(self.dir, "pids")
        self.key = secrets.token_hex(16)  # this case's own key: only processes this case starts inherit it
        self.env = dict(os.environ, **{oi.KEY_ENV: self.key})
        self.env.pop(oi.PARENT_ENV, None)
        self.ident = Ident(self.key)
        self._tools = []  # Phase 2 (round 40): every tool process this case started, stopped through its own Popen
        self.addCleanup(self._stop_all_tools)  # idempotent; tearDown calls it first, this covers a failing tearDown

    def tearDown(self):
        self._stop_all_tools()  # tools first (run_owned stops its own tree on SIGTERM), then descendants by pin
        if self.signal_guard is not None:  # a guarded test starts nothing, so its cleanup must have nothing to stop
            self.assertEqual(self.ident.seen, {}, "a guarded (non-OWNED) test recorded processes")
        self.ident.cleanup()
        left = self.ident.alive_all()
        dir_left = self._remove_case_dir()
        self.assertEqual(left, [], "the case's own cleanup left processes")
        self.assert_clean_ownership(self.ident)
        self.assertIsNone(dir_left, "the case's temporary folder could not be removed (on Windows: a file is still open)")

    def _remove_case_dir(self, rmtree=shutil.rmtree, attempts=10, delay=0.2):
        """Round 42: the case folder is removed with bounded retries (~2 s: a scanner or a just-exited process may still
        hold a file on Windows); if it is still there, the path and the last error are returned, and the case fails,
        instead of the folder being silently abandoned. Never signals anything."""
        err = None
        for i in range(attempts):
            try:
                rmtree(self.dir)
            except FileNotFoundError:
                return None
            except OSError as x:
                err = "%s: %s" % (type(x).__name__, x)
            if not os.path.exists(self.dir):
                return None
            if i + 1 < attempts: time.sleep(delay)
        return "%s left (%s)" % (self.dir, err)

    def assert_clean_ownership(self, ident):
        """A rejected record, an unreadable identity or a cleanup that could not be done through a pin fails the case."""
        self.assertEqual(ident.problems(), [], "ownership unknown or cleanup unverifiable: never a clean cleanup")

    def read_pids(self, n, wait=15):
        end = time.time() + wait
        while True:
            pids, notes, count = scan_pidfile(self.ident, self.pids)
            if count >= n or time.time() > end:
                return pids, notes
            time.sleep(0.02)

    # ── Phase 2 (round 40): tool processes are tracked and stopped through their own Popen, never by pid ──
    # Bounds (round 42). The execution timeout of a test's tool() call is unchanged; cleanup runs only AFTER that timeout
    # has already failed the call (finish_tool re-raises TimeoutExpired) or in tearDown, so it never extends a successful
    # test. Per tool on POSIX: SIGTERM, wait TOOL_GRACE + 5 s (10 s), SIGKILL, wait 5 s => at most ~15 s, then the tool is
    # recorded as unverifiable (the case fails). Tools are stopped one after another, so N live tools take at most ~N x 15 s,
    # plus at most ~5 s for the case's pinned cleanup (Ident.cleanup). A foreground tool() that times out therefore raises
    # TimeoutExpired up to ~15 s after its timeout (it used to be an immediate SIGKILL with no tree stop).
    # Windows: Popen.kill() is TerminateProcess on the tool's own handle: no graceful step, no report from the tool; its
    # tree ends when the tool's job object closes (run_owned's KILL_ON_JOB_CLOSE), then wait 5 s. Bound ~5 s per tool.
    # macOS: no pidfd and no subreaper. SIGTERM lets run_owned stop its own tree (its macOS ownership path); descendants that
    # outlive the tool are stopped only through the case's pinned records (Ident: audit-token identity) in tearDown; an
    # unrecorded descendant cannot be found by this harness (documented limit, not assumed away).
    TOOL_GRACE = 5  # seconds run_owned gets to stop its tree after SIGTERM before the tool itself is killed

    def _start_cmd(self, cmd):
        """Start one tool process. stderr goes to a file, not a pipe: the tool's descendants inherit it, so a pipe would
        stay open (and a read to EOF would block) while any of them survives; the parent's copy is closed at once."""
        err = os.path.join(self.dir, "tool-%d.stderr" % len(self._tools))
        with open(err, "wb") as fh:
            p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fh, env=self.env)
        self._tools.append({"p": p, "err": err, "done": False})
        return p

    def start_tool(self, *args):
        rep = os.path.join(self.dir, "report.json")
        return self._start_cmd([sys.executable, "-B", TOOL, "--report", rep, *args]), rep

    def tool_stderr(self, p):
        e = next(t for t in self._tools if t["p"] is p)
        with open(e["err"], "rb") as fh:
            return fh.read().decode(errors="replace")

    def finish_tool(self, p, timeout):
        """Wait for a tool; on a timeout stop it (and what it started) before re-raising, so no failure path leaks it."""
        try:
            return p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.stop_tool(p)
            raise

    def stop_tool(self, p, grace=None):
        """Bounded stop through the Popen only (never a pid): POSIX SIGTERM (run_owned stops its own tree), wait grace+5 s,
        then kill and wait 5 s (<= ~15 s with the default grace); Windows kill = TerminateProcess on the handle (closing the
        job kills the tree), wait 5 s. Then admit late records (identity-checked) so the case's
        cleanup can stop leftovers by pin. A tool that does not exit is recorded as unverifiable (the case fails)."""
        grace = self.TOOL_GRACE if grace is None else grace
        if p.poll() is None:
            if WINDOWS:
                p.kill()
            else:
                p.send_signal(signal.SIGTERM)
                try:
                    p.wait(timeout=grace + 5)
                except subprocess.TimeoutExpired:
                    p.kill()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.ident.unverifiable.append((p.pid, "tool process did not exit after kill"))
        scan_pidfile(self.ident, self.pids)
        for t in self._tools:
            if t["p"] is p: t["done"] = True

    def _stop_all_tools(self):
        """Idempotent: each tool is stopped once; one failure is recorded and never stops the others."""
        for t in list(self._tools):
            if t["done"]: continue
            try:
                self.stop_tool(t["p"])
            except Exception as x:  # noqa: BLE001 - recorded; the case fails on it
                t["done"] = True
                self.ident.unverifiable.append((getattr(t["p"], "pid", None), "tool stop failed: %s: %s" % (type(x).__name__, x)))

    def tool(self, *args, timeout=60, background=False):
        p, rep = self.start_tool(*args)
        if background:
            return p, rep
        code = self.finish_tool(p, timeout)
        report = load(rep) if os.path.exists(rep) else None
        return code, report, self.tool_stderr(p)

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
        code = self.finish_tool(p, 60)
        r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT, self.tool_stderr(p)); self.assertTrue(r["timed_out"]); self.assertEqual(r["survivors"], []); self.assertEqual(r["certification"], "confirmed", r)
        self.assertEqual(len(pids), 3); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipIf(WINDOWS, "POSIX signals")
    def test_sigterm_ignoring_descendants_are_killed_after_grace(self):
        p, rep = self.tool("--timeout", "2", "--grace", "1", "--", *self.fixture("tree,ignoreterm"), background=True)
        self.read_pids(3); code = self.finish_tool(p, 60); r = load(rep)
        self.assertEqual(code, ro.EXIT_TIMEOUT); self.assertTrue(any(s.get("sig") == "KILL" for s in r["signalled"]), r["signalled"])
        self.assertEqual(self.ident.alive_all(), [])

    def test_escaping_grandchild_is_stopped(self):
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,escape"), background=True)
        pids, _ = self.read_pids(3); code = self.finish_tool(p, 60); r = load(rep)
        self.assertEqual(len(pids), 3)
        self.assertEqual(self.ident.alive_all(), [], r)
        self.assertEqual(code, ro.EXIT_TIMEOUT)
        if MACOS: self.assertTrue(r["escaped_seen"], "macOS reports the escaper it caught")

    @unittest.skipUnless(WINDOWS, "Windows Job Object")
    def test_windows_breakaway_is_refused(self):
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("tree,breakaway"), background=True)
        _, notes = self.read_pids(3); self.finish_tool(p, 60)
        self.assertIn("breakaway-refused", notes); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipIf(WINDOWS, "POSIX signal to the tool")
    def test_tool_sigterm_stops_the_tree(self):
        p, rep = self.tool("--grace", "1", "--", *self.fixture("tree,ignoreterm"), background=True)
        self.read_pids(3); time.sleep(0.3); p.send_signal(signal.SIGTERM); code = self.finish_tool(p, 60)
        self.assertEqual(code, 128 + signal.SIGTERM); self.assertEqual(self.ident.alive_all(), [])

    @unittest.skipUnless(WINDOWS, "Windows: closing the job handle kills the tree")
    def test_windows_tool_killed_job_close_kills_tree(self):
        p, rep = self.tool("--", *self.fixture("tree,escape"), background=True)
        self.read_pids(3); time.sleep(0.5); p.kill(); self.finish_tool(p, 30)
        end = time.time() + 10
        while self.ident.alive_all() and time.time() < end: time.sleep(0.1)
        self.assertEqual(self.ident.alive_all(), [], "KILL_ON_JOB_CLOSE")

    @unittest.skipIf(WINDOWS, "POSIX")
    def test_limit_tool_sigkill_leaves_the_tree(self):
        """Documented limit (negative control): SIGKILL of the tool cannot be handled in-process."""
        p, rep = self.tool("--", *self.fixture("tree"), background=True)
        self.read_pids(3); time.sleep(0.3); p.kill(); self.finish_tool(p, 30); time.sleep(0.3)
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

    @unittest.skipUnless(LINUX and ro._pidfd_works(), "Linux subreaper and pidfd (the fixture signals only through a pidfd)")
    def test_linux_adopted_orphans_are_reaped_while_running(self):
        code, rep, err = self.tool("--timeout", "20", "--", *self.fixture("orphancheck"))
        self.read_pids(2, wait=2)  # round 41: root and engine records, so tearDown verifies the engine is gone
        if code == 4: self.skipTest("the fixture could not pin the engine with a pidfd (it never falls back to kill(pid))")
        self.assertEqual(code, 0, f"a killed orphan must not stay a zombie that looks alive: {err}")

    @unittest.skipUnless(LINUX and ro._pidfd_works(), "Linux subreaper and pidfd")
    def test_f1_orphancheck_reports_an_unreaped_zombie(self):
        """F1 negative control: under a subreaper that never reaps the engine, the fixture's pidfd check must see the
        killed engine as an unreaped zombie and exit 3 (the reap check is not vacuous). The helper is this test's own
        child; it waits only for the fixture root while the fixture runs.
        Round 41: after the root has exited (and reported), the helper stops and reaps what it adopted (the zombie
        engine; or, if the fixture failed early, a live engine or a guard still exiting) through a pidfd taken while
        that process is the helper's own unreaped child, so its pid is pinned (no one else may reap it), then reaps it
        by that pid. It prints how many it reaped: a fixture that exits 4 or throws can no longer leave the engine."""
        if not os.path.exists(f"/proc/{os.getpid()}/task/{os.getpid()}/children"):
            self.skipTest("no /proc/<pid>/task/<tid>/children (the helper could not find what it adopted)")
        helper = ("import ctypes, os, signal, subprocess, sys, time\n"
                  "assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0\n"  # PR_SET_CHILD_SUBREAPER
                  "print(subprocess.Popen(sys.argv[1:]).wait(), flush=True)\n"  # waitpid(root) only, never -1
                  "me, n, end = os.getpid(), 0, time.time() + 10\n"
                  "while time.time() < end:\n"
                  "    kids = [int(k) for k in open(f'/proc/{me}/task/{me}/children').read().split()]\n"
                  "    if not kids: break\n"
                  "    for k in kids:\n"  # our own unreaped children only: pinned until we reap them ourselves
                  "        fd = os.pidfd_open(k); signal.pidfd_send_signal(fd, signal.SIGKILL); os.close(fd)\n"
                  "        os.waitpid(k, 0); n += 1\n"
                  "print(n, flush=True)\n")
        h = subprocess.run([sys.executable, "-c", helper, *self.fixture("orphancheck")], capture_output=True, text=True,
                           timeout=60, env=self.env)
        self.read_pids(2, wait=2)
        out = h.stdout.split()
        self.assertEqual(out[:1], ["3"], h.stderr)
        self.assertEqual(h.returncode, 0, h.stderr)
        self.assertGreaterEqual(int(out[1]) if len(out) > 1 else -1, 1, f"the zombie engine was not reaped by the helper: {h.stderr}")

    @unittest.skipUnless(LINUX and ro._pidfd_works() and hasattr(signal, "pidfd_send_signal"), "Linux pidfd")
    def test_f1_dead_pidfd_never_reaches_another_process(self):
        """F1 pid-reuse property: once the pinned process is reaped, its pidfd refuses every signal (ESRCH), whatever
        process later holds the number. Only this test's own child is involved."""
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        fd = os.pidfd_open(p.pid)
        try:
            p.kill(); p.wait(10)  # reaped: the number is free for reuse from here on
            for sig in (0, signal.SIGKILL):
                with self.assertRaises(ProcessLookupError): signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
            if p.poll() is None: p.kill(); p.wait(10)

    def _f1_wrapped(self, how, records):
        code, rep, err = self.tool("--timeout", "20", "--", sys.executable, "-B", "-c", F1_WRAP, how, FIX, self.pids)
        pids, notes = self.read_pids(records, wait=2)
        self.assertEqual(len(pids), records, notes)
        self.assertNotIn(True, [n.startswith("plainkill") for n in notes], f"a plain kill/killpg was attempted: {notes}")
        self.assertIsNotNone(rep, err); self.assertEqual(rep["survivors"], [], rep)
        return code, notes, err

    @unittest.skipUnless(LINUX and ro._pidfd_works() and hasattr(signal, "pidfd_send_signal"), "Linux pidfd")
    def test_f1_without_pidfd_open_the_fixture_skips_and_never_signals(self):
        """F1 unsupported pidfd (no os.pidfd_open): exit 4 and note it before starting anything; no signal of any kind."""
        code, notes, err = self._f1_wrapped("absent", 1)
        self.assertEqual(code, 4, err); self.assertIn("nopidfd", notes)
        self.assertEqual([n for n in notes if n.startswith("pidfdsig")], [], notes)

    @unittest.skipUnless(LINUX and ro._pidfd_works() and hasattr(signal, "pidfd_send_signal"), "Linux pidfd")
    def test_f1_failing_pidfd_open_skips_and_never_signals(self):
        """F1 unsupported pidfd (pidfd_open raises after the guard and engine exist): exit 4; the fixture signals
        nothing, and the engine is left to the tool, which stops it as its own (no survivors)."""
        code, notes, err = self._f1_wrapped("oserror", 2)
        self.assertEqual(code, 4, err); self.assertIn("nopidfd", notes)
        self.assertEqual([n for n in notes if n.startswith("pidfdsig")], [], notes)

    @unittest.skipUnless(LINUX and ro._pidfd_works() and hasattr(signal, "pidfd_send_signal"), "Linux pidfd")
    def test_f1_stale_pidfd_fails_without_any_fallback(self):
        """F1 identity mismatch / simulated pid reuse: if the pinned identity is gone, the one SIGKILL through it is
        refused (ESRCH) and the fixture fails (traceback, exit 1); it never retries by pid. No process is reused or
        signalled for real: the stale pidfd belongs to the wrapper's own reaped child."""
        code, notes, err = self._f1_wrapped("stale", 2)
        self.assertEqual(code, 1, err); self.assertIn("stalepidfd", notes); self.assertNotIn("nopidfd", notes)
        self.assertEqual([n for n in notes if n.startswith("pidfdsig")], ["pidfdsig:9"], notes)
        self.assertIn("ProcessLookupError", err)

    def test_static_fixture_signals_only_through_pidfd(self):
        """F1: the fixture never calls os.kill/os.killpg; in orphancheck the pidfd is opened before the guard is released
        or reaped, and the engine is signalled (and its reap checked) only through pidfd_send_signal."""
        with open(FIX, encoding="utf8") as fh: src = fh.read()
        tree = ast.parse(src)
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertEqual([c.lineno for c in calls if c.func.attr in ("kill", "killpg") and getattr(c.func.value, "id", None) == "os"], [])
        # round 41: no cached/aliased signal function, no signal through a Popen handle other than the Windows breakaway
        # child's own p.kill(), and no external kill command
        self.assertEqual(signal_cache_violations(src), [])
        if hasattr(ast, "unparse"):
            self.assertEqual([ast.unparse(c.func) for c in calls if c.func.attr in ("kill", "killpg", "send_signal", "terminate")], ["p.kill"])
        self.assertEqual([n.lineno for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
                          and n.value.split()[:1] in (["kill"], ["pkill"], ["killall"], ["taskkill"])], [])
        line = lambda attr, owner=None: [c.lineno for c in calls if c.func.attr == attr and (owner is None or ast.unparse(c.func.value) == owner)] \
            if hasattr(ast, "unparse") else [c.lineno for c in calls if c.func.attr == attr]
        opened, released, reaped = line("pidfd_open"), line("close", "guard.stdin"), line("wait", "guard")
        self.assertEqual(len(opened), 1); self.assertTrue(released and reaped)
        self.assertLess(opened[0], min(released)); self.assertLess(opened[0], min(reaped))
        self.assertGreaterEqual(len(line("pidfd_send_signal")), 2)

    @unittest.skipUnless(LINUX and hasattr(os, "pidfd_open"), "Linux pidfd")
    def test_linux_identity_mismatch_is_never_signalled(self):
        victim = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.ident.record_child(victim)
        snippet = ("import sys, os, signal; sys.path.insert(0, %r); import run_owned as ro\n"
                   "o = ro.LinuxOwner(); pid = %d\n"
                   "o.known[pid] = {'start': -1, 'fd': None, 'ppid': 0, 'pgid': 0}\n"
                   "print(o.signal(pid, signal.SIGTERM))") % (HERE, victim.pid)
        out = subprocess.run([sys.executable, "-B", "-c", snippet], capture_output=True, text=True, timeout=30).stdout.strip()
        time.sleep(0.2)
        self.assertEqual(out, "False"); self.assertIsNone(victim.poll(), "the process with another identity was not signalled")
        victim.kill(); victim.wait()

    def snippet(self, code, timeout=60, expect=3):
        """Round 42 scope note: a snippet interpreter is NOT a tracked tool (it runs run_owned in-process, never TOOL): it
        is this case's own subprocess.run child with capture_output pipes and its own timeout. Its descendants are stopped
        only through their pinned records (read here and in tearDown). On Windows, subprocess.run's communicate() after a
        timeout kill could wait on a pipe a surviving descendant holds; the snippets' fixtures use DEVNULL for their stdio.
        Every untracked interpreter start is inventoried in UNTRACKED_STARTERS (test_static_untracked_interpreters_inventory)."""
        try:
            return self._snippet(code, timeout)
        finally:
            self.read_pids(expect, wait=2)  # record what it started even if it failed, so tearDown stops it

    def _snippet(self, code, timeout):
        out = subprocess.run([sys.executable, "-B", "-c", f"import sys, os, json, signal, subprocess, time; sys.path.insert(0, {HERE!r}); import run_owned as ro\n" + code],
                             capture_output=True, text=True, timeout=timeout, env=self.env)
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
with open({self.pids!r}) as f: vpid = int(f.readline().split()[1])  # record: R1 <pid> ...
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
with open({self.pids!r}) as f: gpid = int(f.readline().split()[1])  # record: R1 <pid> ...
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
        self.read_pids(3); code = self.finish_tool(p, 60); r = load(rep)
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
        self.read_pids(2); code = self.finish_tool(p, 90); r = load(rep)
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
        return int(lines[2].split()[1]) if len(lines) >= 3 else None  # record: R1 <pid> ...
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
        if len(lines) >= 3 and path == "/proc/%s/stat" % lines[2].split()[1]:
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
with open({self.pids!r}) as f: pids = [int(x.split()[1]) for x in f if x.startswith("R1 ")]
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
        self.read_pids(2); code = self.finish_tool(p, 60); r = load(rep)
        self.assertEqual((code, r["certification"]), (ro.EXIT_TIMEOUT, "confirmed"), r)
        self.assertEqual(self.ident.alive_all(), [], r)

    @unittest.skipIf(WINDOWS, "POSIX sessions")
    def test_orphaned_session_escaper_with_a_seen_parent_is_stopped(self):
        """A grandchild starts a new session and is re-parented (launchd / subreaper) while the run goes on."""
        p, rep = self.tool("--timeout", "3", "--grace", "1", "--", *self.fixture("slowdoublefork"), background=True)
        self.read_pids(3); code = self.finish_tool(p, 60); r = load(rep)
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
            code = self.finish_tool(p, 60); r = load(rep)
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
            f.write("import subprocess, sys\n"  # the orphan records ITSELF (authenticated identity, round 38)
                    "subprocess.Popen([sys.executable, sys.argv[2], 'solo', sys.argv[1]], start_new_session=True,"
                    " stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n")
        subprocess.run([sys.executable, helper, sib, FIX], timeout=30, env=self.env)
        end = time.time() + 15
        while True:
            spids, _, _ = scan_pidfile(self.ident, sib)
            if spids or time.time() > end: break
            time.sleep(0.02)
        self.assertEqual(len(spids), 1, self.ident.problems()); spid = spids[0]
        rc = self.finish_tool(p, 60); r = load(rep)
        self.assertEqual((rc, r["certification"]), (ro.EXIT_UNCERTAIN, "uncertain"), r)
        self.assertTrue(any(c["code"] == "lineage_candidate" and c.get("pid") == spid for c in r["reason_codes"]), r)
        self.assertNotIn(spid, [s.get("pid") for s in r["signalled"]])
        self.assertTrue(self.ident.alive(spid), "never signalled (the tearDown stops it by identity)")

    @unittest.skipUnless(MACOS, "macOS audit token")
    def test_mac_stale_identity_and_simulated_pid_reuse_are_refused(self):
        v = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); self.ident.record_child(v)
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
            self.assertNotEqual(signal.getsignal(signal.SIGCHLD), signal.SIG_IGN, "z must stay unreaped (its group id reserved)")
            o = ro.MacOwner(); o.root, o.pinned, o.root_exited_flag = z.pid, True, True
            g = SignalGuard(allow={"killpg": {z.pid}}).install()  # only the test's own unreaped group may be signalled
            try:
                with self.assertRaises(PermissionError, msg="XNU: killpg on a zombie-only group returns EPERM"):
                    os.killpg(z.pid, 0 or signal.SIGTERM)
                o._signal_group(signal.SIGTERM)
            finally:
                g.verify_and_restore()
            self.assertEqual(o.reason_codes if hasattr(o, "reason_codes") else [], [])
            self.assertEqual([n["event"] for n in o.notes], ["killpg_eperm_no_live_member"])
            # (round 36) the former check of a made-up group id with a REAL killpg is gone: a missing group (ESRCH)
            # is covered with a recorder by test_group_missing_is_harmless_and_other_errors_are_reasons
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
        self.assertEqual({type(c["first_seen_seq"]) for c in obs["candidates"]}, {int})  # the kept ones were seen first
        o4 = self.synthetic_mac(procs4 := {4000: R(4000, 100, 1000, 1, 4000, 0)})
        for n in range(ro._DG_SEEN_MAX): procs4[20000 + n] = R(20000 + n, 2000 + n, 9000 + n, 1, 20000 + n, 7, coal=(9, 9))
        o4.scan()                                          # first-seen map full with unrelated processes
        for n in range(ro._DG_SEEN_MAX): del procs4[20000 + n]
        procs4[4500] = R(4500, 5000, 9999, 1, 4500, 4242)  # a candidate that could not be recorded any more
        o4.scan(); o4.verify(); c4, _ = self.dg_cand(o4.diag_record(), 5000)
        self.assertEqual((c4["first_seen_seq"], c4["first_seen_parent"]), ("unknown_truncated", "unknown"))
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

    def dg_scenario(self, mode, with_signal):
        """One H1-shaped run with the diagnostics normal / disabled / raising; returns the decision-relevant state.
        with_signal adds MacOwner.signal() on a known process (POSIX only: it needs signal.SIGKILL and os.killpg). The
        root has exited and is pinned there, so signal() also signals the root's group. Wherever os.killpg exists it is
        replaced by a recorder that raises ProcessLookupError, with or without the signal step, so no real process
        group (pgid 4000 is synthetic) is ever signalled and an unexpected group signal is counted."""
        R = self.dg_rec
        procs = {4000: R(4000, 100, 1000, 1, 4000, 0), 4100: R(4100, 110, 1010, 4000, 4000, 1000)}
        o = self.synthetic_mac(procs)
        o._q = lambda pid, floor=None: dict(procs[pid]) if pid in procs else None
        calls = {"census": 0, "deliver": 0, "coal": 0, "killpg": []}
        census = o._census
        def counted(record_errors=True, floor=None):
            calls["census"] += 1; return census(record_errors, floor)
        o._census = counted
        o._deliver = lambda *a: calls.__setitem__("deliver", calls["deliver"] + 1)
        o.coal = lambda pid: (calls.__setitem__("coal", calls["coal"] + 1), [7, 8])[1]
        saved = {}
        real_killpg = getattr(ro.os, "killpg", None)
        def fake_killpg(pgid, sig):
            calls["killpg"].append((pgid, int(sig))); raise ProcessLookupError(errno.ESRCH, "synthetic group")
        if real_killpg is not None: ro.os.killpg = fake_killpg  # also without the signal step: proves none happens
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
            o.scan(); o.alive(); found = o.verify()
            if with_signal: o.signal(4100, signal.SIGTERM)
            state = dict(known=sorted(o.known), prov=dict(o.prov), ever=sorted(o.ever), idvs={k: sorted(v) for k, v in o.idvs.items()},
                         found=found, codes=list(o.reason_codes), reasons=list(o.uncertain_reasons), escaped=list(o.escaped_seen),
                         notes=list(getattr(o, "notes", [])), calls=dict(calls))
            return state, o.diag_record()
        finally:
            for name, fn in saved.items(): setattr(ro.MacOwner, name, fn)
            if real_killpg is not None: ro.os.killpg = real_killpg

    def test_dg_verdict_and_cleanup_unchanged(self):
        """Control 14 (all platforms, Windows included): diagnostics on, off, or failing on every hook give the same
        ownership state, reasons, candidates, census and coalition reads, and send nothing."""
        on, d_on = self.dg_scenario("normal", with_signal=False)
        off, _ = self.dg_scenario("disabled", with_signal=False)
        bad, d_bad = self.dg_scenario("raising", with_signal=False)
        self.assertEqual(on, off); self.assertEqual(on, bad)
        self.assertEqual(on["found"], [4200]); self.assertIn(4300, on["known"])
        self.assertEqual((on["calls"]["deliver"], on["calls"]["killpg"]), (0, []))
        self.assertGreater(on["calls"]["census"], 0)
        self.assertIsNone(d_on["diag_error"]); self.assertEqual(d_bad["diag_error"], "exception")
        self.assertEqual(ro.validate_attribution_diagnostics(d_bad), [])

    @unittest.skipUnless(hasattr(signal, "SIGKILL") and hasattr(os, "killpg"),
                         "MacOwner.signal needs POSIX signal.SIGKILL and os.killpg (CPython on Windows has neither)")
    def test_dg_verdict_cleanup_and_signals_unchanged(self):
        """Control 15 (POSIX): with a signal to a known process, diagnostics on, off or failing give the same state and
        the same signals: exactly one identity-bound delivery and one group signal to the pinned root's group."""
        on, d_on = self.dg_scenario("normal", with_signal=True)
        off, _ = self.dg_scenario("disabled", with_signal=True)
        bad, d_bad = self.dg_scenario("raising", with_signal=True)
        self.assertEqual(on, off); self.assertEqual(on, bad)
        self.assertEqual(on["found"], [4200]); self.assertIn(4300, on["known"])
        self.assertEqual(on["calls"]["deliver"], 1, "only the explicit signal to the known process")
        self.assertEqual(on["calls"]["killpg"], [(4000, int(signal.SIGTERM))], "one group signal, to the recorder only")
        self.assertIsNone(d_on["diag_error"]); self.assertEqual(d_bad["diag_error"], "exception")
        self.assertEqual(ro.validate_attribution_diagnostics(d_bad), [])

    @staticmethod
    @contextlib.contextmanager
    def without_posix_signals():
        """A Linux/macOS stand-in for CPython on Windows: signal.SIGKILL and os.killpg are absent (restored after)."""
        saved = {(m, n): getattr(m, n) for m, n in ((signal, "SIGKILL"), (os, "killpg")) if hasattr(m, n)}
        for m, n in saved: delattr(m, n)
        try: yield
        finally:
            for (m, n), v in saved.items(): setattr(m, n, v)

    def test_dg_portable_scenario_runs_without_posix_signals(self):
        """Regression control for round 33's Windows failure (signal.SIGKILL missing): the portable scenario must not
        touch POSIX-only names, checked on every platform; the signal scenario must fail there (the shim is real)."""
        with self.without_posix_signals():
            self.assertFalse(hasattr(signal, "SIGKILL") or hasattr(os, "killpg"))
            on, _ = self.dg_scenario("normal", with_signal=False)
            bad, _ = self.dg_scenario("raising", with_signal=False)
            self.assertEqual(on, bad); self.assertEqual(on["found"], [4200])
            with self.assertRaisesRegex(AttributeError, "SIGKILL|killpg"):  # negative control: round 33 on Windows
                self.dg_scenario("normal", with_signal=True)
        self.assertEqual(hasattr(signal, "SIGKILL"), not WINDOWS, "names restored")

    # ── real-signal guard controls (round 36) ──
    def test_guard_every_test_is_classified_exactly_once(self):
        """Replaces the round-34 name-prefix sweep: every test is in exactly one reviewed set, and no test method may give
        an owner a constant .root or kill/killpg a constant id (made-up targets, as in the round-32 killpg(99998))."""
        names = {n for n in dir(type(self)) if n.startswith(unittest.TestLoader.testMethodPrefix)}
        sets = (SYNTHETIC_TESTS, OWNED_TESTS, PURE_TESTS)
        self.assertEqual(set().union(*sets) ^ names, set(), "unclassified or stale names")
        self.assertEqual(sum(map(len, sets)), len(names), "a name is in two sets")
        self.assertGreater(len(SYNTHETIC_TESTS), 30)
        with open(__file__, encoding="utf8") as fh: src = fh.read()
        self.assertEqual(constant_signal_targets(src, OWNED_TESTS), [])  # unguarded tests: no made-up targets at all
        readd = src.replace("            o = ro.MacOwner(); o.root, o.pinned, o.root_exited_flag = z.pid, True, True\n",
                            "            o = ro.MacOwner(); o.root, o.pinned, o.root_exited_flag = z.pid, True, True\n"
                            "            o2 = ro.MacOwner(); o2.root, o2.pinned, o2.root_exited_flag = 99998, True, True\n", 1)
        self.assertNotEqual(readd, src)
        self.assertEqual(constant_signal_targets(readd, OWNED_TESTS), [("test_mac_zombie_only_group_really_returns_eperm_and_is_harmless",
                                                                 readd.split("\n").index("            o2 = ro.MacOwner(); o2.root, o2.pinned, o2.root_exited_flag = 99998, True, True") + 1)],
                         "the round-32 block, if re-added, is caught by parsing alone (never run)")

    def test_guard_no_cached_signal_references(self):
        """Patching os.kill / os.killpg / signal.* intercepts run_owned.py and these tests only because neither file keeps
        its own reference: no from-imports of signal functions, no raw posix/nt/_signal module, no getattr lookups."""
        for path in (TOOL, __file__):
            with open(path, encoding="utf8") as fh: self.assertEqual(signal_cache_violations(fh.read()), [], path)
        self.assertEqual(sorted(k for k, _ in signal_cache_violations(
            "from os import kill\nimport posix\nk = getattr(os, 'killpg')\nclass C:\n    j = getattr(os, 'kill')\n"
            "def f():\n    return getattr(os, 'kill')\n")), ["from-import", "getattr", "getattr", "raw-module"],
            "import-time lookups are flagged; a call-time lookup inside a function is not")
        self.assertEqual(sorted(k for k, _ in signal_cache_violations(
            "k2 = os.kill\ndef g(k=os.killpg):\n    return k\ndef h():\n    return os.kill(1, 0) or signal.pthread_kill\n")),
            ["alias", "alias"], "import-time aliases and default-argument captures are flagged; call-time uses are not")
        neg = "class Case:\n    def test_x(self):\n        os.kill(-1, 0)\n        o.root = -5\n        os.killpg(n, 0)\n"
        self.assertEqual(sorted(constant_signal_targets(neg, {"test_x"})), [("test_x", 3), ("test_x", 4)])
        self.assertIs(ro.os, os); self.assertIs(ro.signal, signal)

    def test_guard_blocks_synthetic_pid_group_and_pidfd_before_the_os_call(self):
        """Controls 1-3, 6: every guarded primitive raises before the OS call, through every module alias; the real
        functions are kept only as the saved originals (never called here)."""
        import os as os_alias
        calls = [("kill", lambda: os.kill(4000, 0)), ("kill", lambda: ro.os.kill(4000, 0)),
                 ("kill", lambda: os_alias.kill(4000, 0)), ("killpg", lambda: getattr(os, "killpg")(4000, 0)),
                 ("pidfd_send_signal", lambda: signal.pidfd_send_signal(-1, 0)),
                 ("pthread_kill", lambda: signal.pthread_kill(threading.get_ident(), 0)),
                 ("token_signal", lambda: ro.MacOwner.token_signal(self.synthetic_mac({}), 4000, 1, 0)),
                 ("force", lambda: ro.WinOwner.force(object()))]
        expected = []
        with signal_floor() as floor_hits:  # under the guard being tested: a broken guard reaches the floor, not the OS
            g = SignalGuard().install()
            try:
                for name, call in calls:
                    if name not in g.blockers: continue  # absent here (killpg/pthread_kill on Windows, pidfd off Linux)
                    self.assertTrue(g.active())
                    with self.assertRaises(RealSignalBlocked): call()
                    expected.append(name)
                self.assertEqual([a[0] for a in g.take()], expected)
                for (owner, name), orig in g.saved.items():
                    if orig is not _ABSENT: self.assertIsNot(orig, g.blockers[name])
            finally:
                g.restore()
        self.assertEqual(floor_hits, [], "the guard let a call through to the floor")
        for name in ("kill", "token_signal", "force"): self.assertIn(name, expected)
        self.assertTrue(self.signal_guard.active())

    def test_guard_synthetic_owner_signal_paths_are_blocked(self):
        """A synthetic MacOwner's real signal paths (pinned live root → os.kill; exited root → os.killpg) are blocked and
        recorded; a recorder installed by the test still counts (control 5)."""
        o = self.synthetic_mac({})
        o._q = lambda pid, floor=None: {"pid": pid, "uniqueid": 100, "idversion": 1000, "ppid": 1, "pgid": pid}
        rec = []
        with signal_floor() as floor_hits:
            g = SignalGuard().install()
            try:
                with self.assertRaises(RealSignalBlocked): o.signal(4000, 0)  # live pinned root: plain kill
                if "killpg" in g.blockers:
                    o.notes, o.root_exited_flag = [], True
                    with self.assertRaises(RealSignalBlocked): o._signal_group(0)  # not an OSError: never "harmless"
                self.assertEqual([a[:2] for a in g.take()], [("kill", 4000)] + ([("killpg", 4000)] if "killpg" in g.blockers else []))
                saved, os.kill = os.kill, lambda pid, sig: rec.append((pid, int(sig)))
                try:
                    o.root_exited_flag = False; o.signal(4000, 0)
                finally:
                    os.kill = saved
                self.assertTrue(g.active())
            finally:
                g.restore()
        self.assertEqual(floor_hits, []); self.assertEqual(rec, [(4000, 0)]); self.assertTrue(self.signal_guard.active())

    def _inner(self, body, teardown=lambda i: None):
        class Inner(unittest.TestCase):
            def setUp(i): i.g = SignalGuard().install(); i.addCleanup(i.g.verify_and_restore)
            def runTest(i): body(i)
            def tearDown(i): teardown(i)
        r = unittest.TestResult()
        with signal_floor() as floor_hits: Inner().run(r)  # a broken guard in Inner reaches the floor, never the OS
        self.assertEqual(floor_hits, [], "the inner guard let a call through to the floor")
        return r

    def test_guard_unexpected_attempt_fails_even_if_swallowed(self):
        """Control 4: an attempt the code under test swallows (run_owned's stop path catches Exception) still fails."""
        def body(i):
            i.assertTrue(i.g.active())
            try: ro.os.kill(4000, 0)
            except Exception: pass  # noqa: BLE001 - as a broad handler in the code under test would
        r = self._inner(body)
        bad = r.errors + r.failures
        self.assertEqual(len(bad), 1, bad); self.assertIn("('kill', 4000, ", bad[0][1])  # reported at cleanup
        self.assertTrue(self.signal_guard.active())

    def test_guard_active_after_a_failed_assertion_and_restored_exactly(self):
        """Controls 7-8: the guard stays active through an assertion failure and tearDown, and restores the exact objects."""
        g = self.signal_guard
        current = {(o, n): (o.__dict__.get(n, _ABSENT) if isinstance(o, type) else getattr(o, n, _ABSENT)) for o, n in _GUARDED}
        seen = []
        r = self._inner(lambda i: i.fail("inner failure"), lambda i: seen.append(i.g.active()))
        self.assertEqual((len(r.failures), len(r.errors), seen), (1, 0, [True]))
        for (o, n), v in current.items():
            now = o.__dict__.get(n, _ABSENT) if isinstance(o, type) else getattr(o, n, _ABSENT)
            self.assertIs(now, v, n)  # the outer (this test's) blockers are back exactly
        self.assertTrue(g.active())
        h = SignalGuard().install(); h.restore()
        self.assertTrue(g.active(), "an inner guard's restore puts the outer blockers back")
        for (o, n), orig in g.saved.items():  # this test's own saved originals are the real functions, untouched
            if orig is not _ABSENT: self.assertFalse(hasattr(orig, "_signal_guard"), n)

    def test_guard_owned_fixture_cleanup_works_without_the_guard(self):
        """Control 9 (OWNED): owned tests are not guarded, and Ident's identity-checked cleanup still stops a fixture."""
        self.assertIsNone(self.signal_guard)
        for o, n in _GUARDED:
            self.assertFalse(hasattr(getattr(o, n, None), "_signal_guard"), n)
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            self.ident.record_child(p)
            self.assertEqual(self.ident.alive_all(), [p.pid])
            self.ident.cleanup()
            self.assertEqual(self.ident.alive_all(), [])
            self.ident.seen = {}  # cleaned up (and on Windows its handle closed): tearDown must not use it again
        finally:
            if p.poll() is None: p.kill()
            p.wait(10)

    def run_mutant(self, edits, test):
        """Exec a mutated copy of this module in memory (no files written) and run one of its tests. Every primitive is
        already blocked by THIS test's guard, installed before the mutant exists, so a mutant cannot reach the OS even
        if it removes its own guard."""
        with open(__file__, encoding="utf8") as fh: src = fh.read()
        for old, new in edits:
            self.assertEqual(src.count(old), 1, f"mutation anchor drifted: {old[:60]!r}"); src = src.replace(old, new)
        self.assertEqual(signal_cache_violations(src), [], "a mutant that caches a primitive could bypass the guard")
        self.assertTrue(self.signal_guard.active())
        path = list(sys.path)
        with signal_floor() as floor_hits:  # whatever the mutant does, nothing below the floor is reachable
            try:
                ns = {"__name__": "run_owned_mutant", "__file__": __file__}
                exec(compile(src, "<mutant>", "exec"), ns)  # noqa: S102 - this module's own source, mutated in memory
                r = unittest.TestResult(); ns["Case"](test).run(r)
            finally:
                sys.path[:] = path
        self.assertTrue(self.signal_guard.active()); self.assertEqual(self.signal_guard.take(), [])
        return r, floor_hits

    def test_guard_mutations_are_caught_before_signalling(self):
        """Control 10: deliberately unsafe mutants fail before any OS call: a synthetic test that signals a pinned live
        made-up root, with and without the mutant's own guard (then THIS test's guard records it); the dg_scenario
        recorder removed (POSIX). The round-32 block re-added is caught by parsing (test_guard_every_test_...)."""
        anchor = "        o.scan(); o.scan()\n        self.assertEqual(sorted(o.known), [4000, 4100, 4200, 4600], o.known)\n"
        unsafe = (anchor + "        o9 = self.synthetic_mac({}); o9._q = lambda pid, floor=None: {'uniqueid': 100, 'idversion': 1000, "
                  "'ppid': 1, 'pgid': pid}\n        o9.signal(4000, 0)\n")
        test = "test_n2_scan_admits_only_with_positive_lineage_and_the_root_coalition"
        r, outer = self.run_mutant([(anchor, unsafe)], test)
        bad = r.errors + r.failures
        self.assertTrue(bad); self.assertEqual(outer, [], "the mutant's own guard caught it before the floor")
        self.assertTrue(all("kill(4000, " in t or "('kill', 4000, " in t for _, t in bad), bad)  # in the body and at cleanup
        unguard = ("        if n not in OWNED_TESTS:  # active through the test, its failures and tearDown; checked and restored last\n",
                   "        if False:\n")
        r, outer = self.run_mutant([(anchor, unsafe), unguard], test)
        self.assertEqual(len(r.errors + r.failures), 1, r.errors + r.failures)
        self.assertEqual([a[:2] for a in outer], [("kill", 4000)], "with its guard removed, the attempt reached only the floor")
        if hasattr(os, "killpg") and hasattr(signal, "SIGKILL"):
            rec = "        if real_killpg is not None: ro.os.killpg = fake_killpg  # also without the signal step: proves none happens\n"
            r, outer = self.run_mutant([(rec, "")], "test_dg_verdict_cleanup_and_signals_unchanged")
            self.assertTrue(r.errors + r.failures); self.assertEqual(outer, [])
            self.assertIn("('killpg', 4000, ", "".join(x[1] for x in r.errors + r.failures))

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
            subprocess.run(self.fixture("tree"), timeout=3, env=self.env)
        except subprocess.TimeoutExpired:
            pass
        pids, _ = self.read_pids(3, wait=2)
        self.assertTrue(self.ident.alive_all(), "the grandchildren survive a plain timeout")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_node_test_runner_child_does_not_survive(self):
        leak = os.path.join(self.dir, "leak.test.cjs")
        with open(leak, "w") as f:
            f.write("const t=require('node:test');const n=require('node:net');const fs=require('node:fs');"
                    f"t('hang',async()=>{{require('node:child_process').execFileSync({json.dumps(PY)},[{json.dumps(FIX)},'recordparent',{json.dumps(self.pids)},String(process.pid)],{{stdio:'ignore'}});n.createServer().listen(0,'127.0.0.1');await new Promise(()=>{{}});}});")
        code, rep, err = self.tool("--timeout", "4", "--grace", "2", "--", shutil.which("node"), "--test", leak)
        pids, _ = self.read_pids(1, wait=1)
        self.assertEqual(code, ro.EXIT_TIMEOUT, err); self.assertTrue(pids, "the per-file test process ran")
        self.assertEqual(self.ident.alive_all(), [], rep)

    # ── Round 38 (DD-R37-LATE-IDENT): identity is admitted only from the process's own authenticated record ──────────
    class FakeTable:
        """Synthetic process table for Ident (no OS call at all): pid -> current identity. stop() behaves like the real
        pinned paths: it 'signals' only when the holder still has the admitted identity, and records that in kills."""
        mac = None

        def __init__(self, table):
            self.table, self.kills, self.unreadable = dict(table), [], set()

        def verify(self, pid, ident):
            if pid in self.unreadable: raise oi.IdentityError(errno.EACCES, "synthetic unreadable")
            cur = self.table.get(pid)
            if cur is None: return "exited", None
            return ("alive", None) if cur == ident else ("reused", cur)

        def alive(self, pid, e):
            return pid in self.unreadable or self.table.get(pid) == e.ident

        def stop(self, pid, e):
            if pid in self.unreadable: return "synthetic: identity unreadable"
            if self.table.get(pid) == e.ident:
                self.kills.append((pid, e.ident)); del self.table[pid]
            return None

        def release(self, e):
            pass

    @staticmethod
    def rec(pid, n, parent=None, key="k" * 32):
        return oi.make_record(pid, f"{oi.PREFIX}{n}", (parent[0], f"{oi.PREFIX}{parent[1]}") if parent else None, key)

    def fake_ident(self, table, key="k" * 32):
        t = self.FakeTable({p: f"{oi.PREFIX}{n}" for p, n in table.items()})
        return Ident(key, backend=t), t

    def test_ident_admits_only_authentic_records_verified_against_the_current_holder(self):
        ident, t = self.fake_ident({7001: 11, 7003: 99, 7004: 14})  # 7002 ended; 7003 reused by another identity
        k, other = "k" * 32, "x" * 32
        ok = self.rec(7001, 11)
        self.assertEqual(ident.admit_line(ok), 7001)                           # valid, alive: admitted
        self.assertEqual(ident.admit_line(self.rec(7002, 12)), 7002)           # authentic, ended before reading: evidence
        self.assertEqual(ident.admit_line(self.rec(7003, 13)), 7003)           # authentic, pid reused: never alive
        self.assertEqual(ident.reused, [(7003, f"{oi.PREFIX}13", f"{oi.PREFIX}99")])
        forged = self.rec(7004, 15)                                           # writer claims an identity the pid lacks
        self.assertEqual(ident.admit_line(forged), 7004); self.assertFalse(ident.alive(7004))
        bad = [("7005", "not a record"),                                       # bare pid
               (ok.replace(f"{oi.PREFIX}11", f"{oi.PREFIX}14").replace("7001", "7004"), "does not authenticate"),  # substituted
               (self.rec(7006, 16, key=other), "does not authenticate"),        # stale: another case's key
               (ok[:-10], "does not authenticate"),                             # truncated mac
               (" ".join(ok.split(" ")[:5]), "truncated"),                      # truncated line
               ("R1", "truncated"),
               (oi.make_record(7007, f"{oi.PREFIX}17", None, ""), "does not authenticate")]  # unauthenticated
        for line, why in bad:
            self.assertIsNone(ident.admit_line(line), line)
            self.assertIn(why, ident.rejected[-1][0], (line, ident.rejected[-1]))
        self.assertEqual(sorted(ident.alive_all()), [7001])
        self.assertNotIn(7005, ident.seen); self.assertNotIn(7006, ident.seen); self.assertNotIn(7007, ident.seen)
        ident.cleanup()
        self.assertEqual(t.kills, [(7001, f"{oi.PREFIX}11")], "only the verified live fixture; never the reuser 7003/7004")
        self.assertEqual(t.table[7003], f"{oi.PREFIX}99"); self.assertEqual(t.table[7004], f"{oi.PREFIX}14")
        self.assertEqual(ident.unverifiable, [])

    def test_ident_record_missing_or_ended_first_admits_nothing_alive(self):
        ident, t = self.fake_ident({7101: 21})
        path = os.path.join(self.dir, "none")
        self.assertEqual(scan_pidfile(ident, path), ([], [], 0), "no pid file: nothing admitted")
        with open(path, "w") as f: f.write(self.rec(7101, 21) + "\n" + self.rec(7102, 22))  # last line unterminated
        pids, notes, n = scan_pidfile(ident, path)
        self.assertEqual((pids, n), ([7101], 1), "an unterminated (still being written) line is never admitted")
        del t.table[7101]                                                      # the fixture ends before cleanup
        ident.cleanup(); self.assertEqual(t.kills, []); self.assertEqual(ident.alive_all(), [])

    def test_ident_lineage_requires_an_admitted_parent(self):
        ident, t = self.fake_ident({7201: 31, 7202: 32, 7203: 33, 7204: 34, 7205: 35})
        self.assertEqual(ident.admit_line(self.rec(7201, 31)), 7201)
        self.assertEqual(ident.admit_line(self.rec(7202, 32, parent=(7201, 31))), 7202)   # verified lineage
        self.assertIsNone(ident.admit_line(self.rec(7203, 33, parent=(7299, 39))))         # original parent missing
        self.assertIsNone(ident.admit_line(self.rec(7204, 34, parent=(7201, 30))))         # contradictory parent identity
        self.assertEqual(ident.admit_line(self.rec(7205, 35, parent=(7202, 32))), 7205)   # grandchild
        self.assertEqual([r[0][:25] for r in ident.rejected], ["parent claim names no adm"] * 2)
        ident.cleanup()
        self.assertEqual(sorted(p for p, _ in t.kills), [7201, 7202, 7205]); self.assertIn(7203, t.table); self.assertIn(7204, t.table)

    def test_ident_multiple_fixtures_ending_in_any_order(self):
        ident, t = self.fake_ident({7301: 41, 7302: 42, 7303: 43, 7304: 44})
        lines = [self.rec(7301, 41), self.rec(7302, 42, parent=(7301, 41)), self.rec(7303, 43, parent=(7302, 42)),
                 self.rec(7304, 44, parent=(7301, 41))]
        del t.table[7302]; t.table[7303] = f"{oi.PREFIX}90"                    # middle ended; grandchild's pid reused
        for x in lines: ident.admit_line(x)
        del t.table[7301]                                                      # root ends after admission
        t.table[7301] = f"{oi.PREFIX}91"                                       # ... and its pid is reused before cleanup
        ident.cleanup()
        self.assertEqual(t.kills, [(7304, f"{oi.PREFIX}44")])
        self.assertEqual((t.table[7301], t.table[7303]), (f"{oi.PREFIX}91", f"{oi.PREFIX}90"), "reusers untouched")
        self.assertEqual(ident.rejected, [])

    def test_ident_cleanup_after_failure_timeout_and_cancellation(self):
        outer = self
        for exc in (AssertionError("the case's assertion failed"), subprocess.TimeoutExpired("tool", 1), KeyboardInterrupt()):
            ident, t = self.fake_ident({7401: 51, 7402: 99})
            class Inner(unittest.TestCase):
                def runTest(self):
                    self.addCleanup(ident.cleanup)  # like tearDown: runs after a failure or a timeout
                    ident.admit_line(outer.rec(7401, 51)); ident.admit_line(outer.rec(7402, 52))
                    raise exc
            res = unittest.TestResult()
            try:
                Inner().run(res)
            except KeyboardInterrupt:  # unittest re-raises it: no cleanup ran (Phase 4 leak), and nothing was signalled
                self.assertEqual(t.kills, []); ident.cleanup()
            self.assertEqual(t.kills, [(7401, f"{oi.PREFIX}51")], type(exc).__name__)
            self.assertEqual(t.table[7402], f"{oi.PREFIX}99")

    def test_ident_unknown_and_unverifiable_are_never_a_clean_cleanup(self):
        ident, t = self.fake_ident({7501: 61, 7502: 62})
        t.unreadable.add(7502)
        ident.admit_line(self.rec(7501, 61)); ident.admit_line(self.rec(7502, 62))
        self.assertEqual([u[0] for u in ident.unknown], [7502]); self.assertNotIn(7502, ident.seen)
        t.unreadable = {7501}
        ident.cleanup()
        self.assertEqual(t.kills, []); self.assertEqual([u[0] for u in ident.unverifiable], [7501])
        self.assertEqual({p[0] for p in ident.problems()}, {"unknown", "unverifiable"})

    def test_ident_problems_fail_the_case(self):
        ident, t = self.fake_ident({7701: 81})
        self.assert_clean_ownership(ident)
        for add in (lambda: ident.admit_line("7701"), lambda: ident.unknown.append((7701, "x")),
                    lambda: ident.unverifiable.append((7701, "x"))):
            ident.rejected, ident.unknown, ident.unverifiable, ident.lines = [], [], [], {}
            add()
            with self.assertRaises(AssertionError): self.assert_clean_ownership(ident)
        td = [f for f in ast.parse(open(__file__, encoding="utf8").read()).body if isinstance(f, ast.ClassDef) and f.name == "Case"][0]
        tear = [f for f in td.body if isinstance(f, ast.FunctionDef) and f.name == "tearDown"][0]
        self.assertTrue(any(isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "assert_clean_ownership" for n in ast.walk(tear)),
                        "tearDown checks ownership problems")

    def test_ident_mutation_late_admission_is_caught(self):
        """Mutation control: an Ident that looks the identity up when it reads the pid file (the round-37 defect) is
        caught by the reuse scenario - through the synthetic recorder, never through a real signal."""
        def scenario(cls):
            ident, t = None, None
            t = self.FakeTable({7601: f"{oi.PREFIX}99"})  # the fixture 7601 (identity 71) ended; its pid was reused
            ident = cls("k" * 32, backend=t)
            ident.admit_line(self.rec(7601, 71)); ident.admit_line("7601")
            ident.cleanup()
            return t.kills
        class MutantLateIdent(Ident):
            def admit_line(self, line):  # MUTANT: pid from any line, identity of the CURRENT holder (late admission)
                try:
                    pid = oi.parse_record(line, self.key)[0]
                except oi.RecordError:
                    pid = int(line) if line.isdigit() else None
                if pid is None: return None
                self._admit(pid, _Entry(self.b.table.get(pid)))
                return pid
        self.assertEqual(scenario(Ident), [], "the corrected Ident never signals the reuser")
        self.assertEqual(scenario(MutantLateIdent), [(7601, f"{oi.PREFIX}99")], "the control detects late admission")

    def test_static_ident_admission_and_signal_paths(self):
        """Source-level: a pid enters Ident.seen only in Ident._admit, called only by admit_line and record_child (and
        by mutation controls); no bare-pid record() exists; Ident and its backend never call kill/killpg; the fixture
        writes only its own record (and its blocked parent's in recordparent)."""
        with open(__file__, encoding="utf8") as fh: tree = ast.parse(fh.read())
        top = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
        ident = top["Ident"]
        meths = {f.name: f for f in ident.body if isinstance(f, ast.FunctionDef)}
        self.assertNotIn("record", meths, "no bare-pid admission method")
        writers, callers = set(), set()
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef): continue
            for n in ast.walk(fn):
                if isinstance(n, (ast.Assign, ast.AugAssign)):
                    for tg in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                        if isinstance(tg, ast.Subscript) and getattr(tg.value, "attr", None) == "seen": writers.add(fn.name)
                if isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "_admit": callers.add(fn.name)
                if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in ("record",) and \
                        getattr(getattr(n.func, "value", None), "attr", None) == "ident": self.fail(f"ident.record() in {fn.name}")
        self.assertEqual(writers, {"_admit"})
        self.assertEqual({c for c in callers if c in meths}, {"admit_line", "record_child"})
        mutation = "test_ident_mutation_late_admission_is_caught"
        for node in tree.body:  # outside Ident, only the mutation control may call _admit (its own mutant class)
            scopes = [f for f in node.body if isinstance(f, ast.FunctionDef)] if isinstance(node, ast.ClassDef) and node.name == "Case" else [node]
            for sc in scopes:
                if (isinstance(node, ast.ClassDef) and node.name == "Ident") or getattr(sc, "name", None) == mutation: continue
                self.assertFalse(any(isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "_admit" for n in ast.walk(sc)),
                                 getattr(sc, "name", type(sc).__name__))
        for cname in ("Ident", "_RealBackend"):
            for n in ast.walk(top[cname]):
                if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in ("kill", "killpg") and \
                        getattr(n.func.value, "id", None) == "os": self.fail(f"plain {n.func.attr} in {cname}")
        with open(FIX, encoding="utf8") as fh: fsrc = fh.read()
        self.assertNotIn("str(os.getpid())", fsrc, "the fixture never writes a bare pid")
        ft = ast.parse(fsrc)
        calls = [n for n in ast.walk(ft) if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in
                 ("write_own_record", "write_parent_record", "make_record")]
        self.assertEqual(sorted(c.func.attr for c in calls), ["write_own_record", "write_own_record", "write_parent_record"])
        self.assertTrue(all(len(c.args) == 1 for c in calls if c.func.attr == "write_own_record"), "own record: no pid argument")
        with open(os.path.join(HERE, "_owned_ident.py"), encoding="utf8") as fh: it = ast.parse(fh.read())
        own = [f for f in it.body if isinstance(f, ast.FunctionDef) and f.name == "write_own_record"][0]
        self.assertIn("os.getpid()", ast.unparse(own)) if hasattr(ast, "unparse") else None

    def test_ident_own_identity_matches_run_owned(self):
        """The identity a process records about itself is the value run_owned reads for that pid (same scale)."""
        me, mine = os.getpid(), oi.identity_of(os.getpid())
        self.assertIsNotNone(mine)
        if LINUX: self.assertEqual(mine, "L%d" % ro._linux_stat(me)[2])
        elif MACOS: self.assertEqual(mine, "M%d" % ro.MacOwner()._q(me)["uniqueid"])
        elif WINDOWS: self.assertRegex(mine, r"^W[0-9]+$"); self.assertEqual(oi.identity_of(me), mine)
        self.assertIsNone(oi.identity_of(2 ** 22 + 12345) if not WINDOWS else None)

    def test_ident_real_records_admit_the_fixture_and_never_a_reused_pid(self):
        """OWNED: a real fixture records itself and is stopped through the record path; a record naming a live process
        of the test with ANOTHER identity (a simulated reuse) is never admitted alive and never signalled."""
        p = subprocess.Popen([sys.executable, "-B", FIX, "solo", self.pids], env=self.env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            pids, _ = self.read_pids(1, wait=15)
            self.assertEqual(pids, [p.pid], self.ident.problems())
            self.assertEqual(self.ident.seen[p.pid].ident, oi.identity_of(p.pid))
            real = oi.identity_of(holder.pid)
            wrong = f"{oi.PREFIX}{int(real[1:]) + 1}"
            with open(self.pids, "a") as f: f.write(oi.make_record(holder.pid, wrong, None, self.key) + "\n")
            pids, _ = self.read_pids(2, wait=1)
            self.assertEqual(self.ident.reused, [(holder.pid, wrong, real)]); self.assertFalse(self.ident.alive(holder.pid))
            self.ident.cleanup()
            self.assertIsNone(holder.poll(), "the process holding the pid under another identity was never signalled")
            self.assertIsNotNone(p.wait(timeout=10), "the authenticated fixture was stopped through its pin")
            self.assertEqual(self.ident.unverifiable, [])
        finally:
            for q in (p, holder):
                if q.poll() is None: q.kill()
                q.wait(10)
    # ── Phase 2 (round 40): cleanup after tool timeouts — controls ─────────────────────────────────────────────────────
    class FakeTool:
        """Tool stand-in for synthetic Phase 2 controls: records what stop_tool asks; never reaches the OS."""
        def __init__(self, pid=7900, alive=True, ignore_term=False, unkillable=False, wait_raises=(), stop_raises=None):
            self.pid, self.alive, self.ignore_term, self.unkillable = pid, alive, ignore_term, unkillable
            self.wait_raises, self.stop_raises, self.calls = list(wait_raises), stop_raises, []
            self.returncode = None if alive else 0
        def poll(self): return None if self.alive else self.returncode
        def send_signal(self, sig):
            self.calls.append(("signal", int(sig)))
            if self.stop_raises: raise self.stop_raises
            if not self.ignore_term: self.alive, self.returncode = False, -int(sig)
        def kill(self):
            self.calls.append(("kill",))
            if self.stop_raises: raise self.stop_raises
            if not self.unkillable: self.alive, self.returncode = False, -9
        def wait(self, timeout=None):
            self.calls.append(("wait", timeout))
            if self.wait_raises: raise self.wait_raises.pop(0)
            if self.alive: raise subprocess.TimeoutExpired("fake-tool", timeout)
            return self.returncode

    @contextlib.contextmanager
    def swapped_ident(self, ident):
        saved = self.ident; self.ident = ident
        try: yield ident
        finally: self.ident = saved

    def add_fake_tool(self, **kw):
        t = self.FakeTool(**kw); self._tools.append({"p": t, "err": None, "done": False}); return t

    def test_phase2_exited_tool_is_never_signalled(self):
        t = self.add_fake_tool(alive=False)
        self._stop_all_tools(); self._stop_all_tools()
        self.assertEqual([c for c in t.calls if c[0] != "wait"], [], "no signal to a tool that already exited")
        self.assertTrue(self._tools[-1]["done"])

    def test_phase2_term_ignoring_tool_is_killed_after_grace(self):
        t = self.add_fake_tool(ignore_term=True)
        self.stop_tool(t, grace=0)
        expect = [("kill",), ("wait", 5)] if WINDOWS else [("signal", int(signal.SIGTERM)), ("wait", 5), ("kill",), ("wait", 5)]
        self.assertEqual(t.calls, expect); self.assertEqual(t.returncode, -9); self.assertEqual(self.ident.unverifiable, [])

    def test_phase2_tool_that_never_exits_is_unverifiable(self):
        with self.swapped_ident(Ident("k" * 32, backend=self.FakeTable({}))) as ident:
            t = self.add_fake_tool(ignore_term=True, unkillable=True)
            self.stop_tool(t, grace=0)
            self.assertEqual([u[0] for u in ident.unverifiable], [7900]); self.assertTrue(ident.problems())

    def test_phase2_interrupted_cleanup_is_retried(self):
        t = self.add_fake_tool(wait_raises=[KeyboardInterrupt()])
        if WINDOWS: t.kill = lambda: (t.calls.append(("kill",)), setattr(t, "alive", False), setattr(t, "returncode", -9))[0]
        with self.assertRaises(KeyboardInterrupt): self._stop_all_tools()
        self.assertFalse(self._tools[-1]["done"], "an interrupted stop is not marked done")
        self._stop_all_tools()
        self.assertTrue(self._tools[-1]["done"]); self.assertIsNotNone(t.returncode)

    def test_phase2_exception_in_one_stop_never_skips_the_others(self):
        with self.swapped_ident(Ident("k" * 32, backend=self.FakeTable({}))) as ident:
            bad = self.add_fake_tool(pid=7901, stop_raises=OSError(errno.EPERM, "synthetic"))
            good = self.add_fake_tool(pid=7902)
            self._stop_all_tools()
            self.assertIsNotNone(good.returncode, "the second tool was still stopped")
            self.assertEqual([u[0] for u in ident.unverifiable], [7901]); self.assertTrue(all(t["done"] for t in self._tools))

    def test_phase2_late_records_after_a_timeout_are_identity_checked(self):
        """After a tool timeout, records written late are admitted only by identity: a reused pid and a forged
        identity are never signalled; an unreadable one is reported (missing handle) — synthetic table, no OS calls."""
        table = self.FakeTable({7911: f"{oi.PREFIX}1", 7912: f"{oi.PREFIX}99", 7913: f"{oi.PREFIX}3", 7914: f"{oi.PREFIX}4"})
        table.unreadable.add(7914)
        with self.swapped_ident(Ident("k" * 32, backend=table)) as ident:
            with open(self.pids, "w") as f:
                for pid, n in ((7911, 1), (7912, 2), (7913, 30), (7914, 4)): f.write(self.rec(pid, n) + "\n")  # 7912 reused, 7913 forged
            t = self.add_fake_tool(ignore_term=False)
            with self.assertRaises(subprocess.TimeoutExpired):
                t.wait_raises = [subprocess.TimeoutExpired("fake-tool", 1)]
                self.finish_tool(t, 1)
            ident.cleanup()
            self.assertEqual(table.kills, [(7911, f"{oi.PREFIX}1")], "only the verified live record is stopped")
            self.assertEqual((table.table[7912], table.table[7913]), (f"{oi.PREFIX}99", f"{oi.PREFIX}3"))
            self.assertEqual([u[0] for u in ident.unknown], [7914]); self.assertTrue(ident.problems())

    def phase2_observer_check(self, n):
        """An independent observer (same key, fresh Ident) admits the case's records and must find none alive BEFORE
        tearDown runs (so tearDown cannot mask a leak). Non-vacuous: it must have admitted n records."""
        obs = Ident(self.key)
        try:
            pids, _, _ = scan_pidfile(obs, self.pids)
            self.assertEqual(len(pids), n, obs.problems())
            end = time.time() + 10
            while obs.alive_all() and time.time() < end: time.sleep(0.05)
            self.assertEqual(obs.alive_all(), [], "the tool's tree outlived the tool's timeout")
            self.assertEqual(obs.problems(), [])
        finally:
            obs.cleanup()  # releases Windows handles; stops nothing unless the assertion above already failed

    def test_phase2_normal_exit_sends_no_signal(self):
        p, rep = self.start_tool("--", sys.executable, "-c", "pass")
        self.assertEqual(self.finish_tool(p, 60), 0)
        sent = []
        p.send_signal = lambda sig: sent.append(sig); p.kill = lambda: sent.append("kill")
        self._stop_all_tools()
        self.assertEqual(sent, []); self.assertIsNone(p.stderr, "stderr is a file, not a pipe")
        self.assertTrue(os.path.exists(self._tools[-1]["err"]))

    def test_phase2_foreground_timeout_stops_the_tool_and_its_tree(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.tool("--grace", "1", "--", *self.fixture("tree"), timeout=4)  # the tool itself has no --timeout
        p = self._tools[-1]["p"]
        self.assertIsNotNone(p.returncode, "the timed-out tool was stopped and reaped")
        if not WINDOWS: self.assertEqual(p.returncode, 128 + signal.SIGTERM, self.tool_stderr(p))
        self.phase2_observer_check(3)

    def test_phase2_background_wait_timeout_stops_tool_then_fixtures(self):
        p, rep = self.tool("--grace", "1", "--", *self.fixture("tree"), background=True)
        self.read_pids(3)
        with self.assertRaises(subprocess.TimeoutExpired): self.finish_tool(p, 2)
        self.assertIsNotNone(p.returncode)
        self.phase2_observer_check(3)

    @unittest.skipIf(WINDOWS, "POSIX: SIGTERM step")
    def test_phase2_real_tool_ignoring_term_is_killed(self):
        ready, script = os.path.join(self.dir, "ready"), os.path.join(self.dir, "ignore_term.py")
        with open(script, "w") as f:
            f.write("import signal, sys, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(sys.argv[1], 'w').close()\ntime.sleep(60)\n")
        p = self._start_cmd([sys.executable, script, ready])
        end = time.time() + 15
        while not os.path.exists(ready) and time.time() < end: time.sleep(0.02)
        self.assertTrue(os.path.exists(ready), "the TERM-ignoring tool is ready (handshake)")
        self.stop_tool(p, grace=0)
        self.assertEqual(p.returncode, -signal.SIGKILL); self.assertEqual(self.ident.unverifiable, [])

    def test_phase2_tool_stderr_leaves_no_open_pipe(self):
        """F2 dependency of Phase 2: tool stderr is a file. Positive: a tool run leaves no ResourceWarning. Negative
        (harness check): this test's own child with an unread, unclosed stderr pipe does produce one."""
        import gc, warnings
        def warns(run):
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always", ResourceWarning)
                run(); gc.collect()
            return [x for x in w if issubclass(x.category, ResourceWarning)]
        def tool_run():
            p, _ = self.start_tool("--", sys.executable, "-c", "pass"); self.finish_tool(p, 60); self._stop_all_tools()
        def leaky_run():
            q = subprocess.Popen([sys.executable, "-c", "pass"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE); q.wait(30)
        self.assertEqual(warns(tool_run), [])
        self.assertTrue(warns(leaky_run), "the ResourceWarning harness detects an unclosed pipe")

    def test_static_tool_processes_only_through_start(self):
        """Every process started with TOOL goes through _start_cmd; the Phase 2 helpers never call os.kill/os.killpg."""
        with open(__file__, encoding="utf8") as fh: tree = ast.parse(fh.read())
        case = [c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == "Case"][0]
        starters = set()
        for fn in (f for f in case.body if isinstance(f, ast.FunctionDef)):
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in ("Popen", "run", "call", "check_call", "check_output") \
                        and any(isinstance(a, ast.Name) and a.id == "TOOL" for a in ast.walk(n)):
                    starters.add(fn.name)
                if fn.name in ("_start_cmd", "start_tool", "finish_tool", "stop_tool", "_stop_all_tools") and isinstance(n, ast.Call) \
                        and getattr(n.func, "attr", None) in ("kill", "killpg") and getattr(n.func.value, "id", None) == "os":
                    self.fail(f"os.{n.func.attr} in {fn.name}")
        self.assertEqual(starters - {"_start_cmd", "start_tool"}, set(), "a tool process started outside start_tool")
        start = [f for f in case.body if isinstance(f, ast.FunctionDef) and f.name == "start_tool"][0]
        self.assertTrue(any(isinstance(n, ast.Name) and n.id == "TOOL" for n in ast.walk(start)))

    # ── Phase 2 round 42 controls ──
    def test_phase2_cleanup_is_registered_before_the_test_body(self):
        """The tools' stop is registered with addCleanup in setUp, so it also runs when tearDown itself fails."""
        self.assertTrue(any(getattr(f, "__func__", None) is Case._stop_all_tools for f, _a, _k in self._cleanups),
                        "setUp must register _stop_all_tools with addCleanup")

    def test_phase2_windows_branch_kills_through_the_handle(self):
        """Synthetic, on every platform: with WINDOWS set, stop_tool calls the handle's kill() (TerminateProcess), never
        send_signal; with it cleared, the POSIX order is SIGTERM, wait, kill, wait. No OS call (FakeTool)."""
        g = globals(); saved = g["WINDOWS"]
        try:
            g["WINDOWS"] = True
            t = self.add_fake_tool(ignore_term=True); self.stop_tool(t, grace=0)
            self.assertEqual(t.calls, [("kill",), ("wait", 5)])
            g["WINDOWS"] = False
            u = self.add_fake_tool(ignore_term=True); self.stop_tool(u, grace=0)
            self.assertEqual(u.calls, [("signal", int(signal.SIGTERM)), ("wait", 5), ("kill",), ("wait", 5)])
        finally:
            g["WINDOWS"] = saved

    def test_phase2_case_dir_removal_is_bounded_and_reported(self):
        """A folder that cannot be removed is reported with its path after bounded retries (never silently abandoned);
        a transient failure is retried. Synthetic remover; only this test's own sub-folder is touched."""
        saved = self.dir
        sub = tempfile.mkdtemp(prefix="sub-", dir=saved)
        try:
            self.dir = sub
            calls = []
            def stuck(path): calls.append(path); raise PermissionError(errno.EACCES, "synthetic: file in use")
            msg = self._remove_case_dir(rmtree=stuck, attempts=3, delay=0)
            self.assertEqual(len(calls), 3); self.assertIn(sub, msg or ""); self.assertIn("PermissionError", msg or "")
            once = []
            def flaky(path):
                if not once: once.append(1); raise PermissionError(errno.EACCES, "synthetic: transient")
                shutil.rmtree(path)
            self.assertIsNone(self._remove_case_dir(rmtree=flaky, attempts=3, delay=0)); self.assertFalse(os.path.exists(sub))
        finally:
            self.dir = saved

    def test_static_teardown_stops_tools_before_pinned_cleanup(self):
        """tearDown stops the tools first (run_owned stops its own tree on SIGTERM), then the case's pinned cleanup."""
        with open(__file__, encoding="utf8") as fh: tree = ast.parse(fh.read())
        case = [c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == "Case"][0]
        td = [f for f in case.body if isinstance(f, ast.FunctionDef) and f.name == "tearDown"][0]
        first = td.body[0]
        self.assertTrue(isinstance(first, ast.Expr) and isinstance(first.value, ast.Call)
                        and getattr(first.value.func, "attr", None) == "_stop_all_tools", "tearDown's first statement")
        calls = [n for n in ast.walk(td) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        stop = min(c.lineno for c in calls if c.func.attr == "_stop_all_tools")
        pinned = min(c.lineno for c in calls if c.func.attr == "cleanup")
        self.assertLess(stop, pinned)

    def test_static_untracked_interpreters_inventory(self):
        """Every Case method that starts a process with subprocess directly (not a tracked tool) is listed in
        UNTRACKED_STARTERS, so a new untracked start is a reviewed change, not an accident."""
        with open(__file__, encoding="utf8") as fh: tree = ast.parse(fh.read())
        case = [c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == "Case"][0]
        found = set()
        for fn in (f for f in case.body if isinstance(f, ast.FunctionDef)):
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and getattr(n.func.value, "id", None) == "subprocess" \
                        and n.func.attr in ("Popen", "run", "call", "check_call", "check_output"):
                    found.add(fn.name)
        self.assertEqual(found - {"_start_cmd"}, UNTRACKED_STARTERS)

if __name__ == "__main__":
    print(f"run_owned self-tests on {sys.platform}, Python {sys.version.split()[0]}", flush=True)
    unittest.main(verbosity=2)
