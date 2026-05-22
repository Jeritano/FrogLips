//! Local, offline crash logging. A process-global panic hook appends panic
//! records to `~/.local-llm-app/crash.log`. Nothing is ever transmitted —
//! the app is privacy/local-first.

use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate when the log grows past this; keep the most recent half.
const MAX_LOG_BYTES: u64 = 256 * 1024;
/// Cap on bytes returned to the frontend.
const READ_TAIL_BYTES: usize = 64 * 1024;

fn crash_log_path() -> Option<PathBuf> {
    let base = dirs::home_dir()?.join(".local-llm-app");
    fs::create_dir_all(&base).ok()?;
    Some(base.join("crash.log"))
}

/// Format a unix timestamp (whole seconds) as an RFC3339 UTC string. Avoids a
/// `chrono`/`time` dependency for a single best-effort log line.
fn rfc3339_utc(unix_secs: u64) -> String {
    // Days since 1970-01-01 (civil calendar, valid for all years we care about).
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let (hh, mm, ss) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hh, mm, ss
    )
}

/// Current time as an RFC3339 UTC string. Best-effort; falls back to
/// `"unknown"` if the system clock is before the epoch.
pub fn now_rfc3339() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| rfc3339_utc(d.as_secs()))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// If `bytes` exceeds `cap`, return a recent tail that fits within `cap`
/// (at most half the cap, so the result has headroom). Otherwise return it
/// unchanged. Pure function — unit-tested.
fn truncate_to_tail(bytes: &[u8], cap: u64) -> &[u8] {
    if (bytes.len() as u64) <= cap {
        return bytes;
    }
    let keep = ((cap / 2) as usize).min(bytes.len());
    &bytes[bytes.len() - keep..]
}

/// Best-effort rotation: if the log is over the cap, rewrite it with only the
/// most recent half. Any IO error is swallowed — a panic hook must not panic.
fn rotate_if_needed(path: &PathBuf) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    let Ok(data) = fs::read(path) else { return };
    let tail = truncate_to_tail(&data, MAX_LOG_BYTES);
    let _ = fs::write(path, tail);
}

/// Append a single crash record. Best-effort; never panics.
fn append_record(record: &str) {
    let Some(path) = crash_log_path() else { return };
    rotate_if_needed(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(record.as_bytes());
        let _ = f.flush();
    }
}

/// Install the process-global panic hook. Chains to the previous hook so the
/// default console printing is preserved. Idempotent.
pub fn install() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let prev = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let thread = std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_string();
            let backtrace = Backtrace::force_capture();

            let record = format!(
                "\n=== PANIC {ts} ===\nthread: {thread}\nlocation: {location}\nmessage: {msg}\nbacktrace:\n{backtrace}\n",
                ts = now_rfc3339(),
            );
            append_record(&record);

            // Preserve default behavior (console output).
            prev(info);
        }));
    });
}

/// Read the crash log, returning at most the last `READ_TAIL_BYTES`. Returns
/// an empty string if no log exists or it cannot be read.
pub fn read_log() -> String {
    let Some(path) = crash_log_path() else {
        return String::new();
    };
    let Ok(data) = fs::read(&path) else {
        return String::new();
    };
    let tail = truncate_to_tail(&data, READ_TAIL_BYTES as u64);
    String::from_utf8_lossy(tail).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_tail_when_over_cap() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 256) as u8).collect();
        let cap = 400u64;
        let out = truncate_to_tail(&data, cap);
        // Over cap -> shrinks and stays within the cap.
        assert!(out.len() < data.len());
        assert!((out.len() as u64) <= cap);
        assert_eq!(out.len(), 200);
        // Keeps the most recent bytes (the tail).
        assert_eq!(out, &data[data.len() - out.len()..]);
    }

    #[test]
    fn truncate_noop_when_under_cap() {
        let data = b"short content";
        let out = truncate_to_tail(data, 1024);
        assert_eq!(out, data);
    }

    #[test]
    fn rotation_shrinks_oversized_file() {
        let dir =
            std::env::temp_dir().join(format!("froglips-crashlog-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("crash.log");

        // Write well past the cap.
        let blob = vec![b'x'; (MAX_LOG_BYTES as usize) * 2 + 1024];
        fs::write(&path, &blob).unwrap();
        let before = fs::metadata(&path).unwrap().len();
        assert!(before > MAX_LOG_BYTES);

        rotate_if_needed(&path);

        let after = fs::metadata(&path).unwrap().len();
        assert!(after < before, "file should shrink after rotation");
        assert!(
            after <= MAX_LOG_BYTES,
            "file should be within cap after rotation"
        );
        // Tail is preserved (still all 'x').
        let kept = fs::read(&path).unwrap();
        assert!(kept.iter().all(|&b| b == b'x'));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rfc3339_format_is_well_formed() {
        // 2021-01-01T00:00:00Z == 1609459200
        assert_eq!(rfc3339_utc(1_609_459_200), "2021-01-01T00:00:00Z");
        // Epoch.
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    }
}
