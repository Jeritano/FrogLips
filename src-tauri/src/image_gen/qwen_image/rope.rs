//! Qwen-Image 3D rotary position embeddings.
//!
//! Qwen-Image's MMDiT applies RoPE on three independent axes — (time,
//! height, width) — concatenated along the per-head dim. For txt2img the
//! `time` axis is always single-step (T=1) so its rotary slot stays at
//! position 0 across the whole image, but the slot is still allocated so
//! the head dim sums correctly and so a future image-edit pipeline that
//! pipes through multiple frames doesn't need a separate kernel.
//!
//! ## Layout
//!
//! RoPE rotates the per-head vector in adjacent `(2k, 2k+1)` pairs
//! (GPT-J / "interleaved" convention — matches candle's `rope_i`). Each
//! axis owns `axis_dim` head-dim slots = `axis_dim/2` rotation pairs.
//! For head_dim 128 with axes (16, 56, 56):
//!   slots  0.. 16 (pairs  0.. 8) rotate by the time position
//!   slots 16.. 72 (pairs  8..36) rotate by the height position
//!   slots 72..128 (pairs 36..64) rotate by the width position
//!
//! The per-axis tables here store ONE value per pair (length
//! `positions * axis_dim/2`), which is exactly the shape candle's
//! `rope_i_slow` consumes (`(seq, n_embd/2)`). [`image_rotation_tensors`]
//! gathers the three axis tables into a single `(img_seq, head_dim/2)`
//! cos/sin pair indexed by each image patch token's `(row, col)` grid
//! coordinate.
//!
//! Pair-rotation math (per pair `k` at position `p`):
//!   freq_k = 1 / theta ^ (2k / axis_dim)
//!   angle  = p * freq_k
//!   out_{2k}   = x_{2k} * cos(angle) - x_{2k+1} * sin(angle)
//!   out_{2k+1} = x_{2k} * sin(angle) + x_{2k+1} * cos(angle)

use candle_core::{Device, Result as CandleResult, Tensor};

use crate::image_gen::qwen_image::config::Config;

/// Per-axis rotary precompute. Each `Vec<f32>` is `positions *
/// (axis_dim/2)` long, holding one cos (resp. sin) value per rotation
/// pair in row-major `[position][pair]` order.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Fields read by image_rotation_tensors (itself Phase-5-only) + future Metal kernel.
pub struct RopeFrequencies {
    pub time_cos: Vec<f32>,
    pub time_sin: Vec<f32>,
    pub height_cos: Vec<f32>,
    pub height_sin: Vec<f32>,
    pub width_cos: Vec<f32>,
    pub width_sin: Vec<f32>,
    /// Per-axis head-dim widths `(t_dim, h_dim, w_dim)`. Each is the
    /// FULL slot count for that axis (= 2 × pair count).
    #[allow(dead_code)] // read by image_rotation_tensors + Phase 6 Metal kernel.
    pub axes: (usize, usize, usize),
    /// Grid extents the tables were built for, so
    /// `image_rotation_tensors` can validate the requested grid fits.
    pub grid: (usize, usize, usize),
}

impl RopeFrequencies {
    /// Build the rotary precompute for a config + grid shape.
    ///
    /// `time_positions` is 1 for txt2img. `height_positions` /
    /// `width_positions` are the post-patch grid dims: `(image_h /
    /// vae_stride / patch_size, image_w / vae_stride / patch_size)`.
    pub fn new(
        config: &Config,
        time_positions: usize,
        height_positions: usize,
        width_positions: usize,
    ) -> Self {
        let (t_dim, h_dim, w_dim) = config.rope_axes_dim;
        let theta = config.rope_theta;
        let (time_cos, time_sin) = axis_table(time_positions, t_dim, theta);
        let (height_cos, height_sin) = axis_table(height_positions, h_dim, theta);
        let (width_cos, width_sin) = axis_table(width_positions, w_dim, theta);
        Self {
            time_cos,
            time_sin,
            height_cos,
            height_sin,
            width_cos,
            width_sin,
            axes: (t_dim, h_dim, w_dim),
            grid: (time_positions, height_positions, width_positions),
        }
    }

