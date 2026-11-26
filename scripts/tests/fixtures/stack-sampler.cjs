// #151 diagnostics (test-only, messages only, opt-in): stack sampling of a process's MAIN THREAD while it runs, so a
// main-thread stall is seen from inside the stall, not reconstructed afterwards. macOS only (`/usr/bin/sample`); on
// other platforms it reports "not run". Off unless a caller asks for it: refusal-clients.cjs starts it only when its
// arguments carry `stackSample` (set only by the json-413 concurrent test on macOS), BEFORE any request is sent.
// If `sample` cannot attach without privileges it tries `sudo -n` (non-interactive; GitHub's macOS runners allow it)
// and otherwise reports why it is unavailable. Output is one bounded line: how it ran and the main thread's leaf
// frames (exclusive sample counts), function and library names only - no addresses, offsets or paths.
// Limitation: `sample` aggregates; it shows where the main thread spent its samples over the window, not when.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_FRAMES = 8;
const SAMPLE = "/usr/bin/sample";

// Parse `sample` output: the main thread's call graph (the thread whose header names com.apple.main-thread, else the
// first thread) -> { total, leaves: [[name, exclusiveCount], ...] } sorted by count. Depth = column of the count.
function parseMainThread(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^Call graph:/.test(l.trim()));
  if (start < 0) return null;
  const threads = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim()) { if (cur) break; continue; }
    if (/^\S/.test(l)) break; // next section
    const m = /^(\s*)([+!:| ]*?)(\d+)\s+(.+)$/.exec(l);
    if (!m) continue;
    const depth = m[1].length + m[2].length;
    if (/^Thread_\d+/.test(m[4]) && m[2].trim() === "") { cur = { header: m[4], total: Number(m[3]), depth, nodes: [] }; threads.push(cur); continue; }
    if (cur) cur.nodes.push({ depth, count: Number(m[3]), text: m[4] });
  }
  if (!threads.length) return null;
  const main = threads.find((t) => /com\.apple\.main-thread/.test(t.header)) || threads[0];
  const stack = [], exclusive = new Map();
  const nodes = main.nodes.map((n) => ({ ...n, childSum: 0 }));
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].childSum += n.count;
    stack.push(n);
  }
  for (const n of nodes) {
    const ex = n.count - n.childSum;
    if (ex <= 0) continue;
    const name = cleanFrame(n.text);
    exclusive.set(name, (exclusive.get(name) || 0) + ex);
  }
  const leaves = [...exclusive.entries()].sort((a, b) => b[1] - a[1]);
  return { total: main.total, isMain: /com\.apple\.main-thread/.test(main.header), leaves };
}

// "kevent  (in libsystem_kernel.dylib) + 10  [0x7ff8...]" -> "kevent (libsystem_kernel.dylib)"; no paths or addresses.
function cleanFrame(text) {
  const m = /^(.*?)\s+\(in ([^)]+)\)/.exec(text);
  let fn = (m ? m[1] : text).replace(/\s*\+\s*\d+.*$/, "").replace(/\[0x[0-9a-f]+\]/gi, "").trim();
  let lib = m ? m[2] : "";
  if (/[\\/]/.test(fn)) fn = fn.replace(/\S*[\\/]\S*/g, "PATH");
  lib = lib.replace(/\S*[\\/]/g, "");
  if (fn.length > 60) fn = `${fn.slice(0, 57)}...`;
  return `${fn || "?"}${lib ? ` (${lib.slice(0, 30)})` : ""}`.replace(/[^A-Za-z0-9 _.:()<>,~*&+-]/g, "");
}

function summarize(parsed, how) {
  if (!parsed) return `${how}; no call graph in the output`;
  const top = parsed.leaves.slice(0, MAX_FRAMES).map(([n, c]) => `${n} ${c}`).join(", ");
  return `${how}; ${parsed.isMain ? "main thread" : "first thread (main not named)"} ${parsed.total} samples; leaf frames: ${top || "none"}`;
}

/**
 * @param {{pid?: number, seconds?: number, intervalMs?: number, platform?: string, sampleBin?: string, allowSudo?: boolean}} o
 *        platform / sampleBin / allowSudo: controls only (stack-sampler.test.cjs runs a stand-in `sample`, never sudo)
 * @returns {{ ready: Promise<{ok:boolean, how?:string, reason?:string}>, finish: () => Promise<string> }}
 */
function startStackSampler({ pid = process.pid, seconds = 10, intervalMs = 10, platform = process.platform, sampleBin = SAMPLE, allowSudo = true } = {}) {
  if (platform !== "darwin") return { ready: Promise.resolve({ ok: false, reason: "not macOS" }), finish: async () => "not run (not macOS)" };
  const file = path.join(os.tmpdir(), `usap-stack-${pid}-${Date.now()}.txt`);
  const args = [String(pid), String(seconds), String(intervalMs), "-mayDie", "-file", file];
  let child = null, how = null, done = null;
  const attempt = (cmd, cmdArgs, label) => new Promise((resolve) => {
    let out = "", settled = false;
    let c;
    try { c = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] }); } catch (_) { resolve({ ok: false, reason: `${label} could not start` }); return; }
    const exited = new Promise((r) => c.once("close", (code) => r(code)));
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const onData = (d) => { if (out.length < 4000) out += d; if (/Sampling process/.test(out)) { child = c; how = label; done = exited; finish({ ok: true, how: label }); } };
    c.stdout.on("data", onData); c.stderr.on("data", onData);
    c.on("error", () => finish({ ok: false, reason: `${label} could not start` }));
    exited.then((code) => finish({ ok: false, reason: `${label} exited ${code}: ${out.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)}` }));
    const timer = setTimeout(() => { try { c.kill(); } catch (_) {} finish({ ok: false, reason: `${label} did not start within 5 s` }); }, 5000);
  });
  const ready = (async () => {
    const first = await attempt(sampleBin, args, "sample");
    if (first.ok) return first;
    if (allowSudo && typeof process.getuid === "function" && process.getuid() !== 0) {
      const second = await attempt("sudo", ["-n", sampleBin, ...args], "sudo -n sample");
      if (second.ok) return second;
      return { ok: false, reason: `${first.reason}; ${second.reason}` };
    }
    return first;
  })();
  const finish = async () => {
    const r = await ready;
    if (!r.ok) return `unavailable (${r.reason})`;
    const code = await Promise.race([done, new Promise((res) => setTimeout(() => res("timeout"), (seconds + 15) * 1000))]);
    if (code === "timeout") { try { child.kill(); } catch (_) {} }
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (err) { return `${how} ${intervalMs} ms x ${seconds} s; output unreadable (${(err && err.code) || "?"})`; }
    try { fs.rmSync(file, { force: true }); } catch (_) { /* sudo may own it */ }
    return summarize(parseMainThread(text), `${how} ${intervalMs} ms x ${seconds} s${code === "timeout" ? " (stopped late)" : ""}`).slice(0, 900);
  };
  return { ready, finish };
}

module.exports = { startStackSampler, parseMainThread, cleanFrame, summarize };
