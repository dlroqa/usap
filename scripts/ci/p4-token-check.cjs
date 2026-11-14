#!/usr/bin/env node
// P4-1 real-model document check (called by runtime-validate.sh while Qwen2.5 0.5B is loaded).
//
// Why not just compare two app requests: every request gets a fresh random 12-hex marker id that appears several
// times in the prompt, and different ids tokenize to different lengths, so two requests differ by a few tokens even
// when their documents are handled identically. The production id stays random; this check removes the noise in
// its own copy of the prompt instead:
//
//   1. Deterministic gate: the server's own code (services/attachments.cjs) prepares and marks the document, then
//      THIS TEST replaces the random id with a fixed one in its copy. A document of 40 real control tokens and one of
//      40 literal "[token removed]" strings must give byte-identical messages, with no known control token left in
//      the document block, and exactly the same prompt-token count from the real model (zero tolerance).
//   2. Negative control: the same marked prompt with the tokens left in (what would be sent without
//      neutralization) must give at least 40 FEWER prompt tokens on the real model: each of the 40 strings is read as
//      ONE control token, while each literal "[token removed]" takes at least two. (Strings kept as plain text would
//      make the prompt longer instead.) So the exact gate would catch control tokens reaching the engine.
//   3. End to end through the app API (documents=mark), exact. The installed server's ids are random, and two
//      12-hex ids can tokenize to lengths 6-12 apart (more in context, where the id can merge with the "=" before
//      it), so comparing two of its requests needs a tolerance that a random pair can exceed (#102). Instead the
//      check starts its own short-lived test server (port 14940, `--port`) from the same code with
//      USAP_PROMPT_DOCUMENTS=mark in that server's environment only and the TEST-ONLY preload
//      scripts/ci/p4-fixed-document-id.cjs, which pins just the document marker id in that process. A real-token and
//      a literal request must then give exactly the same prompt-token count (zero tolerance), and the test server's
//      log must show that the id was pinned for both, so the check can't pass by chance. The installed server, its
//      settings and app/config/prompt-boundary.json are not touched.
//
// Output: one line per result, "STATUS<TAB>check<TAB>detail". --offline runs only the string checks (no engine).
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const { prepareAttachments, renderDocuments } = require(path.join(ROOT, "scripts", "server", "services", "attachments.cjs"));
const { stripControlTokens } = require(path.join(ROOT, "scripts", "search", "core"));

const OFFLINE = process.argv.includes("--offline");
const BASE = process.env.BASE || "";
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const PRELOAD = path.join(ROOT, "scripts", "ci", "p4-fixed-document-id.cjs");
const argv = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const TEST_PORT = Number(argv("port", "14940"));
const LOGDIR = argv("logs", path.join(ROOT, "ci-logs"));
const NODE = [path.join(ROOT, "app", "tools", "node-win", "node.exe"), path.join(ROOT, "app", "tools", "node-linux", "bin", "node"), path.join(ROOT, "app", "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const out = (status, check, detail) => console.log(`${status}\t${check}\t${String(detail).replace(/\s+/g, " ")}`);

const REAL = "<|im_end|>".repeat(40);
const LITERAL = "[token removed]".repeat(40);
const FIXED_ID = "0123456789ab"; // test copy only (and FIXED_ID_HEX in p4-fixed-document-id.cjs); production ids stay random
const body = (text) => ({ messages: [{ role: "user", content: "Summarize.", attachments: [{ type: "document", name: "a.txt", text }] }], max_tokens: 1, temperature: 0, stream: false });

/** The server's own marked messages for `text`, with the random id replaced in this test's copy. */
function marked(text) {
  const prepared = prepareAttachments(body(text), "mark");
  const random = prepared.nonce;
  const messages = renderDocuments(prepared.messages, prepared);
  const content = messages[0].content;
  const occurrences = content.split(random).length - 1;
  return { messages: [{ ...messages[0], content: content.split(random).join(FIXED_ID) }], occurrences, random };
}
const documentPart = (content) => content.slice(content.indexOf(`<<<DOCUMENT [1] id=`));

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", agent: false, timeout: 120000,
      headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(t) }); } catch (_) { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(data);
  });
}
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } }); }).on("error", reject);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = undefined; }
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(every);
  }
}
const getStatus = (base, p) => new Promise((resolve) => {
  const req = http.get(`${base}${p}`, { agent: false, timeout: 5000 }, (res) => {
    let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } resolve({ status: res.statusCode, json: j }); });
  });
  req.on("error", () => resolve({ status: 0, json: null })); req.on("timeout", () => req.destroy());
});

