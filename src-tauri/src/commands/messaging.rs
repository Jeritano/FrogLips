//! Tauri commands for the multi-channel messaging gateway. Secrets (bot tokens /
//! passwords) live in the Keychain (`messaging:<channel>`); the renderer never
//! holds them. The agent run happens frontend-side under a safe-tools policy —
//! these commands manage credentials, lifecycle, and the outbound send.

use crate::messaging;

fn kc(channel: &str) -> String {
    format!("messaging:{channel}")
}

fn known(channel: &str) -> Result<(), String> {
    if messaging::CHANNELS.contains(&channel) {
        Ok(())
    } else {
        Err(format!("unknown channel: {channel}"))
    }
}

/// Store (or clear, when empty) a channel's secret in the Keychain.
#[tauri::command]
pub fn messaging_set_token(channel: String, token: String) -> Result<(), String> {
    known(&channel)?;
    let t = token.trim();
    if t.is_empty() {
        crate::settings::keychain_delete_account(&kc(&channel));
        return Ok(());
    }
    if crate::settings::keychain_set_account(&kc(&channel), t) {
        Ok(())
    } else {
        Err("failed to store secret in Keychain".into())
    }
}

#[tauri::command]
pub fn messaging_has_token(channel: String) -> bool {
    crate::settings::keychain_get(&kc(&channel)).is_some()
}

/// Validate a channel's stored credentials (returns a human label, e.g. bot name).
#[tauri::command]
pub async fn messaging_validate(channel: String) -> Result<String, String> {
    known(&channel)?;
    messaging::validate(&channel).await
}

#[tauri::command]
pub async fn messaging_start(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    known(&channel)?;
    messaging::start(app, &channel).await
}

#[tauri::command]
pub fn messaging_stop(channel: String) {
    messaging::stop(&channel);
}

#[tauri::command]
pub fn messaging_status() -> Vec<messaging::ChannelStatus> {
    messaging::status()
}

/// Deliver an agent reply back to the originating platform. Called by the
/// frontend gateway after a run completes.
#[tauri::command]
pub async fn messaging_send(channel: String, target: String, text: String) -> Result<(), String> {
    known(&channel)?;
    messaging::send(&channel, &target, &text).await
}
