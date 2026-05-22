//! mistralrs-core backend (macOS aarch64, `--features native-inference`).
//!
//! Moved verbatim from the old `native_inference.rs` as part of Phase 1 of
//! the cross-platform Native backend rollout. Public surface is preserved:
//! `NativeRuntime`, `SharedRuntime`, `new_shared`, with the same method
//! signatures `lib.rs` already calls.

use anyhow::{anyhow, Context, Result};
use either::Either;
use indexmap::IndexMap;
use mistralrs_core::{
    Constraint, DefaultSchedulerMethod, DeviceMapSetting, MistralRs, MistralRsBuilder, ModelDType,
    NormalLoaderBuilder, NormalRequest, NormalSpecificConfig, Request, RequestMessage, Response,
    SamplingParams, SchedulerConfig, Tool, TokenSource, ToolChoice,
};
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use super::{ChatMsg, ChatTurn, ModelRef, NativeBackend, NativeToolCall, SamplingOpts};

/// One loaded model + the engine that drives requests against it.
/// Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct NativeRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    mistralrs: Arc<MistralRs>,
    model_id: String,
    next_id: AtomicUsize,
}

impl NativeRuntime {
    /// Load a HF model by repo id (e.g. `"mlx-community/Llama-3.2-3B-Instruct-4bit"`)
    /// onto the Metal device. Runs the heavy `load_model_from_hf` on a
    /// blocking thread so the async runtime stays responsive.
    pub async fn load(model_id: String) -> Result<Self> {
        let id_for_load = model_id.clone();
        let pipeline = tokio::task::spawn_blocking(move || -> Result<_> {
            let device = candle_device()?;
            let loader = NormalLoaderBuilder::new(
                NormalSpecificConfig::default(),
                None,                      // chat_template
                None,                      // tokenizer_json
                Some(id_for_load.clone()), // model_id
                false,                     // no_kv_cache
                None,                      // jinja_explicit
            )
            .build(None)
            .with_context(|| format!("failed to build loader for {id_for_load}"))?;

            loader
                .load_model_from_hf(
                    None,
                    TokenSource::CacheToken,
                    &ModelDType::Auto,
                    &device,
                    true, // silent
                    DeviceMapSetting::Auto(mistralrs_core::AutoDeviceMapParams::default_text()),
                    None, // no in-situ quant
                    None, // no paged-attn
                )
                .with_context(|| format!("failed to load {id_for_load} from HF"))
        })
        .await
        .map_err(|e| anyhow!("join error: {e}"))??;

        let scheduler = SchedulerConfig::DefaultScheduler {
            method: DefaultSchedulerMethod::Fixed(NonZeroUsize::new(5).unwrap()),
        };
        let mistralrs = MistralRsBuilder::new(pipeline, scheduler, false, None)
            .build()
            .await;

        Ok(Self {
            inner: Arc::new(Inner {
                mistralrs,
                model_id,
                next_id: AtomicUsize::new(1),
            }),
        })
    }

    pub fn model_id(&self) -> &str {
        &self.inner.model_id
    }

