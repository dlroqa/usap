# Dependencies & licenses

## npm (app/frontend, lockfile v3, 75 resolved packages; `npm audit`: 0 vulnerabilities on 2026-11-09)
| Package | Locked | Role | License (per package.json) |
|---|---|---|---|
| react / react-dom | 19.2.7 | UI | MIT |
| vite | 8.3.5 | build (dev) | MIT |
| @vitejs/plugin-react | 6.0.3 | build (dev) | MIT |
| lucide-react | 1.21.0 | icons | ISC |
| katex | 0.18.11 | math rendering (npm marks this version deprecated; upgrade needs a visual check) | MIT |
| pdfjs-dist | 4.10.38 | PDF attachment text | Apache-2.0 |
| @fontsource-variable/inter | 5.3.0 | font | OFL-1.1 (font) / MIT |
| @tauri-apps/api, plugin-opener, cli | 2.x | vestigial; no Tauri app exists | Apache-2.0 OR MIT |

## Native runtimes downloaded at setup (not in the repo; licenses to confirm per release, U)
| Runtime | Source | Expected license |
|---|---|---|
| llama.cpp `llama-server` | github.com/ggml-org/llama.cpp releases | MIT |
| stable-diffusion.cpp `sd-server` | github.com/leejet/stable-diffusion.cpp, github.com/leaxer-ai/leaxer-stable-diffusion | MIT (confirm fork) |
| whisper.cpp | github.com/ggml-org/whisper.cpp | MIT |
| Node.js 22.12.0 | nodejs.org/dist | MIT + bundled licenses |
| Python + pip (OpenVINO/Core ML paths) | python.org, bootstrap.pypa.io | PSF / MIT |
| Apple ml-stable-diffusion | github.com/apple/ml-stable-diffusion | MIT |
| MSVC redistributable (Windows) | aka.ms/vc14 | Microsoft EULA |
| Kokoro TTS runtime deps | npm, installed by setup-tts | per package (to inventory) |

## Models
Users download them from Hugging Face; each model has its own license (often non-commercial or OpenRAIL). The app does not redistribute models. Showing licenses in the UI is backlog work.
