#!/usr/bin/env bash
# Validate an install produced by first-time setup (mac.sh / linux.sh / windows.bat) against a
# RUNNING studio server: native binary architecture, executable bits, engine startup,
# and real inference through the app's own API with small, pinned, checksum-verified
# models. Writes one JSON line per check to $RESULTS and prints a Markdown table.
#   EXPECTED_ARCH=arm64|x86_64 BASE=http://127.0.0.1:14900 RESULTS=out.jsonl scripts/ci/runtime-validate.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/app"
EXPECTED_ARCH="${EXPECTED_ARCH:?}"
BASE="${BASE:?}"
RESULTS="${RESULTS:-$ROOT/runtime-results.jsonl}"
CACHE="${MODEL_CACHE:-$ROOT/.ci-model-cache}"
: > "$RESULTS"
FAILED=0

# Statuses: PASS, FAIL (fails the job), SKIP (optional component not installed),
# UNSUPPORTED / UNAVAILABLE (a GPU path that this runner's hardware cannot run; recorded with
# the reason, never silently skipped; FAIL instead when REQUIRE_GPU=1).
record() { # name status detail
  local detail="${3//$'\n'/ }"; detail="${detail//|/\\|}"
  node -e 'console.log(JSON.stringify({check:process.argv[1],status:process.argv[2],arch:process.argv[3],detail:process.argv[4]}))' \
    "$1" "$2" "$EXPECTED_ARCH" "$3" >> "$RESULTS"
  printf '| %s | %s | %s |\n' "$1" "$2" "$detail"
  [[ "$2" == "FAIL" ]] && FAILED=1
  return 0
}

archs_of() { local o; o="$(lipo -archs "$1" 2>/dev/null || file -b "$1")"; echo "${o//x86-64/x86_64}"; }

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

sha256_check() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 -c -; else sha256sum -c -; fi; }

fetch_verified() { # url sha256 dest
  local url="$1" sum="$2" dest="$3"
  mkdir -p "$(dirname "$dest")"
  if [[ ! -f "$dest" ]] || ! echo "$sum  $dest" | sha256_check >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$dest.part" && mv "$dest.part" "$dest"
  fi
  echo "$sum  $dest" | sha256_check >/dev/null 2>&1
}

api() { # method path [json-body]
  if [[ $# -ge 3 ]]; then curl -s -m 600 -X "$1" -H 'content-type: application/json' --data "$3" "$BASE$2"; else curl -s -m 600 -X "$1" "$BASE$2"; fi
}

json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }

echo "| Check | Result | Detail |"
echo "|---|---|---|"

OS="$(uname -s)"
case "$OS" in Darwin) PLAT=mac ;; Linux) PLAT=linux ;; MINGW*|MSYS*|CYGWIN*) PLAT=win ;; *) PLAT=unknown ;; esac
NODE_ARCH=$([[ "$EXPECTED_ARCH" == arm64 ]] && echo arm64 || echo x64)
EXE=$([[ "$PLAT" == win ]] && echo .exe || echo "")
# Hosted Windows runners expose Python as "python", not "python3".
PY=python3; for c in python3 python; do "$c" -c "import zlib" >/dev/null 2>&1 && { PY="$c"; break; }; done

# ── Hardware / translation ──────────────────────────────────────────────────
if [[ "$PLAT" == mac ]]; then
  hw="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"; tr="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
  if [[ "$tr" == 0 && ( ( "$EXPECTED_ARCH" == arm64 && "$hw" == 1 ) || ( "$EXPECTED_ARCH" == x86_64 && "$hw" == 0 ) ) ]]; then
    record "native hardware" PASS "$(sysctl -n machdep.cpu.brand_string); hw.optional.arm64=$hw; translated=$tr"
  else
    record "native hardware" FAIL "hw.optional.arm64=$hw translated=$tr"
  fi
else
  m="$(uname -m)"; extra=""
  # Git Bash on Windows: also require a native AMD64 OS (not x64 emulation on Windows on Arm).
  if [[ "$PLAT" == win ]]; then extra=" PROCESSOR_ARCHITECTURE=${PROCESSOR_ARCHITECTURE:-?}"; [[ "${PROCESSOR_ARCHITECTURE:-}" == AMD64 ]] || m="$m(non-native)"; fi
  [[ "$m" == "$EXPECTED_ARCH" ]] && record "native hardware" PASS "$OS $m$extra" || record "native hardware" FAIL "$OS $m$extra"
fi

