// services/image-port.cjs — choosing the port for a replacement image engine when engineSlot is on (#170).
//
// Order (the text engine already works this way: llm-engine.cjs waits for exits, then picks its port, and waits for
// the old port's release after a stop):
//   1. wait (bounded) until every earlier image engine process has a confirmed exit — before any port is checked;
//   2. if the wanted port is busy and it is the port our previous image engine used, wait (bounded) for its release;
//   3. otherwise, or if it is still busy, use the existing backup range, each port verified free before it is chosen.
// A port taken by another program is not waited for (the backup range is used at once, as before). Nothing here
// retries a failed engine start: a bind that still fails afterwards is reported as a normal load failure.
// Used only when engineSlot is on; with engineSlot off image-engine.cjs keeps its earlier code path unchanged.
"use strict";

const FALLBACK_FIRST = 28088;
const FALLBACK_LAST = 28120;
const EXIT_WAIT_MS = 5000;      // as before (slot.waitForExits("image", 5000))
const RELEASE_WAIT_MS = 5000;   // as the text engine's release wait after a stop (llm-engine.cjs)
const RELEASE_POLL_MS = 150;    // as waitForPortAvailable in serve.cjs

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFree(checkPort, port) {
  try { return Boolean((await checkPort(port)).available); } catch (_) { return false; }
}

/**
 * @param {object} o
 * @param {object} o.slot                         engine slot (waitForExits, unconfirmedError)
 * @param {number} o.wantedPort                   preferred port, or the explicitly requested one
 * @param {number|null} o.previousPort            port of the image engine this server started last (null: none)
 * @param {(port:number)=>Promise<{available:boolean}>} o.checkPort
 * @param {()=>boolean} [o.isCancelled]           a stop request arrived: end before any spawn
 * @param {()=>Error} [o.cancelledError]
 * @returns {Promise<{port:number, waitedForReleaseMs:number, fellBack:boolean, reason:string}>}
 */
async function selectImagePort({
  slot, wantedPort, previousPort = null, checkPort, isCancelled = () => false,
  cancelledError = () => Object.assign(new Error("Loading the image model was stopped."), { code: "ENGINE_START_CANCELLED", statusCode: 409 }),
  exitWaitMs = EXIT_WAIT_MS, releaseWaitMs = RELEASE_WAIT_MS, pollMs = RELEASE_POLL_MS,
  fallbackFirst = FALLBACK_FIRST, fallbackLast = FALLBACK_LAST, now = Date.now, sleep = sleepMs, log = console,
}) {
  const stopIfCancelled = () => { if (isCancelled()) throw cancelledError(); };
  // 1. Earlier image engines first: no port is checked while one of them may still be running or binding.
  if (!(await slot.waitForExits("image", exitWaitMs))) throw slot.unconfirmedError("image");
  stopIfCancelled();
  // 2. The wanted port, waiting for its release only when our own previous engine had it.
  if (await isFree(checkPort, wantedPort)) { stopIfCancelled(); return { port: wantedPort, waitedForReleaseMs: 0, fellBack: false, reason: "free" }; }
  stopIfCancelled();
  let waited = 0;
  if (previousPort !== null && previousPort === wantedPort) {
    const start = now();
    const end = start + releaseWaitMs;
    while (now() < end) {
      await sleep(Math.max(1, Math.min(pollMs, end - now())));
      stopIfCancelled();
      if (await isFree(checkPort, wantedPort)) {
        stopIfCancelled();
        return { port: wantedPort, waitedForReleaseMs: now() - start, fellBack: false, reason: "released" };
      }
      stopIfCancelled();
    }
    waited = now() - start;
    log.warn(`  [backend] Port ${wantedPort} was still busy ${waited} ms after the previous image engine exited; using the backup range.`);
  }
  // 3. The backup range, each port verified free.
  for (let port = fallbackFirst; port <= fallbackLast; port += 1) {
    if (port === wantedPort) continue;
    if (await isFree(checkPort, port)) {
      stopIfCancelled();
      log.log(`  [backend] Preferred port ${wantedPort} is busy; using ${port} instead.`);
      return { port, waitedForReleaseMs: waited, fellBack: true, reason: waited ? "not-released" : "busy" };
    }
    stopIfCancelled();
  }
  throw new Error(`No free backend port found. Tried ${wantedPort} and ${fallbackFirst}-${fallbackLast}.`);
}

module.exports = { selectImagePort, FALLBACK_FIRST, FALLBACK_LAST, EXIT_WAIT_MS, RELEASE_WAIT_MS, RELEASE_POLL_MS };