    /// Stream a chat completion. `messages` is a list of `(role, content)`.
    /// `on_chunk` fires once per assistant-content delta. Returns the
    /// concatenated final text.
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatMsg>,
        sampling: SamplingOpts,
        mut on_chunk: impl FnMut(String) + Send + 'static,
    ) -> Result<String> {
        let req_msgs: Vec<IndexMap<String, mistralrs_core::MessageContent>> = messages
            .into_iter()
            .map(|(role, content)| {
                let mut m = IndexMap::new();
                m.insert("role".to_string(), Either::Left(role));
                m.insert("content".to_string(), Either::Left(content));
                m
            })
            .collect();

        let (tx, mut rx) = mpsc::channel::<Response>(64);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let request = Request::Normal(Box::new(NormalRequest {
            messages: RequestMessage::Chat {
                messages: req_msgs,
                enable_thinking: None,
                reasoning_effort: None,
            },
            sampling_params: sampling.into(),
            response: tx,
            return_logprobs: false,
            is_streaming: true,
            id,
            constraint: Constraint::None,
            suffix: None,
            tools: None,
            tool_choice: None,
            logits_processors: None,
            return_raw_logits: false,
            web_search_options: None,
            model_id: None,
            truncate_sequence: false,
        }));

        self.inner
            .mistralrs
            .get_sender(None)
            .map_err(|e| anyhow!("get_sender failed: {e:?}"))?
            .send(request)
            .await
            .map_err(|e| anyhow!("send_request failed: {e:?}"))?;

        let mut full = String::new();
        while let Some(resp) = rx.recv().await {
            match resp {
                Response::Chunk(chunk) => {
                    for choice in chunk.choices {
                        if let Some(content) = choice.delta.content {
                            on_chunk(content.clone());
                            full.push_str(&content);
                        }
                        if choice.finish_reason.is_some() {
                            return Ok(full);
                        }
                    }
                }
                Response::Done(d) => {
                    for choice in d.choices {
                        if let Some(content) = choice.message.content {
                            if !full.contains(&content) {
                                on_chunk(content.clone());
                                full.push_str(&content);
                            }
                        }
                    }
                    return Ok(full);
                }
                Response::ModelError(e, _) => {
                    return Err(anyhow!("model error: {e}"));
                }
                Response::InternalError(e) => {
                    return Err(anyhow!("internal error: {e}"));
                }
                Response::ValidationError(e) => {
                    return Err(anyhow!("validation error: {e}"));
                }
                _ => {}
            }
        }
        Ok(full)
    }

    /// Stream a tool-calling chat turn. `messages` and `tools` are
    /// OpenAI-style JSON values; tool calls are collected from the stream and
    /// returned alongside the assistant text.
    pub async fn chat_stream_tools(
        &self,
        messages: Vec<serde_json::Value>,
        tools: Vec<serde_json::Value>,
        sampling: SamplingOpts,
        mut on_chunk: impl FnMut(String) + Send + 'static,
    ) -> Result<ChatTurn> {
        let parsed_tools: Vec<Tool> = tools
            .into_iter()
            .map(|t| serde_json::from_value(t).context("invalid tool definition"))
            .collect::<Result<_>>()?;

        let req_msgs: Vec<IndexMap<String, mistralrs_core::MessageContent>> =
            messages.into_iter().map(build_chat_message).collect();

        let (tx, mut rx) = mpsc::channel::<Response>(64);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let tools_opt = (!parsed_tools.is_empty()).then_some(parsed_tools);
        let tool_choice = tools_opt.as_ref().map(|_| ToolChoice::Auto);
        let request = Request::Normal(Box::new(NormalRequest {
            messages: RequestMessage::Chat {
                messages: req_msgs,
                enable_thinking: None,
                reasoning_effort: None,
            },
            sampling_params: sampling.into(),
            response: tx,
            return_logprobs: false,
            is_streaming: true,
            id,
            constraint: Constraint::None,
            suffix: None,
            tools: tools_opt,
            tool_choice,
            logits_processors: None,
            return_raw_logits: false,
            web_search_options: None,
            model_id: None,
            truncate_sequence: false,
        }));

        self.inner
            .mistralrs
            .get_sender(None)
            .map_err(|e| anyhow!("get_sender failed: {e:?}"))?
            .send(request)
            .await
            .map_err(|e| anyhow!("send_request failed: {e:?}"))?;

        let mut full = String::new();
        let mut tool_calls: Vec<NativeToolCall> = Vec::new();
        while let Some(resp) = rx.recv().await {
            match resp {
                Response::Chunk(chunk) => {
                    for choice in chunk.choices {
                        if let Some(content) = choice.delta.content {
                            on_chunk(content.clone());
                            full.push_str(&content);
                        }
                        if let Some(calls) = choice.delta.tool_calls {
                            collect_tool_calls(&mut tool_calls, calls);
                        }
                        if choice.finish_reason.is_some() {
                            return Ok(ChatTurn {
                                content: full,
                                tool_calls,
                            });
                        }
                    }
                }
                Response::Done(d) => {
                    for choice in d.choices {
                        if let Some(content) = choice.message.content {
                            if !full.contains(&content) {
                                on_chunk(content.clone());
                                full.push_str(&content);
                            }
                        }
                        if let Some(calls) = choice.message.tool_calls {
                            collect_tool_calls(&mut tool_calls, calls);
                        }
                    }
                    return Ok(ChatTurn {
                        content: full,
                        tool_calls,
                    });
                }
                Response::ModelError(e, _) => return Err(anyhow!("model error: {e}")),
                Response::InternalError(e) => return Err(anyhow!("internal error: {e}")),
                Response::ValidationError(e) => return Err(anyhow!("validation error: {e}")),
                _ => {}
            }
        }
        Ok(ChatTurn {
            content: full,
            tool_calls,
        })
    }
}

