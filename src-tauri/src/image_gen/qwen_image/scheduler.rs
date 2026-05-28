//! Flow-match Euler discrete scheduler for Qwen-Image — Phase 5.
//!
//! Qwen-Image is a rectified-flow model: the transformer predicts a
//! velocity `v` and the sampler integrates `x_{t-1} = x_t + (σ_{t-1} -
//! σ_t) · v` along a schedule of sigmas from 1 (pure noise) to 0
//! (clean latent). This is the `FlowMatchEulerDiscreteScheduler` from
//! diffusers, the simplest correct sampler for the architecture.
//!
//! This is a SMALL, fully-correct port (no architecture dependency) —
//! the math is exact and unit-tested. The only thing it can't do until
//! the transformer + VAE weights land (Phase 8) is produce a real
//! velocity to integrate; the scheduler itself is done.

use candle_core::{Result as CandleResult, Tensor};

/// Flow-match Euler scheduler over a linear sigma schedule.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Driven by the Phase-5 denoise loop.
pub struct FlowMatchScheduler {
    /// Sigma per step, length `num_steps + 1`, descending 1 → 0. The
    /// extra trailing 0 lets the last step integrate to a clean latent.
    pub sigmas: Vec<f64>,
    /// Number of integration steps.
    pub num_steps: usize,
}

#[allow(dead_code)]
impl FlowMatchScheduler {
    /// Build a scheduler with a linear sigma schedule from 1.0 down to
    /// 0.0 over `num_steps`. Qwen-Image's reference uses a shifted
    /// schedule (`shift = 3.0` by default); we apply the standard
    /// time-shift `σ' = shift·σ / (1 + (shift-1)·σ)` so the sampling
    /// matches the reference's noise distribution.
    pub fn new(num_steps: usize, shift: f64) -> Self {
        let n = num_steps.max(1);
        let mut sigmas = Vec::with_capacity(n + 1);
        for i in 0..n {
            // Linear in [1, 0): σ_i = 1 - i/n.
            let sigma = 1.0 - (i as f64) / (n as f64);
            let shifted = shift * sigma / (1.0 + (shift - 1.0) * sigma);
            sigmas.push(shifted);
        }
        sigmas.push(0.0);
        Self { sigmas, num_steps: n }
    }

    /// Sigma at integration step `i` (0-indexed). Used to scale the
    /// initial noise and to feed the transformer the current timestep.
    pub fn sigma(&self, i: usize) -> f64 {
        self.sigmas[i.min(self.sigmas.len() - 1)]
    }

    /// The timestep value handed to the transformer at step `i`.
    /// Qwen-Image conditions on `t = σ · 1000` (the diffusers
    /// convention scales the continuous sigma into the model's
    /// timestep range).
    pub fn timestep(&self, i: usize) -> f64 {
        self.sigma(i) * 1000.0
    }

    /// One Euler integration step: `x_{i+1} = x_i + (σ_{i+1} - σ_i)·v`.
    /// `velocity` is the transformer's prediction at step `i`. Returns
    /// the latent for the next step.
    pub fn step(&self, x: &Tensor, velocity: &Tensor, i: usize) -> CandleResult<Tensor> {
        let dt = self.sigmas[i + 1] - self.sigmas[i];
        x + (velocity * dt)?
    }

    /// Scale a unit-variance noise sample to the initial latent for
    /// sampling: `x_0 = noise · σ_0`. With σ_0 ≈ shift-adjusted 1.0 the
    /// starting latent is effectively the noise itself.
    pub fn scale_initial_noise(&self, noise: &Tensor) -> CandleResult<Tensor> {
        noise * self.sigmas[0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device, Tensor};

    #[test]
    fn sigma_schedule_descends_to_zero() {
        let s = FlowMatchScheduler::new(8, 3.0);
        assert_eq!(s.sigmas.len(), 9); // num_steps + 1
        // Monotonic non-increasing.
        for w in s.sigmas.windows(2) {
            assert!(w[0] >= w[1], "sigmas must be non-increasing: {} < {}", w[0], w[1]);
        }
        // Terminates at exactly 0.
        assert_eq!(*s.sigmas.last().unwrap(), 0.0);
    }

    #[test]
    fn first_sigma_is_near_one_after_shift() {
        // At σ=1 the shift formula gives shift·1/(1+(shift-1)·1) =
        // shift/shift = 1, so the first sigma is exactly 1 regardless
        // of shift.
        let s = FlowMatchScheduler::new(4, 3.0);
        assert!((s.sigmas[0] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn timestep_scales_sigma_by_1000() {
        let s = FlowMatchScheduler::new(4, 1.0);
        assert!((s.timestep(0) - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn euler_step_integrates_velocity() {
        // With a constant velocity of 1 and dt = σ_{i+1}-σ_i, the step
        // must add exactly dt to every element.
        let dev = Device::Cpu;
        let s = FlowMatchScheduler::new(2, 1.0);
        let x = Tensor::zeros((1, 4), DType::F32, &dev).unwrap();
        let v = Tensor::ones((1, 4), DType::F32, &dev).unwrap();
        let dt = s.sigmas[1] - s.sigmas[0];
        let nxt = s.step(&x, &v, 0).unwrap();
        let vals = nxt.flatten_all().unwrap().to_vec1::<f32>().unwrap();
        for val in vals {
            assert!((val as f64 - dt).abs() < 1e-6, "expected dt={dt}, got {val}");
        }
    }

    #[test]
    fn shift_one_is_linear_schedule() {
        // shift = 1 → σ' = σ, so the schedule is plain linear.
        let s = FlowMatchScheduler::new(4, 1.0);
        let expected = [1.0, 0.75, 0.5, 0.25, 0.0];
        for (a, b) in s.sigmas.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-9, "{a} vs {b}");
        }
    }
}
