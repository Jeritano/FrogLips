//! Qwen-Image 3D rotary position embeddings.
//!
//! Qwen-Image's MMDiT applies RoPE on three independent axes — (time,
//! height, width) — concatenated along the per-head dim. For txt2img the
//! `time` axis is always single-step (T=1) so its rotary slot stays at
//! position 0 across the whole image, but the slot is still allocated so
//! the head dim sums correctly and so a future image-edit pipeline that
//! pipes through multiple frames doesn't need a separate kernel.
//!
//! Math (per axis):
//!   For a slot pair `(d_{2k}, d_{2k+1})` at position `p`:
//!     freq_k = 1 / theta ^ (2k / axis_dim)
//!     angle  = p * freq_k
//!     out_{2k}   = x_{2k} * cos(angle) - x_{2k+1} * sin(angle)
//!     out_{2k+1} = x_{2k} * sin(angle) + x_{2k+1} * cos(angle)
//!
//! Concretely for head_dim = 128 with axes (16, 56, 56):
//!   d[ 0.. 16] rotated by the time-position
//!   d[16.. 72] rotated by the height-position
//!   d[72..128] rotated by the width-position
//!
//! Phase 2 (2026-05-28) ships the [`RopeFrequencies`] precompute path —
//! a CPU-side table of `(cos, sin)` per axis position — alongside a
//! placeholder for the Metal-side rotation kernel (Phase 2b). The
//! precompute itself is exercised by the unit tests below; the
//! Metal-side rotation will land when the joint-block forward pass
//! wires it up.

use crate::image_gen::qwen_image::config::Config;

/// Per-axis rotary precompute. Each `Vec<f32>` is `positions * axis_dim`
/// long and holds `cos` (resp. `sin`) values laid out in row-major
/// `[position][slot]` order, with adjacent (2k, 2k+1) slots sharing the
/// same frequency.
///
/// The `time` axis is always length-1 for txt2img (single-step
/// generation); the table is still allocated so the forward pass can
/// uniformly slice three axes off a single struct.
#[derive(Debug, Clone)]
pub struct RopeFrequencies {
    /// Time axis. For txt2img only the `time = 0` row is used.
    pub time_cos: Vec<f32>,
    pub time_sin: Vec<f32>,
    /// Height axis. Length = `height_positions * height_axis_dim`.
    pub height_cos: Vec<f32>,
    pub height_sin: Vec<f32>,
    /// Width axis. Length = `width_positions * width_axis_dim`.
    pub width_cos: Vec<f32>,
    pub width_sin: Vec<f32>,
    /// Echo of the axis dims for downstream shape checks.
    #[allow(dead_code)] // Phase 2 type-only; read by attention kernel in Phase 2b.
    pub axes: (usize, usize, usize),
}

impl RopeFrequencies {
    /// Build the rotary precompute for a given config and grid shape.
    ///
    /// `time_positions` is typically 1 for txt2img and matches the
    /// VAE-latent temporal stride (i.e. frame count) for any future
    /// video extension. `height_positions` and `width_positions` are
    /// the post-patch grid dimensions: `(image_h / vae_stride /
    /// patch_size, image_w / vae_stride / patch_size)`.
    pub fn new(
        config: &Config,
        time_positions: usize,
        height_positions: usize,
        width_positions: usize,
    ) -> Self {
        let (t_dim, h_dim, w_dim) = config.rope_axes_dim;
        let theta = config.rope_theta;
        let time_cos = Vec::with_capacity(time_positions * t_dim);
        let time_sin = Vec::with_capacity(time_positions * t_dim);
        let height_cos = Vec::with_capacity(height_positions * h_dim);
        let height_sin = Vec::with_capacity(height_positions * h_dim);
        let width_cos = Vec::with_capacity(width_positions * w_dim);
        let width_sin = Vec::with_capacity(width_positions * w_dim);

        let mut out = Self {
            time_cos,
            time_sin,
            height_cos,
            height_sin,
            width_cos,
            width_sin,
            axes: (t_dim, h_dim, w_dim),
        };
        out.fill_axis(time_positions, t_dim, theta, Axis::Time);
        out.fill_axis(height_positions, h_dim, theta, Axis::Height);
        out.fill_axis(width_positions, w_dim, theta, Axis::Width);
        out
    }

