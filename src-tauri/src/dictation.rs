//! Native voice dictation — AVAudioEngine mic tap → SFSpeechRecognizer.
//!
//! Why app-side and not `webkitSpeechRecognition` in the webview: WebKit
//! gates the JS SpeechRecognition API on a UIDelegate permission callback
//! that wry (0.55) does not implement, so the request is default-denied
//! INSIDE the webview — macOS TCC is never consulted and no permission
//! prompt ever appears. Running recognition here makes the standard TCC
//! prompts fire (NSMicrophoneUsageDescription +
//! NSSpeechRecognitionUsageDescription are in Info.plist, and the hardened
//! runtime carries com.apple.security.device.microphone).
//!
//! Event contract with src/components/ChatInput.tsx:
//!   dictation-partial : String — cumulative transcript for this session
//!   dictation-end     : ()     — session finished (stop or final result)
//!   dictation-error   : String — error code/message; session is dead
//!
//! Recognition is on-device when the recognizer supports it (Apple Silicon
//! with downloaded dictation assets) — audio never leaves the machine, which
//! matches the local-first posture of the app. Otherwise Apple's speech
//! service is used, same as system dictation.

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionTask, SFSpeechRecognizer,
    SFSpeechRecognizerAuthorizationStatus,
};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

/// Live session objects. The ObjC classes used here (AVAudioEngine,
/// SFSpeechRecognitionTask, recognition request) have no main-thread
/// affinity — Apple's canonical dictation sample appends buffers from the
/// audio render thread and stops from arbitrary queues. The wrapper is
/// only ever touched under the SESSION mutex.
struct ActiveSession {
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    /// Set before an intentional stop so the result handler can tell a
    /// user-initiated teardown from a recognition failure.
    stopping: Arc<AtomicBool>,
}
// SAFETY: see ActiveSession doc — cross-thread use of these specific
// classes is the documented Apple pattern; all access is mutex-serialized.
unsafe impl Send for ActiveSession {}

static SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

fn emit_error(app: &AppHandle, msg: &str) {
    let _ = app.emit("dictation-error", msg.to_string());
}

/// Request microphone TCC access. Blocks (bounded) on the user's answer the
/// first time; instant on every later call.
fn ensure_mic_access() -> Result<(), String> {
    unsafe {
        let media = AVMediaTypeAudio.expect("AVMediaTypeAudio static");
        match AVCaptureDevice::authorizationStatusForMediaType(media) {
            AVAuthorizationStatus::Authorized => return Ok(()),
            AVAuthorizationStatus::NotDetermined => {}
            _ => {
                return Err(
                    "mic-denied: microphone access is blocked for Froglips — enable it in \
                     System Settings → Privacy & Security → Microphone"
                        .into(),
                )
            }
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });
        AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &handler);
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => Ok(()),
            Ok(false) => Err("mic-denied: microphone permission was declined".into()),
            Err(_) => Err("mic-denied: timed out waiting for the permission prompt".into()),
        }
    }
}

/// Request speech-recognition TCC access (separate service from the mic).
fn ensure_speech_access() -> Result<(), String> {
    unsafe {
        match SFSpeechRecognizer::authorizationStatus() {
            SFSpeechRecognizerAuthorizationStatus::Authorized => return Ok(()),
            SFSpeechRecognizerAuthorizationStatus::NotDetermined => {}
            _ => {
                return Err(
                    "speech-denied: speech recognition is blocked for Froglips — enable it in \
                     System Settings → Privacy & Security → Speech Recognition"
                        .into(),
                )
            }
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
        });
        SFSpeechRecognizer::requestAuthorization(&handler);
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => Ok(()),
            Ok(false) => Err("speech-denied: speech recognition permission was declined".into()),
            Err(_) => Err("speech-denied: timed out waiting for the permission prompt".into()),
        }
    }
}

/// Start a dictation session. Idempotent-ish: a second start while one is
/// live tears the old one down first (the frontend toggle should prevent
/// this, but a stale session must never wedge the mic).
pub fn start(app: AppHandle) -> Result<(), String> {
    stop_internal(false);
    ensure_mic_access()?;
    ensure_speech_access()?;

    unsafe {
        let recognizer = SFSpeechRecognizer::new();
        if !recognizer.isAvailable() {
            return Err(
                "speech-unavailable: the system speech recognizer is not available \
                 (check System Settings → Keyboard → Dictation)"
                    .into(),
            );
        }

        let request = SFSpeechAudioBufferRecognitionRequest::new();
        request.setShouldReportPartialResults(true);
        if recognizer.supportsOnDeviceRecognition() {
            request.setRequiresOnDeviceRecognition(true);
        }

        let engine = AVAudioEngine::new();
        let input: Retained<AVAudioInputNode> = engine.inputNode();
        let format = input.inputFormatForBus(0);

        // Mic buffers → recognition request. Runs on the audio render thread.
        let tap_request = request.clone();
        let tap = RcBlock::new(
            move |buf: std::ptr::NonNull<objc2_avf_audio::AVAudioPCMBuffer>,
                  _when: std::ptr::NonNull<objc2_avf_audio::AVAudioTime>| {
                tap_request.appendAudioPCMBuffer(buf.as_ref());
            },
        );
        // The generated binding takes the tap as a raw `*mut DynBlock`.
        input.installTapOnBus_bufferSize_format_block(
            0,
            1024,
            Some(&format),
            &*tap as *const _ as *mut _,
        );

        engine.prepare();
        if let Err(e) = engine.startAndReturnError() {
            input.removeTapOnBus(0);
            return Err(format!("audio-engine: {}", e.localizedDescription()));
        }

        let stopping = Arc::new(AtomicBool::new(false));
        let handler_app = app.clone();
        let handler_stopping = stopping.clone();
        let handler = RcBlock::new(
            move |result: *mut objc2_speech::SFSpeechRecognitionResult,
                  error: *mut objc2_foundation::NSError| {
                if let Some(result) = result.as_ref() {
                    let text = result.bestTranscription().formattedString().to_string();
                    let _ = handler_app.emit("dictation-partial", text);
                    if result.isFinal() {
                        let _ = handler_app.emit("dictation-end", ());
                        return;
                    }
                }
                if let Some(error) = error.as_ref() {
                    if handler_stopping.load(Ordering::Acquire) {
                        // endAudio() after a stop surfaces a benign
                        // "no speech detected"-class error — that is the
                        // normal teardown path, not a failure.
                        let _ = handler_app.emit("dictation-end", ());
                    } else {
                        emit_error(&handler_app, &error.localizedDescription().to_string());
                    }
                }
            },
        );
        let task: Retained<SFSpeechRecognitionTask> =
            recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);

        *SESSION.lock() = Some(ActiveSession {
            engine,
            input,
            request,
            task,
            stopping,
        });
    }
    Ok(())
}

/// Stop the live session (no-op when none).
pub fn stop() {
    stop_internal(true);
}

fn stop_internal(graceful: bool) {
    let Some(s) = SESSION.lock().take() else {
        return;
    };
    s.stopping.store(true, Ordering::Release);
    unsafe {
        s.input.removeTapOnBus(0);
        s.engine.stop();
        if graceful {
            // Let the recognizer flush a final result for audio already
            // captured; the result handler emits dictation-end.
            s.request.endAudio();
        } else {
            s.task.cancel();
        }
    }
}
