#!/usr/bin/env bash
# Validate a macOS install produced by first-time setup (mac.sh / setup.sh) against a
# RUNNING studio server: native binary architecture, executable bits, engine startup,
# and real inference through the app's own API with small, pinned, checksum-verified
# models. Writes one JSON line per check to $RESULTS and prints a Markdown table.
#   EXPECTED_ARCH=arm64|x86_64 BASE=http://127.0.0.1:14900 RESULTS=out.jsonl scripts/ci/macos-runtime-validate.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/app"
EXPECTED_ARCH="${EXPECTED_ARCH:?}"
BASE="${BASE:?}"
RESULTS="${RESULTS:-$ROOT/runtime-results.jsonl}"
CACHE="${MODEL_CACHE:-$ROOT/.ci-model-cache}"
: > "$RESULTS"
FAILED=0

record() { # name status detail
  local detail="${3//\"/\'}"
  printf '{"check":"%s","status":"%s","arch":"%s","detail":"%s"}\n' "$1" "$2" "$EXPECTED_ARCH" "${detail//$'\n'/ }" >> "$RESULTS"
  printf '| %s | %s | %s |\n' "$1" "$2" "${detail//$'\n'/ }"
  [[ "$2" == "FAIL" ]] && FAILED=1
  return 0
}

archs_of() { lipo -archs "$1" 2>/dev/null || file -b "$1"; }

check_binary() { # name path required(1/0)
  local name="$1" bin="$2" required="$3"
  if [[ ! -e "$bin" ]]; then
    [[ "$required" == 1 ]] && record "$name binary" FAIL "missing: ${bin#$ROOT/}" || record "$name binary" SKIP "not installed: ${bin#$ROOT/}"
    return 1
  fi
  [[ -x "$bin" ]] || { record "$name binary" FAIL "not executable: ${bin#$ROOT/}"; return 1; }
  local a; a="$(archs_of "$bin")"
  if [[ "$a" == *"$EXPECTED_ARCH"* ]]; then record "$name binary" PASS "${bin#$ROOT/}: $a, executable"; return 0; fi
  record "$name binary" FAIL "${bin#$ROOT/} is '$a', expected $EXPECTED_ARCH"; return 1
}

fetch_verified() { # url sha256 dest
  local url="$1" sum="$2" dest="$3"
  mkdir -p "$(dirname "$dest")"
  if [[ ! -f "$dest" ]] || ! echo "$sum  $dest" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$dest.part" && mv "$dest.part" "$dest"
  fi
  echo "$sum  $dest" | shasum -a 256 -c - >/dev/null 2>&1
}

