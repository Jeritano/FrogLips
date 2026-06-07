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

#[derive(Serialize, Clone, Debug)]
pub struct AskUserRequest {
    pub id: String,
    pub question: String,
    pub hint: Option<String>,
}

/// Returns the request payload + a receiver so the Tauri command layer can
/// emit the event before awaiting the answer. (A single `ask()` flavor that
/// hides the emit would be cleaner but the AppHandle lives in the command
/// layer, not here.)
pub fn prepare(
    question: String,
    hint: Option<String>,
) -> Result<(AskUserRequest, oneshot::Receiver<String>), String> {
    if question.trim().is_empty() {
        return Err("question must not be empty".into());
    }
    if question.len() > 4096 {
        return Err("question too long".into());
    }
    let id = format!(
        "ask-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
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
    // Sec review M2: the user is trusted for INTENT (they typed the answer
    // into our modal), but the *content* of the answer can carry attacker-
    // influenced text — most commonly because the user pasted error output
    // or chat content from somewhere else. Scan + wrap before the answer
    // flows back into the agent loop so jailbreak phrases inside the
    // paste are flagged as DATA, not interpreted as instructions.
    let (wrapped, _findings) = crate::agent::injection_scan::scan_and_wrap(&answer);
    Ok(wrapped)
}

pub fn reply(id: &str, answer: String) -> Result<(), String> {
    let tx = PENDING
        .lock()
        .remove(id)
        .ok_or_else(|| format!("no pending ask {id}"))?;
    tx.send(answer)
        .map_err(|_| "reply receiver dropped".to_string())?;
    Ok(())
}

pub fn cancel(id: &str) {
    PENDING.lock().remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    // PENDING is process-global — serialize tests so a parallel runner
    // can't interleave id collisions or leak state between cases.
    use parking_lot::Mutex as PLMutex;
    static TEST_LOCK: PLMutex<()> = PLMutex::new(());

    #[test]
    fn prepare_rejects_empty_question() {
        let _g = TEST_LOCK.lock();
        let err = prepare("   ".into(), None).unwrap_err();
        assert!(err.contains("must not be empty"));
    }

    #[test]
    fn prepare_rejects_oversized_question() {
        let _g = TEST_LOCK.lock();
        let big = "x".repeat(4097);
        let err = prepare(big, None).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn prepare_yields_unique_ids() {
        let _g = TEST_LOCK.lock();
        let (a, _rx_a) = prepare("Q1?".into(), None).unwrap();
        let (b, _rx_b) = prepare("Q2?".into(), Some("h".into())).unwrap();
        assert_ne!(a.id, b.id);
        // Cleanup so the global map doesn't carry pendings into other tests.
        cancel(&a.id);
        cancel(&b.id);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn prepare_reply_round_trips_the_answer() {
        let _g = TEST_LOCK.lock();
        let (req, rx) = prepare("ok?".into(), None).unwrap();
        reply(&req.id, "yes please".into()).unwrap();
        // Drop the registry lock before awaiting — the reply is already queued
        // and `rx` is keyed by a unique id, so no concurrent test can race it.
        // (Also satisfies clippy::await_holding_lock under `cargo clippy --tests`.)
        drop(_g);
        let answer = await_reply(rx, &req.id).await.unwrap();
        // injection_scan::scan_and_wrap rewrites benign answers verbatim;
        // make sure the round-trip carries the payload, not None/empty.
        assert!(answer.contains("yes please"));
    }

    #[test]
    fn reply_on_unknown_id_errors() {
        let _g = TEST_LOCK.lock();
        let err = reply("not-a-real-id", "noop".into()).unwrap_err();
        assert!(err.contains("no pending"));
    }

    #[test]
    fn cancel_removes_pending_and_is_idempotent() {
        let _g = TEST_LOCK.lock();
        let (req, _rx) = prepare("cancel-me?".into(), None).unwrap();
        cancel(&req.id);
        // Second cancel is a no-op (no panic, no error).
        cancel(&req.id);
        // Subsequent reply on the cancelled id is an error.
        let err = reply(&req.id, "late".into()).unwrap_err();
        assert!(err.contains("no pending"));
    }
}
