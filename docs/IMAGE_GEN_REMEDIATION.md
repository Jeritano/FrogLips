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
- ⚙ **H3. Loading-event race: `image-progress` can fire before the
  frontend's `listen` registers.**
  Frontend half landed `(pending)`: `useImageGeneration` now registers
  all three listeners (with their unlisten handles captured to a ref)
  BEFORE `imageGenerate` is dispatched, and a unit test asserts the
  ordering so the contract can't regress. The Rust-side counterpart —
  not emitting `Loading{stage:"warmup"}` from inside `engine.generate`
  until the pump is ready — stays with the BACK agent.
- ✓ **H4. Cancel button visible while non-functional.** `(pending)`
  Removed the Cancel button. While `progress.phase === "loading"` the
  UI shows a static "First run can take a few minutes — feel free to
  keep using other tabs." hint; sampling is spinner-only. Frontend
  carries a TODO(image-gen-back-ready) to bring the button back once
  C3 lands.
- ✓ **H5. Gallery shows ALL images cross-conversation.** `(pending)`
  ImageView now ships a three-state chip (All / This chat /
  Standalone). Default is "This chat" when a conv is selected, "All"
  otherwise. Standalone filters client-side; switch to a server-side
  arg once BACK ships one.
- ⚙ **H6. Save-to-Downloads ignores the user's chosen destination.**
  Frontend half landed `(pending)`: `ImageDetail` feature-detects
  `api.imageSaveTo` and calls it when present (writing to the chosen
  dest path verbatim); the legacy `<a download>` path remains as a
  fallback marked TODO(image-gen-back-ready) until BACK ships the IPC.

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
- ✓ **M4. `useImageGeneration` doesn't tear down listeners on unmount
  mid-flight.** `(pending)`
  Outstanding unlisten handles now live on a `cleanupsRef` and a
  top-level `useEffect` returns a teardown that drains them on
  unmount. Unit test asserts ≥3 unlistens fire when the hook unmounts
  with a generate in flight.
- ⚙ **M5. Cold-load shows zero progress between "warmup" and step 0.**
  Frontend stub landed `(pending)`: while phase is "loading" the
  status line rotates through helpful hints ("Loading FLUX weights…",
  "First run downloads ~14 GB from HuggingFace", …) every 3 s. When
  BACK starts emitting `Loading{stage:"downloading", bytes, total}`
  the UI will switch to the real byte counter; the TODO marker in
  `ImagePromptPanel.tsx` flags the swap site.
- ☐ **M6. `assert_under_images_root` re-canonicalizes every write.**
  Cheap, but cache the canonical root once per session.
- ☐ **M7. Atomic write skips parent directory fsync.**
  `commands/image.rs:516-549`. On power-loss the rename can be lost on
  APFS. Mirror `agent/fs.rs::write_nofollow_sync`.
- ✓ **M8. `Loading` event misclassified by frontend as sampling step.**
  `(pending)`
  Reordered to check `stage` first; a Loading event carrying
  `step:0,total:0` plus a non-empty stage string is now correctly
  classified as "loading" (with the stage label surfaced). Unit test
  asserts the ordering using a Loading-then-sampling event sequence.

## Low / Style

- ☐ **L1. `is_dev` model check is a substring match** (`contains("dev")`).
  Matches `developer-edition`, `lewdev`, etc. Use exact match against
  the canonicalized repo id.
- ☐ **L2. `random_seed` collision window is one nanosecond.**
  Acceptable while M1 is open (seed is decorative); revisit when the
  engine honors it.
- ☐ **L3. `image_cancel` doesn't drain remaining progress events.**
  Cosmetic; the event pump exits with the cancel.
- ⚙ **L4. `image_list` limit caps at 2000.**
  Frontend stub landed `(pending)`: when the server returns exactly
  PAGE_LIMIT (200) rows the strip shows a "Load more" button that
  bumps the limit and re-fetches. Real cursor-based pagination stays
  with BACK; `ImageView.tsx` carries the TODO marker.
- ✓ **L5. Agent-loop-generated images don't auto-refresh the gallery.**
  `(pending)`
  ImageView now registers a global `image-done` listener via
  `useTauriEvent`; any successful generation (including agent-driven
  ones) triggers a refresh and selects the new row. Covered by a unit
  test.
- ☐ **L6. `params_json` is hand-formatted twice** (`metadata.rs:37-40`
  dead vs `commands/image.rs:223-226`). Drift bait.
- ☐ **L7. `mod.rs:19 #![allow(dead_code)]` is overly broad.**
  Scope to the items that need it.

## Interface rework

- ✓ **U1. Hide the Advanced disclosure entirely until honored.** `(pending)`
  Advanced disclosure deleted from `ImagePromptPanel.tsx`. Replaced by
  a single hint line under Generate: "Schnell uses 4 steps; Dev uses
  28. Seed and CFG are model-defined in the current engine." Steps /
  cfg / seed inputs are gone entirely (opts pass nulls so Rust falls
  through to defaults).
- ✓ **U2. Replace 3-column layout with canvas-left + vertical thumb
  strip.** `(pending)`
  CSS grid retooled to `canvas | strip` over a sticky-bottom composer.
  Detail metadata moved into an "ℹ" disclosure inside the canvas pane.
  Under 1100 px the strip flips to a horizontal scroller below the
  composer (single media query).
- ✓ **U3. Per-conv gallery filter chip.** `(pending)`
  Three-state chip group in the canvas header (All / This chat /
  Standalone). Default depends on `conversationId`. Standalone is
  client-side; TODO(image-gen-back-ready) flips it to server-side
  once BACK ships an arg.
- ✓ **U4. Subscribe to `image-done` globally in `ImageView`.** `(pending)`
  Done via `useTauriEvent("image-done", refresh)`. Test covers it.
- ⚙ **U5. Real save dialog.** Frontend half landed `(pending)`:
  feature-detects `api.imageSaveTo` and routes through it when
  present; otherwise falls back to the legacy in-webview download.
  TODO(image-gen-back-ready) drops the fallback once H6 lands.
- ⚙ **U6. "Unload model" button on the prompt panel.** Frontend half
  landed `(pending)`: button renders iff `api.imageUnload` is on the
  api object; on success surfaces "Model unloaded. Next generate will
  reload (~30-90s)." TODO marker for the post-H1 cleanup.
- ⚙ **U7. Cold-load progress UI.** Frontend half landed `(pending)`:
  rotating hint copy while phase is "loading"; switches to a real
  byte counter once BACK starts emitting
  `Loading{stage:"downloading", bytes, total}`.
- ✓ **U8. Drop seed line from detail pane until C1 fixes the underlying
  bug.** `(pending)`
  Seed row removed from `ImageDetail.tsx`. Steps and CFG only render
  when they differ from the model default (so a future engine-honored
  override shows up automatically).

## Feature add-ons (new requests from this session)

- ⚙ **F1. Add quantized FLUX.1 variants to the model dropdown** —
  Frontend half landed `(pending)`: dropdown gains `schnell-fp8`,
  `dev-fp8`, `schnell-gguf-q4`, `dev-gguf-q4`. The `generate_image`
  agent tool enum gains the same values, and the system-prompt rule
  tells the agent to prefer the smaller variants on low-RAM machines.
  Rust-side mapping in `canonicalize_flux_repo` stays with BACK.
- ✓ **F2. Document FLUX.1 Pro / 1.1 Pro as unavailable.** `(pending)`
  USER_GUIDE §7b now carries a "Note on FLUX Pro / 1.1 Pro" paragraph
  explaining the closed weights; README's Images bullet mentions the
  same.
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
