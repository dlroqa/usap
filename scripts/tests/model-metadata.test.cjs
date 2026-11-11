// Step 9.8f: read-only model metadata (scripts/server/model-metadata.cjs, GET /api/model-inspect).
// Model headers are built here, so the tests need no downloads.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { inspectModel } = require("../server/model-metadata.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-meta-")); made.push(d); return d; };
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ } });

// GGUF v3 writer. kv: [key, type, value] with type "str" | "u32" | "f32" | "strarr" | "u64" | "bool".
function gguf({ version = 3, kv = [], tensors = [] } = {}) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); u64(b.length); parts.push(b); };
  parts.push(Buffer.from("GGUF"));
  u32(version);
  u64(tensors.length);
  u64(kv.length);
  for (const [key, type, value] of kv) {
    str(key);
    if (type === "str") { u32(8); str(value); }
    else if (type === "u32") { u32(4); u32(value); }
    else if (type === "u64") { u32(10); u64(value); }
    else if (type === "bool") { u32(7); parts.push(Buffer.from([value ? 1 : 0])); }
    else if (type === "f32") { u32(6); const b = Buffer.alloc(4); b.writeFloatLE(value); parts.push(b); }
    else if (type === "strarr") { u32(9); u32(8); u64(value.length); for (const v of value) str(v); }
    else if (type === "raw") { parts.push(value); }
  }
  for (const [name, dims, type] of tensors) {
    str(name); u32(dims.length); for (const d of dims) u64(d); u32(type); u64(0);
  }
  parts.push(Buffer.alloc(64));
  return Buffer.concat(parts);
}
const LLAMA = [
  ["general.architecture", "str", "llama"], ["general.name", "str", "Tiny Llama"], ["general.size_label", "str", "1.1B"],
  ["llama.context_length", "u32", 2048], ["llama.block_count", "u32", 22], ["llama.embedding_length", "u32", 2048],
  ["llama.attention.head_count", "u32", 32], ["llama.attention.head_count_kv", "u32", 4],
];

test("metadata: a GGUF text model reports format, quantization, architecture, engine and a memory estimate", () => {
  const dir = tmp();
  const file = path.join(dir, "tiny-llama.gguf");
  // A large vocabulary first, as real files have, so the reader has to go past the first megabytes.
  const vocab = Array.from({ length: 120000 }, (_, i) => `token-${i}-${"x".repeat(i % 40)}`);
  fs.writeFileSync(file, gguf({ kv: [LLAMA[0], ["tokenizer.ggml.tokens", "strarr", vocab], ...LLAMA.slice(1), ["general.file_type", "u32", 15]],
    tensors: [["token_embd.weight", [2048, 32000], 12], ["blk.0.attn_norm.weight", [2048], 0]] }));
  const m = inspectModel(file);
  assert.equal(m.format, "gguf");
  assert.equal(m.ggufVersion, 3);
  assert.equal(m.kind, "text");
  assert.equal(m.architecture, "llama");
  assert.equal(m.name, "Tiny Llama");
  assert.equal(m.parameters, "1.1B");
  assert.equal(m.contextLength, 2048);
  assert.deepEqual(m.quantization, { type: "Q4_K_M", source: "header" });
  assert.equal(m.engine, "llama.cpp");
  assert.equal(m.sizeBytes, fs.statSync(file).size);
  // KV cache at 4096 tokens, q8_0: 22 layers × 4096 × 4 heads × (64 + 64) × 34/32
  assert.equal(m.memory.kvCacheBytes, Math.round(22 * 4096 * 4 * 128 * 34 / 32));
  assert.equal(m.memory.totalBytes, m.sizeBytes + m.memory.kvCacheBytes + 256 * 1024 * 1024);
  assert.equal(inspectModel(file, { contextSize: 8192 }).memory.kvCacheBytes, 2 * m.memory.kvCacheBytes);
  assert.deepEqual(m.warnings, []);
});

