# Step 9.8f: model management and downloads

Status: **done** (#59, #60; model metadata in #63). Part of the modular backend plan in [STEP9_8_MODULES.md](STEP9_8_MODULES.md).

This step moves model management and downloads out of `scripts/server/serve.cjs` into three modules. The code is
moved, not rewritten. API responses, model folders, file names and the interface are unchanged.

## Module boundaries

| Module | Owns | Does not own |
|---|---|---|
| `services/model-store.cjs` | Model folders on disk: listing image, text and OpenVINO models; models linked in place (`linkedFrom`, broken links marked `missing`); filing a model under its detected type; model file names; streamed imports (staged as `.part`, then replaced in one step) | HTTP, downloads, engines |
| `services/downloads.cjs` | The single download slot and its status; verified model downloads (Step 9.4 downloader: allow-listed destinations, re-validated redirects, staged `.part` files, checksums, retries); cancellation; OpenVINO model downloads; the Windows image-engine download and its staged install; the logic of `GET /api/download-progress` | HTTP, model listing |
| `routes/models.cjs` | The 17 HTTP routes below | Server state (read through getters) |

Routes: `GET /api/models`, `/api/llm/models`, `/api/openvino-models`, `/api/download-progress`,
`/api/huggingface/models` (prefix); `POST /api/download-model`, `/api/llm/download-model`, `/api/download-openvino-model`,
`/api/download-backend`, `/api/cancel-download`, `/api/delete-model`, `/api/llm/delete-model`, `/api/move-model`,
`/api/link-model`, `/api/pick-model-file`, `/api/import-model` and `/api/llm/import-model` (prefix; streamed upload).

The speech and voice routes keep using the same download slot and upload code through the same functions.

All routes are still reached only through the request pipeline: Host check, Origin/CORS, sign-in, then the router,
inside the error boundary.

## How it was moved

* 26 top-level declarations (10 in the model store, 16 in downloads) and the 17 route bodies were moved by a script
  that works on the syntax tree, so the moved text is exact. A second check compares every moved function and route
  body with the previous `serve.cjs`, after undoing only the rewrites listed below: all are identical.
* The rewrites are limited to free variables:
  * server state that changes at run time is read through getters: `getLlmSettings()`, `getLlmProc()`,
    `getCurrentSettings()`, `getBackendProc()`, `getDownloadState()`;
  * `cachedBackendOptions = null` became `invalidateBackendOptions()`;
  * the body of `GET /api/download-progress` became `downloads.getDownloadProgress()`, because it resets the
    download status.
* `serve.cjs` keeps the old function names (bound from the services), so the code that stays there is unchanged.
* The services are created where the moved code used to be, so start-up order is the same: the model store before the
  speech and voice services, which use its helpers.
* A golden comparison ran 36 requests against the previous and the new server (model lists, every download check,
  traversal attempts, deletes, moves, links, imports). The responses and the resulting files are identical.

## Still in `serve.cjs`

* The Hugging Face search and projector helpers (`searchHuggingFaceModels`, `addHuggingFaceFileSize`,
  `resolveHuggingFaceProjector`). Only the model routes use them now; they can move with a later catalog change.
* Model load settings and recommendations (`/api/llm/model-settings`, `/api/llm/recommend`) and load-error messages
  (`getModelLoadIssue`): they belong to the engines (9.8g image, 9.8h text).
* Cleanup candidates (`/api/cleanup`), which also cover non-model files.

## Tests

`scripts/tests/model-management.test.cjs` (24 tests, deterministic, no network):

* downloads with a stand-in downloader: verified result, checksum mismatch, interrupted transfer, cancel (a late
  result can't overwrite it), one download at a time, restricted destinations refused before any request, response
  checks (status, HTML pages), redirects reported, URL checks;
* the model store on a temporary folder: imports keep only the file name, interrupted imports leave no model and no
  `.part` file, malformed GGUF and safetensors headers are listed as `unknown`, linked and broken-link models;
* routes with stand-in dependencies: the 17 routes and their matching rules, `409` while a download runs, deletes
  never leave the models folder, a loaded text model is stopped before it is deleted, a loaded model can't be moved,
  moves and links never overwrite;
* the real server with sign-in on: every model change needs sign-in, cross-origin and non-JSON deletes are refused,
  downloads to loopback, link-local, private and internal destinations (and `file:`) are refused on both download
  routes, an upload cut off mid-way leaves nothing behind, and a signed-in import keeps only the file name.

The checksum, redirect and partial-file handling of the downloader itself stays covered by
`download-integrity.test.cjs`, `integrity.test.cjs` and `ssrf.test.cjs` (Step 9.4, 9.3).

## Existing behaviour kept as it is

These were found while moving the code. Changing them would change behaviour, so this step keeps them. Follow-ups:
[#58](https://github.com/dlroqa/usap/issues/58) (the first three and the shared download slot) and
[#57](https://github.com/dlroqa/usap/issues/57) (linked-model locations).

* An import or download replaces a model with the same file name in that folder.
* `POST /api/delete-model` and `/api/llm/delete-model` accept any file name inside their folder, including the
  `.part` file of a download in progress.
* `POST /api/pick-model-file` opens a file dialog on the computer running the studio, for any signed-in device.
* `POST /api/download-openvino-model` answers `500` when the OpenVINO runtime isn't installed (the 9.7 finding that
  some validation errors still return 500).
* Model lists return the full location of models linked in place (`linkedFrom`).
* There is one download slot for image, text, speech and voice models and the image engine.
