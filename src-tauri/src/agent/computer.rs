//! macOS desktop "Computer Use" driver — synthesizes mouse/keyboard/scroll
//! input via CoreGraphics CGEvent and feeds the model a downscaled screenshot
//! of the screen so it can perceive→act in a loop.
//!
//! This is the most powerful capability in the app: it can move the cursor and
//! type on the user's behalf. It is gated FOUR ways and none of these live
//! here — they wrap every call:
//!   1. `settings.computer_use_enabled` (default OFF; per-run opt-in).
//!   2. The agent-loop confirmation modal (every cu_* tool is `dangerous`).
//!   3. The Rust approval-token binding (`verify_bound` in commands/agent.rs).
//!   4. macOS Accessibility TCC — posting input requires the user to grant
//!      Froglips in System Settings → Privacy & Security → Accessibility.
//!
//! This module's own job is narrow: do the OS-level work, fail CLOSED, and
//! never silently no-op. If Accessibility isn't granted, every action returns
//! `ok:false` with guidance rather than posting an event the OS drops.
//!
//! Coordinate model: the model works in the PIXEL space of the last
//! `cu_screenshot` (what it actually sees). `cu_screenshot` records that
//! image's dimensions plus the main display's size in POINTS; the action tools
//! map an incoming image-pixel coordinate to a global display point before
//! posting. A click before any screenshot has no mapping and is rejected.

#![cfg(target_os = "macos")]

use base64::Engine;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
}

/// Mapping captured by the most recent `cu_screenshot`, used to translate the
/// model's image-pixel coordinates into global display points.
#[derive(Clone, Copy)]
struct ShotGeom {
    img_w: f64,
    img_h: f64,
    point_w: f64,
    point_h: f64,
    origin_x: f64,
    origin_y: f64,
}

static LAST_SHOT: Mutex<Option<ShotGeom>> = Mutex::new(None);

/// Longest-side cap for the screenshot sent to the model. Keeps vision-token
/// cost bounded (a Retina capture is otherwise ~3000px wide) while preserving
/// enough detail to target UI elements. The coordinate mapping makes the
/// downscale transparent to the caller.
const MAX_SHOT_EDGE: u32 = 1568;

const PERM_MSG: &str = "Accessibility permission not granted — open System Settings → Privacy & Security → Accessibility and enable Froglips, then try again. (Check status / re-prompt from Settings → Computer Use.)";
const NO_SHOT_MSG: &str =
    "No screenshot taken yet — call cu_screenshot first so the coordinate space is known.";

/// Public: is the process trusted for Accessibility? When `prompt` is true and
/// it is NOT trusted, macOS shows its one-time "open Accessibility settings"
/// dialog (the only way an app can nudge the user toward the grant).
pub fn check_permission(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            return AXIsProcessTrusted();
        }
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let val = CFBoolean::true_value();
        let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef())
    }
}

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "failed to create CGEventSource".to_string())
}

/// Parse a PNG's IHDR for (width, height). Returns None if the bytes aren't a
/// PNG with a readable header.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // 8-byte signature, then IHDR: len(4)+"IHDR"(4)+width(4)+height(4).
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((w, h))
}

#[derive(Serialize)]
pub struct CuScreenshotResult {
    pub ok: bool,
    pub path: String,
    pub bytes: u64,
    /// Pixel dimensions of the (downscaled) image the model receives. Click
    /// coordinates are interpreted in THIS space.
    pub img_w: u32,
    pub img_h: u32,
    /// Main-display dimensions in points (the CGEvent coordinate space).
    pub point_w: u32,
    pub point_h: u32,
    pub image_b64: String,
    pub mime: String,
}

