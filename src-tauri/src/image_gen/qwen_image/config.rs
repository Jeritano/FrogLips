//! Qwen-Image MMDiT configuration.
//!
//! Mirrors the `transformer_blocks.0` … `transformer_blocks.{num_layers-1}`
//! shape exposed by HF `Qwen/Qwen-Image`'s diffusers config. Defaults match
//! the canonical Alibaba release (2026-04 weights snapshot). All sizes are
//! captured here in one place so the forward-pass port in `transformer.rs`
//! has a single source of truth and so weight-loading code can fail loudly
//! on a shape mismatch.
//!
//! The values come from the HF `Qwen/Qwen-Image/config.json` and the
//! upstream `QwenImageTransformer2DModel` constructor signature. Where the
//! upstream config has a derived value (e.g. `head_dim =
//! hidden_size / num_attention_heads`), we keep the redundant field so
//! debug prints and assertions read cleanly; the derived check lives in
//! [`Config::validate`].

use anyhow::{anyhow, Result};

/// Qwen-Image transformer configuration.
///
/// The struct is `Copy` so the planner can clone it freely into per-block
/// sub-configs without lifetime gymnastics — the field set is small and
/// trivially-copyable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    /// Hidden dimension shared by the image and text streams in the
    /// joint blocks. Matches Qwen-Image's `hidden_size = 3072`.
    pub hidden_size: usize,
    /// Number of attention heads per joint block. Canonical = 24.
    pub num_attention_heads: usize,
    /// Per-head dimension. Canonical = `hidden_size / num_attention_heads`
    /// = 128. Stored explicitly so a shape mismatch is detected at config
    /// build time rather than inside an attention kernel.
    pub head_dim: usize,
    /// Number of MMDiT joint blocks. Canonical = 60 (Qwen-Image's depth is
    /// the largest in the open MMDiT family as of 2026-04).
    pub num_layers: usize,
    /// FFN inner dimension. Canonical = `4 * hidden_size = 12288`.
    pub ffn_dim: usize,
    /// VAE patch size (square). Image latents are folded into patches of
    /// this size before entering the transformer. Canonical = 2.
    pub patch_size: usize,
    /// Number of channels in the VAE latent space. Canonical = 16 (Qwen
    /// uses the same 16-channel latent as SD3/Flux).
    pub in_channels: usize,
    /// Joint text-stream embedding dim. The Qwen2.5-VL-7B text encoder
    /// emits 3584-d activations; a learned projection lifts them to
    /// `hidden_size` inside `prepare_text_embed`. Stored so the projection
    /// shapes verify at config load.
    pub text_embed_dim: usize,
    /// Maximum sequence length the text encoder produces (post-tokenize +
    /// pad). Canonical = 512. Tighter values are accepted; longer
    /// sequences are truncated before entering the transformer.
    pub max_text_seq_len: usize,
    /// Rotary-embedding base (theta). Canonical = 10_000.0 — matches the
    /// standard transformer convention.
    pub rope_theta: f32,
    /// Latent-dim split for the 3D RoPE. Qwen-Image splits the per-head
    /// rotary slot across (time, height, width) axes. Canonical = (16, 56,
    /// 56) for a head_dim of 128 (16 + 56 + 56 = 128). The `time` axis is
    /// kept for parity with the diffusers reference even though txt2img
    /// only ever uses height/width — leaving it 0 in the forward pass.
    pub rope_axes_dim: (usize, usize, usize),
}

impl Config {
    /// Canonical Qwen-Image config as published by Alibaba in 2026-04.
    /// Returns the same parameters the HF `Qwen/Qwen-Image` repo's
    /// `config.json` ships with. Use this as the starting point — callers
    /// can override individual fields for ablations or for fp8/quantized
    /// variants that differ in `num_layers` or `ffn_dim`.
    #[allow(dead_code)] // Phase 2 type-only; consumed by transformer.rs in Phase 2b.
    pub fn qwen_image_canonical() -> Self {
        Self {
            hidden_size: 3072,
            num_attention_heads: 24,
            head_dim: 128,
            num_layers: 60,
            ffn_dim: 12_288,
            patch_size: 2,
            in_channels: 16,
            text_embed_dim: 3584,
            max_text_seq_len: 512,
            rope_theta: 10_000.0,
            rope_axes_dim: (16, 56, 56),
        }
    }

