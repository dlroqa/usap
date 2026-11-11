# Step 9.8: modular backend (design and PR sequence)

Goal: split `scripts/server/serve.cjs` (≈7,800 lines, 59 routes in one if-chain) into maintainable
modules **without changing the interface or the external API**. It stays one Node.js process on one
port, with no new services, ports or background processes.

## Rules for every 9.8 PR

* **A pure move plus wiring:** one functional area per PR. Handlers keep their code, messages, status
  codes and response shapes. The API contract, render, security and native-runtime gates must pass
  unchanged.
* **Security stays central:** every request enters through `scripts/server/http/pipeline.cjs`, in
  this order: Host check, Origin and CORS, preflight, sign-in, module routes, the routes not yet
  moved, all inside the error boundary. Modules never create servers or handle security themselves.
  The outbound guard (`net-guard.cjs`) and the verified downloader stay the only way out.
* **Dependency injection:** a route module is a function that receives its dependencies (services,
  `json`, and state accessors as functions) and returns a registration callback. No module reaches
  into another's state. That keeps modules testable with stand-ins.
* **No frontend, screenshot-baseline or user-data changes.**

## Module boundaries (target)

```
scripts/server/
  serve.cjs                 wiring only: config, services, router, pipeline, listen, shutdown
  http/
    pipeline.cjs            request order and error boundary              (PR 9.8a, done)
    router.cjs              exact/prefix routing, first match wins         (PR 9.8a, done)
  routes/                   HTTP adapters: parse, validate, call a service, respond
    system.cjs              health, diagnostics, hardware, telemetry        (PR 9.8a, done)
    llm.cjs                 text models, chat (streaming), conversations    (needs #14 coverage: done)
    image.cjs               image engine, generation, outputs, /v1 and /sdapi proxy
    speech.cjs              transcription engine, models, transcriptions
    tts.cjs                 voice engine, models, outputs
    models.cjs              import, link, move, delete, catalog, downloads
    search.cjs              web search config and queries
  services/                 domain logic, no HTTP
    llm-engine.cjs          llama.cpp lifecycle (supervisor + restart policy already modular)
    image-engine.cjs, speech-engine.cjs, tts-engine.cjs
    model-store.cjs         model files and settings (on top of paths.cjs)
    downloads.cjs           wraps downloader.cjs and integrity.cjs
    hardware.cjs            GPU/CPU/NPU detection and telemetry
  (existing, already modular) lan-auth.cjs, request-policy.cjs, net-guard.cjs, downloader.cjs,
    integrity.cjs, supervisor.cjs, engine-guard.cjs, restart-policy.cjs, errors.cjs, paths.cjs
```

## PR sequence

| PR | Scope | Risk |
|---|---|---|
| **9.8a** (#36, done) | Pipeline, router, `routes/system.cjs` (6 read-only routes) | Low: read-only routes; pipeline order covered by tests |
| **9.8b** (#37, done) | `routes/tts.cjs` + `services/tts-engine.cjs` | Low: self-contained |
| **9.8c** (#40, done) | `routes/speech.cjs` + `services/speech-engine.cjs` (including the binary upload route) | Medium: streaming upload |
| **9.8d** (#46, done) | `routes/search.cjs` + `services/web-search.cjs`, trust boundary documented | Low |
| **9.8e** (#56, done: [plan](STEP9_8E_PLAN.md)) | `services/hardware.cjs` (detection used by several routes) | Medium: shared |
| **9.8f** (#59, #60, #63, done: [notes](STEP9_8F_MODELS.md)) | `routes/models.cjs` + `services/model-store.cjs` + `services/downloads.cjs` | Medium: file operations; traversal tests already exist |
| **9.8g** (#65, done: [notes](STEP9_8G_IMAGE.md)) | `routes/image.cjs` + `services/image-engine.cjs` (proxy included) | Medium |
| 9.8h | `routes/llm.cjs` + `services/llm-engine.cjs` (chat streaming last) | Highest: streaming contract tests on all 4 OS |

Each PR is reviewed and merged separately, with owner approval.

## Integration points for later workstreams (no implementation in 9.8)

* **Multi-user authentication and API keys** (#28): `lan-auth.cjs` already sits behind a single
  `handle(req, res)` step in the pipeline. A future identity module can replace it there and attach a
  principal to the request, which route modules can check, without touching each route.
* **Prompt-injection defense and trust boundaries:** web search results and fetched pages enter
  through `routes/search.cjs` and the `content.js` fetcher, and chat requests through `routes/llm.cjs`.
  A filtering or labelling service can be injected at those two seams.
* **Optional cloud inference and model routing:** `services/llm-engine.cjs` will expose one
  "generate/chat" interface. A router service can choose between local and (off-by-default) remote
  providers behind it, and outbound calls still go through `net-guard.cjs`.
