# Engine supervision (Step 9.6)

The studio server (`scripts/server/serve.cjs`) starts separate engine processes: llama.cpp for chat,
stable-diffusion.cpp for images, whisper.cpp for transcription, and the Kokoro worker for voice. This
page describes how they are started, stopped and watched.

## The problem this fixes

Before Step 9.6, on **Linux and macOS**, engines were cleaned up only when the server shut down
normally (Ctrl+C, `SIGTERM`). If the server was killed outright, its engines kept running in the
background. That happens with `SIGKILL`, a crash that bypasses the shutdown handlers, the
out-of-memory killer, or a closed terminal. The orphaned engine still held its memory (often several
GB for a model) and its port, and the next start had to find another port.

On **Windows**, Node already places the processes it starts in a job object that Windows ends together
with the server. A plainly started engine therefore didn't outlive a killed server there. The
supervisor keeps that behaviour and adds the same graceful stop and diagnostics on every platform.

`scripts/tests/engine-supervision.test.cjs` checks this on all four platforms. On Linux and macOS, a
plainly started engine survives its killed parent, which reproduces the original problem. On Windows,
the baseline is that it stops. A supervised engine stops within seconds everywhere.

## How it works

Each engine runs under a small guard process (`scripts/server/engine-guard.cjs`), started by
`scripts/server/supervisor.cjs`:

```
serve.cjs ──IPC channel──▶ engine-guard.cjs ──▶ llama-server / sd-server / whisper-cli / Kokoro worker
```

* **The server goes away, for any reason:** the operating system closes the IPC channel, and the guard
  stops the engine. A check every second that the server process still exists is a second safety net.
* **Normal stop** (unloading a model, switching models): a polite stop first, then a forced one after
  3 seconds (`USAP_ENGINE_STOP_GRACE_MS`). Then the server waits until the engine's port is free again.
  On Windows the engine and anything it started are ended together (`taskkill /T`).
* **Transparent:** the engine's output, exit code and crash signal reach the server unchanged, so
  existing error messages still apply (for example the macOS Metal `SIGABRT`). Input still reaches
  the engine: the voice worker reads its job that way.
* **Graceful server shutdown** still stops every engine first, as before. On exits that skip the
  shutdown handlers (an uncaught error), an exit hook asks every engine to stop immediately.

## Text engine lifecycle

| Situation | Behaviour |
|---|---|
| Stop while a model is loading | The load is cancelled at once (not after it finishes, which on a CPU could take minutes). No other backend or profile is tried. `POST /api/llm/start` answers `409` with `code: "ENGINE_START_CANCELLED"` |
| Engine fails to start | Reported as before. Recorded in diagnostics (`lastExit`, `unexpected: false`). Not restarted |
| Engine never becomes ready | Times out (built-in limits: 6 min GPU, 12 min CPU; `USAP_LLM_READY_TIMEOUT_MS` overrides them). The engine is stopped and its port released |
| Engine stops on its own after loading (a crash) | Detected and restarted with the same settings after 1 s, 2 s, then 4 s. After 3 restarts within 10 minutes it isn't restarted again. Chat then answers `409` with `code: "ENGINE_CRASHED"` and an error explaining what happened. Loading the model again by hand resets the count. `USAP_ENGINE_AUTO_RESTART=0` turns restarts off |
| Chat while not ready | `409`, as before, with an additive `code`: `ENGINE_NOT_READY`, `ENGINE_STARTING`, `ENGINE_RESTARTING` or `ENGINE_CRASHED`. The message for a model that isn't loaded is unchanged |
| Concurrent start/stop requests | Serialized as before. Never more than one engine, and the reported state matches the processes |

The image engine reports an unexpected crash signal as a clear message ("The image engine stopped
unexpectedly (signal …)") instead of only a later connection error. It isn't restarted automatically.

## Diagnostics (additive)

* `GET /api/llm/status` → `engine`: `state` (`stopped`, `starting`, `ready`, `restarting`,
  `crashed`), `restartsInWindow`, `restartLimit`, `autoRestart`, `lastExit` (`code`, `signal`, `at`,
  `unexpected`), `crash`, `supervised`.
* `GET /api/diagnostics` → `engines.llm` (the same), and `engines.processes`: the supervised
  processes now running (label, process ids, start time) and the last 10 exits.

No other field changed; the API contract tests pass unchanged.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `USAP_ENGINE_STOP_GRACE_MS` | `3000` | How long an engine gets to stop politely before it is forced |
| `USAP_ENGINE_AUTO_RESTART` | on | `0` turns off automatic restarts of the text engine |
| `USAP_LLM_READY_TIMEOUT_MS` | built-in | Overrides how long a text model may take to become ready |

## Limitations

* **Not supervised yet:**
  * The optional Intel NPU (OpenVINO) worker, which can't be tested on hosted CI.
  * The short one-off helper commands (version and `--help` probes, OpenVINO model conversion).
* **Only the text engine restarts automatically.** The image, speech and voice processes report
  failures but aren't restarted.
* If something kills **only a guard process** with `SIGKILL` (not the server), its engine isn't
  stopped. Normal tools that end the server, or the whole process tree, are covered.
* On Windows, stopping an engine is always forced: console programs can't be asked to stop politely.
  Before Step 9.6 it was also forced.
