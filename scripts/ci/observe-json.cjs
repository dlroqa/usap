"use strict";
// Native validators: one GET of a JSON endpoint, recorded so that a failed check says what was actually observed.
// The request is the same as the validators' own getJson (one connection, agent: false, a fixed client timeout); it
// adds no retry and no longer timeout. Explicit allowlists only: the caller names the top-level keys it expects and,
// per expected field, the values that may be printed (setting names such as "on", "off", "chat-queue"). Anything else
// is reduced to a count, a type or "<other value>", so no token, id, path, prompt or other response content reaches a
// CI log, whatever the response contains.
const http = require("http");


function observeJson(port, path, { timeoutMs = 10000, host = "127.0.0.1" } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      let json = null;
      if (typeof v.text === "string" && v.text.length) { try { json = JSON.parse(v.text); } catch (_) { json = null; } }
      resolve({ path, timeoutMs, durationMs: Date.now() - t0, timedOut, status: 0, contentType: null, ended: false, error: null, bodyBytes: 0, ...v, json });
    };
    const req = http.request({ host, port, path, method: "GET", agent: false, timeout: timeoutMs }, (res) => {
      let text = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; bytes += Buffer.byteLength(c); });
      const meta = () => ({ status: res.statusCode, contentType: String(res.headers["content-type"] || "") || null, text, bodyBytes: bytes });
      res.on("end", () => done({ ...meta(), ended: true }));
      res.on("close", () => done({ ...meta(), ended: false }));
      res.on("error", (e) => done({ ...meta(), ended: false, error: e.code || "response-error" }));
    });
    req.on("timeout", () => { timedOut = true; req.destroy(new Error("client timeout")); });
    req.on("error", (e) => done({ error: timedOut ? "client-timeout" : (e.code || "request-error") }));
    req.end();
  });
}

function pick(obj, dotted) {
  let v = obj;
  for (const k of dotted.split(".")) { if (v === null || typeof v !== "object" || !(k in v)) return { present: false }; v = v[k]; }
  return { present: true, value: v };
}
function safeValue(v, allowed) {
  if (Array.isArray(allowed) && allowed.includes(v)) return JSON.stringify(v);
  if (v === null) return "null";
  if (typeof v === "string") return "<other string>";
  return `<${Array.isArray(v) ? "array" : typeof v}>`;
}
function safeContentType(ct) {
  if (!ct) return "none";
  const base = String(ct).split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(base) ? base : "<unusual>";
}

// expect: { "limits.chatQueue": "on", ... } (the verdict: every field equals its value, as before this module).
// knownKeys: top-level keys that may be named when present. allowedValues: { field: [values that may be printed] };
// an expected value is always allowed for its own field.
function describeObservation(o, expect = {}, { server, knownKeys = [], allowedValues = {} } = {}) {
  const parts = [`GET ${o.path}: ${o.status ? `status ${o.status}` : "no response"} in ${o.durationMs} ms`,
    `timeout ${o.timedOut ? `YES (${o.timeoutMs} ms)` : "no"}`];
  if (o.error) parts.push(`error ${String(o.error).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "unknown"}`);
  parts.push(`content-type ${safeContentType(o.contentType)}`, `body ${o.bodyBytes} B${o.ended ? "" : " (incomplete)"}`);
  if (o.json && typeof o.json === "object" && !Array.isArray(o.json)) {
    const keys = Object.keys(o.json);
    const known = knownKeys.filter((k) => keys.includes(k));
    const missing = knownKeys.filter((k) => !keys.includes(k));
    parts.push(`JSON object: ${keys.length} keys; known present [${known.join(",")}]${missing.length ? `; known missing [${missing.join(",")}]` : ""}; other keys ${keys.length - known.length}`);
  } else if (o.bodyBytes) parts.push(o.json === null ? "not JSON" : "JSON not an object");
  let ok = Object.keys(expect).length > 0;
  const fields = [];
  for (const [k, want] of Object.entries(expect)) {
    const got = o.json ? pick(o.json, k) : { present: false };
    if (!got.present || got.value !== want) ok = false;
    fields.push(`${k}=${got.present ? safeValue(got.value, [want, ...(allowedValues[k] || [])]) : "MISSING"}`);
  }
  if (fields.length) parts.push(`expected fields: ${fields.join(", ")}`);
  if (server) {
    const s = server();
    parts.push(`server ${s.alive ? "alive" : `exited (code ${s.code}, signal ${s.signal})`}, up ${s.upMs} ms`);
  }
  return { ok, detail: parts.join("; ") };
}

// Which Node runs what (informational): the validator (this process) and the studio server it launches.
function runtimeLabel(serverNode, root, { spawnSync = require("child_process").spawnSync, path = require("path") } = {}) {
  let server = "unknown";
  try { const r = spawnSync(serverNode, ["-v"], { encoding: "utf8", timeout: 10000, windowsHide: true }); const v = String(r.stdout || "").trim(); if (/^v\d+\.\d+\.\d+$/.test(v)) server = v; } catch (_) { /* unknown */ }
  const where = serverNode.startsWith(root) ? path.relative(root, serverNode) : "the validator's own node";
  return `validator node ${process.version}; server node ${server} (${where})`;
}

module.exports = { observeJson, describeObservation, runtimeLabel };
