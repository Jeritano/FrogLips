//! Qwen2.5 text encoder for Qwen-Image — Phase 3 skeleton.
//!
//! Qwen-Image conditions on activations from a Qwen2.5-VL-7B-Instruct
//! encoder. For txt2img the vision tower is unused; only the language-
//! model path runs, emitting `(batch, seq, text_embed_dim=3584)`
//! hidden states that a learned projection (in the transformer's
//! `prepare_text_embed`, Phase 5) lifts to the MMDiT `hidden_size`.
//!
//! This module ships a structurally-complete decoder layer — RMSNorm,
//! grouped-query attention with RoPE, SwiGLU MLP — matching the Qwen2.5
//! architecture. It runs end-to-end on CPU/Metal against zeroed weights
//! (shape-tested below). Numeric validation against the HF reference is
//! deferred to Phase 8 (real weights + Metal runtime); the structure is
//! locked so that validation is a diff-the-logits exercise, not a
//! rewrite.
//!
//! ## Architecture (Qwen2.5-7B language model)
//!
//! ```text
//! tokens → embed → [decoder_layer × num_layers] → final RMSNorm → hidden
//!
//! decoder_layer:
//!   h = h + attn(rmsnorm(h))           # GQA + RoPE
//!   h = h + mlp(rmsnorm(h))            # SwiGLU
//!
//! attn:   q,k,v = proj(x); rope(q,k); GQA-repeat(k,v); sdpa; o_proj
//! mlp:    down(silu(gate(x)) * up(x))
//! ```
//!
//! Grouped-query attention: `num_attention_heads` query heads share
//! `num_key_value_heads` K/V heads (Qwen2.5-7B: 28 query / 4 kv).

use candle_core::{Result as CandleResult, Tensor, D};
use candle_nn::Linear;

use crate::image_gen::qwen_image::rope::apply_rope_interleaved;
use crate::image_gen::qwen_image::transformer::sdpa_manual;

/// Qwen2.5-7B language-model config (text-only path).
#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(dead_code)] // Fields consumed by the Phase-5 forward wiring + loader.
pub struct TextConfig {
    pub hidden_size: usize,
    pub num_layers: usize,
    pub num_attention_heads: usize,
    pub num_key_value_heads: usize,
    pub head_dim: usize,
    pub intermediate_size: usize,
    pub rms_eps: f64,
    pub rope_theta: f32,
    pub max_seq_len: usize,
}

impl TextConfig {
    /// Canonical Qwen2.5-7B params (the LM half of Qwen2.5-VL-7B).
    #[allow(dead_code)] // Phase-5 entry point.
    pub fn qwen25_7b() -> Self {
        Self {
            hidden_size: 3584,
            num_layers: 28,
            num_attention_heads: 28,
            num_key_value_heads: 4,
            head_dim: 128,
            intermediate_size: 18_944,
            rms_eps: 1e-6,
            rope_theta: 1_000_000.0,
            max_seq_len: 512,
        }
    }
}

/// RMSNorm (no bias) over the last dim. Pure tensor ops → CPU + Metal.
fn rms_norm(x: &Tensor, weight: &Tensor, eps: f64) -> CandleResult<Tensor> {
    let xf = x.to_dtype(candle_core::DType::F32)?;
    let variance = xf.sqr()?.mean_keepdim(D::Minus1)?;
    let normed = xf.broadcast_div(&(variance + eps)?.sqrt()?)?;
    let normed = normed.to_dtype(x.dtype())?;
    normed.broadcast_mul(weight)
}

/// Repeat K/V heads `n_rep` times along the head axis for GQA so the
/// query heads have matching K/V. `(b, kv_heads, seq, hd)` →
/// `(b, kv_heads * n_rep, seq, hd)`.
fn repeat_kv(x: &Tensor, n_rep: usize) -> CandleResult<Tensor> {
    if n_rep == 1 {
        return Ok(x.clone());
    }
    let (b, kv, seq, hd) = x.dims4()?;
    x.unsqueeze(2)?
        .broadcast_as((b, kv, n_rep, seq, hd))?
        .reshape((b, kv * n_rep, seq, hd))
}

/// One Qwen2.5 decoder layer's parameters.
#[allow(dead_code)] // Phase 3 type-only; real tensors land via Phase 4 loader.
#[derive(Debug)]
pub struct DecoderLayer {
    pub input_ln: Tensor,        // RMSNorm weight (hidden,)
    pub post_attn_ln: Tensor,    // RMSNorm weight (hidden,)
    pub q_proj: Linear,
    pub k_proj: Linear,
    pub v_proj: Linear,
    pub o_proj: Linear,
    pub gate_proj: Linear,
    pub up_proj: Linear,
    pub down_proj: Linear,
}