# ── Binaries: architecture + executable bit + startup ──────────────────────
case "$PLAT" in
  mac)   NODE_BIN="$APP/tools/node-mac/bin/node"
         LLAMA_BINS=("$APP/llm-backend/mac/$([[ "$EXPECTED_ARCH" == arm64 ]] && echo arm64 || echo x64)/llama-server")
         WHISPER_BIN="$APP/speech-backend/mac/cpu/whisper-cli"
         SD_BINS=("$APP/backend/mac/sd") ;;
  linux) NODE_BIN="$APP/tools/node-linux/bin/node"
         LLAMA_BINS=("$APP/llm-backend/linux/cpu/llama-server" "$APP/llm-backend/linux/vulkan/llama-server")
         WHISPER_BIN="$APP/speech-backend/linux/cpu/whisper-cli"
         SD_BINS=("$APP/backend/linux/cpu/sd-server-cpu" "$APP/backend/linux/vulkan/sd-server-vulkan") ;;
  win)   NODE_BIN="$APP/tools/node-win/node.exe"
         LLAMA_BINS=("$APP/llm-backend/win/cpu/llama-server.exe" "$APP/llm-backend/win/vulkan/llama-server.exe")
         WHISPER_BIN="$APP/speech-backend/win/cpu/whisper-cli.exe"
         SD_BINS=("$APP/backend/win/cpu/sd-cpu.exe" "$APP/backend/win/vulkan/sd-vulkan.exe") ;;
esac
check_binary "portable node" "$NODE_BIN" 1 && {
  v="$("$NODE_BIN" -p 'process.version+" "+process.arch')"
  [[ "$v" == *" $NODE_ARCH" ]] && record "portable node startup" PASS "$v" || record "portable node startup" FAIL "$v"
}
for bin in "${LLAMA_BINS[@]}"; do
  label="llama-server ($(basename "$(dirname "$bin")"))"
  check_binary "$label" "$bin" 1 && {
    out="$("$bin" --version 2>&1 | head -5)"
    [[ "$out" == *version* ]] && record "$label startup" PASS "$(echo "$out" | grep -m1 version)" || record "$label startup" FAIL "$out"
  }
