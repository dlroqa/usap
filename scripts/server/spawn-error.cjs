// spawn-error.cjs — turn an engine launch failure into a safe, actionable message (#68).
//
// When an engine file exists but can't be started (not executable, a folder, a drive that doesn't allow running
// programs), Node reports it as an "error" event on the child process instead of an exit. Every engine listens for
// it, so the server keeps running, the start fails like any other failed launch, and the next start can succeed.
// The message names no path; the server log keeps the full details for troubleshooting on this computer.
"use strict";

function describeSpawnError(err, engineLabel) {
  const code = String((err && err.code) || "");
  let hint;
  if (code === "EACCES" || code === "EPERM") {
    hint = "The engine file can't be run: it isn't marked as a program, or the drive doesn't allow running programs. Run setup again, or keep the studio on a drive that keeps file permissions (not FAT32 or exFAT).";
  } else if (code === "ENOENT" || code === "ENOTDIR") {
    hint = "The engine file is missing. Run setup again.";
  } else if (code === "ENOEXEC" || code === "EFTYPE" || code === "UNKNOWN") {
    hint = "The engine file isn't a program this computer can run (damaged, or built for another system). Run setup again.";
  } else {
    hint = "Run setup again to reinstall it.";
  }
  return `Could not start the ${engineLabel}${code ? ` (${code})` : ""}. ${hint}`;
}

/** True when the "error" event means the process never started (no pid), not a later kill or IPC error. */
function isLaunchFailure(proc) {
  return !proc || !proc.pid;
}

module.exports = { describeSpawnError, isLaunchFailure };
