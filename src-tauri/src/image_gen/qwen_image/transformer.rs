//! Qwen-Image MMDiT joint-block transformer — Phase 2 skeleton.
//!
//! The actual forward pass (Phase 2b — pending) materializes the math
//! sketched in the type comments below. This file ships the type
//! commitments + per-block constructor signatures so weight loading and
//! LoRA dispatch in later phases can be built against a stable surface.
//!
//! ## Joint-block layout (per `transformer_blocks.{i}`)
//!
//! A Qwen-Image joint block runs the image stream and text stream side-
//! by-side through a shared attention surface. Within one block, in
//! order:
//!
//!  1. Image stream `img_mod`-conditioned LayerNorm → `attn.to_q/k/v`
//!  2. Text stream `txt_mod`-conditioned LayerNorm → `attn.add_q/k/v_proj`
//!  3. 3D RoPE applied to image Q/K (per [`rope::RopeFrequencies`]); text
//!     stream is RoPE-free.
//!  4. Joint attention: concatenate image and text K/V along the sequence
//!     dim, run a single SDPA, split back into image and text streams.
//!  5. Image stream output proj `attn.to_out.0`, text stream output proj
//!     `attn.to_add_out`.
//!  6. Per-stream MLP: image uses `ff.net.0.proj` + `ff.net.2`; text uses
//!     the same shape with its own weights.
//!  7. Per-stream residual + AdaLayerNormZero modulation gates the MLP.
//!
//! `img_mod` and `txt_mod` are SiLU(linear(time_embed)) projections of
//! the diffusion-step embedding into 6 channel-modulation vectors each:
//! (shift, scale, gate) per ln-block. Standard MMDiT pattern.
//!
//! Tensor key shapes the forward pass + LoRA dispatch reference (these
//! are the safetensors key paths under `transformer.transformer_blocks
//! .{i}.`):
//!
//! ```text
//! attn.to_q.weight             (hidden_size, hidden_size)
//! attn.to_k.weight             (hidden_size, hidden_size)
//! attn.to_v.weight             (hidden_size, hidden_size)
//! attn.to_out.0.weight         (hidden_size, hidden_size)
//! attn.add_q_proj.weight       (hidden_size, hidden_size)
//! attn.add_k_proj.weight       (hidden_size, hidden_size)
//! attn.add_v_proj.weight       (hidden_size, hidden_size)
//! attn.to_add_out.weight       (hidden_size, hidden_size)
//! ff.net.0.proj.weight         (ffn_dim,    hidden_size)
//! ff.net.2.weight              (hidden_size, ffn_dim)
//! ff_context.net.0.proj.weight (ffn_dim,    hidden_size)
//! ff_context.net.2.weight      (hidden_size, ffn_dim)
//! img_mod.1.weight             (6 * hidden_size, hidden_size)
//! txt_mod.1.weight             (6 * hidden_size, hidden_size)
//! ```
//!
//! The trailing `norm_*.weight` LayerNorm scales are not pulled in here
//! because Qwen uses `elementwise_affine=False` LayerNorm for the pre-
//! attention norms (the modulation provides the gain/bias). The post-
//! attention LayerNorm (`norm2`) IS affine and will appear in the
//! eventual weight-loading map.
//!
//! ## Phase status
//!
//! Phase 2 (THIS COMMIT): type skeleton + Config + 3D RoPE precompute
//! + JointBlock constructor signature. Forward pass returns
//! `qwen_unimplemented`. No weight loading yet — that lands in Phase 4
//! alongside the VAE / text-encoder weight maps so the loader walks all
//! three in one shot.
//!
//! Phase 2b: forward pass with candle SDPA. Hooks the joint-attention,
//! the MLP, and the modulation projections.
//!
//! Phase 3-6: text encoder, VAE, scheduler, offload — see the master
//! plan in `mod.rs`.