done
check_binary "whisper-cli" "$WHISPER_BIN" 1 && {
  "$WHISPER_BIN" --help >/dev/null 2>&1 && record "whisper-cli startup" PASS "--help exits 0" || record "whisper-cli startup" FAIL "--help failed"
}
for bin in "${SD_BINS[@]}"; do
  label="sd ($(basename "$bin"))"
  check_binary "$label" "$bin" 1 && {
    # Same library search path the app sets when it spawns the image backend.
    d="$(dirname "$bin")"
    LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" DYLD_LIBRARY_PATH="$d${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
      "$bin" --help >/dev/null 2>&1; rc=$?
    [[ $rc == 0 || $rc == 1 ]] && record "$label startup" PASS "--help ran (exit $rc), libraries resolved" || record "$label startup" FAIL "exit $rc"
  }
done
if [[ "$PLAT" == mac ]]; then
  for lib in "$APP"/backend/mac/*.dylib; do
    [[ -e "$lib" ]] || continue
    a="$(archs_of "$lib")"
    [[ "$a" == *"$EXPECTED_ARCH"* ]] && record "dylib $(basename "$lib")" PASS "$a" || record "dylib $(basename "$lib")" FAIL "$a"
  done
fi
# Native Node addons used by Kokoro TTS must load in the portable Node.
addons="$(cd "$APP/tts-runtime" && "$NODE_BIN" -e '
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

# Image: Stable Diffusion 1.5 pruned-emaonly Q4_0 GGUF (CreativeML OpenRAIL-M), pinned.
# Each backend in IMAGE_BACKENDS (default "cpu") is selected explicitly through the app API.
# "cpu" must pass. A GPU backend that is not offered, or that the runner's GPU cannot run, is
# recorded as UNAVAILABLE / UNSUPPORTED with the reason (FAIL when REQUIRE_GPU=1).
SD_MODEL="stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf"
REQUIRE_GPU="${REQUIRE_GPU:-0}"
SERVER_LOG="${SERVER_LOG:-}"

png_stats() {
  "$PY" -c 'import struct,zlib,sys
d=open(sys.argv[1],"rb").read()
assert d[:8]==b"\x89PNG\r\n\x1a\n"
w,h=struct.unpack(">II",d[16:24]); i=8; idat=b""
while i<len(d):
    n=struct.unpack(">I",d[i:i+4])[0]; t=d[i+4:i+8]
    if t==b"IDAT": idat+=d[i+8:i+8+n]
    i+=12+n
raw=zlib.decompress(idat); vals=set(raw[::97])
print(w,h,len(vals))' "$1" 2>/dev/null
}

gpu_fail() { # check detail : FAIL on CPU or when a GPU is required, else UNSUPPORTED with the reason
  local why=""
  [[ -n "$SERVER_LOG" && -f "$SERVER_LOG" ]] && why="$(tail -n +"$LOG_START" "$SERVER_LOG" | grep -E 'unsupported op|ggml_abort|failed to|error:' | tail -1 | cut -c1-160)"
  if [[ "$B" == cpu || "$REQUIRE_GPU" == 1 ]]; then record "$1" FAIL "$2${why:+ | log: $why}"
  else record "$1" UNSUPPORTED "this runner's GPU cannot run it: $2${why:+ | log: $why}"; fi
}

image_test() { # backend id (cpu|metal|vulkan|cuda|rocm)
  B="$1"; local label="Image [$1]" opts t0 t1 start st gen stats
  LOG_START=1; [[ -n "$SERVER_LOG" && -f "$SERVER_LOG" ]] && LOG_START=$(( $(wc -l < "$SERVER_LOG") + 1 ))
  opts="$(api GET /api/backend-options)"
  if [[ "$(echo "$opts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log((o.options||[]).some(x=>x.id===process.argv[1]))})' "$B" 2>/dev/null)" != true ]]; then
    local reason; reason="$(echo "$opts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const u=(o.unavailable||[]).find(x=>x.id===process.argv[1]);console.log(u?u.reason:"not offered by the app on this machine")})' "$B" 2>/dev/null)"
    if [[ "$B" == cpu || "$REQUIRE_GPU" == 1 ]]; then record "$label backend" FAIL "${reason:0:300}"; else record "$label backend" UNAVAILABLE "${reason:0:300}"; fi
    return
  fi
  t0=$(date +%s)
  start="$(api POST /api/restart-backend "{\"model\":\"$SD_MODEL\",\"width\":256,\"height\":256,\"steps\":4,\"backend_type\":\"$B\",\"use_gpu\":$([[ $B == cpu ]] && echo false || echo true)}")"
  for _ in $(seq 1 180); do st="$(api GET /api/backend-status)"; [[ "$(echo "$st" | json_get ready)" == true || -n "$(echo "$st" | json_get error)" ]] && break; sleep 5; done
  if [[ "$(echo "$st" | json_get ready)" != true ]]; then
    gpu_fail "$label load" "start: ${start:0:150} status: ${st:0:250}"; api POST /api/stop-backend '{}' >/dev/null; return
  fi
  local mode; mode="$(echo "$st" | json_get loading.backendMode)"; [[ -z "$mode" ]] && mode="$(echo "$st" | json_get settings.backendMode)"
  record "$label load" PASS "$(( $(date +%s) - t0 ))s; mode ${mode:-?}"
  t1=$(date +%s)
  gen="$(curl -s -m 1800 -X POST -H 'content-type: application/json' --data '{"prompt":"a red apple on a wooden table","negative_prompt":"","width":256,"height":256,"steps":4,"cfg_scale":7,"seed":42,"sampler_name":"euler_a","batch_size":1}' "$BASE/sdapi/v1/txt2img")"
  rm -f "$ROOT/ci-image-$B.png"
  echo "$gen" | json_get images.0 | base64 --decode > "$ROOT/ci-image-$B.png" 2>/dev/null
  stats="$(png_stats "$ROOT/ci-image-$B.png")"
  set -- $stats
  if [[ "${1:-0}" == 256 && "${2:-0}" == 256 && "${3:-0}" -gt 20 ]]; then
    record "$label inference" PASS "$(( $(date +%s) - t1 ))s: 256x256 PNG, 4 steps, $3 distinct sampled byte values (not blank)"
  else
    gpu_fail "$label inference" "stats='$stats' resp=${gen:0:200}"
  fi
  api POST /api/stop-backend '{}' >/dev/null
  sleep 2
}

if fetch_verified "https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/031b5f5df991f511b3f5fa8fed6d99048ababb69/$SD_MODEL" \
     b8944e9fe0b69b36ae1b5bb0185b3a7b8ef14347fe0fa9af6c64c4829022261f "$CACHE/$SD_MODEL"; then
  cp "$CACHE/$SD_MODEL" "$APP/models/$SD_MODEL"
  for b in ${IMAGE_BACKENDS:-cpu}; do image_test "$b"; done
else
  record "Image model download" FAIL "checksum mismatch or download failed"
fi

exit $FAILED
