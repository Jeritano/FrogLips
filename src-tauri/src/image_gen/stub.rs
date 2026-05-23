//! Stub fallback for builds without `native-mistralrs` + macOS aarch64.
//!
//! Mirrors the [`crate::native_inference::stub`] pattern: keeps the public
//! surface the IPC layer wires against (`ImageEngine`, `SharedEngine`,
//! `new_engine`) but every method returns a "image gen unavailable on this
//! build" error so non-mac builds stay green and the IPC handlers can give a
//! friendly message rather than crashing.

use anyhow::{anyhow, Result};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

use super::{ImageGenRequest, ImageProgress};

#[derive(Clone, Default)]
pub struct ImageEngine;

pub fn new_engine() -> ImageEngine {
    ImageEngine
}

impl ImageEngine {
    pub fn check_memory(&self, _model: &str, _offload: bool) -> Result<()> {
        Err(anyhow!("image gen unavailable on this build"))
    }

    pub fn register_cancel(&self, _op_id: &str) -> Arc<Notify> {
        // Hand back a fresh Notify nobody will ever fire — keeps the signature
        // identical to the real engine so the IPC layer doesn't need cfg
        // branches.
        Arc::new(Notify::new())
    }

    pub fn release_cancel(&self, _op_id: &str) {}

    pub fn cancel(&self, _op_id: &str) -> bool {
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