api() { # method path [json-body]
  if [[ $# -ge 3 ]]; then curl -s -m 600 -X "$1" -H 'content-type: application/json' --data "$3" "$BASE$2"; else curl -s -m 600 -X "$1" "$BASE$2"; fi
}

json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }

echo "| Check | Result | Detail |"
echo "|---|---|---|"

# ── Hardware / translation ──────────────────────────────────────────────────
hw="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"; tr="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
if [[ "$tr" == 0 && ( ( "$EXPECTED_ARCH" == arm64 && "$hw" == 1 ) || ( "$EXPECTED_ARCH" == x86_64 && "$hw" == 0 ) ) ]]; then
  record "native hardware" PASS "$(sysctl -n machdep.cpu.brand_string); hw.optional.arm64=$hw; translated=$tr"
else
  record "native hardware" FAIL "hw.optional.arm64=$hw translated=$tr"
fi

# ── Binaries: architecture + executable bit + startup ──────────────────────
NODE_ARCH=$([[ "$EXPECTED_ARCH" == arm64 ]] && echo arm64 || echo x64)
LLAMA_DIR=$([[ "$EXPECTED_ARCH" == arm64 ]] && echo arm64 || echo x64)
check_binary "portable node" "$APP/tools/node-mac/bin/node" 1 && {
  v="$("$APP/tools/node-mac/bin/node" -p 'process.version+" "+process.arch')"
  [[ "$v" == *" $NODE_ARCH" ]] && record "portable node startup" PASS "$v" || record "portable node startup" FAIL "$v"
}
check_binary "llama-server" "$APP/llm-backend/mac/$LLAMA_DIR/llama-server" 1 && {
  out="$("$APP/llm-backend/mac/$LLAMA_DIR/llama-server" --version 2>&1 | head -3)"
  [[ $? == 0 && "$out" == *version* ]] && record "llama-server startup" PASS "$(echo "$out" | grep -m1 version)" || record "llama-server startup" FAIL "$out"
}
check_binary "whisper-cli" "$APP/speech-backend/mac/cpu/whisper-cli" 1 && {
  "$APP/speech-backend/mac/cpu/whisper-cli" --help >/dev/null 2>&1 && record "whisper-cli startup" PASS "--help exits 0" || record "whisper-cli startup" FAIL "--help failed"
}
if [[ "$EXPECTED_ARCH" == arm64 ]]; then
  check_binary "sd (image, Metal)" "$APP/backend/mac/sd" 1 && {
    "$APP/backend/mac/sd" --help >/dev/null 2>&1; rc=$?
    [[ $rc == 0 || $rc == 1 ]] && record "sd startup" PASS "--help ran (exit $rc), dylibs resolved" || record "sd startup" FAIL "exit $rc"
  }
else
  [[ ! -e "$APP/backend/mac/sd" ]] && record "no arm64-only image binary on Intel" PASS "app/backend/mac/sd absent" || record "no arm64-only image binary on Intel" FAIL "$(archs_of "$APP/backend/mac/sd")"
  opts="$(api GET /api/backend-options)"
  [[ "$opts" == *"not available on Intel Macs"* ]] && record "Intel image message" PASS "backend-options explains image generation is unavailable" || record "Intel image message" FAIL "${opts:0:200}"
fi
# Native Node addons used by Kokoro TTS must load in the portable Node.
addons="$(cd "$APP/tts-runtime" && "$APP/tools/node-mac/bin/node" -e '
  const o = require("onnxruntime-node"); const s = require("sharp");
  console.log("onnxruntime-node", require("onnxruntime-node/package.json").version, "sharp", s.versions?.sharp || "?", process.arch);' 2>&1)"
[[ $? == 0 && "$addons" == *"$NODE_ARCH"* ]] && record "TTS native addons load" PASS "$addons" || record "TTS native addons load" FAIL "$addons"

# ── Real inference through the app API ────────────────────────────────────
# Text: Qwen2.5-0.5B-Instruct Q4_K_M (Apache-2.0), pinned revision + sha256.
QWEN="qwen2.5-0.5b-instruct-q4_k_m.gguf"
if fetch_verified "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/$QWEN" \
     74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db "$CACHE/$QWEN"; then
  cp "$CACHE/$QWEN" "$APP/llm-models/$QWEN"
  t0=$(date +%s)
  start="$(api POST /api/llm/start "{\"model\":\"$QWEN\",\"contextSize\":2048,\"gpuLayers\":0}")"
  for _ in $(seq 1 120); do [[ "$(api GET /api/llm/status | json_get ready)" == true ]] && break; sleep 2; done
  status="$(api GET /api/llm/status)"
  if [[ "$(echo "$status" | json_get ready)" == true ]]; then
    record "LLM load (app API)" PASS "$(( $(date +%s) - t0 ))s; backend $(echo "$status" | json_get settings.backendMode)"
    reply="$(api POST /api/llm/chat '{"messages":[{"role":"user","content":"Reply with exactly one word: hello"}],"max_tokens":16,"temperature":0,"stream":false}')"
    text="$(echo "$reply" | json_get choices.0.message.content)"
    [[ -z "${text// /}" ]] && text="$(echo "$reply" | json_get content)"
    [[ -n "${text// /}" ]] && record "LLM inference (app API)" PASS "reply: ${text:0:60}" || record "LLM inference (app API)" FAIL "${reply:0:200}"
  else
    record "LLM load (app API)" FAIL "start: ${start:0:200} status: ${status:0:200}"
  fi
  api POST /api/llm/stop '{}' >/dev/null
else
  record "LLM model download" FAIL "checksum mismatch or download failed"
fi

# Speech: whisper ggml-tiny.en (MIT) + JFK sample from whisper.cpp, pinned.
if fetch_verified "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin" \
     921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f "$CACHE/ggml-tiny.en.bin" \
   && fetch_verified "https://raw.githubusercontent.com/ggml-org/whisper.cpp/bd9e1a12352fa57e448bdea6a0649aa9c24c64aa/samples/jfk.wav" \
     59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e "$CACHE/jfk.wav"; then
  cp "$CACHE/ggml-tiny.en.bin" "$APP/speech-models/ggml-tiny.en.bin"
  t0=$(date +%s)
  res="$(curl -s -m 600 -X POST -H 'content-type: audio/wav' --data-binary @"$CACHE/jfk.wav" "$BASE/api/speech/transcribe?model=ggml-tiny.en.bin&language=en&save=false&filename=jfk.wav")"
  # The JFK sample says "...ask not what your country can do for you...".
  lower="$(echo "$res" | tr "[:upper:]" "[:lower:]")"
  if [[ "$(echo "$res" | json_get ok)" == true && "$lower" == *"your country"* ]]; then
    record "Speech transcription (app API)" PASS "$(( $(date +%s) - t0 ))s: $(echo "$lower" | grep -o 'ask not[^"]*' | head -1 | cut -c1-70)"
  else
    record "Speech transcription (app API)" FAIL "${res:0:300}"
  fi
  api POST /api/speech/stop '{}' >/dev/null
else
  record "Speech model download" FAIL "checksum mismatch or download failed"
fi

# Voice: Kokoro 82M ONNX q8 through the app's catalog (kokoro-js fetches the model).
api POST /api/tts/download-model '{"model":"kokoro-onnx-q8"}' >/dev/null
t0=$(date +%s)
before="$(ls "$APP/tts-outputs" 2>/dev/null | sort)"
res="$(api POST /api/tts/speak '{"text":"Hello from the continuous integration runner.","model":"kokoro-onnx-q8.json"}')"
new="$(comm -13 <(echo "$before") <(ls "$APP/tts-outputs" 2>/dev/null | sort) | grep -iE '\.(wav|mp3|ogg)$' | head -1)"
if [[ "$(echo "$res" | json_get ok)" == true && -n "$new" && -s "$APP/tts-outputs/$new" ]]; then
  record "TTS synthesis (app API)" PASS "$(( $(date +%s) - t0 ))s: $new ($(wc -c < "$APP/tts-outputs/$new" | tr -d ' ') bytes, $(file -b "$APP/tts-outputs/$new" | cut -c1-40))"
else
  record "TTS synthesis (app API)" FAIL "${res:0:300}"
fi
api POST /api/tts/stop '{}' >/dev/null

if [[ "$EXPECTED_ARCH" == arm64 ]]; then
  record "Image generation inference" UNVERIFIED "no small, license-clear SD model fits CI; needs provisioned Apple Silicon hardware"
fi

exit $FAILED
