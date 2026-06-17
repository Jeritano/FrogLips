//! Tauri commands for the messaging gateway (v1: Telegram). The bot token lives
//! in the Keychain (`messaging:telegram`); the renderer never holds it. The
//! agent run happens frontend-side under a safe-tools-only policy — these
//! commands only manage credentials, lifecycle, and the outbound send.

use crate::messaging;

const TELEGRAM_KC: &str = "messaging:telegram";

/// Store the Telegram bot token in the Keychain. Empty string clears it.
#[tauri::command]
pub fn messaging_set_token(token: String) -> Result<(), String> {
    let t = token.trim();
    if t.is_empty() {
        crate::settings::keychain_delete_account(TELEGRAM_KC);
        return Ok(());
    }
    if crate::settings::keychain_set_account(TELEGRAM_KC, t) {
        Ok(())
    } else {
        Err("failed to store token in Keychain".into())
    }
}

#[tauri::command]
pub fn messaging_has_token() -> bool {
    crate::settings::keychain_get(TELEGRAM_KC).is_some()
}

/// Validate a token via getMe (uses the passed token if non-empty, else the
/// stored one). Returns the bot username.
#[tauri::command]
pub async fn messaging_validate_token(token: Option<String>) -> Result<String, String> {
    let tok = match token {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => crate::settings::keychain_get(TELEGRAM_KC)
            .ok_or("no token stored — paste your bot token first")?,
    };
    messaging::validate_token(&tok).await
}

/// Start the Telegram gateway using the stored token + the allowlist from
/// settings. Fails closed if no token or an empty allowlist.
#[tauri::command]
pub async fn messaging_start(app: tauri::AppHandle) -> Result<(), String> {
    let token = crate::settings::keychain_get(TELEGRAM_KC)
        .ok_or("no Telegram bot token stored — add it in Messaging first")?;
    let cfg = crate::settings::load().messaging.telegram;
    if !cfg.enabled {
        return Err("Telegram channel is disabled in settings".into());
    }
    messaging::start(app, token, cfg.allowed_user_ids).await
}

#[tauri::command]
pub fn messaging_stop() {
    messaging::stop();
}

#[tauri::command]
pub fn messaging_status() -> messaging::GatewayStatus {
    messaging::status()
}

/// Deliver an agent reply to a Telegram chat. Called by the frontend gateway
/// after a run completes. Reads the token from the Keychain.
#[tauri::command]
pub async fn messaging_send(chat_id: i64, text: String) -> Result<(), String> {
    let token = crate::settings::keychain_get(TELEGRAM_KC)
        .ok_or("no Telegram bot token stored")?;
    messaging::send(&token, chat_id, &text).await
}
