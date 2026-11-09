# Runner requirements for runtime and GPU validation

`native-runtime.yml` runs the real launcher (first-time setup, then a repeat launch) and
`scripts/ci/runtime-validate.sh` on GitHub-hosted runners. What those runners can and cannot
prove:

| Target | Hosted runner | Native check | What runs for real | GPU path |
|---|---|---|---|---|
| macOS Apple Silicon | `macos-15` (M1 VM) | `hw.optional.arm64=1`, `sysctl.proc_translated=0` | LLM, Whisper, Kokoro, SD image on CPU | Metal device is "Apple Paravirtual device". ggml-metal aborts on `NORM` for SD, recorded as `UNSUPPORTED` |
| macOS Intel | `macos-15-intel` | `hw.optional.arm64=0`, `translated=0`, Intel CPU brand | LLM, Whisper, Kokoro, SD image on CPU | Same paravirtual Metal, recorded as `UNSUPPORTED` |
| Linux x64 | `ubuntu-24.04` | `uname -m` | LLM, Whisper, Kokoro, SD image on CPU | No Vulkan GPU, recorded as `UNAVAILABLE` |
| Windows x64 | `windows-2025` | `PROCESSOR_ARCHITECTURE=AMD64` | LLM, Whisper, Kokoro, SD image on CPU | No Vulkan device, recorded as `UNAVAILABLE` |

Hosted runners have **no usable GPU**, so a green hosted run proves CPU inference only.
On Apple Silicon the LLM's backend is labelled "Metal GPU", but CI loads it with
`gpuLayers: 0`, so the compute is on the CPU. **Metal, Vulkan, CUDA and ROCm inference are unverified**
until a run on real hardware records `PASS` for them.

## Result statuses

| Status | Meaning | Fails the job |
|---|---|---|
| `PASS` | Ran for real and the output was checked (reply text, transcript, WAV, 256x256 non-blank PNG) | no |
| `FAIL` | A required check failed. CPU paths are always required | yes |
| `SKIP` | An optional component isn't installed | no |
| `UNAVAILABLE` | The app doesn't offer the GPU backend on this machine; the app's own reason is recorded | no (yes with `REQUIRE_GPU=1`) |
| `UNSUPPORTED` | The GPU backend was offered and attempted, but the runner's GPU couldn't run it; the server-log reason is recorded | no (yes with `REQUIRE_GPU=1`) |

Nothing is skipped silently: every backend listed in `IMAGE_BACKENDS` gets a row.

## Verifying a GPU backend (self-hosted)

You need a physical machine with the GPU, its driver, and enough disk for about 3 GB of downloads:

| Backend | Hardware | Driver / runtime |
|---|---|---|
| Metal | Apple Silicon Mac (physical, not a VM). Intel Macs are optional, since Metal on Intel/AMD Mac GPUs is unverified | macOS 14+ |
| Vulkan | Any Vulkan 1.2 GPU (`vulkaninfo --summary` lists it, not only llvmpipe) | Mesa / vendor driver; Windows: GPU driver with Vulkan |
| CUDA | NVIDIA GPU | Driver with CUDA 12.x support (`nvidia-smi` works) |
| ROCm | Supported AMD GPU on Linux | ROCm runtime (`rocminfo` works) |

Run the same validation on that machine, from a fresh checkout:

```bash
FRONTEND_PORT=14900 ./mac.sh        # or ./linux.sh, or windows.bat; complete setup, keep it running
EXPECTED_ARCH=arm64 BASE=http://127.0.0.1:14900 RESULTS=gpu-results.jsonl \
  IMAGE_BACKENDS="cpu metal" REQUIRE_GPU=1 SERVER_LOG=<launcher log> \
  bash scripts/ci/runtime-validate.sh
```

Use `IMAGE_BACKENDS="cpu vulkan"`, `"cpu cuda"` or `"cpu rocm"` on other machines.
`REQUIRE_GPU=1` turns `UNAVAILABLE`/`UNSUPPORTED` into `FAIL`, so a pass is a verified GPU result.

### Self-hosted runner safety

This repository is public. **Never** attach a self-hosted runner to a workflow that runs on
`pull_request` from forks: anyone could execute code on that machine. If GPU runners are
added, use a separate workflow triggered only by `workflow_dispatch` or `schedule`, with
`runs-on` labels such as `[self-hosted, gpu-metal]`. Use a dedicated machine or user account
with no credentials or personal data, and keep repository backups off it.