    fn fill_axis(&mut self, positions: usize, axis_dim: usize, theta: f32, which: Axis) {
        // Pair-rotation: (2k, 2k+1) share the same frequency. Build a
        // single freq table per axis and replay it across positions.
        let pairs = axis_dim / 2;
        let mut freqs = Vec::with_capacity(pairs);
        for k in 0..pairs {
            let exp = (2.0 * k as f32) / axis_dim as f32;
            freqs.push(1.0 / theta.powf(exp));
        }
        for p in 0..positions {
            for k in 0..pairs {
                let angle = p as f32 * freqs[k];
                let (sin, cos) = angle.sin_cos();
                // Lay out as the matched (cos[2k], cos[2k+1]) pair (same
                // value) so a downstream kernel that loads (cos, sin)
                // per slot doesn't need a divide-by-2 in the index math.
                let (cos_target, sin_target) = which.targets(self);
                cos_target.push(cos);
                cos_target.push(cos);
                sin_target.push(sin);
                sin_target.push(sin);
                let _ = p; // silence the never-read lint when positions==1
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Axis {
    Time,
    Height,
    Width,
}

impl Axis {
    fn targets<'a>(self, f: &'a mut RopeFrequencies) -> (&'a mut Vec<f32>, &'a mut Vec<f32>) {
        match self {
            Axis::Time => (&mut f.time_cos, &mut f.time_sin),
            Axis::Height => (&mut f.height_cos, &mut f.height_sin),
            Axis::Width => (&mut f.width_cos, &mut f.width_sin),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_gen::qwen_image::config::Config;

    fn approx_eq(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn frequencies_have_expected_lengths() {
        let c = Config::qwen_image_canonical();
        let (t, h, w) = c.rope_axes_dim;
        let r = RopeFrequencies::new(&c, 1, 32, 48);
        assert_eq!(r.time_cos.len(), 1 * t);
        assert_eq!(r.time_sin.len(), 1 * t);
        assert_eq!(r.height_cos.len(), 32 * h);
        assert_eq!(r.height_sin.len(), 32 * h);
        assert_eq!(r.width_cos.len(), 48 * w);
        assert_eq!(r.width_sin.len(), 48 * w);
    }

    #[test]
    fn position_zero_gives_cos_one_sin_zero() {
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 1, 1);
        // For every axis, position 0 must produce angle = 0 → cos = 1,
        // sin = 0 — the identity rotation.
        for v in [&r.time_cos, &r.height_cos, &r.width_cos] {
            for &x in v.iter() {
                assert!(approx_eq(x, 1.0, 1e-6), "cos at p=0 must be 1, got {x}");
            }
        }
        for v in [&r.time_sin, &r.height_sin, &r.width_sin] {
            for &x in v.iter() {
                assert!(approx_eq(x, 0.0, 1e-6), "sin at p=0 must be 0, got {x}");
            }
        }
    }

    #[test]
    fn adjacent_slots_share_frequency() {
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 2, 1);
        let (_t, h_dim, _w) = r.axes;
        // The cos/sin tables are laid out as (cos[2k], cos[2k+1]) sharing
        // the same value. Row `position=1` starts at `h_dim` and has
        // pairs at indices 0/1, 2/3, … each equal.
        let row_start = h_dim;
        for pair_start in (0..h_dim).step_by(2) {
            let a = r.height_cos[row_start + pair_start];
            let b = r.height_cos[row_start + pair_start + 1];
            assert!(approx_eq(a, b, 0.0), "pair cos must be equal: {a} vs {b}");
            let a = r.height_sin[row_start + pair_start];
            let b = r.height_sin[row_start + pair_start + 1];
            assert!(approx_eq(a, b, 0.0), "pair sin must be equal: {a} vs {b}");
        }
    }

    #[test]
    fn axis_dims_round_trip() {
        let c = Config::qwen_image_canonical();
        let r = RopeFrequencies::new(&c, 1, 4, 4);
        assert_eq!(r.axes, c.rope_axes_dim);
    }
}
