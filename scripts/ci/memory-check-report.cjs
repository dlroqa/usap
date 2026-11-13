#!/usr/bin/env node
// Step 9.9d native evidence: checks the warn-only memory result of a real model load on this runner and prints
// one "STATUS<TAB>name<TAB>detail" line for scripts/ci/runtime-validate.sh.
//
//   node memory-check-report.cjs text|image [server-log] < start-response.json
//
// PASS means the check ran as designed on this OS: an advisory, unenforced result with measured memory and the
// expected estimate parts, no paths or names, and (when a log is given) one log line. The verdict itself (e.g.
// "likely-fits" or "tight") is reported in the detail, not judged: the model loaded either way, which is the point.
"use strict";
const fs = require("fs");

const kind = process.argv[2];
const logPath = process.argv[3];
const name = kind === "image" ? "Memory check, image load (9.9d, warn only)" : "Memory check, text load (9.9d, warn only)";
const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", () => {
  const problems = [];
  let body = null;
  try { body = JSON.parse(raw); } catch (_) { problems.push("start response is not JSON"); }
  const m = body && body.memoryCheck;
  if (!m) problems.push("no memoryCheck in the start response");
  else {
    if (m.advisory !== true || m.enforced !== false || m.mode !== "warn") problems.push("not advisory/unenforced");
    if (m.workload !== `${kind}-model-load`) problems.push(`workload ${m.workload}`);
    if (!m.available || !m.available.ramBytes.known || !m.available.totalRamBytes.known) problems.push("available memory not measured on this OS");
    if (!m.required || !m.required.lowerBoundBytes.known) problems.push("model file size not measured");
    if (kind === "text") {
      if (!m.required.estimateBytes.known) problems.push(`no estimate (${m.reasons.join(", ")})`);
      if (m.required.contextSize !== 2048) problems.push(`context ${m.required.contextSize}, expected 2048`);
      if (!["likely-fits", "tight", "may-not-fit"].includes(m.verdict)) problems.push(`verdict ${m.verdict} with known inputs`);
    } else {
      if (!m.reasons.includes("compute-memory-unknown")) problems.push("image working memory not marked unknown");
      if (m.verdict === "likely-fits") problems.push("image said likely-fits without a working-memory estimate");
    }
    const text = JSON.stringify(m);
    if (/qwen|sd1|stable|\.gguf|\.safetensors|[A-Za-z]:\\\\|\/(home|Users|tmp|var|private|runner)\//i.test(text)) problems.push("a name or path appears in the result");
  }
  if (logPath && fs.existsSync(logPath)) {
    const what = kind === "image" ? "Image model" : "Text model";
    if (!fs.readFileSync(logPath, "utf8").includes(`[memory] ${what}:`)) problems.push("no [memory] log line");
  }
  let detail = problems.join("; ");
  if (m && m.available) {
    const est = m.required && m.required.estimateBytes.known ? `estimate ${gb(m.required.estimateBytes.value)}` : "estimate unknown";
    const parts = m.required && m.required.parts && m.required.parts.kvCacheBytes && m.required.parts.kvCacheBytes.known ? ` (files ${gb(m.required.parts.weightsBytes.value)} + KV ${gb(m.required.parts.kvCacheBytes.value)} + allowance)` : m.required && m.required.lowerBoundBytes.known ? ` (files ${gb(m.required.lowerBoundBytes.value)})` : "";
    const have = m.available.ramBytes.known ? `${gb(m.available.ramBytes.value)} available, measured (${m.available.ramBytes.source || "?"})` : "available unknown";
    const total = m.available.totalRamBytes.known ? `, total ${gb(m.available.totalRamBytes.value)}` : "";
    detail = `${detail ? `${detail} | ` : ""}verdict ${m.verdict}; ${est}${parts}; ${have}${total}; pool ${m.memoryPool}${m.reasons.length ? `; reasons ${m.reasons.join(",")}` : ""}; model loaded`;
  }
  console.log(`${problems.length ? "FAIL" : "PASS"}\t${name}\t${detail}`);
});
