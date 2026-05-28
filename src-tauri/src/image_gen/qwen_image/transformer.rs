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

use candle_core::{Result as CandleResult, Tensor, D};

use crate::image_gen::qwen_image::config::Config;
use crate::image_gen::qwen_image::rope::{apply_rope_interleaved, RopeFrequencies};
use crate::image_gen::qwen_image::weights::JointBlockWeights;

/// Non-affine LayerNorm over the last dim. Qwen-Image's pre-attention
/// and pre-MLP norms use `elementwise_affine=False` — the gain/bias
/// come from the AdaLayerNormZero modulation instead. Pure tensor ops
/// so it runs on CPU + Metal alike.
fn layer_norm_no_affine(x: &Tensor, eps: f64) -> CandleResult<Tensor> {
    let mean = x.mean_keepdim(D::Minus1)?;
    let centered = x.broadcast_sub(&mean)?;
    let var = centered.sqr()?.mean_keepdim(D::Minus1)?;
    let denom = (var + eps)?.sqrt()?;
    centered.broadcast_div(&denom)
}

/// Apply AdaLayerNormZero modulation: `norm(x) * (1 + scale) + shift`.
/// `scale` / `shift` are `(batch, hidden)`; unsqueezed to `(batch, 1,
/// hidden)` so they broadcast across the sequence dim.
fn modulate(normed: &Tensor, scale: &Tensor, shift: &Tensor) -> CandleResult<Tensor> {
    let scale = scale.unsqueeze(1)?; // (b, 1, h)
    let shift = shift.unsqueeze(1)?;
    let one_plus = (scale + 1.0)?;
    normed.broadcast_mul(&one_plus)?.broadcast_add(&shift)
}

/// Gated residual: `x + gate * delta`. `gate` is `(batch, hidden)`,
/// unsqueezed to broadcast across the sequence dim.
fn gated_add(x: &Tensor, gate: &Tensor, delta: &Tensor) -> CandleResult<Tensor> {
    let gate = gate.unsqueeze(1)?;
    x.broadcast_add(&delta.broadcast_mul(&gate)?)
}