/// Capture the main display, downscale, and return base64 PNG + the geometry
/// needed to map click coordinates back to display points.
pub async fn screenshot() -> Result<Value, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = std::env::temp_dir().join(format!("froglips-cu-{stamp}.png"));
    let path_str = target.to_string_lossy().into_owned();

    // Capture: -x silent, -t png. Main display only (consistent coordinate
    // space). No -i so it can never block on interactive selection.
    let status = tokio::process::Command::new("screencapture")
        .arg("-x")
        .arg("-t")
        .arg("png")
        .arg(&path_str)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| format!("screencapture failed: {e}"))?;
    if !status.success() {
        return Err(format!(
            "screencapture exited {status} (Screen Recording permission may be required)"
        ));
    }

    // Downscale to cap vision-token cost. Best-effort: if sips is unavailable
    // or errors, fall through with the full-resolution capture.
    let _ = tokio::process::Command::new("sips")
        .arg("-Z")
        .arg(MAX_SHOT_EDGE.to_string())
        .arg(&path_str)
        .kill_on_drop(true)
        .status()
        .await;

    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|e| format!("read screenshot failed: {e}"))?;
    let (img_w, img_h) = png_dimensions(&bytes).ok_or("unreadable PNG header")?;

    // Display geometry in points (CGEvent coordinate space). Done on a blocking
    // thread — CGDisplay is a C call, kept off the async reactor.
    let (point_w, point_h, origin_x, origin_y) = tokio::task::spawn_blocking(|| {
        let b = CGDisplay::main().bounds();
        (b.size.width, b.size.height, b.origin.x, b.origin.y)
    })
    .await
    .map_err(|e| format!("display geometry task failed: {e}"))?;

    *LAST_SHOT.lock() = Some(ShotGeom {
        img_w: img_w as f64,
        img_h: img_h as f64,
        point_w,
        point_h,
        origin_x,
        origin_y,
    });

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let res = CuScreenshotResult {
        ok: true,
        path: path_str,
        bytes: bytes.len() as u64,
        img_w,
        img_h,
        point_w: point_w as u32,
        point_h: point_h as u32,
        image_b64: b64,
        mime: "image/png".to_string(),
    };
    serde_json::to_value(res).map_err(|e| e.to_string())
}

/// Map an image-pixel coordinate to a global display point, clamped to the
/// display bounds. Returns None when no screenshot has established a mapping.
fn map_point(x: f64, y: f64) -> Option<CGPoint> {
    let g = (*LAST_SHOT.lock())?;
    let sx = if g.img_w > 0.0 {
        g.point_w / g.img_w
    } else {
        1.0
    };
    let sy = if g.img_h > 0.0 {
        g.point_h / g.img_h
    } else {
        1.0
    };
    let mut px = g.origin_x + x * sx;
    let mut py = g.origin_y + y * sy;
    px = px.clamp(g.origin_x, g.origin_x + g.point_w - 1.0);
    py = py.clamp(g.origin_y, g.origin_y + g.point_h - 1.0);
    Some(CGPoint::new(px, py))
}

fn ok_action(action: &str, detail: String) -> Value {
    json!({ "ok": true, "action": action, "detail": detail })
}
fn soft_fail(action: &str, msg: &str) -> Value {
    json!({ "ok": false, "action": action, "kind": "computer_use", "message": msg })
}

/// Guard shared by every action tool: Accessibility must be granted.
fn guard(action: &str) -> Result<(), Value> {
    if !check_permission(false) {
        return Err(soft_fail(action, PERM_MSG));
    }
    Ok(())
}

fn button_for(name: &str) -> CGMouseButton {
    match name {
        "right" => CGMouseButton::Right,
        "middle" | "center" => CGMouseButton::Center,
        _ => CGMouseButton::Left,
    }
}
fn down_up(button: &str) -> (CGEventType, CGEventType) {
    match button {
        "right" => (CGEventType::RightMouseDown, CGEventType::RightMouseUp),
        "middle" | "center" => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp),
        _ => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
    }
}

