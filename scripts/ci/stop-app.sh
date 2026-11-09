#!/usr/bin/env bash
# Stop the studio server started by a launcher in CI, plus the engines it spawned.
# Windows: kill by the listening port's PID tree, never by image name (node.exe also runs the
# Actions runner's JavaScript steps).
set -u
PORT="${FRONTEND_PORT:-1420}"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    for pid in $(netstat -ano | awk -v p=":$PORT" '$2 ~ p"$" && $4 == "LISTENING" {print $5}' | sort -u); do
      taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
    done
    for img in llama-server.exe whisper-cli.exe whisper-server.exe sd-cpu.exe sd-vulkan.exe sd-cuda.exe; do
      taskkill //IM "$img" //F >/dev/null 2>&1 || true
    done ;;
  *)
    lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
    pkill -f "scripts/server/serve.cjs" || true
    pkill -f "llama-server|whisper-server|tts-kokoro-worker" || true ;;
esac
sleep 3