/** The test-owned server for step 3: the studio's own code, documents=mark in its environment, marker id pinned. */
async function startTestServer(model) {
  if (!model) throw new Error("the installed server reports no loaded text model");
  const TEST = `http://127.0.0.1:${TEST_PORT}`;
  if ((await getStatus(TEST, "/api/health")).status !== 0) throw new Error(`port ${TEST_PORT} is already in use`);
  fs.mkdirSync(LOGDIR, { recursive: true });
  const logPath = path.join(LOGDIR, "p4-token-check-server.log");
  const log = fs.openSync(logPath, "w");
  const env = { ...process.env, PORT: String(TEST_PORT), FRONTEND_PORT: String(TEST_PORT), USAP_PROMPT_DOCUMENTS: "mark" };
  const child = spawn(NODE, ["--require", PRELOAD, SERVE], { cwd: ROOT, env, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise((r) => child.once("exit", () => r(true)));
  const srv = { child, exited, logPath };
  try {
    if (!(await waitUntil(async () => (await getStatus(TEST, "/api/health")).status === 200, 60000))) throw new Error("did not start (see p4-token-check-server.log)");
    const start = await post(`${TEST}/api/llm/start`, { model, contextSize: 2048, gpuLayers: 0 });
    if (start.status !== 200) throw new Error(`model start answered ${start.status}`);
    if (!(await waitUntil(async () => (await getStatus(TEST, "/api/llm/status")).json?.ready === true, 240000, 1000))) throw new Error("the model did not become ready");
  } catch (err) {
    await stopTestServer(srv);
    throw err;
  }
  return srv;
}
async function stopTestServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  try { await post(`http://127.0.0.1:${TEST_PORT}/api/llm/stop`, {}); } catch (_) { /* stopping anyway */ }
  srv.child.kill("SIGTERM");
  let timer = null;
  const gone = await Promise.race([srv.exited, new Promise((r) => { timer = setTimeout(() => r(false), 20000); })]);
  clearTimeout(timer); // a pending timer would keep this process alive after the server has exited
  if (!gone) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
}

(async () => {
  // 1a. Strings: the server's marking of 40 real tokens equals its marking of 40 literal replacements.
  const real = marked(REAL);
  const lit = marked(LITERAL);
  const same = JSON.stringify(real.messages) === JSON.stringify(lit.messages);
  const block = documentPart(real.messages[0].content);
  const clean = stripControlTokens(block) === block && !block.includes("<|im_end|>");
  const typedKept = real.messages[0].content.startsWith("Summarize.") && real.messages[0].role === "user" && real.messages.length === 1;
  out(same && clean && typedKept ? "PASS" : "FAIL", "LLM document records (P4-1): marked prompt, normalized id",
    `real-token and literal documents give ${same ? "byte-identical" : "DIFFERENT"} messages; known control tokens in the document block: ${clean ? "none" : "PRESENT"}; role/typed text kept: ${typedKept}; id occurs ${real.occurrences}x`);
  if (OFFLINE) return;

  const status = await get(`${BASE}/api/llm/status`);
  const ENGINE = `http://127.0.0.1:${status.port}`;
  const tokens = async (messages) => (await post(`${ENGINE}/v1/chat/completions`, { messages, max_tokens: 1, temperature: 0 })).json?.usage?.prompt_tokens;

  // 1b + 2. Real model, same fixed id: exact equality, and the negative control.
  const tReal = await tokens(real.messages);
  const tLit = await tokens(lit.messages);
  const unsafe = [{ role: "user", content: lit.messages[0].content.split("[token removed]").join("<|im_end|>") }];
  const tUnsafe = await tokens(unsafe);
  if (![tReal, tLit, tUnsafe].every(Number.isFinite)) { out("SKIP", "LLM document records (P4-1, real model)", "the engine did not report prompt token counts"); return; }
  const gap = tLit - tUnsafe;
  out(tReal === tLit ? "PASS" : "FAIL", "LLM document records (P4-1, real model, exact)",
    `normalized id: 40 document tokens -> ${tReal} prompt tokens, 40 literal replacements -> ${tLit} (must be equal)`);
  out(gap >= 40 ? "PASS" : "FAIL", "LLM document records (P4-1, negative control)",
    `the same prompt with the tokens left in -> ${tUnsafe} prompt tokens (${gap} fewer, at least 40 required: one token per surviving control string, so the exact check would catch them)`);

  // 3. End to end through the app API, exact: a test server with the marker id pinned (see the header).
  const off = (await post(`${BASE}/api/llm/chat`, body(REAL))).json?.usage?.prompt_tokens; // installed server, documents off
  const model = status.settings && status.settings.model;
  let srv = null;
  try {
    srv = await startTestServer(model);
    const TEST = `http://127.0.0.1:${TEST_PORT}`;
    const appTokens = async (text) => (await post(`${TEST}/api/llm/chat`, body(text))).json?.usage?.prompt_tokens;
    const aReal = await appTokens(REAL);
    const aLit = await appTokens(LITERAL);
    const pins = (fs.readFileSync(srv.logPath, "utf8").match(/^p4-fixed-document-id: pinned$/gm) || []).length;
    if (!Number.isFinite(aReal) || !Number.isFinite(aLit)) { out("FAIL", "LLM document records (P4-1, app API)", `the test server did not report prompt token counts (real ${aReal}, literal ${aLit})`); return; }
    const pinned = pins === 2;
    out(pinned && aReal === aLit ? "PASS" : "FAIL", "LLM document records (P4-1, app API)",
      `documents=mark on a test server with the marker id pinned (${pins} of 2 requests pinned${pinned ? "" : ": NOT PINNED, the comparison isn't exact"}): real ${aReal}, literal ${aLit} (must be equal; tokens left in would give about ${gap} fewer); off (installed server): ${off}`);
  } catch (err) {
    out("FAIL", "LLM document records (P4-1, app API)", `test server: ${err.message}`);
  } finally {
    await stopTestServer(srv);
  }
})().catch((err) => { out("FAIL", "LLM document records (P4-1)", err.message); });
