# Step 9.8g: image generation

Status: **in review** (not merged). Part of the modular backend plan in [STEP9_8_MODULES.md](STEP9_8_MODULES.md).

This step moves image generation out of `scripts/server/serve.cjs` into two modules. The code is moved, not
rewritten. API responses, model and output folders, engine choice, defaults and the interface are unchanged. No new
port, service or dependency is added.

## Module boundaries

| Module | Owns | Does not own |
|---|---|---|
| `services/image-engine.cjs` | Engine state; backend choice and validation probes (CPU, Vulkan, CUDA, ROCm, Metal); starting, readiness, load progress and stopping the stable-diffusion.cpp engine under the engine supervisor; the OpenVINO NPU worker; the Core ML backend; the `/v1` and `/sdapi` proxy; generation progress; saved outputs | HTTP routes, model files and downloads (`model-store`, `downloads`), backend options for the system routes (`getBackendOptions` stays in `serve.cjs`) |
| `routes/image.cjs` | The 10 routes below | Engine state, which it reads and sets through `state` |

Routes: `GET/POST /v1/*` and `/sdapi/*` (prefix; proxied to the engine); `GET /api/backend-status`,
`/api/generation-progress`, `/api/outputs`, `/api/output-file` (prefix); `POST /api/restart-backend`,
`/api/stop-backend`, `/api/openvino-generate`, `/api/save-output`, `/api/delete-outputs`.

All routes are still reached only through the request pipeline: Host check, Origin/CORS, sign-in, then the router,
inside the error boundary.

## How it was moved

* 47 top-level declarations (18 of them engine state) and the 10 route bodies were moved by a script that works on
  the syntax tree. A second check compares each with the previous `serve.cjs` after undoing only the rewrites
  below: all are identical.
* The rewrites are limited to free variables:
  * `BACKEND_PATH`, which start-up detection sets in `serve.cjs`, is read through `getBackendPath()`.
  * In the routes, engine state `X` became `state.X`. `state` has getters, and setters only for the four values the
    routes set before (`currentSettings`, `backendError`, `backendLoadState`, `PORT_BACKEND`).
  * In `serve.cjs`, the 21 places that read engine state (health, diagnostics, hardware polling, the model routes)
    read `imageEngine.state.X`, which is getter-only and frozen. Nothing outside the module writes it.
* The service is created where the engine state used to be declared. Functions bound later in `serve.cjs`
  (hardware, model store) are passed as wrappers resolved when called, so start-up order is unchanged.
* A golden comparison ran 29 requests against the previous and the new server: status, progress, outputs, saving,
  traversal attempts, deletes, restart and stop without an engine, OpenVINO, the proxy, health, diagnostics,
  hardware and backend options. Responses and files are identical; only the random ports the test harness assigns
  differ.

## Tests

`scripts/tests/image-engine.test.cjs` (8 tests) runs the real server with a fake stable-diffusion.cpp sd-server
(`scripts/tests/api-contract/fake-sd-server.cjs`). On Windows it runs through the same compiled test launcher as the
fake llama-server. The tests cover:

* the CPU engine passing the backend probe;
* a quantized (Q4_0) GGUF model loading and generating a real PNG, with progress, saved outputs and stop;
* missing, outside-the-folder and too-small models refused before the engine starts;
* a model that fails to load reports the engine's error, and no engine is left running;
* an engine crash during generation fails the request, and the process is gone afterwards;
* two concurrent generations; a 3-second generation not cut off by the proxy; a restart refused while generating;
  a client disconnect (see below); stopping during a generation;
* saved outputs keep to the outputs folder, and non-images are refused;
* with sign-in on, all image routes need sign-in, cross-origin requests are refused, and the status shape is kept.

Real CPU image generation with a real model (Stable Diffusion 1.5 Q4_0 GGUF) runs in
`.github/workflows/native-runtime.yml` on Linux x64, Windows x64, macOS arm64 and macOS Intel. GPU and NPU backends
are unverified.

## Existing behaviour kept as it is

* A client that disconnects doesn't cancel the engine's work. The engine finishes the image, and stopping the engine
  is the only way to cancel. Follow-up: [#64](https://github.com/dlroqa/usap/issues/64).
* Loading another image model while one is loaded is refused until it is unloaded. Changing settings during a
  generation is refused.
* Some validation errors still answer `500` (for example a missing model on `POST /api/restart-backend`), as noted in
  Step 9.7.
* macOS Intel image generation stays slow. The optimized build is Step 9.11.
