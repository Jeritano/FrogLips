//! Qwen-Image end-to-end pipeline wiring — Phase 5.
//!
//! Connects the pieces built in Phases 2-4 into the txt2img denoise
//! flow:
//!
//! ```text
//! prompt → text_encoder → text_embed (b, txt_seq, 3584)
//! noise  → patchify     → latent tokens (b, img_seq, hidden)
//! for step in scheduler:
//!     v = transformer(latent_tokens, text_embed, timestep)
//!     latent_tokens = scheduler.step(latent_tokens, v, step)
//! latent = unpatchify(latent_tokens)
//! latent = vae.unnormalize(latent)
//! image  = vae.decode(latent)            # Phase 8: real conv decoder
//! ```
//!
//! This module ships the patchify/unpatchify transforms (real, shape-
//! tested) + the `denoise` loop STRUCTURE. The loop calls a
//! `velocity_fn` closure so the transformer wiring (which needs the
//! per-block weight set from the Phase-4 loader + the text embed) can
//! be injected by the engine without this module depending on a loaded
//! model. The closure indirection also makes the loop unit-testable
//! with a synthetic velocity.

use candle_core::{Result as CandleResult, Tensor};

use crate::image_gen::qwen_image::config::Config;
use crate::image_gen::qwen_image::scheduler::FlowMatchScheduler;

/// Fold a `(b, C, H, W)` latent into transformer patch tokens
/// `(b, (H/p)·(W/p), C·p·p)` by extracting non-overlapping `p×p`
/// patches. `p = config.patch_size`.
///
/// Layout matches diffusers: patches walk row-major over the grid, and
/// within a patch the channel-major `(C, p, p)` block is flattened.
#[allow(dead_code)] // Phase-5 forward wiring.
pub fn patchify(latent: &Tensor, config: &Config) -> CandleResult<Tensor> {
    let p = config.patch_size;
    let (b, c, h, w) = latent.dims4()?;
    if h % p != 0 || w % p != 0 {
        candle_core::bail!("patchify: H ({h}) and W ({w}) must be divisible by patch_size ({p})");
    }
    let gh = h / p;
    let gw = w / p;
    // (b, c, gh, p, gw, p)
    let x = latent.reshape((b, c, gh, p, gw, p))?;
    // → (b, gh, gw, c, p, p) so each token's feature block is
    // contiguous channel-major.
    let x = x.permute((0, 2, 4, 1, 3, 5))?.contiguous()?;
    // → (b, gh*gw, c*p*p)
    x.reshape((b, gh * gw, c * p * p))
}

/// Inverse of [`patchify`]: `(b, gh·gw, C·p·p)` → `(b, C, H, W)`.
#[allow(dead_code)] // Phase-5 forward wiring.
pub fn unpatchify(
    tokens: &Tensor,
    config: &Config,
    grid_h: usize,
    grid_w: usize,
) -> CandleResult<Tensor> {
    let p = config.patch_size;
    let c = config.in_channels;
    let (b, seq, feat) = tokens.dims3()?;
    if seq != grid_h * grid_w {
        candle_core::bail!("unpatchify: seq ({seq}) != grid_h·grid_w ({})", grid_h * grid_w);
    }
    if feat != c * p * p {
        candle_core::bail!("unpatchify: feat ({feat}) != C·p·p ({})", c * p * p);
    }
    // (b, gh, gw, c, p, p)
    let x = tokens.reshape((b, grid_h, grid_w, c, p, p))?;
    // → (b, c, gh, p, gw, p)
    let x = x.permute((0, 3, 1, 4, 2, 5))?.contiguous()?;
    // → (b, c, gh*p, gw*p)
    x.reshape((b, c, grid_h * p, grid_w * p))
}

/// Run the denoise loop. `velocity_fn(latent_tokens, timestep, step_idx)`
/// returns the transformer's velocity prediction for the current latent.
/// Injecting it as a closure keeps this module independent of a loaded
/// model and makes the loop unit-testable.
///
/// Returns the final clean latent tokens (still in patch-token layout;
/// caller unpatchifies + VAE-decodes).
#[allow(dead_code)] // Phase-5 forward wiring; called by the engine in Phase 8.
pub fn denoise<F>(
    initial_noise_tokens: &Tensor,
    scheduler: &FlowMatchScheduler,
    mut velocity_fn: F,
) -> CandleResult<Tensor>
where
    F: FnMut(&Tensor, f64, usize) -> CandleResult<Tensor>,
{
    let mut latent = scheduler.scale_initial_noise(initial_noise_tokens)?;
    for i in 0..scheduler.num_steps {
        let t = scheduler.timestep(i);
        let v = velocity_fn(&latent, t, i)?;
        latent = scheduler.step(&latent, &v, i)?;
    }
    Ok(latent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device, Tensor};

    fn small_cfg() -> Config {
        Config {
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
        }
    }

    #[test]
    fn patchify_unpatchify_round_trips() {
        let dev = Device::Cpu;
        let cfg = small_cfg();
        // (b=1, C=16, H=8, W=8) → grid 4×4, feat = 16·2·2 = 64.
        let latent = Tensor::arange(0f32, (16 * 8 * 8) as f32, &dev)
            .unwrap()
            .reshape((1, 16, 8, 8))
            .unwrap();
        let tokens = patchify(&latent, &cfg).unwrap();
        assert_eq!(tokens.dims(), [1, 16, 64]); // seq=4*4, feat=16*2*2

        let back = unpatchify(&tokens, &cfg, 4, 4).unwrap();
        assert_eq!(back.dims(), [1, 16, 8, 8]);
        // Exact round-trip: every element preserved.
        let a = latent.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        let b = back.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn patchify_rejects_indivisible_dims() {
        let dev = Device::Cpu;
        let cfg = small_cfg();
        // H=7 not divisible by patch_size 2.
        let latent = Tensor::zeros((1, 16, 7, 8), DType::F32, &dev).unwrap();
        assert!(patchify(&latent, &cfg).is_err());
    }

    #[test]
    fn denoise_with_zero_velocity_returns_scaled_noise() {
        // Zero velocity → latent never changes after the initial
        // scale. End state == scale_initial_noise(noise).
        let dev = Device::Cpu;
        let sched = FlowMatchScheduler::new(4, 1.0);
        let noise = Tensor::ones((1, 16, 64), DType::F32, &dev).unwrap();
        let zero_v = |x: &Tensor, _t: f64, _i: usize| -> CandleResult<Tensor> {
            x.zeros_like()
        };
        let out = denoise(&noise, &sched, zero_v).unwrap();
        let expected = sched.scale_initial_noise(&noise).unwrap();
        let a = out.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        let b = expected.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        for (x, y) in a.iter().zip(b.iter()) {
            assert!((x - y).abs() < 1e-6);
        }
    }

    #[test]
    fn denoise_calls_velocity_once_per_step() {
        let dev = Device::Cpu;
        let sched = FlowMatchScheduler::new(5, 3.0);
        let noise = Tensor::zeros((1, 4, 8), DType::F32, &dev).unwrap();
        let mut calls = 0usize;
        let counting = |x: &Tensor, _t: f64, _i: usize| -> CandleResult<Tensor> {
            calls += 1;
            x.zeros_like()
        };
        denoise(&noise, &sched, counting).unwrap();
        assert_eq!(calls, 5);
    }
}
