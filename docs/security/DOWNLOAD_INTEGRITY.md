# Download integrity (Step 9.4)

USAP downloads engines, a portable Node.js, and models. This page explains what is checked for each
download, and what those checks do and don't prove.

## Two different guarantees

| Term | What it means | What it does **not** mean |
|---|---|---|
| **Transfer integrity** | The bytes on disk are the bytes the source sent. Size and SHA-256 match what the *same* source reports. Catches truncation, disk/USB write errors and corruption in transit. | It says nothing about who published the file. A checksum served by the same host as the file can be replaced along with the file. |
| **Pinned digest** (`verified`) | The SHA-256 and size match a value recorded **in this repository** ([`scripts/config/download-digests.txt`](../../scripts/config/download-digests.txt)) when the version was reviewed. A file swapped later (compromised mirror, hijacked release asset, network attacker) is refused. | If the publisher was already compromised before the digest was pinned, the pin records the bad file. It is not a code-signing check. |
| **Publisher-signed** (`signed`) | A pinned digest whose value came from a checksum list the publisher **signed**. The signature was checked when the digest was pinned. | The signature is checked when a version is pinned, not on every download. |

## Download status

The app reports one status per finished download (`GET /api/download-progress` → `integrity`, `sha256`):

* `verified`: matched a pinned or publisher-signed digest.
* `source-checksum`: no pinned digest, but the file matched the SHA-256 the source reported (Hugging Face
  sends one for files it stores). **Transfer integrity only; the publisher is not authenticated.**
* `unverified`: no expected digest was available. The file's SHA-256 is computed and logged, but it is
  **not authenticated**. This applies to community models from search results and to URLs you paste.

A download that fails a check is discarded. The partial file is removed and any existing file of the same
name is kept.

## What is covered