/// Manual scaled dot-product attention. Candle 0.10's `nn_ops::sdpa` is
/// Metal/CUDA-only — invoking it on a CPU tensor panics with "SDPA has
/// no cpu impl". For Phase 2b we need a path that runs on both Metal
/// (real inference) and CPU (unit tests), so we open-code the math:
///
/// ```text
/// scores = (q @ k.transpose(-2, -1)) * scale
/// attn   = softmax(scores, dim=-1)
/// out    = attn @ v
/// ```
///
/// All inputs are `(batch, heads, seq, head_dim)`; output matches q's
/// shape. Phase 6 (Metal kernels) replaces this with `nn_ops::sdpa`
/// behind a `#[cfg]` once the test harness has a Metal-capable runner.
fn sdpa_manual(q: &Tensor, k: &Tensor, v: &Tensor, scale: f32) -> CandleResult<Tensor> {
    let kt = k.transpose(D::Minus2, D::Minus1)?.contiguous()?;
    let scores = q.matmul(&kt)?;
    let scaled = (scores * scale as f64)?;
    let attn = candle_nn::ops::softmax_last_dim(&scaled)?;
    attn.matmul(v)
}

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

    /// Full joint-block forward pass.
    ///
    /// Phase 2c (2026-05-28) completes the block:
    ///   1. AdaLayerNormZero modulation derived from the timestep
    ///      embedding `temb` — each stream's `*_mod` linear projects
    ///      `silu(temb)` into 6 channel vectors (shift/scale/gate for
    ///      the attn block, shift/scale/gate for the MLP block).
    ///   2. Pre-attention non-affine LayerNorm → modulate → Q/K/V.
    ///   3. 3D RoPE rotation (interleaved) on the IMAGE Q/K only; the
    ///      text stream is position-free in Qwen-Image.
    ///   4. Joint attention (concat image+text K/V, single SDPA, split).
    ///   5. Output projections + gated residual (`gate_msa`).
    ///   6. Pre-MLP non-affine LayerNorm → modulate → `ff_in` → GELU →
    ///      `ff_out` → gated residual (`gate_mlp`).
    ///
    /// Shape contract:
    ///   * `img`: `(batch, img_seq, hidden_size)`
    ///   * `txt`: `(batch, txt_seq, hidden_size)`
    ///   * `temb`: `(batch, hidden_size)` — timestep embedding.
    ///   * `rope_cos` / `rope_sin`: `(img_seq, head_dim/2)` from
    ///     [`RopeFrequencies::image_rotation_tensors`].
    ///   * returns `(img_out, txt_out)` with the input stream shapes.
    ///
    /// Remaining Phase 5 wiring: this is the PER-BLOCK pass. The
    /// end-to-end forward (patchify → N blocks → unpatchify → VAE
    /// decode) lands once the loader + scheduler exist.
    #[allow(dead_code)] // Wired by the Phase 5 end-to-end forward pass.
    pub fn forward(
        &self,
        img: &Tensor,
        txt: &Tensor,
        temb: &Tensor,
        weights: &JointBlockWeights,
        rope_cos: &Tensor,
        rope_sin: &Tensor,
    ) -> CandleResult<(Tensor, Tensor)> {
        const LN_EPS: f64 = 1e-6;
        let cfg = self.config;
        let heads = cfg.num_attention_heads;
        let head_dim = cfg.head_dim;
        let h = cfg.hidden_size;
        let scale = (head_dim as f32).powf(-0.5);

        let (b, img_seq, _) = img.dims3()?;
        let (_, txt_seq, _) = txt.dims3()?;

        // ── 1. Modulation: silu(temb) → 6 chunks per stream ──
        let act = candle_nn::ops::silu(temb)?;
        let img_mod = act.apply(&weights.img_mod)?; // (b, 6h)
        let txt_mod = act.apply(&weights.txt_mod)?;
        // chunk(6, last) splits the 6h dim into six (b, h) tensors in
        // order: shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp,
        // gate_mlp.
        let imc = img_mod.chunk(6, D::Minus1)?;
        let txc = txt_mod.chunk(6, D::Minus1)?;
        let (i_shift_a, i_scale_a, i_gate_a, i_shift_m, i_scale_m, i_gate_m) =
            (&imc[0], &imc[1], &imc[2], &imc[3], &imc[4], &imc[5]);
        let (t_shift_a, t_scale_a, t_gate_a, t_shift_m, t_scale_m, t_gate_m) =
            (&txc[0], &txc[1], &txc[2], &txc[3], &txc[4], &txc[5]);

        // ── 2. Pre-attention norm + modulate → Q/K/V ──
        let img_in = modulate(&layer_norm_no_affine(img, LN_EPS)?, i_scale_a, i_shift_a)?;
        let txt_in = modulate(&layer_norm_no_affine(txt, LN_EPS)?, t_scale_a, t_shift_a)?;

        let img_q = img_in.apply(&weights.img_to_q)?;
        let img_k = img_in.apply(&weights.img_to_k)?;
        let img_v = img_in.apply(&weights.img_to_v)?;
        let txt_q = txt_in.apply(&weights.txt_add_q)?;
        let txt_k = txt_in.apply(&weights.txt_add_k)?;
        let txt_v = txt_in.apply(&weights.txt_add_v)?;

        // Reshape to (batch, heads, seq, head_dim).
        let to_heads = |x: Tensor, seq: usize| -> CandleResult<Tensor> {
            x.reshape((b, seq, heads, head_dim))?
                .transpose(1, 2)?
                .contiguous()
        };
        let img_q = to_heads(img_q, img_seq)?;
        let img_k = to_heads(img_k, img_seq)?;
        let img_v = to_heads(img_v, img_seq)?;
        let txt_q = to_heads(txt_q, txt_seq)?;
        let txt_k = to_heads(txt_k, txt_seq)?;
        let txt_v = to_heads(txt_v, txt_seq)?;

        // ── 3. 3D RoPE on image Q/K (text is position-free) ──
        let img_q = apply_rope_interleaved(&img_q, rope_cos, rope_sin)?;
        let img_k = apply_rope_interleaved(&img_k, rope_cos, rope_sin)?;

        // ── 4. Joint attention ──
        let joint_q = Tensor::cat(&[&img_q, &txt_q], 2)?;
        let joint_k = Tensor::cat(&[&img_k, &txt_k], 2)?;
        let joint_v = Tensor::cat(&[&img_v, &txt_v], 2)?;
        let joint_out = sdpa_manual(&joint_q, &joint_k, &joint_v, scale)?;

        let img_attn = joint_out.narrow(2, 0, img_seq)?;
        let txt_attn = joint_out.narrow(2, img_seq, txt_seq)?;

        let from_heads = |x: Tensor, seq: usize| -> CandleResult<Tensor> {
            x.transpose(1, 2)?.reshape((b, seq, heads * head_dim))?.contiguous()
        };
        let img_attn = from_heads(img_attn, img_seq)?;
        let txt_attn = from_heads(txt_attn, txt_seq)?;

        // ── 5. Output projection + gated residual ──
        let img_attn = img_attn.apply(&weights.img_to_out)?;
        let txt_attn = txt_attn.apply(&weights.txt_to_add_out)?;
        let img = gated_add(img, i_gate_a, &img_attn)?;
        let txt = gated_add(txt, t_gate_a, &txt_attn)?;

        // ── 6. Pre-MLP norm + modulate → MLP → gated residual ──
        let img_mlp_in = modulate(&layer_norm_no_affine(&img, LN_EPS)?, i_scale_m, i_shift_m)?;
        let txt_mlp_in = modulate(&layer_norm_no_affine(&txt, LN_EPS)?, t_scale_m, t_shift_m)?;
        let img_mlp = img_mlp_in
            .apply(&weights.img_ff_in)?
            .gelu()?
            .apply(&weights.img_ff_out)?;
        let txt_mlp = txt_mlp_in
            .apply(&weights.txt_ff_in)?
            .gelu()?
            .apply(&weights.txt_ff_out)?;
        let img = gated_add(&img, i_gate_m, &img_mlp)?;
        let txt = gated_add(&txt, t_gate_m, &txt_mlp)?;

        // Silence unused-binding lint on `h` when assertions compiled out.
        debug_assert_eq!(img.dim(D::Minus1)?, h);
        Ok((img, txt))
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

    // ── Phase 2b: joint-attention forward pass shape contract ──
    //
    // The forward path runs against `JointBlockWeights::zeroed` so the
    // numeric output is always all-zero. We only assert the shape
    // round-trips: a `(batch, img_seq, hidden_size)` image stream stays
    // shape-stable end-to-end, and the same for the text stream. The
    // real numeric validation lands in Phase 5 once the weight loader
    // + scheduler are wired and we can diff outputs against the
    // diffusers reference.

    #[test]
    fn joint_block_forward_preserves_stream_shapes() {
        use candle_core::{DType, Device, Tensor};
        use crate::image_gen::qwen_image::weights::JointBlockWeights;

        // Small test config so the CPU matmul stays fast.
        let test_cfg = Config {
            hidden_size: 32,
            num_attention_heads: 4,
            head_dim: 8,
            num_layers: 1,
            ffn_dim: 64,
            patch_size: 2,
            in_channels: 16,
            text_embed_dim: 32,
            max_text_seq_len: 16,
            rope_theta: 10_000.0,
            rope_axes_dim: (2, 2, 4),
        };
        test_cfg.validate().expect("test config must validate");

        let device = Device::Cpu;
        // Grid 4×4 → img_seq = 16. txt_seq is independent.
        let (h_pos, w_pos) = (4usize, 4usize);
        let t = QwenImageTransformer::new(test_cfg, 1, h_pos, w_pos).expect("scaffold");
        let w = JointBlockWeights::zeroed(&test_cfg, &device, DType::F32)
            .expect("zeroed weights");
        let (rope_cos, rope_sin) =
            t.rope.image_rotation_tensors(&device).expect("rope tensors");

        let batch = 1;
        let img_seq = h_pos * w_pos;
        let txt_seq = 8;
        let img = Tensor::zeros((batch, img_seq, test_cfg.hidden_size), DType::F32, &device)
            .expect("img tensor");
        let txt = Tensor::zeros((batch, txt_seq, test_cfg.hidden_size), DType::F32, &device)
            .expect("txt tensor");
        let temb = Tensor::zeros((batch, test_cfg.hidden_size), DType::F32, &device)
            .expect("temb tensor");

        let (img_out, txt_out) = t.blocks[0]
            .forward(&img, &txt, &temb, &w, &rope_cos, &rope_sin)
            .expect("forward must run end-to-end");
        assert_eq!(img_out.dims(), [batch, img_seq, test_cfg.hidden_size]);
        assert_eq!(txt_out.dims(), [batch, txt_seq, test_cfg.hidden_size]);
    }

    #[test]
    fn joint_block_forward_with_nonzero_temb_runs() {
        // Exercise the modulation path with a non-zero timestep
        // embedding so the silu + chunk + broadcast arithmetic is
        // actually traversed (zeroed temb short-circuits to silu(0)=0).
        use candle_core::{DType, Device, Tensor};
        use crate::image_gen::qwen_image::weights::JointBlockWeights;

        let test_cfg = Config {
            hidden_size: 16,
            num_attention_heads: 2,
            head_dim: 8,
            num_layers: 1,
            ffn_dim: 32,
            patch_size: 2,
            in_channels: 16,
            text_embed_dim: 16,
            max_text_seq_len: 8,
            rope_theta: 10_000.0,
            rope_axes_dim: (2, 2, 4),
        };
        let device = Device::Cpu;
        let t = QwenImageTransformer::new(test_cfg, 1, 2, 2).expect("scaffold");
        let w = JointBlockWeights::zeroed(&test_cfg, &device, DType::F32).expect("weights");
        let (rc, rs) = t.rope.image_rotation_tensors(&device).expect("rope");
        let img = Tensor::ones((1, 4, 16), DType::F32, &device).unwrap();
        let txt = Tensor::ones((1, 3, 16), DType::F32, &device).unwrap();
        let temb = Tensor::ones((1, 16), DType::F32, &device).unwrap();
        let (io, to) = t.blocks[0]
            .forward(&img, &txt, &temb, &w, &rc, &rs)
            .expect("forward with non-zero temb");
        assert_eq!(io.dims(), [1, 4, 16]);
        assert_eq!(to.dims(), [1, 3, 16]);
    }
}