pub fn move_to(x: f64, y: f64) -> Value {
    if let Err(v) = guard("cu_move") {
        return v;
    }
    let Some(pt) = map_point(x, y) else {
        return soft_fail("cu_move", NO_SHOT_MSG);
    };
    let Ok(src) = source() else {
        return soft_fail("cu_move", "failed to create event source");
    };
    if let Ok(ev) = CGEvent::new_mouse_event(src, CGEventType::MouseMoved, pt, CGMouseButton::Left)
    {
        ev.post(CGEventTapLocation::HID);
        ok_action("cu_move", format!("moved to ({:.0},{:.0})", pt.x, pt.y))
    } else {
        soft_fail("cu_move", "failed to create mouse-move event")
    }
}

pub fn click(x: f64, y: f64, button: &str, count: u32) -> Value {
    if let Err(v) = guard("cu_click") {
        return v;
    }
    let Some(pt) = map_point(x, y) else {
        return soft_fail("cu_click", NO_SHOT_MSG);
    };
    let Ok(src) = source() else {
        return soft_fail("cu_click", "failed to create event source");
    };
    let cgbtn = button_for(button);
    let (down, up) = down_up(button);
    let n = count.clamp(1, 3);
    for i in 1..=n {
        let Ok(ev_down) = CGEvent::new_mouse_event(src.clone(), down, pt, cgbtn) else {
            return soft_fail("cu_click", "failed to create mouse-down event");
        };
        // kCGMouseEventClickState — lets macOS recognise multi-clicks.
        ev_down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
        ev_down.post(CGEventTapLocation::HID);
        let Ok(ev_up) = CGEvent::new_mouse_event(src.clone(), up, pt, cgbtn) else {
            return soft_fail("cu_click", "failed to create mouse-up event");
        };
        ev_up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i as i64);
        ev_up.post(CGEventTapLocation::HID);
    }
    ok_action(
        "cu_click",
        format!("{button} click x{n} at ({:.0},{:.0})", pt.x, pt.y),
    )
}

pub fn drag(x1: f64, y1: f64, x2: f64, y2: f64) -> Value {
    if let Err(v) = guard("cu_drag") {
        return v;
    }
    let (Some(start), Some(end)) = (map_point(x1, y1), map_point(x2, y2)) else {
        return soft_fail("cu_drag", NO_SHOT_MSG);
    };
    let Ok(src) = source() else {
        return soft_fail("cu_drag", "failed to create event source");
    };
    let btn = CGMouseButton::Left;
    let make = |t: CGEventType, p: CGPoint| CGEvent::new_mouse_event(src.clone(), t, p, btn);
    let Ok(down) = make(CGEventType::LeftMouseDown, start) else {
        return soft_fail("cu_drag", "failed to create drag-down event");
    };
    down.post(CGEventTapLocation::HID);
    // Interpolate a handful of intermediate dragged events so apps that track
    // drag velocity (selection, sliders) register a real drag, not a teleport.
    const STEPS: i32 = 12;
    for s in 1..=STEPS {
        let t = s as f64 / STEPS as f64;
        let p = CGPoint::new(
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
        );
        if let Ok(ev) = make(CGEventType::LeftMouseDragged, p) {
            ev.post(CGEventTapLocation::HID);
        }
    }
    if let Ok(up) = make(CGEventType::LeftMouseUp, end) {
        up.post(CGEventTapLocation::HID);
    }
    ok_action(
        "cu_drag",
        format!(
            "dragged ({:.0},{:.0})→({:.0},{:.0})",
            start.x, start.y, end.x, end.y
        ),
    )
}