test("metadata: without general.file_type, the weights' tensor type is used, then the file name", () => {
  const dir = tmp();
  const byTensor = path.join(dir, "model.gguf");
  fs.writeFileSync(byTensor, gguf({ kv: LLAMA, tensors: [["a", [4096, 4096], 8], ["b", [4096], 0], ["c", [10, 10], 14]] }));
  assert.deepEqual(inspectModel(byTensor).quantization, { type: "Q8_0", source: "tensors" });
  const byName = path.join(dir, "Model-7B-IQ4_XS.gguf");
  fs.writeFileSync(byName, gguf({ kv: LLAMA }));
  assert.deepEqual(inspectModel(byName).quantization, { type: "IQ4_XS", source: "file name" });
  const unknownType = path.join(dir, "future.gguf");
  fs.writeFileSync(unknownType, gguf({ kv: [...LLAMA, ["general.file_type", "u32", 99]] }));
  assert.deepEqual(inspectModel(unknownType).quantization, { type: "file type 99", source: "header" }, "unknown values are reported as numbers, not guessed");
});

test("metadata: image GGUF, vision projector, Whisper, safetensors and ckpt map to the right engine", () => {
  const dir = tmp();
  const sd = path.join(dir, "sd-v1-5-Q4_0.gguf");
  fs.writeFileSync(sd, gguf({ kv: [["general.architecture", "str", "sd1"], ["general.file_type", "u32", 2]] }));
  const sdm = inspectModel(sd);
  assert.equal(sdm.kind, "image");
  assert.equal(sdm.engine, "stable-diffusion.cpp");
  assert.equal(sdm.quantization.type, "Q4_0");
  assert.equal(sdm.memory.kvCacheBytes, null);

  const mmproj = path.join(dir, "mmproj-f16.gguf");
  fs.writeFileSync(mmproj, gguf({ kv: [["general.architecture", "str", "clip"], ["general.file_type", "u32", 1]] }));
  assert.equal(inspectModel(mmproj).engine, "llama.cpp (vision projector)");

  const whisper = path.join(dir, "ggml-tiny.en-q5_1.bin");
  fs.writeFileSync(whisper, Buffer.concat([Buffer.from("lmgg"), Buffer.alloc(60)]));
  const w = inspectModel(whisper);
  assert.equal(w.format, "ggml");
  assert.equal(w.engine, "whisper.cpp");
  assert.deepEqual(w.quantization, { type: "Q5_1", source: "file name" });

  const header = Buffer.from(JSON.stringify({ "model.diffusion_model.input_blocks.0.weight": { dtype: "F16", shape: [1], data_offsets: [0, 2] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  const st = path.join(dir, "dream.safetensors");
  fs.writeFileSync(st, Buffer.concat([len, header, Buffer.alloc(2)]));
  assert.equal(inspectModel(st).engine, "stable-diffusion.cpp");

  const header2 = Buffer.from(JSON.stringify({ "model.layers.0.self_attn.q_proj.weight": { dtype: "BF16", shape: [1], data_offsets: [0, 2] } }));
  const len2 = Buffer.alloc(8); len2.writeBigUInt64LE(BigInt(header2.length));
  const llmSt = path.join(dir, "llm.safetensors");
  fs.writeFileSync(llmSt, Buffer.concat([len2, header2, Buffer.alloc(2)]));
  const l = inspectModel(llmSt);
  assert.equal(l.engine, null);
  assert.ok(l.warnings.some((x) => /needs GGUF/.test(x)), "a text safetensors model is not claimed to run");

  const ckpt = path.join(dir, "old.ckpt");
  fs.writeFileSync(ckpt, "PK");
  assert.equal(inspectModel(ckpt).engine, "stable-diffusion.cpp");

  fs.mkdirSync(path.join(dir, "model.coreml"));
  assert.equal(inspectModel(path.join(dir, "model.coreml")).engine, "Core ML (macOS)");
});

test("metadata: damaged or hostile headers give warnings, never an exception", () => {
  const dir = tmp();
  const big = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const cases = {
    "truncated.gguf": Buffer.from("GGUF\x03\x00\x00"),
    "huge-counts.gguf": Buffer.concat([Buffer.from("GGUF"), Buffer.from([3, 0, 0, 0]), big(0xffffffffffffn), big(0xffffffffffffn)]),
    "string-past-end.gguf": gguf({ kv: [["general.architecture", "raw", Buffer.concat([Buffer.from([8, 0, 0, 0]), big(0x7fffffffffffn)])]] }),
    "bad-type.gguf": gguf({ kv: [["general.architecture", "raw", Buffer.from([77, 0, 0, 0])]] }),
    "nested.gguf": gguf({ kv: [["x", "raw", Buffer.concat([Buffer.from([9, 0, 0, 0, 9, 0, 0, 0]), big(1n), Buffer.from([9, 0, 0, 0]), big(1n), Buffer.from([9, 0, 0, 0]), big(1n), Buffer.from([9, 0, 0, 0]), big(1n)])]] }),
    "many-dims.gguf": gguf({ kv: LLAMA, tensors: [["t", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0]] }),
    "old-version.gguf": gguf({ version: 1, kv: LLAMA }),
    "empty.gguf": Buffer.alloc(0),
  };
  for (const [name, data] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    let m;
    assert.doesNotThrow(() => { m = inspectModel(file); }, name);
    assert.ok(Array.isArray(m.warnings), name);
    if (name !== "empty.gguf") assert.ok(m.warnings.length > 0, `${name} warns`);
    assert.ok(m.memory === null || m.memory.kvCacheBytes === null || Number.isFinite(m.memory.kvCacheBytes), name);
  }
  assert.equal(inspectModel(path.join(dir, "missing.gguf")).format, "unknown");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
  assert.ok(inspectModel(path.join(dir, "notes.txt")).warnings.length);
});

// The route on the real server: read-only, file names only, no paths in the answer.
let srv;
let root;
test.before(async () => {
  root = makeRoot();
  fs.mkdirSync(path.join(root, "app", "llm-models"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "llm-models", "tiny.gguf"), gguf({ kv: [...LLAMA, ["general.file_type", "u32", 7]] }));
  fs.writeFileSync(path.join(root, "app", "secret.gguf"), gguf({ kv: LLAMA }));
  srv = await startServer(root);
});
test.after(() => {
  stopServer(srv);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});

test("GET /api/model-inspect: facts for a model in its folder, with no path in the answer", async () => {
  const r = await request(srv.port, "GET", "/api/model-inspect?type=text&filename=tiny.gguf");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.filename, "tiny.gguf");
  assert.equal(r.json.quantization.type, "Q8_0");
  assert.equal(r.json.engine, "llama.cpp");
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(path.basename(root)));
  const ctx = await request(srv.port, "GET", "/api/model-inspect?type=text&filename=tiny.gguf&context=8192");
  assert.equal(ctx.json.memory.contextSize, 8192);
});

test("GET /api/model-inspect: other folders, traversal and bad requests are refused", async () => {
  const cases = [
    ["/api/model-inspect?type=text&filename=..%2Fsecret.gguf", 404],
    ["/api/model-inspect?type=text&filename=..", 404],
    ["/api/model-inspect?type=text&filename=.", 404],
    ["/api/model-inspect?type=text&filename=missing.gguf", 404],
    ["/api/model-inspect?type=config&filename=tiny.gguf", 400],
    ["/api/model-inspect?type=text", 400],
    ["/api/model-inspectx?type=text&filename=tiny.gguf", 404],
  ];
  for (const [url, status] of cases) {
    const r = await request(srv.port, "GET", url);
    assert.equal(r.status, status, url);
    assert.equal(r.json.ok, false, url);
  }
});