use crate::image_gen::qwen_image::config::Config;
use crate::image_gen::qwen_image::rope::RopeFrequencies;

/// One MMDiT joint block. Phase 2 ships the type and the constructor
/// shape; the parameter tensors land in Phase 4. The signature is
/// designed so a future `forward(img, txt, modulation, rope)` method
/// can drop in without breaking callers.
#[allow(dead_code)] // Phase 2 type-only commitment; forward path lands in 2b.
#[derive(Debug)]
pub struct JointBlock {
    /// Layer index (0 .. config.num_layers). Used for logging and for
    /// the safetensors prefix `transformer.transformer_blocks.{idx}.`.
    pub layer_idx: usize,
    /// Echo of the config the block was built from. Stored so the
    /// per-block forward path can validate shapes without threading a
    /// reference through every call.
    pub config: Config,
}

#[allow(dead_code)] // See `JointBlock` — Phase 2 placeholder.
impl JointBlock {
    pub fn new(layer_idx: usize, config: Config) -> Self {
        Self { layer_idx, config }
    }

    /// Path prefix this block's parameters live under inside the
    /// Qwen-Image safetensors archive. Matches the diffusers
    /// `transformer.transformer_blocks.{i}.` convention so the future
    /// weight loader can build the per-parameter lookup keys by
    /// concatenation.
    pub fn safetensors_prefix(&self) -> String {
        format!("transformer.transformer_blocks.{}.", self.layer_idx)
    }
}

/// Top-level Qwen-Image transformer container. Holds the per-block
/// state + the rotary precompute. Phase 2 ships the type only —
/// `forward()` will be added in 2b when SDPA + projection layers wire
/// through.
#[allow(dead_code)]
#[derive(Debug)]
pub struct QwenImageTransformer {
    pub config: Config,
    pub blocks: Vec<JointBlock>,
    pub rope: RopeFrequencies,
}

#[allow(dead_code)]
impl QwenImageTransformer {
    /// Build the transformer scaffold for the given config and the
    /// post-VAE-patch grid shape. Validates the config invariants and
    /// pre-computes the rotary tables. Does NOT load any weights yet
    /// — weight loading lands in Phase 4.
    pub fn new(
        config: Config,
        time_positions: usize,
        height_positions: usize,
        width_positions: usize,
    ) -> anyhow::Result<Self> {
        config.validate()?;
        let blocks = (0..config.num_layers)
            .map(|i| JointBlock::new(i, config))
            .collect();
        let rope = RopeFrequencies::new(
            &config,
            time_positions,
            height_positions,
            width_positions,
        );
        Ok(Self {
            config,
            blocks,
            rope,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transformer_scaffold_has_one_block_per_layer() {
        let c = Config::qwen_image_canonical();
        let t = QwenImageTransformer::new(c, 1, 4, 4).expect("scaffold must build");
        assert_eq!(t.blocks.len(), c.num_layers);
    }

    #[test]
    fn block_safetensors_prefix_includes_layer_index() {
        let c = Config::qwen_image_canonical();
        let t = QwenImageTransformer::new(c, 1, 4, 4).expect("scaffold must build");
        assert_eq!(
            t.blocks[0].safetensors_prefix(),
            "transformer.transformer_blocks.0."
        );
        assert_eq!(
            t.blocks[59].safetensors_prefix(),
            "transformer.transformer_blocks.59."
        );
    }

    #[test]
    fn transformer_rejects_invalid_config() {
        let mut c = Config::qwen_image_canonical();
        c.head_dim = 99; // 99 * 24 ≠ 3072
        assert!(QwenImageTransformer::new(c, 1, 4, 4).is_err());
    }

    #[test]
    fn rope_axes_round_trip_through_transformer() {
        let c = Config::qwen_image_canonical();
        let t = QwenImageTransformer::new(c, 1, 4, 4).expect("scaffold must build");
        assert_eq!(t.rope.axes, c.rope_axes_dim);
    }
}
