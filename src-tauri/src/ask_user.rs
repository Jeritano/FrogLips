//! Agent → user round-trip: agent calls `ask_user(question)`, frontend pops
//! a modal, the user types an answer, frontend calls `agent_ask_user_reply`,
//! the agent receives the answer via a oneshot channel.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;

const ASK_TIMEOUT_SECS: u64 = 600; // 10 min — well past human attention span

static PENDING: Lazy<Mutex<HashMap<String, oneshot::Sender<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Clone)]
pub struct AskUserRequest {
    pub id: String,
    pub question: String,
    pub hint: Option<String>,
}

/// Returns the request payload + a receiver so the Tauri command layer can
/// emit the event before awaiting the answer. (A single `ask()` flavor that
/// hides the emit would be cleaner but the AppHandle lives in the command
/// layer, not here.)
pub fn prepare(question: String, hint: Option<String>) -> Result<(AskUserRequest, oneshot::Receiver<String>), String> {
    if question.trim().is_empty() {
        return Err("question must not be empty".into());
    }
    if question.len() > 4096 {
        return Err("question too long".into());
    }
    let id = format!("ask-{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or(0));
    let (tx, rx) = oneshot::channel();
    PENDING.lock().insert(id.clone(), tx);
    Ok((AskUserRequest { id, question, hint }, rx))
}

pub async fn await_reply(rx: oneshot::Receiver<String>, id: &str) -> Result<String, String> {
    let answer = tokio::time::timeout(Duration::from_secs(ASK_TIMEOUT_SECS), rx)
        .await
        .map_err(|_| {
            PENDING.lock().remove(id);
            "ask_user timed out (10 min)".to_string()
        })?
        .map_err(|e| {
            PENDING.lock().remove(id);
            format!("ask_user channel closed: {e}")
        })?;
    Ok(answer)
}

pub fn reply(id: &str, answer: String) -> Result<(), String> {
    let tx = PENDING.lock().remove(id).ok_or_else(|| format!("no pending ask {id}"))?;
    tx.send(answer).map_err(|_| "reply receiver dropped".to_string())?;
    Ok(())
}

pub fn cancel(id: &str) {
    PENDING.lock().remove(id);
}
