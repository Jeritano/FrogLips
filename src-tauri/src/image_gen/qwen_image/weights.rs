//! Per-block weight container for the Qwen-Image joint MMDiT block.
//!
//! Phase 2b (2026-05-28): holds the eight `Linear` projections the
//! joint-attention path needs to run end-to-end. Phase 4 will add the
//! real safetensors loader; Phase 2b ships a `zeroed()` helper so the
//! forward pass can be exercised in unit tests against shape-correct
//! placeholders.
//!
//! Naming mirrors the diffusers tensor key paths under
//! `transformer.transformer_blocks.{i}.` so the future loader can build
//! the per-parameter lookup keys by simple string concatenation — see
//! the doc block on `transformer.rs` for the full layout reference.
//!
//! Module not gated by `feature = "native-mistralrs"` because candle is
//! always-on (see Cargo.toml). The forward pass uses Metal on Apple
//! Silicon and CPU elsewhere; either path satisfies the type contract
//! without changing the public surface.

use candle_core::{DType, Device, Result, Tensor};
use candle_nn::Linear;

use crate::image_gen::qwen_image::config::Config;

/// All `Linear` projections one joint block needs. LayerNorm scales for
/// the post-attention `norm2` block live here too once Phase 2c lands
/// the AdaLayerNormZero modulation path; for Phase 2b we keep the
/// surface minimal so the joint-attention core can be exercised in
/// isolation.
#[allow(dead_code)] // Phase 2b/2c: built but not yet wired to a real safetensors loader.
#[derive(Debug)]
pub struct JointBlockWeights {
    // Image stream attention projections.
    pub img_to_q: Linear,
    pub img_to_k: Linear,
    pub img_to_v: Linear,
    pub img_to_out: Linear,
    // Text stream attention projections.
    pub txt_add_q: Linear,
    pub txt_add_k: Linear,
    pub txt_add_v: Linear,
    pub txt_to_add_out: Linear,
    // Phase 2c — per-stream MLP. `ff_in` is `ff.net.0.proj`
    // (hidden→ffn), `ff_out` is `ff.net.2` (ffn→hidden). Text stream
    // uses `ff_context.*` with identical shapes.
    pub img_ff_in: Linear,
    pub img_ff_out: Linear,
    pub txt_ff_in: Linear,
    pub txt_ff_out: Linear,
    // Phase 2c — AdaLayerNormZero modulation. `img_mod` / `txt_mod`
    // are the `*_mod.1` linears projecting the timestep embedding into
    // SIX channel-modulation vectors each (shift_msa, scale_msa,
    // gate_msa, shift_mlp, scale_mlp, gate_mlp), so out_dim =
    // 6 * hidden_size.
    pub img_mod: Linear,
    pub txt_mod: Linear,
}

impl JointBlockWeights {
    /// Construct a weight set populated with zeroed tensors of the
    /// correct shape. Intended for unit tests and shape-flow smoke
    /// tests — the forward pass produces all-zero outputs but the
    /// shape arithmetic is real, so a mis-sized config trips the
    /// matmul shape check loudly.
    ///
    /// The real safetensors loader (Phase 4) will replace this with a
    /// `load_from_safetensors(prefix, vb)` constructor reading
    /// matching keys out of the Qwen-Image archive.
    #[allow(dead_code)] // Phase 2b: only callers are unit tests + Phase 4 loader.
    pub fn zeroed(config: &Config, device: &Device, dtype: DType) -> Result<Self> {
        let h = config.hidden_size;
        let f = config.ffn_dim;
        // Linear in candle is `out = x @ W.T + b`, so the weight tensor
        // has shape `(out_dim, in_dim)`. For square projections both
        // dims are `hidden_size`.
        let square = || Tensor::zeros((h, h), dtype, device).map(|w| Linear::new(w, None));
        // `rect(out, in)` for the MLP + modulation projections.
        let rect = |out: usize, inp: usize| {
            Tensor::zeros((out, inp), dtype, device).map(|w| Linear::new(w, None))
        };
        Ok(Self {
            img_to_q: square()?,
            img_to_k: square()?,
            img_to_v: square()?,
            img_to_out: square()?,
            txt_add_q: square()?,
            txt_add_k: square()?,
            txt_add_v: square()?,
            txt_to_add_out: square()?,
            img_ff_in: rect(f, h)?,
            img_ff_out: rect(h, f)?,
            txt_ff_in: rect(f, h)?,
            txt_ff_out: rect(h, f)?,
            // Modulation projects the timestep embedding (hidden-d) into
            // 6 modulation vectors of hidden-d each.
            img_mod: rect(6 * h, h)?,
            txt_mod: rect(6 * h, h)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zeroed_weights_match_hidden_size() {
        let device = Device::Cpu;
        let cfg = Config::qwen_image_canonical();
        let w = JointBlockWeights::zeroed(&cfg, &device, DType::F32).expect("zeroed must build");
        for linear in [
            &w.img_to_q,
            &w.img_to_k,
            &w.img_to_v,
            &w.img_to_out,
            &w.txt_add_q,
            &w.txt_add_k,
            &w.txt_add_v,
            &w.txt_to_add_out,
        ] {
            let shape = linear.weight().dims();
            assert_eq!(
                shape,
                [cfg.hidden_size, cfg.hidden_size],
                "all square projections must be (hidden_size, hidden_size)"
            );
        }
    }

    #[test]
    fn zeroed_weights_have_no_bias() {
        let device = Device::Cpu;
        let cfg = Config::qwen_image_canonical();
        let w = JointBlockWeights::zeroed(&cfg, &device, DType::F32).expect("zeroed must build");
        // Qwen-Image's attention projections are bias-free in the
        // upstream config; the zeroed stub mirrors that so the forward
        // path matches the real shape.
        assert!(w.img_to_q.bias().is_none());
        assert!(w.txt_add_q.bias().is_none());
    }
}