/// Build one mistralrs chat-message map from an OpenAI-style JSON message.
/// Carries `role`/`content` plus, when present, the structured `tool_calls`
/// of an assistant turn and the `name`/`tool_call_id` of a tool result —
/// all of which the chat template needs to round-trip an agent loop.
fn build_chat_message(
    msg: serde_json::Value,
) -> IndexMap<String, mistralrs_core::MessageContent> {
    let mut m = IndexMap::new();
    let role = msg
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();
    let content = msg
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    m.insert("role".to_string(), Either::Left(role));
    m.insert("content".to_string(), Either::Left(content));

    if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
        let entries: Vec<IndexMap<String, serde_json::Value>> = calls
            .iter()
            .filter_map(|c| c.as_object())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .collect();
        if !entries.is_empty() {
            m.insert("tool_calls".to_string(), Either::Right(entries));
        }
    }
    if let Some(name) = msg.get("name").and_then(|v| v.as_str()) {
        m.insert("name".to_string(), Either::Left(name.to_string()));
    }
    if let Some(id) = msg.get("tool_call_id").and_then(|v| v.as_str()) {
        m.insert("tool_call_id".to_string(), Either::Left(id.to_string()));
    }
    m
}

/// Merge a batch of streamed `ToolCallResponse`s into the accumulator,
/// de-duplicating by call id (the stream may repeat a completed call).
fn collect_tool_calls(
    acc: &mut Vec<NativeToolCall>,
    calls: Vec<mistralrs_core::ToolCallResponse>,
) {
    for c in calls {
        if acc.iter().any(|existing| existing.id == c.id) {
            continue;
        }
        acc.push(NativeToolCall {
            id: c.id,
            name: c.function.name,
            arguments: c.function.arguments,
        });
    }
}

impl From<SamplingOpts> for SamplingParams {
    fn from(v: SamplingOpts) -> Self {
        let mut s = SamplingParams::neutral();
        s.temperature = v.temperature.or(Some(0.7));
        s.top_p = v.top_p.or(Some(0.95));
        s.max_len = v.max_tokens.or(Some(2048));
        s
    }
}

fn candle_device() -> Result<candle_core::Device> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(d) = candle_core::Device::new_metal(0) {
            return Ok(d);
        }
    }
    Ok(candle_core::Device::Cpu)
}

pub type SharedRuntime = Arc<Mutex<Option<NativeRuntime>>>;

pub fn new_shared() -> SharedRuntime {
    Arc::new(Mutex::new(None))
}

/* ── Trait impl ───────────────────────────────────────────────────────── */

impl NativeBackend for NativeRuntime {
    fn load(
        model_ref: ModelRef,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self>> + Send>> {
        Box::pin(async move {
            match model_ref {
                ModelRef::HfRepo(id) => NativeRuntime::load(id).await,
                ModelRef::GgufPath(_) => Err(anyhow!(
                    "mistralrs backend does not support local GGUF paths (use llama.cpp backend)"
                )),
            }
        })
    }

    fn model_id(&self) -> &str {
        NativeRuntime::model_id(self)
    }

    fn chat_stream(
        &self,
        messages: Vec<ChatMsg>,
        sampling: SamplingOpts,
        on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>> {
        Box::pin(
            async move { NativeRuntime::chat_stream(self, messages, sampling, on_chunk).await },
        )
    }

    fn chat_stream_tools(
        &self,
        messages: Vec<serde_json::Value>,
        tools: Vec<serde_json::Value>,
        sampling: SamplingOpts,
        on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ChatTurn>> + Send + '_>> {
        Box::pin(async move {
            NativeRuntime::chat_stream_tools(self, messages, tools, sampling, on_chunk).await
        })
    }
}
