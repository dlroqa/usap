// restart-policy.cjs — when may a crashed text engine be restarted automatically? (Step 9.6)
//
// Conservative by design:
//   * at most `limit` restarts within `windowMs`, with exponential backoff (1 s, 2 s, 4 s);
//   * never when the engine ran out of memory: reloading the same model would fail the same way and
//     keep the machine under memory pressure;
//   * never when there is less free memory than the model file needs (this also covers a Linux
//     OOM-killer SIGKILL, which leaves no message);
//   * never when automatic restarts are turned off.
"use strict";

// Messages llama.cpp / ggml / GPU runtimes print when an allocation fails.
const OUT_OF_MEMORY_RE = /out of memory|failed to allocate|unable to allocate|cannot allocate memory|std::bad_alloc|cudaMalloc failed|ErrorOutOfDeviceMemory|OutOfDeviceMemory|insufficient memory|not enough memory|ggml_backend_\w*alloc\w*.*fail/i;
// Windows STATUS_NO_MEMORY (0xC0000017) and STATUS_COMMITMENT_LIMIT (0xC000012D), as unsigned and signed exit codes.
const WINDOWS_NO_MEMORY_CODES = new Set([0xC0000017, 0xC0000017 - 0x100000000, 0xC000012D, 0xC000012D - 0x100000000]);

function isOutOfMemory({ code = null, stderrTail = "" } = {}) {
  return OUT_OF_MEMORY_RE.test(String(stderrTail || "")) || WINDOWS_NO_MEMORY_CODES.has(Number(code));
}

/**
 * @returns {{ restart: true, delayMs: number } | { restart: false, reason: string, message: string }}
 */
function decideRestart({
  autoRestart = true,
  attempts = [],          // timestamps of earlier automatic restarts
  now = Date.now(),
  limit = 3,
  windowMs = 10 * 60 * 1000,
  code = null,
  stderrTail = "",
  modelBytes = 0,         // size of the model file(s) to reload
  freeBytes = Infinity,   // os.freemem()
} = {}) {
  const recent = attempts.filter((t) => now - t < windowMs);
  if (!autoRestart) return { restart: false, reason: "disabled", message: "Automatic restart is turned off." };
  if (isOutOfMemory({ code, stderrTail })) {
    return { restart: false, reason: "out-of-memory", message: "It ran out of memory, so it was not restarted. Close other programs, or choose a smaller model or a shorter context." };
  }
  if (modelBytes > 0 && freeBytes < modelBytes) {
    return { restart: false, reason: "low-memory", message: `Only ${(freeBytes / 1073741824).toFixed(1)} GB of memory is free, less than the model needs (${(modelBytes / 1073741824).toFixed(1)} GB), so it was not restarted.` };
  }
  if (recent.length >= limit) {
    return { restart: false, reason: "limit", message: `It was restarted ${recent.length} times in the last ${Math.round(windowMs / 60000)} minutes and was not restarted again.` };
  }
  return { restart: true, delayMs: 1000 * 2 ** recent.length };
}

module.exports = { decideRestart, isOutOfMemory };