pub fn scroll(x: f64, y: f64, dx: i32, dy: i32) -> Value {
    if let Err(v) = guard("cu_scroll") {
        return v;
    }
    let Some(pt) = map_point(x, y) else {
        return soft_fail("cu_scroll", NO_SHOT_MSG);
    };
    let Ok(src) = source() else {
        return soft_fail("cu_scroll", "failed to create event source");
    };
    // Position the pointer first so the scroll lands on the intended region.
    if let Ok(mv) = CGEvent::new_mouse_event(
        src.clone(),
        CGEventType::MouseMoved,
        pt,
        CGMouseButton::Left,
    ) {
        mv.post(CGEventTapLocation::HID);
    }
    // wheel1 = vertical (positive = up), wheel2 = horizontal.
    match CGEvent::new_scroll_event(src, ScrollEventUnit::LINE, 2, dy, dx, 0) {
        Ok(ev) => {
            ev.post(CGEventTapLocation::HID);
            ok_action("cu_scroll", format!("scrolled dx={dx} dy={dy}"))
        }
        Err(_) => soft_fail("cu_scroll", "failed to create scroll event"),
    }
}

pub fn type_text(text: &str) -> Value {
    if let Err(v) = guard("cu_type") {
        return v;
    }
    let Ok(src) = source() else {
        return soft_fail("cu_type", "failed to create event source");
    };
    // CGEventKeyboardSetUnicodeString is bounded per event; chunk so long
    // strings type reliably. Each chunk posts as keydown+keyup carrying the
    // unicode payload (keycode 0 is a placeholder the unicode string overrides).
    let chars: Vec<char> = text.chars().collect();
    for chunk in chars.chunks(16) {
        let s: String = chunk.iter().collect();
        if let Ok(down) = CGEvent::new_keyboard_event(src.clone(), 0, true) {
            down.set_string(&s);
            down.post(CGEventTapLocation::HID);
        }
        if let Ok(up) = CGEvent::new_keyboard_event(src.clone(), 0, false) {
            up.set_string(&s);
            up.post(CGEventTapLocation::HID);
        }
    }
    ok_action("cu_type", format!("typed {} chars", chars.len()))
}

/// Map a key name (case-insensitive) to a US-layout virtual keycode.
fn keycode_for(name: &str) -> Option<u16> {
    let n = name.to_ascii_lowercase();
    let code = match n.as_str() {
        "return" | "enter" => 0x24,
        "tab" => 0x30,
        "space" | "spacebar" => 0x31,
        "delete" | "backspace" => 0x33,
        "escape" | "esc" => 0x35,
        "forwarddelete" | "del" => 0x75,
        "left" | "arrowleft" => 0x7B,
        "right" | "arrowright" => 0x7C,
        "down" | "arrowdown" => 0x7D,
        "up" | "arrowup" => 0x7E,
        "home" => 0x73,
        "end" => 0x77,
        "pageup" => 0x74,
        "pagedown" => 0x79,
        "f1" => 0x7A,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6D,
        "f11" => 0x67,
        "f12" => 0x6F,
        "a" => 0x00,
        "s" => 0x01,
        "d" => 0x02,
        "f" => 0x03,
        "h" => 0x04,
        "g" => 0x05,
        "z" => 0x06,
        "x" => 0x07,
        "c" => 0x08,
        "v" => 0x09,
        "b" => 0x0B,
        "q" => 0x0C,
        "w" => 0x0D,
        "e" => 0x0E,
        "r" => 0x0F,
        "y" => 0x10,
        "t" => 0x11,
        "o" => 0x1F,
        "u" => 0x20,
        "i" => 0x22,
        "p" => 0x23,
        "l" => 0x25,
        "j" => 0x26,
        "k" => 0x28,
        "n" => 0x2D,
        "m" => 0x2E,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "5" => 0x17,
        "6" => 0x16,
        "7" => 0x1A,
        "8" => 0x1C,
        "9" => 0x19,
        "0" => 0x1D,
        "-" | "minus" => 0x1B,
        "=" | "equal" => 0x18,
        "," | "comma" => 0x2B,
        "." | "period" => 0x2F,
        "/" | "slash" => 0x2C,
        ";" | "semicolon" => 0x29,
        "'" | "quote" => 0x27,
        "[" => 0x21,
        "]" => 0x1E,
        "\\" | "backslash" => 0x2A,
        "`" | "grave" => 0x32,
        _ => return None,
    };
    Some(code)
}