| Download | Where | Check | Status |
|---|---|---|---|
| Portable Node.js 22.12.0 (Linux x64, macOS arm64/x64, Windows x64) | setup | SHA-256 + size, from the GPG-signed `SHASUMS256.txt` (signature checked with a key from [nodejs/release-keys](https://github.com/nodejs/release-keys)) | **Verified** (publisher-signed) |
| llama.cpp `b11418` engines and CUDA runtimes | setup | SHA-256 + size pinned from the GitHub release asset digests | **Verified** (pinned) |
| whisper.cpp `v1.9.1` engines | setup | same | **Verified** (pinned) |
| stable-diffusion.cpp `master-685-19bdfe2` / `master-782-b290693` engines and CUDA runtime | setup and in-app (Windows) | same; in-app engine installs **require** a pinned digest | **Verified** (pinned) |
| leaxer prebuilt Linux CUDA image engine `v0.1.0` | setup (`--max-perf`) | same | **Verified** (pinned) |
| Catalog speech models (`ggerganov/whisper.cpp` ggml files) | in-app | SHA-256 + size pinned from the Hugging Face LFS object ids | **Verified** (pinned) |
| Catalog chat models: Phi-3 mini q4, Qwen2.5-Coder 0.5B, SmolLM2 1.7B | in-app | same | **Verified** (pinned) |
| Catalog chat models: Meta-Llama-3-8B-Instruct Q8_0 / Q4_K_M (QuantFactory), Mistral-7B-Instruct-v0.3 Q8_0 (TheBloke) | in-app | no pinned digest: the files were not found at those repository paths when this list was made ([#24](https://github.com/dlroqa/usap/issues/24)) | Unverified / source-checksum |
| Community models (Hugging Face search, pasted URLs) | in-app | source checksum when Hugging Face provides one; otherwise local SHA-256 only | Source-checksum / **unverified** |
| A different engine version (`LLAMA_RELEASE`, `WHISPER_RELEASE` overrides) | setup | warning plus local SHA-256 | **Unverified** |
| Microsoft Visual C++ runtime (`aka.ms/vc14/vc_redist.x64.exe`) | Windows setup | none: the URL always points to the latest build, so a digest cannot be pinned. Microsoft signs the installer, but USAP does not check that signature yet ([#20](https://github.com/dlroqa/usap/issues/20)) | **Unverified** |
| Portable Python 3.11.9, `get-pip.py` (OpenVINO NPU option) | Windows setup | warning plus local SHA-256 (`get-pip.py` changes over time; [#20](https://github.com/dlroqa/usap/issues/20)) | **Unverified** |
| npm packages (frontend, Kokoro runtime) | setup | npm checks each package's `sha512` against the lockfile where one exists; setup uses `npm install`, not `npm ci` (S-10, [#22](https://github.com/dlroqa/usap/issues/22)) | Lockfile integrity (npm) |
| Kokoro voice model weights | first use | fetched by `kokoro-js` from Hugging Face; not covered ([#21](https://github.com/dlroqa/usap/issues/21)) | **Unverified** |
| Python packages, `git clone` source builds (Core ML, source fallbacks) | optional setup paths | not covered ([#23](https://github.com/dlroqa/usap/issues/23)) | **Unverified** |

GPU engine archives are pinned, but GPU acceleration itself is still unverified in USAP (see the README).

## How files are written

1. The download streams to `<name>.part` and is hashed as it arrives. Each request and each redirect hop
   goes through the outbound-request guard (Step 9.3), with at most 10 redirects.
2. When the transfer ends, the size is compared with `Content-Length`, then with the pinned size and
   SHA-256 if the URL is pinned (otherwise with the source's checksum, if it reported one). The file is
   synced to disk.
3. Only then is it renamed over the destination in a single step. The old file is never deleted first. If
   the rename is refused, the old file is moved aside and restored if the new one can't be put in place.
4. Engine archives installed by the app are extracted into a staging copy of the engine folder. The
   executable's CPU architecture is checked (ELF/Mach-O/PE headers), and then the folders are swapped. If
   the engine is running and Windows locks its folder, the swap is refused and the installed engine stays.
   Setup does the same for llama.cpp updates on Linux and macOS. Windows setup still replaces image
   engines in place (the archive is verified first, but a failed extraction can leave no engine): [#19](https://github.com/dlroqa/usap/issues/19).
5. **Retries:** interrupted or stalled transfers are retried twice, each time **from byte zero**. A partial
   file is never resumed, because its first bytes can't be trusted across attempts. A digest mismatch is
   never retried. Cancelling stops the transfer and deletes the partial file.

## Updating a pinned digest

When a version pin changes (for example `RELEASE=` in `scripts/setup/setup-llama.sh`):

1. For GitHub releases, get the asset digests from the API, e.g.
   `gh api repos/ggml-org/llama.cpp/releases/tags/<tag> --jq '.assets[]|"\(.digest) \(.size) \(.name)"'`.
   For Node.js, download `SHASUMS256.txt.asc` and verify it with `gpg` against a key from
   nodejs/release-keys before copying the lines.
2. Replace the lines in `scripts/config/download-digests.txt` (format `<sha256> <size> <url> [signed]`).
3. The `native-runtime` workflow downloads and verifies the assets for all four platforms on real
   runners. That is an independent re-computation of the digests, and it must pass before merging.

`scripts/tests/integrity.test.cjs` fails if a hard-coded engine or Node.js URL in the server or Windows
setup is missing from the list.

## Tracked gaps

Security-sensitive failures are reported as errors, never hidden. These gaps are open, and none of them
is labelled verified:

| Issue | Gap | Priority |
|---|---|---|
| [#19](https://github.com/dlroqa/usap/issues/19) | Windows setup: staged image-engine install with rollback | Before release packaging |
| [#20](https://github.com/dlroqa/usap/issues/20) | Visual C++ runtime, portable Python, `get-pip.py` | Before release packaging |
| [#21](https://github.com/dlroqa/usap/issues/21) | Kokoro voice weights | |
| [#22](https://github.com/dlroqa/usap/issues/22) | Staged, lockfile-exact dependency updates for portable installs (S-10) | |
| [#23](https://github.com/dlroqa/usap/issues/23) | Source builds and Python packages | |
| [#24](https://github.com/dlroqa/usap/issues/24) | Catalog chat models missing at their Hugging Face paths | |
