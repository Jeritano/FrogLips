//! Qwen-Image backend — Alibaba's MMDiT text-to-image diffusion model.
//!
//! ## Multi-phase port plan
//!
//! Adding a second backend to Froglips is a structurally large undertaking
//! because the existing image_gen surface is shaped around mistralrs's
//! `FluxLoader` (model id → repo → safetensors → Metal → diffusion). Qwen-Image
//! is not supported by mistralrs 0.8.1 (the upstream `DiffusionLoaderType`
//! enum only exposes `Flux` + `FluxOffloaded`; master is still 0.8.1 as of
//! 2026-05-28), and the closest cousin in candle-transformers is the SD3
//! `MMDiT` block — Qwen uses a similar joint-block layout but with 3D RoPE on
//! patch coordinates and a Qwen2.5-VL-7B text encoder, both of which are
//! absent from candle.
//!
//! Rather than wedge a partially-working pipeline into the IPC surface, this
//! module is split into staged phases. Each phase commits as a contained
//! piece of work so the build stays green between sessions.
//!
//! | Phase | Scope | Status |
//! |-------|-------|--------|
//! | **1** | Module scaffold, base-id detection, LoRA key mapping, dispatcher routing, frontend dropdown, KNOWN_MODELS entries, tests for the dispatcher / key-mapping branches. Generation returns `kind:"qwen_unimplemented"`. | **shipped** |
//! | 2 | Port `candle-transformers::models::mmdit` SD3 joint-block as a starting point. Add Qwen's 3D RoPE on patch coordinates. | pending |
//! | 3 | Qwen2.5-VL-7B-Instruct text encoder (text-only path is enough for txt2img). Reuse existing Qwen2 plumbing from candle. | pending |
//! | 4 | `AutoencoderKLQwenImage` VAE port. | pending |
//! | 5 | Flow-match Euler scheduler. Wire end-to-end forward pass. | pending |
//! | 6 | Memory offload (mirror `FluxOffloaded`) for ≤16 GiB Macs. | pending |
//! | 7 | LoRA dispatch: load the merged variant via the new loader instead of erroring. | pending |
//!
//! Phase 1 deliverable contract:
//!
//! * `is_qwen_base(repo)` returns `true` for the Qwen-Image HF repo.
//! * `model_id_resolves_to_qwen(id)` returns `true` for the four `qwen-image*`
//!   shorthands the frontend emits and for the canonical `Qwen/Qwen-Image`
//!   repo id (case-insensitive).
//! * The dispatcher in `engine.rs::generate` and `engine.rs::load_or_reuse`
//!   short-circuits on `is_qwen_base` with `kind:"qwen_unimplemented"` until
//!   Phase 5 lands.
//! * The LoRA pipeline accepts `Qwen/Qwen-Image` as a base (see
//!   `lora::ALLOWED_BASES`) and routes Qwen-shape LoRA keys through the new
//!   `Convention::QwenImage` branch in `lora::target_from_lora_key`.
//! * The frontend `KNOWN_MODELS` list surfaces `qwen-image` / `qwen-image-fp8`
//!   so the LoRA panel can pick them as the base for a merge.
//!
//! ## Security-review carve-out (2026-05-28)
//!
//! The user's stated motivation for Phase 1 is a capability audit of NSFW
//! Qwen-Image LoRAs. With Phase 1 in place, an analyst can:
//!
//!   1. Download a Qwen-Image LoRA into the Froglips cache.
//!   2. Run `lora::inspect` to dump the safetensors header (tensor key
//!      conventions, dtype, shape — no weights deserialization).
//!   3. Hash-verify against the HF API checksum.
//!   4. Optionally run `lora::merge` to materialize the merged variant on
//!      disk (purely tensor math — no inference) and inspect the result.
//!
//! Actual image generation remains gated behind Phase 5, so the audit can
//! complete without enabling the capability.

use anyhow::anyhow;