fn modifier_flag(name: &str) -> Option<CGEventFlags> {
    match name.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" | "super" | "win" => Some(CGEventFlags::CGEventFlagCommand),
        "shift" => Some(CGEventFlags::CGEventFlagShift),
        "ctrl" | "control" => Some(CGEventFlags::CGEventFlagControl),
        "opt" | "option" | "alt" => Some(CGEventFlags::CGEventFlagAlternate),
        "fn" | "function" => Some(CGEventFlags::CGEventFlagSecondaryFn),
        _ => None,
    }
}

/// Press a key combo like "cmd+c", "cmd+shift+t", "Return", "Escape". The last
/// `+`-separated token is the key; the rest are modifiers.
pub fn key(combo: &str) -> Value {
    if let Err(v) = guard("cu_key") {
        return v;
    }
    let parts: Vec<&str> = combo
        .split('+')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let Some((key_name, mods)) = parts.split_last() else {
        return soft_fail("cu_key", "empty key combo");
    };
    let Some(code) = keycode_for(key_name) else {
        return soft_fail("cu_key", &format!("unknown key: {key_name}"));
    };
    let mut flags = CGEventFlags::empty();
    for m in mods {
        match modifier_flag(m) {
            Some(f) => flags |= f,
            None => return soft_fail("cu_key", &format!("unknown modifier: {m}")),
        }
    }
    let Ok(src) = source() else {
        return soft_fail("cu_key", "failed to create event source");
    };
    if let Ok(down) = CGEvent::new_keyboard_event(src.clone(), code, true) {
        down.set_flags(flags);
        down.post(CGEventTapLocation::HID);
    }
    if let Ok(up) = CGEvent::new_keyboard_event(src, code, false) {
        up.set_flags(flags);
        up.post(CGEventTapLocation::HID);
    }
    ok_action("cu_key", format!("pressed {combo}"))
}

/// Current cursor location, reported in BOTH display points and (when a
/// screenshot mapping exists) the image-pixel space the model reasons in.
pub fn cursor_position() -> Value {
    let Ok(src) = source() else {
        return soft_fail("cu_cursor_position", "failed to create event source");
    };
    let Ok(ev) = CGEvent::new(src) else {
        return soft_fail("cu_cursor_position", "failed to read cursor");
    };
    let p = ev.location();
    let img = (*LAST_SHOT.lock()).map(|g| {
        let sx = if g.point_w > 0.0 {
            g.img_w / g.point_w
        } else {
            1.0
        };
        let sy = if g.point_h > 0.0 {
            g.img_h / g.point_h
        } else {
            1.0
        };
        ((p.x - g.origin_x) * sx, (p.y - g.origin_y) * sy)
    });
    json!({
        "ok": true,
        "point": { "x": p.x as i64, "y": p.y as i64 },
        "image": img.map(|(x, y)| json!({ "x": x as i64, "y": y as i64 })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_reads_ihdr() {
        // 8-byte sig + IHDR length + "IHDR" + 4x4 dims (rest irrelevant).
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&100u32.to_be_bytes()); // width
        b.extend_from_slice(&50u32.to_be_bytes()); // height
        b.extend_from_slice(&[0u8; 8]);
        assert_eq!(png_dimensions(&b), Some((100, 50)));
    }

    #[test]
    fn png_dimensions_rejects_non_png() {
        assert_eq!(png_dimensions(b"not a png at all really"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn keycode_known_keys() {
        assert_eq!(keycode_for("Return"), Some(0x24));
        assert_eq!(keycode_for("c"), Some(0x08));
        assert_eq!(keycode_for("ESC"), Some(0x35));
        assert_eq!(keycode_for("nonsense"), None);
    }

    #[test]
    fn modifier_aliases() {
        assert!(modifier_flag("cmd").is_some());
        assert!(modifier_flag("Command").is_some());
        assert!(modifier_flag("option").is_some());
        assert!(modifier_flag("bogus").is_none());
    }
}
