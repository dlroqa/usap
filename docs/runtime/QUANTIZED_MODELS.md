# Model formats and quantization

This page describes how USAP handles quantized models today (Step 9.8f). USAP runs models through separate
engines. Each engine reads its own file formats, including its own quantized variants. USAP doesn't convert or
re-quantize models, and it doesn't route a model to an engine by its quantization: the model's type (image, text,
speech, voice) picks the engine.

**Not every quantized model works.** A model runs only if the engine version that USAP ships reads its format,
architecture and quantization type.

## Engines and formats

| Use | Engine (version pinned in setup) | Formats it reads | Quantization in the file | Verified in CI |
|---|---|---|---|---|
| Chat | llama.cpp (`llamaRelease` in `scripts/config/llm-backends.json`) | GGUF, plus a GGUF vision projector (`mmproj`) for image input | Whatever that llama.cpp release supports: F32, F16, BF16, Q4_0…Q8_0, the K-quants (Q2_K…Q6_K), the IQ quants, and others | Qwen2.5-0.5B-Instruct **Q4_K_M**, CPU, on Linux x64, Windows x64, macOS arm64 and macOS Intel |
| Image | stable-diffusion.cpp (`SD_RELEASE` in the setup scripts) | GGUF, safetensors, ckpt | GGUF diffusion models (e.g. Q4_0, Q8_0) or F16/F32 safetensors | Stable Diffusion 1.5 **Q4_0** GGUF, CPU, on the same 4 platforms |
| Speech to text | whisper.cpp | GGML `.bin` (`lmgg` header) | F16 and quantized Whisper files (e.g. q5_1, q8_0) | Whisper tiny.en and **tiny.en-q5_1**, CPU, on the same 4 platforms |
| Voice | Kokoro 82M through onnxruntime-node | ONNX | The catalog's `dtype` (`q8` by default, `fp32` available) | Kokoro **q8**, CPU, on the same 4 platforms |
| Image on an Intel NPU (experimental) | OpenVINO GenAI | OpenVINO IR folders from the catalog | The catalog entry's precision (e.g. FP16) | Not verified |
| Image on the Apple Neural Engine (experimental) | Core ML | `.coreml` / `.mlmodelc` folders (downloaded as `.zip`) | Palettized Core ML weights from the catalog | Not verified |

GPU backends (CUDA, Vulkan, Metal, ROCm, SYCL) are not verified in CI for any engine. "Verified" means a real model
ran on the CPU on hosted CI runners (`.github/workflows/native-runtime.yml`).

## How a file is filed and run

1. A model is added from a tab: catalog download, link download, import or "link in place".
2. Its header decides its type, whatever the tab (`scripts/server/model-kind.cjs`):
   * GGUF: `general.architecture`. Diffusion architectures mean image; `clip` is a vision projector, kept with the
     text models; anything else is text.
   * safetensors: tensor names.
   * Whisper: the `lmgg` magic.
3. The engine for that type loads the file. If the engine can't read a quantization type or architecture (for
   example one newer than the shipped release), loading fails with the engine's own error. USAP doesn't check this
   in advance.

Not supported: text models in safetensors, PyTorch, AWQ, GPTQ, EXL2 or MLX format (convert them to GGUF
elsewhere), and ONNX text models.

## Inspecting a model

`GET /api/model-inspect?type=image|text|speech&filename=<file name>` reads the model's header and returns facts about
it. It is read-only: it loads nothing, changes nothing, and returns no paths. Only a file name inside the type's model
folder can be named. A model linked in place is read where it is, because you linked it; no other file outside the
model folders can be reached. It needs sign-in like every other route when the studio is shared.

| Field | Meaning |
|---|---|
| `format` | `gguf`, `safetensors`, `ckpt`, `ggml` (Whisper), `coreml` or `unknown` |
| `kind` | `image`, `text`, `speech` or `unknown`, as detected from the header |
| `architecture`, `name`, `parameters`, `contextLength`, `ggufVersion` | From the GGUF metadata when present (`general.*`, `<arch>.context_length`) |
| `quantization` | `{ type, source }`. `source` is `header` (`general.file_type`), `tensors` (the weights' most common tensor type) or `file name` (a pattern such as `Q4_K_M` in the name). Unknown values are reported as numbers (`file type 99`), not guessed. |
| `engine` | The engine in this studio that runs this kind of file, or `null`. This is detected from the header, not a check that this file loads |
| `compatible` | Always `null`: USAP doesn't check a file against the shipped engine version ([#61](https://github.com/dlroqa/usap/issues/61)). A model can still fail to load |
| `sizeBytes` | File size |
| `memory` | A rough estimate; see below |
| `warnings` | Damaged headers, formats no engine here runs, and similar notes |

The optional `context` parameter (512 to 1,048,576, default 4096) sets the context size for the text-model estimate.

### The memory estimate is rough

For GGUF text models: `totalBytes = file size + KV cache + 256 MB`. The KV cache is
`layers × context × KV heads × (key length + value length) × 34/32` bytes, which matches the studio's default
`q8_0` cache. It is informational only: model selection, automatic context size, GPU layers and loading are unchanged.

The estimate is too high or too low in several cases:
* Hybrid, state-space and sliding-window models keep less cache than this formula assumes.
* Mixture-of-experts models count all experts in the file size.
* Memory-mapped weights may not all be resident.
* GPU offload, a different cache type and the vision projector are not included.

Image, speech and Core ML models get only `weightsBytes` (the file size), with no total.

Header reading is bounded: at most 64 MB, limits on key, tensor and string counts, and long strings are skipped.
Damaged or hostile headers produce `unknown` fields and a warning, never an error.

## Follow-ups

Tracked as separate issues, not part of 9.8f:
* checking a model against the shipped engine versions before loading ([#61](https://github.com/dlroqa/usap/issues/61));
* more formats or conversion ([#62](https://github.com/dlroqa/usap/issues/62)).