    /// Assemble the per-token rotation tensors for the image stream.
    ///
    /// Image patch tokens are laid out row-major: token index `i = t *
    /// (H*W) + row * W + col`, for `t ∈ [0, T)`, `row ∈ [0, H)`, `col ∈
    /// [0, W)`. Each token's `head_dim/2` rotation pairs are the
    /// concatenation of `[time(t), height(row), width(col)]` axis
    /// slices.
    ///
    /// Returns `(cos, sin)` each of shape `(img_seq, head_dim/2)`,
    /// ready to feed [`apply_rope_interleaved`].
    #[allow(dead_code)] // Consumed by the Phase 5 end-to-end forward pass.
    pub fn image_rotation_tensors(&self, device: &Device) -> CandleResult<(Tensor, Tensor)> {
        let (t_dim, h_dim, w_dim) = self.axes;
        let (t_pos, h_pos, w_pos) = self.grid;
        let t_pairs = t_dim / 2;
        let h_pairs = h_dim / 2;
        let w_pairs = w_dim / 2;
        let half = t_pairs + h_pairs + w_pairs;
        let img_seq = t_pos * h_pos * w_pos;

        let mut cos = Vec::with_capacity(img_seq * half);
        let mut sin = Vec::with_capacity(img_seq * half);
        for t in 0..t_pos {
            let t_off = t * t_pairs;
            for row in 0..h_pos {
                let h_off = row * h_pairs;
                for col in 0..w_pos {
                    let w_off = col * w_pairs;
                    cos.extend_from_slice(&self.time_cos[t_off..t_off + t_pairs]);
                    cos.extend_from_slice(&self.height_cos[h_off..h_off + h_pairs]);
                    cos.extend_from_slice(&self.width_cos[w_off..w_off + w_pairs]);
                    sin.extend_from_slice(&self.time_sin[t_off..t_off + t_pairs]);
                    sin.extend_from_slice(&self.height_sin[h_off..h_off + h_pairs]);
                    sin.extend_from_slice(&self.width_sin[w_off..w_off + w_pairs]);
                }
            }
        }
        let cos = Tensor::from_vec(cos, (img_seq, half), device)?;
        let sin = Tensor::from_vec(sin, (img_seq, half), device)?;
        Ok((cos, sin))
    }
}

/// Build a single axis's `(cos, sin)` pair table — one value per
/// rotation pair, `positions * (axis_dim/2)` long, row-major
/// `[position][pair]`.
fn axis_table(positions: usize, axis_dim: usize, theta: f32) -> (Vec<f32>, Vec<f32>) {
    let pairs = axis_dim / 2;
    let mut freqs = Vec::with_capacity(pairs);
    for k in 0..pairs {
        let exp = (2.0 * k as f32) / axis_dim as f32;
        freqs.push(1.0 / theta.powf(exp));
    }
    let mut cos = Vec::with_capacity(positions * pairs);
    let mut sin = Vec::with_capacity(positions * pairs);
    for p in 0..positions {
        for &f in &freqs {
            let (s, c) = (p as f32 * f).sin_cos();
            cos.push(c);
            sin.push(s);
        }
    }
    (cos, sin)
}

