# shellcheck shell=bash
# Download integrity for the setup scripts (Step 9.4). Source this file, then call
#   usap_verify_download <url> <file>
# before moving a downloaded file into place. The URL is looked up in scripts/config/download-digests.txt:
#   * listed   -> size and SHA-256 must match, otherwise returns 1 (the caller discards the file)
#   * unlisted -> prints a warning and the file's SHA-256 ("unverified"), returns 0. This happens for
#                 overridden versions (LLAMA_RELEASE, WHISPER_RELEASE) and sources without pinned digests.
# A missing or unreadable digest list fails closed (returns 1) instead of treating everything as unverified.

USAP_DIGESTS="${USAP_DIGESTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../config" 2>/dev/null && pwd)/download-digests.txt}"

usap_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 -r "$1" | awk '{print $1}'
  fi
}

usap_verify_download() {
  local url="$1" file="$2" name line expected size actual actual_size
  name="$(basename "$file")"; name="${name%.part}"
  if [[ ! -r "$USAP_DIGESTS" ]]; then
    echo "   XX   Download digest list missing: $USAP_DIGESTS (refusing to install unverified files)" >&2
    return 1
  fi
  if [[ ! -s "$file" ]]; then
    echo "   XX   $name is empty or missing" >&2
    return 1
  fi
  line="$(awk -v u="$url" '$0 !~ /^[[:space:]]*#/ && $3 == u { print $1 " " $2; exit }' "$USAP_DIGESTS")"
  actual="$(usap_sha256 "$file")"
  if [[ -z "$line" ]]; then
    echo "   !!   $name is not in the pinned digest list; installing it UNVERIFIED (publisher not authenticated)."
    echo "   !!   SHA-256: $actual"
    return 0
  fi
  expected="${line%% *}"
  size="${line##* }"
  actual_size="$(wc -c < "$file" | tr -d '[:space:]')"
  if [[ "$actual_size" != "$size" ]]; then
    echo "   XX   $name is $actual_size bytes, expected $size (incomplete or replaced download). Discarded." >&2
    return 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "   XX   $name failed SHA-256 verification (expected $expected, got $actual). Discarded." >&2
    return 1
  fi
  echo "   OK   SHA-256 verified: $name"
}
