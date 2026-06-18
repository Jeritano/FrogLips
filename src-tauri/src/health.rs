//! Subsystem health / degradation registry.
//!
//! A tiny process-global map of subsystem → health state, written next to the
//! existing fail-open diagnostics calls so the UI can show a "Degraded" pill
//! that opens the Diagnostics panel. STRICTLY observational — reading or
//! writing this registry must never alter the surrounding control flow. It
//! mirrors the philosophy of `diagnostics.rs`: a degraded subsystem is recorded
//! and surfaced, but the operation that recorded it proceeds (or fails) exactly
//! as it would have without the registry.
//!
//! Recovery paths call [`clear`] so a transient degradation doesn't stick the
//! pill on forever once the subsystem is healthy again.

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::BTreeMap;

/// Coarse health classification for one subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthState {
    /// Subsystem is functioning normally. Recovery paths `clear()` a subsystem
    /// rather than recording `Ok`, so this variant is part of the public state
    /// vocabulary (a caller MAY `set(..., Ok, ...)` for an explicit healthy
    /// note) but is not constructed on the default recovery path.
    #[allow(dead_code)]
    Ok,
    /// Subsystem is impaired but the app still runs (fail-open path taken).
    Degraded,
    /// Subsystem failed and is not currently usable.
    Failed,
}

/// One subsystem's recorded health, plus a human-readable reason and the
/// unix-seconds timestamp the CURRENT state began (resets only on a state
/// transition, so a repeated `Degraded` ping doesn't keep bumping `since`).
#[derive(Debug, Clone, Serialize)]
pub struct Subsystem {
    /// Subsystem key (e.g. "backend", "mcp", "workspace").
    pub name: String,
    pub state: HealthState,
    /// Most recent reason string for the current state.
    pub reason: String,
    /// Unix seconds when the current `state` was first entered.
    pub since: i64,
}

static REGISTRY: Lazy<RwLock<BTreeMap<String, Subsystem>>> =
    Lazy::new(|| RwLock::new(BTreeMap::new()));

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record `state`/`reason` for `subsystem`. `since` is reset to "now" ONLY when
/// the state actually changes from what was previously recorded; a repeated set
/// at the same state just refreshes the reason and leaves `since` alone (so the
/// pill can show "degraded for 2m" honestly rather than resetting every poll).
pub fn set(subsystem: &str, state: HealthState, reason: &str) {
    let mut g = REGISTRY.write();
    match g.get_mut(subsystem) {
        Some(existing) => {
            if existing.state != state {
                existing.state = state;
                existing.since = now_secs();
            }
            existing.reason = reason.to_string();
        }
        None => {
            g.insert(
                subsystem.to_string(),
                Subsystem {
                    name: subsystem.to_string(),
                    state,
                    reason: reason.to_string(),
                    since: now_secs(),
                },
            );
        }
    }
}

/// Drop a subsystem's entry — used on recovery so a previously-degraded
/// subsystem no longer contributes to the "Degraded" pill.
pub fn clear(subsystem: &str) {
    REGISTRY.write().remove(subsystem);
}

/// Registry key for the derived agent tool-failure signal.
pub const AGENT_TOOLS: &str = "agent_tools";

/// Minimum tool-call sample before a failure rate is allowed to trip the pill —
/// keeps a single failure out of one or two calls from flapping it on.
const TOOL_FAILURE_MIN_SAMPLE: i64 = 8;
/// Failure-rate thresholds for the derived signal.
const TOOL_FAILURE_DEGRADED_RATE: f64 = 0.25;
const TOOL_FAILURE_FAILED_RATE: f64 = 0.50;