/// Apply interleaved (GPT-J style) rotary embedding to `x`.
///
/// Pure tensor ops (reshape / narrow / broadcast_mul / cat) so it runs
/// on CPU and Metal alike — candle's fused `rope_i` is Metal/CUDA-only.
/// Mirrors `candle_nn::rotary_emb::rope_i_slow`.
///
/// `x`:   `(batch, heads, seq, head_dim)`
/// `cos`/`sin`: `(seq, head_dim/2)`
/// returns `(batch, heads, seq, head_dim)`.
pub fn apply_rope_interleaved(x: &Tensor, cos: &Tensor, sin: &Tensor) -> CandleResult<Tensor> {
    use candle_core::D;
    let (b, n_head, seq, n_embd) = x.dims4()?;
    let cos = cos.narrow(0, 0, seq)?.reshape((seq, n_embd / 2, 1))?;
    let sin = sin.narrow(0, 0, seq)?.reshape((seq, n_embd / 2, 1))?;
    let cos = cos.broadcast_as((b, 1, seq, n_embd / 2, 1))?;
    let sin = sin.broadcast_as((b, 1, seq, n_embd / 2, 1))?;
    let x = x.reshape((b, n_head, seq, n_embd / 2, 2))?;
    let x0 = x.narrow(D::Minus1, 0, 1)?;
    let x1 = x.narrow(D::Minus1, 1, 1)?;
    let y0 = (x0.broadcast_mul(&cos)? - x1.broadcast_mul(&sin)?)?;
    let y1 = (x0.broadcast_mul(&sin)? + x1.broadcast_mul(&cos)?)?;
    let rope = Tensor::cat(&[y0, y1], D::Minus1)?;
    rope.flatten_from(D::Minus2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_gen::qwen_image::config::Config;

    fn approx_eq(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn axis_tables_have_pair_lengths() {
        let c = Config::qwen_image_canonical();
        let (t, h, w) = c.rope_axes_dim;
        let r = RopeFrequencies::new(&c, 1, 32, 48);
        assert_eq!(r.time_cos.len(), 1 * (t / 2));
        assert_eq!(r.height_cos.len(), 32 * (h / 2));
        assert_eq!(r.width_cos.len(), 48 * (w / 2));
    }

    #[test]
    fn position_zero_is_identity_rotation() {
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 1, 1);
        for v in [&r.time_cos, &r.height_cos, &r.width_cos] {
            for &x in v {
                assert!(approx_eq(x, 1.0, 1e-6), "cos at p=0 must be 1, got {x}");
            }
        }
        for v in [&r.time_sin, &r.height_sin, &r.width_sin] {
            for &x in v {
                assert!(approx_eq(x, 0.0, 1e-6), "sin at p=0 must be 0, got {x}");
            }
        }
    }

    #[test]
    fn image_rotation_tensor_shape_is_seq_by_half_head_dim() {
        let c = Config::qwen_image_canonical();
        let (h_pos, w_pos) = (4usize, 6usize);
        let r = RopeFrequencies::new(&c, 1, h_pos, w_pos);
        let (cos, sin) = r
            .image_rotation_tensors(&Device::Cpu)
            .expect("rotation tensors");
        let half = c.head_dim / 2;
        assert_eq!(cos.dims(), [1 * h_pos * w_pos, half]);
        assert_eq!(sin.dims(), [1 * h_pos * w_pos, half]);
    }

    #[test]
    fn image_rotation_token_zero_is_all_identity() {
        // Token 0 = (t=0, row=0, col=0) → every axis at position 0 →
        // cos=1, sin=0 across the whole head_dim/2 row.
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 2, 2);
        let (cos, sin) = r.image_rotation_tensors(&Device::Cpu).expect("rotation");
        let half = c.head_dim / 2;
        let cos0 = cos.narrow(0, 0, 1).unwrap().flatten_all().unwrap()
            .to_vec1::<f32>().unwrap();
        let sin0 = sin.narrow(0, 0, 1).unwrap().flatten_all().unwrap()
            .to_vec1::<f32>().unwrap();
        assert_eq!(cos0.len(), half);
        for &x in &cos0 { assert!(approx_eq(x, 1.0, 1e-6)); }
        for &x in &sin0 { assert!(approx_eq(x, 0.0, 1e-6)); }
    }

    #[test]
    fn apply_rope_at_position_zero_is_noop() {
        // RoPE with cos=1/sin=0 must return the input unchanged.
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 1, 1);
        let (cos, sin) = r.image_rotation_tensors(&Device::Cpu).expect("rotation");
        // x: (batch=1, heads=2, seq=1, head_dim).
        let x = Tensor::arange(0f32, (2 * c.head_dim) as f32, &Device::Cpu)
            .unwrap()
            .reshape((1, 2, 1, c.head_dim))
            .unwrap();
        let y = apply_rope_interleaved(&x, &cos, &sin).expect("rope");
        let xv = x.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        let yv = y.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        for (a, b) in xv.iter().zip(yv.iter()) {
            assert!(approx_eq(*a, *b, 1e-5), "identity rope changed value: {a} vs {b}");
        }
    }

    #[test]
    fn axes_round_trip() {
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 4, 4);
        assert_eq!(r.axes, c.rope_axes_dim);
    }
}