#[allow(dead_code)]
impl DecoderLayer {
    /// Forward one layer. `cos`/`sin`: `(seq, head_dim/2)` RoPE tables.
    pub fn forward(
        &self,
        x: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        cfg: &TextConfig,
    ) -> CandleResult<Tensor> {
        let (b, seq, _) = x.dims3()?;
        let nh = cfg.num_attention_heads;
        let nkv = cfg.num_key_value_heads;
        let hd = cfg.head_dim;
        let scale = (hd as f32).powf(-0.5);

        // ── Attention sub-block ──
        let normed = rms_norm(x, &self.input_ln, cfg.rms_eps)?;
        let q = normed.apply(&self.q_proj)?;
        let k = normed.apply(&self.k_proj)?;
        let v = normed.apply(&self.v_proj)?;

        let q = q.reshape((b, seq, nh, hd))?.transpose(1, 2)?.contiguous()?;
        let k = k.reshape((b, seq, nkv, hd))?.transpose(1, 2)?.contiguous()?;
        let v = v.reshape((b, seq, nkv, hd))?.transpose(1, 2)?.contiguous()?;

        let q = apply_rope_interleaved(&q, cos, sin)?;
        let k = apply_rope_interleaved(&k, cos, sin)?;

        let k = repeat_kv(&k, nh / nkv)?;
        let v = repeat_kv(&v, nh / nkv)?;

        let attn = sdpa_manual(&q, &k, &v, scale)?;
        let attn = attn
            .transpose(1, 2)?
            .reshape((b, seq, nh * hd))?
            .contiguous()?
            .apply(&self.o_proj)?;
        let x = (x + attn)?;

        // ── MLP sub-block (SwiGLU) ──
        let normed = rms_norm(&x, &self.post_attn_ln, cfg.rms_eps)?;
        let gate = candle_nn::ops::silu(&normed.apply(&self.gate_proj)?)?;
        let up = normed.apply(&self.up_proj)?;
        let mlp = (gate * up)?.apply(&self.down_proj)?;
        &x + mlp
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device};

    fn zeroed_layer(cfg: &TextConfig, dev: &Device) -> DecoderLayer {
        let h = cfg.hidden_size;
        let nh = cfg.num_attention_heads;
        let nkv = cfg.num_key_value_heads;
        let hd = cfg.head_dim;
        let i = cfg.intermediate_size;
        let lin = |o: usize, inp: usize| {
            Linear::new(Tensor::zeros((o, inp), DType::F32, dev).unwrap(), None)
        };
        DecoderLayer {
            input_ln: Tensor::ones((h,), DType::F32, dev).unwrap(),
            post_attn_ln: Tensor::ones((h,), DType::F32, dev).unwrap(),
            q_proj: lin(nh * hd, h),
            k_proj: lin(nkv * hd, h),
            v_proj: lin(nkv * hd, h),
            o_proj: lin(h, nh * hd),
            gate_proj: lin(i, h),
            up_proj: lin(i, h),
            down_proj: lin(h, i),
        }
    }

    #[test]
    fn qwen25_7b_config_gqa_ratio_is_integer() {
        let c = TextConfig::qwen25_7b();
        assert_eq!(c.num_attention_heads % c.num_key_value_heads, 0);
    }

    #[test]
    fn decoder_layer_preserves_shape() {
        // Small config for a fast CPU test; keep the GQA ratio + even
        // head_dim so rope + repeat_kv exercise real paths.
        let cfg = TextConfig {
            hidden_size: 32,
            num_layers: 1,
            num_attention_heads: 8,
            num_key_value_heads: 2,
            head_dim: 4,
            intermediate_size: 64,
            rms_eps: 1e-6,
            rope_theta: 1_000_000.0,
            max_seq_len: 16,
        };
        let dev = Device::Cpu;
        let layer = zeroed_layer(&cfg, &dev);
        // RoPE tables for the text stream: 1D positions, head_dim/2 pairs.
        // Build a trivial cos=1/sin=0 table so it's an identity rotation.
        let seq = 5;
        let half = cfg.head_dim / 2;
        let cos = Tensor::ones((seq, half), DType::F32, &dev).unwrap();
        let sin = Tensor::zeros((seq, half), DType::F32, &dev).unwrap();
        let x = Tensor::ones((1, seq, cfg.hidden_size), DType::F32, &dev).unwrap();
        let y = layer.forward(&x, &cos, &sin, &cfg).expect("layer forward");
        assert_eq!(y.dims(), [1, seq, cfg.hidden_size]);
    }

    #[test]
    fn repeat_kv_expands_head_axis() {
        let dev = Device::Cpu;
        let x = Tensor::zeros((1, 2, 5, 4), DType::F32, &dev).unwrap();
        let r = repeat_kv(&x, 4).unwrap();
        assert_eq!(r.dims(), [1, 8, 5, 4]);
    }

    #[test]
    fn repeat_kv_noop_when_ratio_one() {
        let dev = Device::Cpu;
        let x = Tensor::zeros((1, 4, 5, 4), DType::F32, &dev).unwrap();
        let r = repeat_kv(&x, 1).unwrap();
        assert_eq!(r.dims(), [1, 4, 5, 4]);
    }
}
