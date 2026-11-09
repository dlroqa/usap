const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectModelKind } = require("../server/model-kind.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-kind-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function ggufString(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

// Minimal GGUF v3: header plus key/values; "before" entries come ahead of general.architecture
function writeGguf(name, architecture, before = []) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const kvs = [...before];
  if (architecture) kvs.push(Buffer.concat([ggufString("general.architecture"), u32(8), ggufString(architecture)]));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length), ...kvs]));
  return file;
}

function writeSafetensors(name, keys) {
  const header = Buffer.from(JSON.stringify(Object.fromEntries(keys.map((key) => [key, { dtype: "F16", shape: [1], data_offsets: [0, 2] }]))));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.concat([length, header, Buffer.alloc(2)]));
  return file;
}

test("GGUF language models are text", () => {
  assert.deepEqual(detectModelKind(writeGguf("qwen.gguf", "qwen2")), { kind: "text", detail: "qwen2" });
  assert.equal(detectModelKind(writeGguf("gemma.gguf", "gemma3")).kind, "text");
});

test("GGUF vision add-ons (mmproj) stay with text models", () => {
  assert.equal(detectModelKind(writeGguf("mmproj.gguf", "clip")).kind, "text");
});

test("GGUF diffusion models are image", () => {
  assert.deepEqual(detectModelKind(writeGguf("flux.gguf", "flux")), { kind: "image", detail: "flux" });
  assert.equal(detectModelKind(writeGguf("sdxl.gguf", "sdxl")).kind, "image");
});

test("GGUF architecture is found after other metadata, including string arrays", () => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const name = Buffer.concat([ggufString("general.name"), u32(8), ggufString("Some Model")]);
  const count = Buffer.concat([ggufString("general.file_type"), u32(4), u32(15)]);
  const tokens = Buffer.concat([ggufString("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), ggufString("a"), ggufString("b")]);
  assert.equal(detectModelKind(writeGguf("late.gguf", "llama", [name, count, tokens])).kind, "text");
});

test("GGUF without an architecture is unknown", () => {
  assert.equal(detectModelKind(writeGguf("bare.gguf", null)).kind, "unknown");
});

test("safetensors are classified by tensor names", () => {
  assert.equal(detectModelKind(writeSafetensors("sd.safetensors", ["model.diffusion_model.input_blocks.0.weight", "first_stage_model.decoder.conv_in.weight"])).kind, "image");
  assert.equal(detectModelKind(writeSafetensors("flux.safetensors", ["double_blocks.0.img_attn.qkv.weight"])).kind, "image");
  assert.equal(detectModelKind(writeSafetensors("llm.safetensors", ["model.layers.0.self_attn.q_proj.weight", "lm_head.weight"])).kind, "text");
  assert.equal(detectModelKind(writeSafetensors("lora.safetensors", ["lora_unet_down_blocks_0.alpha"])).kind, "unknown");
});

test("whisper.cpp .bin files are speech", () => {
  const file = path.join(tmp, "ggml-tiny.bin");
  fs.writeFileSync(file, Buffer.concat([Buffer.from("lmgg"), Buffer.alloc(60)]));
  assert.deepEqual(detectModelKind(file), { kind: "speech", detail: "whisper" });
});

test("unreadable paths are unknown rather than throwing", () => {
  assert.equal(detectModelKind(path.join(tmp, "does-not-exist.gguf")).kind, "unknown");
});
