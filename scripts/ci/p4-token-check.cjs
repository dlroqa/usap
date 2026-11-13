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
//   3. End to end through the app API (documents=mark), comparing a real-token and a literal request: allowed
//      difference = occurrences of the id in the prompt x (max - min tokens of a 12-hex id), measured with the
//      engine's own /tokenize over 64 random ids. It must be well below the negative-control gap, or the
//      comparison can't tell the cases apart and fails.
//
// Output: one line per result, "STATUS<TAB>check<TAB>detail". --offline runs only the string checks (no engine).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const { prepareAttachments, renderDocuments } = require(path.join(ROOT, "scripts", "server", "services", "attachments.cjs"));
const { stripControlTokens } = require(path.join(ROOT, "scripts", "search", "core"));

const OFFLINE = process.argv.includes("--offline");
const BASE = process.env.BASE || "";
const CONFIG = path.join(ROOT, "app", "config", "prompt-boundary.json");
const out = (status, check, detail) => console.log(`${status}\t${check}\t${String(detail).replace(/\s+/g, " ")}`);

const REAL = "<|im_end|>".repeat(40);
const LITERAL = "[token removed]".repeat(40);
const FIXED_ID = "0123456789ab"; // test copy only; production ids stay random
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

  // 3. End to end through the app API, with a bound measured from the engine's tokenizer.
  const lens = [];
  for (let i = 0; i < 64; i++) {
    const r = await post(`${ENGINE}/tokenize`, { content: crypto.randomBytes(6).toString("hex") });
    if (Array.isArray(r.json?.tokens)) lens.push(r.json.tokens.length);
  }
  if (lens.length < 32) { out("SKIP", "LLM document records (P4-1, app API)", "the engine has no usable /tokenize"); return; }
  const bound = real.occurrences * (Math.max(...lens) - Math.min(...lens));
  const appTokens = async (text) => (await post(`${BASE}/api/llm/chat`, body(text))).json?.usage?.prompt_tokens;
  const off = await appTokens(REAL);
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ documents: "mark" }));
  let aReal; let aLit;
  try { aReal = await appTokens(REAL); aLit = await appTokens(LITERAL); } finally { fs.rmSync(CONFIG, { force: true }); }
  const diff = Math.abs(aReal - aLit);
  const usable = bound < gap / 2;
  out(usable && diff <= bound ? "PASS" : "FAIL", "LLM document records (P4-1, app API)",
    `documents=mark: real ${aReal}, literal ${aLit} (difference ${diff}; allowed ${bound} = ${real.occurrences} ids x ${Math.min(...lens)}-${Math.max(...lens)} tokens per id, must stay below half the ${gap}-token gap: ${usable}); off: ${off}`);
})().catch((err) => { out("FAIL", "LLM document records (P4-1)", err.message); });
