"use strict";
// Issue #120 (part A): how an image-engine process ended, so that the studio can tell a stop it asked for from an
// engine that went away on its own. Before this, an engine that exited with code 0 after "READY" left no error (the
// model silently vanished), and a requested stop on Windows (guard -> taskkill /T /F -> exit code 1) left a false
// "exited with code 1" error. Pure function; image-engine.cjs applies the result to the current engine only (an exit
// of a replaced, stale engine is ignored there, as before).
//
//   kind "requested"              the studio asked this process to stop (killBackend): never a new error
//   kind "unexpected-after-ready" it had reported READY and was not asked to stop
//   kind "startup-failure"        it ended before READY and was not asked to stop
//
//   reason "exit-code"   non-zero exit code: the caller keeps its existing description (describeBackendExitCode)
//   reason "signal"      a signal other than SIGTERM/SIGKILL (e.g. SIGABRT): the caller keeps its existing message
//   reason "clean-exit"  exit code 0 that nobody asked for: `message` is the new error text
//   reason "terminated"  SIGTERM/SIGKILL (or no code and no signal) that the studio did not send: `message` is new

const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/;

function safeSignal(signal) {
  return typeof signal === "string" && SIGNAL_NAME.test(signal) ? signal : "unknown";
}

function classifyImageExit({ stopRequested = false, wasReady = false, code = null, signal = null } = {}) {
  const ready = wasReady === true;
  if (stopRequested === true) return { kind: "requested", reason: "requested", wasReady: ready, message: null };
  const kind = ready ? "unexpected-after-ready" : "startup-failure";
  if (Number.isInteger(code) && code !== 0) return { kind, reason: "exit-code", wasReady: ready, message: null };
  if (signal && signal !== "SIGTERM" && signal !== "SIGKILL") return { kind, reason: "signal", wasReady: ready, message: null };
  if (code === 0) {
    return {
      kind, reason: "clean-exit", wasReady: ready,
      message: ready
        ? "The image engine stopped unexpectedly after it was ready (exit code 0); the studio did not ask it to stop. Load the model again. If this happens again, the server log shows the engine's last lines."
        : "The image engine exited during start-up (exit code 0) before it was ready. Try loading the model again. If this happens again, the server log shows the engine's last lines.",
    };
  }
  const how = signal ? `signal ${safeSignal(signal)}` : "no exit code";
  return {
    kind, reason: "terminated", wasReady: ready,
    message: ready
      ? `The image engine was terminated unexpectedly after it was ready (${how}); the studio did not stop it. This can happen when the system runs out of memory. Load the model again.`
      : `The image engine was terminated during start-up (${how}); the studio did not stop it. This can happen when the system runs out of memory. Try loading the model again.`,
  };
}

// The exit of a process that is no longer the current engine (replaced, or already cleared) is stale: it must not
// touch the current engine's state or error, whatever it was. Otherwise it is classified. The "asked to stop" marker
// is a property of that process object, so an old engine's stop can never be read as the new engine's.
function imageExitOutcome({ current, proc, wasReady, code, signal }) {
  if (!proc || current !== proc) return { stale: true, kind: "stale", reason: "stale", wasReady: false, message: null };
  return { stale: false, ...classifyImageExit({ stopRequested: proc.usapStopRequested === true, wasReady, code, signal }) };
}

module.exports = { classifyImageExit, imageExitOutcome };