/// DERIVED, observational rollup of the agent tool-failure rate into the health
/// registry. Called from `agent_audit::stats` (a read-only aggregate) so a
/// rising tool-failure rate surfaces on the "Degraded" pill + Diagnostics panel
/// instead of being buried in the audit table.
///
/// Below the minimum sample (or at a healthy rate) the signal is `clear()`ed so
/// the pill drops once tools recover; at/above the degraded/failed thresholds
/// it records `Degraded`/`Failed` with a human-readable reason. Reads/writes
/// here never alter the caller's control flow — `stats()` returns the same
/// value regardless.
pub fn record_tool_failure_rate(total: i64, failures: i64, rate: f64) {
    if total < TOOL_FAILURE_MIN_SAMPLE || rate < TOOL_FAILURE_DEGRADED_RATE {
        clear(AGENT_TOOLS);
        return;
    }
    let pct = (rate * 100.0).round() as i64;
    let reason = format!("{failures}/{total} agent tool calls failed in the last 24h ({pct}%)");
    let state = if rate >= TOOL_FAILURE_FAILED_RATE {
        HealthState::Failed
    } else {
        HealthState::Degraded
    };
    set(AGENT_TOOLS, state, &reason);
}

/// Snapshot of every recorded subsystem, ordered by key (BTreeMap order). Used
/// by the `health_snapshot` command so the UI can render the pill + panel.
pub fn snapshot() -> Vec<Subsystem> {
    REGISTRY.read().values().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    // The registry is process-global; serialize the tests that mutate it so a
    // parallel test runner can't interleave their set/clear calls.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn since_resets_only_on_state_change() {
        let _g = TEST_LOCK.lock();
        clear("test-sub");

        set("test-sub", HealthState::Degraded, "first");
        let after_first = snapshot()
            .into_iter()
            .find(|s| s.name == "test-sub")
            .expect("subsystem recorded");
        let since1 = after_first.since;
        assert_eq!(after_first.state, HealthState::Degraded);
        assert_eq!(after_first.reason, "first");

        // Same state again, different reason → since must NOT move.
        set("test-sub", HealthState::Degraded, "second");
        let after_same = snapshot()
            .into_iter()
            .find(|s| s.name == "test-sub")
            .expect("subsystem still recorded");
        assert_eq!(
            after_same.since, since1,
            "since must not reset on same-state ping"
        );
        assert_eq!(after_same.reason, "second", "reason still updates");

        // A different state DOES reset since (may be equal-or-greater depending
        // on clock granularity; assert it is recorded and the state changed).
        set("test-sub", HealthState::Failed, "down");
        let after_change = snapshot()
            .into_iter()
            .find(|s| s.name == "test-sub")
            .expect("subsystem still recorded");
        assert_eq!(after_change.state, HealthState::Failed);
        assert!(
            after_change.since >= since1,
            "since advances (or holds) on state change"
        );

        clear("test-sub");
        assert!(
            snapshot().into_iter().all(|s| s.name != "test-sub"),
            "clear removes the subsystem"
        );
    }

    #[test]
    fn clear_is_idempotent_and_safe_on_absent() {
        let _g = TEST_LOCK.lock();
        // Clearing something never recorded must not panic.
        clear("never-recorded-subsystem");
        assert!(snapshot()
            .into_iter()
            .all(|s| s.name != "never-recorded-subsystem"));
    }

    fn tool_state() -> Option<HealthState> {
        snapshot()
            .into_iter()
            .find(|s| s.name == AGENT_TOOLS)
            .map(|s| s.state)
    }

    #[test]
    fn tool_failure_rate_trips_and_clears() {
        let _g = TEST_LOCK.lock();
        clear(AGENT_TOOLS);

        // Below the minimum sample → never trips, even at a high rate.
        record_tool_failure_rate(3, 3, 1.0);
        assert_eq!(tool_state(), None, "small sample must not trip the pill");

        // Healthy rate over a real sample → cleared.
        record_tool_failure_rate(100, 5, 0.05);
        assert_eq!(tool_state(), None, "healthy rate stays clear");

        // Degraded band.
        record_tool_failure_rate(20, 6, 0.30);
        assert_eq!(tool_state(), Some(HealthState::Degraded));

        // Failed band.
        record_tool_failure_rate(20, 12, 0.60);
        assert_eq!(tool_state(), Some(HealthState::Failed));

        // Recovery clears it.
        record_tool_failure_rate(20, 0, 0.0);
        assert_eq!(tool_state(), None, "recovery clears the signal");

        clear(AGENT_TOOLS);
    }
}
