//! Stub backend for any build where the real native engine is not active.
//!
//! Active when NOT (feature = "native-mistralrs" && macOS aarch64). Every
//! method returns an error so the frontend can fall back to Ollama / MLX.

use anyhow::{anyhow, Result};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{ChatMsg, ModelRef, NativeBackend, SamplingOpts};

#[derive(Clone)]
pub struct NativeRuntime;

impl NativeRuntime {
    pub async fn load(_model_id: String) -> Result<Self> {
        Err(anyhow!("Native backend not available on this platform"))
    }

    pub fn model_id(&self) -> &str {
        ""
    }

    pub async fn chat_stream(
        &self,
        _messages: Vec<ChatMsg>,
        _sampling: SamplingOpts,
        _on_chunk: impl FnMut(String) + Send + 'static,
    ) -> Result<String> {
        Err(anyhow!("Native backend not available on this platform"))
    }
}

pub type SharedRuntime = Arc<Mutex<Option<NativeRuntime>>>;

pub fn new_shared() -> SharedRuntime {
    Arc::new(Mutex::new(None))
}

/* ── Trait impl ───────────────────────────────────────────────────────── */

impl NativeBackend for NativeRuntime {
    fn load(
        _model_ref: ModelRef,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self>> + Send>> {
        Box::pin(async move { Err(anyhow!("Native backend not available on this platform")) })
    }

    fn model_id(&self) -> &str {
        NativeRuntime::model_id(self)
    }

    fn chat_stream(
        &self,
        _messages: Vec<ChatMsg>,
        _sampling: SamplingOpts,
        _on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>> {
        Box::pin(async move { Err(anyhow!("Native backend not available on this platform")) })
    }
}
