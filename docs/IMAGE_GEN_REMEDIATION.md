# Image-gen layer — remediation tracker

Single source of truth for the open items in the Flux text-to-image
surface, consolidated from the senior-engineer audit (session of 2026-05-23)
plus the bugs surfaced while actually exercising the feature. Severity is
graded the same way as the rest of the codebase audits.

Status legend: ☐ open · ⚙ in-progress · ✓ landed.

## Critical

- ☐ **C1. mistralrs deterministic-output bug — every generation returns the same image regardless of prompt.**
  Root: `mistralrs-core 0.8.1`'s diffusion pipeline holds a single
  `Arc<Mutex<Isaac64Rng>>` keyed at load time and never re-seeded per
  request (`pipeline/diffusion.rs:351`). Schnell's 4-step denoise from a
  fixed initial latent dominates the prompt-conditioning signal, so
  different prompts produce near-identical PNGs. Confirm via
  `shasum` on two generations with different prompts.
  Fix path: (a) ship a "fresh each gen" toggle that drops the cached
  pipeline before each call (~30-90 s warmup per gen, 100 % reliable),
  then (b) vendor the Flux sampler with our own per-request seed.
- ☐ **C2. PNG metadata embedding is dead code.**
  `image_gen/metadata.rs::encode_with_metadata` is never called — the
  bytes mistralrs hands back are written to disk verbatim. The
  reproducibility contract ("each PNG carries `prompt`, `model`,
  `params_json`, `version` as tEXt chunks") is silently broken.
  Either wire it into `commands/image.rs::write_atomic` (decode →
  re-encode with chunks) or delete the module.
- ☐ **C3. `is_cancelled` is structurally non-functional — even pre-dispatch
  cancel never fires.**
  `engine.rs:416-456` polls `Notify::notified()` once with a no-op
  waker; `notify_waiters` only wakes already-parked waiters. The Cancel
  button is decorative end-to-end.
  Fix: swap to `tokio_util::sync::CancellationToken` (or
  `AtomicBool + Notify`), poll between every step we actually have
  control over.
- ☐ **C4. Send-to-chat may keep failing on the macOS asset:// scheme.**
  `tauri.conf.json:24` lists `asset: http://asset.localhost` in
  `connect-src`; macOS Tauri 2 may need the bare `asset:` scheme
  literal. Verify by checking the webview console for a CSP
  `Refused to connect` warning while clicking "Send to current chat".
- ☐ **C5. Black-tile rendering — confirm asset-protocol scope works on
  canonical paths.**
  Just landed `assetProtocol.scope: ["$HOME/.local-llm-app/images/**"]`
  + the `protocol-asset` cargo feature (`85cd1d7`). If the user's home
  canonicalizes through `/System/Volumes/Data/...` on FileVault'd
  APFS, the glob fails. Broaden to `**` and confirm with
  `Console.app` WKWebView logs if the surface still shows black.

## High

- ☐ **H1. Pipeline never unloads — ~14-28 GiB pinned until app quit.**
  Add `image_unload` IPC + an "Unload model" button. Auto-evict after
  N minutes idle. Half the plumbing already exists in
  `load_or_reuse` (switching `(model, offload)` drops the previous
  slot).
- ☐ **H2. Concurrent generate calls race the pipeline.**
  `engine.rs::generate` does NOT serialize. Two IPC callers (UI click
  + agent-loop tool call) can both invoke `load_or_reuse`, doubling
  the ~14 GiB load. Add a generate-wide mutex.
- ☐ **H3. Loading-event race: `image-progress` can fire before the
  frontend's `listen` registers.**
  `commands/image.rs:113-122` emits `Loading{stage:"warmup"}` from
  inside `engine.generate` BEFORE the pump task is ready. Events lost
  → UI stays on the wrong phase. Mint the op-id, register listeners,
  THEN call `image_generate`.
- ☐ **H4. Cancel button visible while non-functional.**
  Tied to C3. Until cancel actually works, swap the button for a
  static hint ("first run downloads ~14 GB"). Reintroduce when
  cancellation is real.
- ☐ **H5. Gallery shows ALL images cross-conversation.**
  `ImageView.tsx:44` calls `imageList(null, 200)`. Add a 3-state
  filter chip: All / This chat / Standalone. Default to "This chat"
  when a conv is selected.
- ☐ **H6. Save-to-Downloads ignores the user's chosen destination.**
  `ImageDetail.tsx:60-98` asks for a dest path, then writes via
  `<a download>` (always Downloads dir). Add an `image_save_to` Rust
  IPC that copies from the validated source path to a validated dest
  path via `commands/path_safety`.

## Medium

- ☐ **M1. Reported seed is fabricated.**
  `commands/image.rs::random_seed` picks a value our IPC records, but
  mistralrs's `SamplingParams::deterministic()` is LLM-only and the
  diffusion path uses an opaque internal Rng. The "Seed: …" in the
  detail pane corresponds to nothing the engine consumed. Until the
  engine honors a seed (C1 fix), either drop the field from the UI or
  label it "(recorded, currently ignored by engine)".
- ☐ **M2. `image_get` IPC has no React caller.**
  Used only by the agent-loop dispatch arm. Either delete or wire
  into a "regenerate from row" affordance.
- ☐ **M3. Send-to-chat round-trip is wasteful + lacks structured error.**
  `App.tsx:556-565` chunks PNG → base64 → `messages.images`. ~1.4 MB
  string per send; conversation rows grow. Add a structured error
  kind ("asset-fetch", "encode-failed") for the catch block.
- ☐ **M4. `useImageGeneration` doesn't tear down listeners on unmount
  mid-flight.**
  Add a `useEffect(() => () => unlisten(), [])` so switching views
  during a generation doesn't leak Tauri event listeners or fire
  `setState` on an unmounted component.
- ☐ **M5. Cold-load shows zero progress between "warmup" and step 0.**
  10+ minutes opaque on a fresh HF cache. Poll
  `~/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-*` dir
  size every ~5 s and emit synthetic `Loading{stage:"downloading",
  bytes, total}` events. UI shows "Downloading: 4.2 / 14.0 GB" instead
  of "Loading model…".
- ☐ **M6. `assert_under_images_root` re-canonicalizes every write.**
  Cheap, but cache the canonical root once per session.
- ☐ **M7. Atomic write skips parent directory fsync.**
  `commands/image.rs:516-549`. On power-loss the rename can be lost on
  APFS. Mirror `agent/fs.rs::write_nofollow_sync`.
- ☐ **M8. `Loading` event misclassified by frontend as sampling step.**
  `useImageGeneration.ts:106-119` checks `typeof p.step === "number"`
  before `stage`, so a Loading event with `step:0,total:0` lands as
  "Generating step 0/0". Reorder to check `stage` first.

## Low / Style

- ☐ **L1. `is_dev` model check is a substring match** (`contains("dev")`).
  Matches `developer-edition`, `lewdev`, etc. Use exact match against
  the canonicalized repo id.
- ☐ **L2. `random_seed` collision window is one nanosecond.**
  Acceptable while M1 is open (seed is decorative); revisit when the
  engine honors it.
- ☐ **L3. `image_cancel` doesn't drain remaining progress events.**
  Cosmetic; the event pump exits with the cancel.
- ☐ **L4. `image_list` limit caps at 2000.**
  Past 2000 images the gallery silently truncates. Add pagination or
  surface the truncation.
- ☐ **L5. Agent-loop-generated images don't auto-refresh the gallery.**
  `ImageView` doesn't subscribe to `image-done` globally. Add a
  cross-component listener.
- ☐ **L6. `params_json` is hand-formatted twice** (`metadata.rs:37-40`
  dead vs `commands/image.rs:223-226`). Drift bait.
- ☐ **L7. `mod.rs:19 #![allow(dead_code)]` is overly broad.**
  Scope to the items that need it.

## Interface rework

- ☐ **U1. Hide the Advanced disclosure entirely until honored.**
  Steps/cfg/seed are lies in 0.8.1 (M1, C1). Replace with a tooltip
  on Generate explaining the model defaults.
- ☐ **U2. Replace 3-column layout with canvas-left + vertical thumb
  strip.**
  At 1440 px the current grid crowds the detail pane. Big canvas left,
  96 px-wide thumb scroller right, prompt composer collapsed into a
  sticky bottom bar, detail metadata behind a drawer toggle.
- ☐ **U3. Per-conv gallery filter chip.**
  Tied to H5.
- ☐ **U4. Subscribe to `image-done` globally in `ImageView`.**
  Tied to L5.
- ☐ **U5. Real save dialog.**
  Tied to H6.
- ☐ **U6. "Unload model" button on the prompt panel.**
  Tied to H1.
- ☐ **U7. Cold-load progress UI.**
  Tied to M5.
- ☐ **U8. Drop seed line from detail pane until C1 fixes the underlying
  bug.**
  Tied to M1.

## Feature add-ons (new requests from this session)

- ☐ **F1. Add quantized FLUX.1 variants to the model dropdown** —
  fp8 / GGUF Q4_K of FLUX.1-dev and FLUX.1-schnell. Same `FluxLoader`
  in mistralrs 0.8.1 (no new code path), much smaller RAM footprint
  (~6 GiB instead of 14-28 GiB), runs on 8 GiB Macs. Add as new
  options in `canonicalize_flux_repo` and the frontend dropdown.
- ☐ **F2. Document FLUX.1 Pro / 1.1 Pro as unavailable** (closed
  weights, API-only). Add a one-liner to USER_GUIDE §7b so the next
  user doesn't wonder why they aren't in the picker.
- ☐ **F3. Wire Fill / Depth / Canny / Redux control adapters when
  mistralrs exposes a loader.**
  Currently 0.8.1 has no plumbing for them. Watch upstream.

## Already shipped this session

- ✓ Friendly Flux shorthand → canonical HF repo id mapping
  (`canonicalize_flux_repo`, `6d7b049`).
- ✓ Full anyhow chain on HF load errors + actionable hints
  (`c25b0d6`).
- ✓ One-time HuggingFace setup documented in USER_GUIDE §7b
  (`3c16d82`).
- ✓ Tauri `assetProtocol` config + `protocol-asset` cargo feature so
  the gallery can actually load the PNGs it writes (`85cd1d7`).
- ✓ Module + IPC + DB v10 + scaffold from R1 (`6af574f`).
- ✓ Real mistralrs Flux wiring + frontend Image surface +
  `generate_image` agent tool from R2 (`e9094b5`, `7af5487`).
