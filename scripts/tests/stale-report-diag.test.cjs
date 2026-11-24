// Stale-file report diagnostics (fixtures/stale-report-diag.cjs): each way the server test could find matched 0 reads
// differently. The REAL report module is run on a real temporary folder; causes are injected only through its own
// fs and clock parameters. Messages only: nothing here changes the report or a verdict.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStaleFileReport, MAX_MS } = require("../server/services/stale-file-report.cjs");
const { describeStaleReport } = require("./fixtures/stale-report-diag.cjs");

const STAMP = "2026-11-20T15-35-46-120Z";
function folder() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "usap-stalediag-"));
  const data = path.join(base, "app"), tx = path.join(data, "transcriptions");
  fs.mkdirSync(tx, { recursive: true });
  fs.writeFileSync(path.join(tx, "transcript-2026-11-20T15-35-46-120Z-user.wav.json"), "{}");
  fs.writeFileSync(path.join(tx, `.speech-${STAMP}-left.wav`), "left behind");
  return { data, tx, rm: () => fs.rmSync(base, { recursive: true, force: true }) };
}
// Lists the transcript first, then the legacy file, whatever the platform's directory order.
const ordered = (real) => ({ ...real, promises: { ...real.promises, opendir: async (d) => { const names = fs.readdirSync(d).sort((a) => (a.startsWith("transcript") ? -1 : 1)); let i = 0; return { [Symbol.asyncIterator]() { return { next: async () => (i < names.length ? { value: { name: names[i++] }, done: false } : { value: undefined, done: true }) }; }, close: async () => {} }; } } });
const run = async (d, extra = {}) => createStaleFileReport({ setting: { mode: "report" }, dataRoot: d.data, transcriptions: d.tx, ...extra }).run();

test("stale report diag: a normal run, a truncated scan, an lstat error, a missing entry, an absent folder and an absent file read differently", async () => {
  const d = folder();
  try {
    const ok = describeStaleReport(await run(d), { files: [{ category: "legacy", present: true, unchanged: true }], entries: { legacy: 1, transcript: 1, other: 0 } });
    assert.match(ok, /legacy folder: state scanned, scanned 2, matched 1, .*truncated false, errors none/);

    // the time budget runs out after the first entry (the clock jumps past MAX_MS): truncated, matched 0
    let tick = 0; const clock = () => (tick++ < 2 ? 0 : MAX_MS + 1);
    const truncated = describeStaleReport(await run(d, { fs: ordered(fs), clock }));
    assert.match(truncated, /scanned 1, matched 0, .*truncated true/);

    // lstat of the legacy file fails (as a sharing or permission error could): counted as an error, matched 0
    const busy = { ...ordered(fs), lstatSync: (p, ...a) => { if (String(p).includes(".speech-")) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return fs.lstatSync(p, ...a); } };
    assert.match(describeStaleReport(await run(d, { fs: busy })), /scanned 2, matched 0, .*truncated false, errors EBUSY 1/);

    // the listing returns only the transcript: scanned 1, not truncated, no error
    const short = { ...fs, promises: { ...fs.promises, opendir: async () => { let done = false; return { [Symbol.asyncIterator]() { return { next: async () => (done ? { done: true, value: undefined } : (done = true, { value: { name: "transcript-2026-11-20T15-35-46-120Z-user.wav.json" }, done: false })) }; }, close: async () => {} }; } } };
    assert.match(describeStaleReport(await run(d, { fs: short })), /scanned 1, matched 0, .*truncated false, errors none/);

    // the test's own view when its file is gone
    assert.match(describeStaleReport(await run(d), { files: [{ category: "legacy", present: false, unchanged: false }] }), /test's files now: legacy ABSENT/);
  } finally { d.rm(); }
  const gone = folder(); gone.rm();
  assert.match(describeStaleReport(await createStaleFileReport({ setting: { mode: "report" }, dataRoot: gone.data, transcriptions: gone.tx }).run()), /report state data-folder-unreadable|legacy folder: state absent/);
  assert.equal(describeStaleReport(undefined), "report snapshot absent");
  assert.doesNotMatch(describeStaleReport({ legacyTranscriptionTemporaries: { state: "scanned", errors: { "a/b\\c": 1 } } }), /[\\/]/, "no path characters");
});
