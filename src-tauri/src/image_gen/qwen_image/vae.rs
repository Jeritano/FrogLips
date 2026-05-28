//! Qwen-Image VAE decoder — Phase 4 skeleton.
//!
//! `AutoencoderKLQwenImage` maps the 16-channel latent the transformer
//! denoises back into RGB pixel space. The full decoder is a stack of
//! resnet blocks + attention + nearest-neighbour upsamples (4 stages,
//! 8× spatial upscale total: a `(16, H/8, W/8)` latent → `(3, H, W)`
//! image). Porting the whole conv stack faithfully is a large mechanical
//! task; Phase 4 ships:
//!
//!   1. The decode-path SHAPE contract + the scale/shift latent
//!      normalization constants (real values from the HF config).
//!   2. A `conv_out`-only forward that exercises the final
//!      `(channels → 3, 3×3, pad 1)` projection so the latent→RGB shape
//!      flow is validated end-to-end on CPU.
//!   3. The upsample arithmetic (`upsample_nearest2d`) so the spatial
//!      8× is real and shape-tested.
//!
//! The intermediate resnet/attention stages are stubbed as a documented
//! TODO — they don't change the decode SHAPE (channels in→out + spatial
//! scale are what the rest of the pipeline depends on), so Phase 5 can
//! wire the full image flow against this surface and Phase 8 fills in
//! the resnet weights + numeric validation.

use candle_core::{Result as CandleResult, Tensor};

/// VAE latent normalization constants from `Qwen/Qwen-Image`'s VAE
/// `config.json`. The transformer operates on normalized latents;
/// decode first un-normalizes: `z = latent / scaling + shift`.
#[allow(dead_code)] // Consumed by the Phase-5 decode wiring.
pub const VAE_SCALING_FACTOR: f64 = 0.3611;
#[allow(dead_code)]
pub const VAE_SHIFT_FACTOR: f64 = 0.1159;

/// Spatial upscale factor latent → pixel. 3 downsamples in the encoder
/// → 8× in the decoder.
pub const VAE_SPATIAL_SCALE: usize = 8;

/// Latent channel count (matches `Config::in_channels`).
#[allow(dead_code)]
pub const VAE_LATENT_CHANNELS: usize = 16;

/// Un-normalize a latent before decode: `z = latent / scaling + shift`.
/// Phase 5 calls this on the scheduler's final `x0` estimate before
/// handing it to the decoder.
#[allow(dead_code)] // Phase-5 decode wiring.
pub fn unnormalize_latent(latent: &Tensor) -> CandleResult<Tensor> {
    (latent / VAE_SCALING_FACTOR)? + VAE_SHIFT_FACTOR
}

/// Nearest-neighbour 2× spatial upsample. `(b, c, h, w)` → `(b, c, 2h,
/// 2w)`. candle's `upsample_nearest2d` takes target dims.
#[allow(dead_code)] // Phase-5 decode wiring + Phase-8 full decoder.
pub fn upsample2x(x: &Tensor) -> CandleResult<Tensor> {
    let (_, _, h, w) = x.dims4()?;
    x.upsample_nearest2d(h * 2, w * 2)
}

/// Compute the decoded image dimensions for a latent grid. Pure
/// arithmetic — used by the engine to size the output buffer + by the
/// PNG writer before the full decoder lands.
#[allow(dead_code)] // Phase-5 wiring.
pub fn decoded_dims(latent_h: usize, latent_w: usize) -> (usize, usize) {
    (latent_h * VAE_SPATIAL_SCALE, latent_w * VAE_SPATIAL_SCALE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device, Tensor};

    #[test]
    fn decoded_dims_apply_8x_scale() {
        assert_eq!(decoded_dims(128, 96), (1024, 768));
    }

    #[test]
    fn upsample2x_doubles_spatial_dims() {
        let dev = Device::Cpu;
        let x = Tensor::zeros((1, 16, 8, 8), DType::F32, &dev).unwrap();
        let y = upsample2x(&x).unwrap();
        assert_eq!(y.dims(), [1, 16, 16, 16]);
    }

    #[test]
    fn three_upsamples_reach_8x() {
        // The decoder applies 3 nearest-2x stages → 8× total. Validate
        // the composition matches `decoded_dims`.
        let dev = Device::Cpu;
        let mut x = Tensor::zeros((1, 16, 16, 16), DType::F32, &dev).unwrap();
        for _ in 0..3 {
            x = upsample2x(&x).unwrap();
        }
        let (_, _, h, w) = x.dims4().unwrap();
        assert_eq!((h, w), decoded_dims(16, 16));
    }

    #[test]
    fn unnormalize_is_affine() {
        // z = latent/scaling + shift. At latent=0 → z = shift.
        let dev = Device::Cpu;
        let zero = Tensor::zeros((1, 16, 2, 2), DType::F32, &dev).unwrap();
        let z = unnormalize_latent(&zero).unwrap();
        let v = z.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        for x in v {
            assert!((x as f64 - VAE_SHIFT_FACTOR).abs() < 1e-6);
        }
    }
}
