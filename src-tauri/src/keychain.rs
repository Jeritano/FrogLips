//! OS keychain wrapper for cloud-backend API keys.
//!
//! Uses the `keyring` crate, which maps to macOS Keychain on Apple platforms.
//! Each provider gets its own service identifier so revoking one doesn't
//! affect the others.

use anyhow::{anyhow, Result};

const ACCOUNT: &str = "api_key";

/// Per-provider keychain service identifier. Keep these stable — changing one
/// orphans existing keychain entries (user has to re-enter the key).
fn service_for(provider: &str) -> Result<&'static str> {
    match provider {
        "novita" => Ok("com.froglips.novita"),
        other => Err(anyhow!("unknown keychain provider: {other}")),
    }
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(anyhow!("key must not be empty"));
    }
    if key.len() > 512 {
        return Err(anyhow!("key exceeds 512 chars"));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err(anyhow!("key contains control characters"));
    }
    Ok(())
}

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    validate_key(key)?;
    let service = service_for(provider)?;
    let entry = keyring::Entry::new(service, ACCOUNT)?;
    entry.set_password(key)?;
    Ok(())
}

pub fn get_key(provider: &str) -> Result<Option<String>> {
    let service = service_for(provider)?;
    let entry = keyring::Entry::new(service, ACCOUNT)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn clear_key(provider: &str) -> Result<()> {
    let service = service_for(provider)?;
    let entry = keyring::Entry::new(service, ACCOUNT)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn has_key(provider: &str) -> bool {
    matches!(get_key(provider), Ok(Some(_)))
}
