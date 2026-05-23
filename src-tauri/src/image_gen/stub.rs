//! Stub fallback for builds without `native-mistralrs` + macOS aarch64.
//!
//! Mirrors the [`crate::native_inference::stub`] pattern: keeps the public
//! surface the IPC layer wires against (`ImageEngine`, `SharedEngine`,
//! `new_engine`) but every method returns a "image gen unavailable on this
//! build" error so non-mac builds stay green and the IPC handlers can give a
//! friendly message rather than crashing.

use anyhow::{anyhow, Result};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{ImageGenRequest, ImageProgress};

#[derive(Clone, Default)]
pub struct ImageEngine;

pub fn new_engine() -> ImageEngine {
    ImageEngine
}

impl ImageEngine {
    /// Mirrors the real engine — never called on stub builds (the IPC layer
    /// short-circuits earlier), so flagged allow-dead-code.
    #[allow(dead_code)]
    pub fn check_memory(&self, _model: &str, _offload: bool) -> Result<()> {
        Err(anyhow!("image gen unavailable on this build"))
    }

    /// Mirrors the real engine's signature so the IPC layer doesn't need cfg
    /// branches. The returned token is never cancelled by the stub.
    pub fn register_cancel(&self, _op_id: &str) -> CancellationToken {
        CancellationToken::new()
    }

    pub fn release_cancel(&self, _op_id: &str) {}

    pub fn cancel(&self, _op_id: &str) -> bool {
        false
    }

    /// Idempotent no-op on the stub: nothing was ever loaded, so nothing to
    /// drop.
    pub fn unload(&self) -> bool {
        false
    }

    pub async fn generate(
        &self,
        _req: ImageGenRequest,
        _events: mpsc::Sender<ImageProgress>,
    ) -> Result<Vec<u8>> {
        Err(anyhow!("image gen unavailable on this build"))
    }
}