    /// Verifies the cross-field invariants the constructor promises hold.
    /// Called once at config-load time so an upstream config_json mismatch
    /// surfaces with a clear error rather than as an obscure attention-
    /// shape failure deep in the forward pass.
    pub fn validate(&self) -> Result<()> {
        if self.hidden_size == 0 {
            return Err(anyhow!("hidden_size must be > 0"));
        }
        if self.num_attention_heads == 0 {
            return Err(anyhow!("num_attention_heads must be > 0"));
        }
        if self.head_dim * self.num_attention_heads != self.hidden_size {
            return Err(anyhow!(
                "head_dim ({}) * num_attention_heads ({}) must equal hidden_size ({})",
                self.head_dim,
                self.num_attention_heads,
                self.hidden_size,
            ));
        }
        let (t, h, w) = self.rope_axes_dim;
        if t + h + w != self.head_dim {
            return Err(anyhow!(
                "rope_axes_dim sum ({} + {} + {} = {}) must equal head_dim ({})",
                t,
                h,
                w,
                t + h + w,
                self.head_dim,
            ));
        }
        // Each axis-dim is the dim of a `cos+sin` rotary pair — must be
        // even or the pair-rotation breaks.
        for (name, axis) in [("time", t), ("height", h), ("width", w)] {
            if axis % 2 != 0 {
                return Err(anyhow!(
                    "rope axis `{name}` dim ({axis}) must be even (cos/sin pairs)"
                ));
            }
        }
        if self.ffn_dim < self.hidden_size {
            return Err(anyhow!(
                "ffn_dim ({}) must be ≥ hidden_size ({})",
                self.ffn_dim,
                self.hidden_size,
            ));
        }
        if self.patch_size == 0 || self.in_channels == 0 {
            return Err(anyhow!("patch_size and in_channels must be > 0"));
        }
        if self.text_embed_dim == 0 || self.max_text_seq_len == 0 {
            return Err(anyhow!("text_embed_dim and max_text_seq_len must be > 0"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_config_validates() {
        Config::qwen_image_canonical().validate().expect("canonical must validate");
    }

    #[test]
    fn canonical_head_dim_matches_division() {
        let c = Config::qwen_image_canonical();
        assert_eq!(c.head_dim * c.num_attention_heads, c.hidden_size);
    }

    #[test]
    fn canonical_rope_axes_sum_to_head_dim() {
        let c = Config::qwen_image_canonical();
        let (t, h, w) = c.rope_axes_dim;
        assert_eq!(t + h + w, c.head_dim);
    }

    #[test]
    fn validate_catches_head_dim_mismatch() {
        let mut c = Config::qwen_image_canonical();
        c.head_dim = 64; // 64 * 24 = 1536 ≠ 3072
        assert!(c.validate().is_err());
    }

    #[test]
    fn validate_catches_rope_axes_mismatch() {
        let mut c = Config::qwen_image_canonical();
        c.rope_axes_dim = (16, 56, 60); // sums to 132 ≠ head_dim 128
        assert!(c.validate().is_err());
    }

    #[test]
    fn validate_rejects_odd_rope_axis() {
        let mut c = Config::qwen_image_canonical();
        c.rope_axes_dim = (15, 57, 56); // sums to 128 but `time` axis is odd
        assert!(c.validate().is_err());
    }

    #[test]
    fn validate_rejects_zero_hidden_size() {
        let mut c = Config::qwen_image_canonical();
        c.hidden_size = 0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn validate_rejects_ffn_smaller_than_hidden() {
        let mut c = Config::qwen_image_canonical();
        c.ffn_dim = c.hidden_size - 1;
        assert!(c.validate().is_err());
    }
}
