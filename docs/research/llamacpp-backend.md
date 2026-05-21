# llama.cpp Cross-Platform Native Backend — Research

Decision: **`llama-cpp-2`** (utilityai) for non-mac-arm64 targets.

## Crate choice
- Active, MIT/Apache-2.0, multi-backend feature flags (`cuda`, `metal`, `vulkan`, `hipblas`, `openblas`, `dynamic-link`).
- Bundles llama.cpp via git submodule + CMake. Build deps: cmake, C/C++ compiler, clang.
- Tracks upstream closely — pin minor version, expect quarterly churn.

## Feature scheme (mutually exclusive)
```toml
default = []
native-inference  = []                                                 # umbrella
native-mistralrs  = ["native-inference", "dep:mistralrs-core", "dep:candle-core", ...]
native-llamacpp   = ["native-inference", "dep:llama-cpp-2"]
```
`compile_error!` in `native_inference/mod.rs` if both set. Per-target default:
- macos-aarch64 → `native-mistralrs`
- macos-x86_64 / linux-* / windows-* → `native-llamacpp`

## Module layout
```
src-tauri/src/native_inference/
  mod.rs                # cfg dispatch + NativeRuntime trait + SharedRuntime
  mistralrs_backend.rs  # cfg(feature = "native-mistralrs")
  llamacpp_backend.rs   # cfg(feature = "native-llamacpp")
  stub.rs               # cfg(not(any(...)))
```

## Trait surface
```rust
async fn load(model_ref: ModelRef) -> Result<Self>;
fn model_id(&self) -> &str;
async fn chat_stream(messages, sampling, on_chunk) -> Result<String>;
// Drop for context release
```
`ModelRef::HfRepo(String)` or `ModelRef::GgufPath(PathBuf)`. SamplingOpts + SharedRuntime unchanged so `lib.rs` untouched.

## ModelBrowser changes (GGUF picker)
`ModelBrowser.tsx` HF tab is pinned to `mlx-community` + repo-only IDs.
- New tab `"hf-gguf"` querying HF without author filter or with `library=gguf`.
- Per-repo file tree via `https://huggingface.co/api/models/{repo}/tree/main`.
- Pull signature `(repo_id, filename)` — single GGUF file download.
- New Rust cmd `native_download_gguf(repo, file, dest)` streaming to `~/Library/Application Support/.../models/gguf/`.

## Build cost
- Compile: +3-6 min on M-series, +5-10 min on x86_64 CI cold. Cached after.
- Binary: +8-15 MB per enabled backend. Metal-only ~10 MB. CUDA +40 MB (dynamic libs unbundled). Vulkan +5 MB.
- Both backends on macos-arm64 = BAD. Make mutually exclusive.

## Rollout order
1. Refactor `native_inference.rs` into trait + module layout. Mistralrs-only. Verify no behavior change. **[done]**
2. Add `llama-cpp-2` behind `native-llamacpp`. GGUF-from-local-path only. Hidden Rust cmd for testing. **[done]**
3. Extend `ModelBrowser.tsx` with GGUF file-picker tab. **[done]**
4. Flip CI matrix so non-mac-arm64 builds `native-llamacpp` by default. **[designed — see `.github/workflows/release.yml`; not yet validated in CI since no tag has been pushed against the new workflow]**
5. Optional: `dynamic-link` to use user-installed `libllama`, skip bundling.

### Phase 4 design notes
`release.yml` is a 4-entry matrix (`macos-14` / `macos-13` / `ubuntu-22.04` / `windows-2022`) with a downstream `publish` job that flattens artifacts and emits `latest.json` covering all four `platforms` keys (`darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`, `windows-x86_64`). The mac-arm64 entry uses `native-mistralrs`; the other three use `native-llamacpp`. CI deps:
- **Linux**: `cmake build-essential libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf curl wget file`
- **Windows**: cmake (preinstalled) + LLVM/clang via `KyleMayes/install-llvm-action@v2` with `LIBCLANG_PATH` exported for `bindgen` (used by `llama-cpp-sys-2`).
- **macOS**: cmake via Xcode CLT (fallback `brew install cmake` if missing).

## Risks
- llama-cpp-2 API breaks frequently w/ upstream. Pin minor, expect churn.
- cmake/clang in CI runners. Already true for tauri builds; confirm Windows.