// Phase 2 submodules (2026-05-28). Each is a contained piece of the
// MMDiT port — config + 3D RoPE precompute landed first; the joint-
// block forward pass (Phase 2b) hangs off `transformer`. None of these
// allocate model weights yet; weight loading is Phase 4.
pub mod config;
pub mod rope;
pub mod transformer;
pub mod weights;

/// Canonical HF repo id for the Qwen-Image base model.
pub const QWEN_IMAGE_REPO: &str = "Qwen/Qwen-Image";

/// Shorthand model ids the frontend dropdown emits. `commands/image.rs::
/// canonicalize_*` maps these into [`QWEN_IMAGE_REPO`].
pub const QWEN_IMAGE_SHORTHANDS: &[&str] = &[
    "qwen-image",
    "qwen-image-fp8",
];

/// Returns `true` when `repo` names the Qwen-Image base. Case-insensitive so
/// a model id typed `qwen/qwen-image` from the agent loop matches the
/// canonical `Qwen/Qwen-Image`.
pub fn is_qwen_base(repo: &str) -> bool {
    repo.eq_ignore_ascii_case(QWEN_IMAGE_REPO)
}

/// Returns `true` when `id` names a Qwen-Image variant — accepts both the
/// shorthand list and the canonical HF repo id. Used by the dispatcher in
/// `engine.rs` to route a `generate_image` request away from the Flux path.
///
/// Does NOT accept the `<base>+lora:<sha>` suffix; the dispatcher strips
/// the LoRA suffix BEFORE this check so a `Qwen/Qwen-Image+lora:abc...` id
/// resolves correctly.
pub fn model_id_resolves_to_qwen(id: &str) -> bool {
    if is_qwen_base(id) {
        return true;
    }
    QWEN_IMAGE_SHORTHANDS
        .iter()
        .any(|s| id.eq_ignore_ascii_case(s))
}

/// Phase-1 stub error: surfaced by the engine dispatcher when a request
/// resolves to a Qwen-Image variant. Frontend renders this with a
/// "Qwen-Image inference is not yet enabled — Phase 5 work" copy.
pub fn unimplemented_error() -> anyhow::Error {
    anyhow!(
        "kind:\"qwen_unimplemented\" Qwen-Image inference is not yet wired in; only LoRA inspection + merge are supported in Phase 1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_repo_is_qwen_base() {
        assert!(is_qwen_base(QWEN_IMAGE_REPO));
    }

    #[test]
    fn is_qwen_base_is_case_insensitive() {
        assert!(is_qwen_base("qwen/qwen-image"));
        assert!(is_qwen_base("QWEN/QWEN-IMAGE"));
        assert!(is_qwen_base("Qwen/Qwen-Image"));
    }

    #[test]
    fn is_qwen_base_rejects_unrelated_repos() {
        assert!(!is_qwen_base("black-forest-labs/FLUX.1-dev"));
        assert!(!is_qwen_base("Qwen/Qwen2-VL-7B"));
        assert!(!is_qwen_base("stabilityai/stable-diffusion-3.5-large"));
    }

    #[test]
    fn shorthands_resolve_to_qwen() {
        for s in QWEN_IMAGE_SHORTHANDS {
            assert!(
                model_id_resolves_to_qwen(s),
                "shorthand {s} must resolve to Qwen"
            );
            // Case-insensitive too.
            assert!(model_id_resolves_to_qwen(&s.to_uppercase()));
        }
    }

    #[test]
    fn canonical_repo_resolves_to_qwen() {
        assert!(model_id_resolves_to_qwen(QWEN_IMAGE_REPO));
        assert!(model_id_resolves_to_qwen("qwen/qwen-image"));
    }

    #[test]
    fn flux_ids_do_not_resolve_to_qwen() {
        assert!(!model_id_resolves_to_qwen("schnell"));
        assert!(!model_id_resolves_to_qwen("dev"));
        assert!(!model_id_resolves_to_qwen("black-forest-labs/FLUX.1-dev"));
        assert!(!model_id_resolves_to_qwen("black-forest-labs/FLUX.1-schnell"));
    }
}
