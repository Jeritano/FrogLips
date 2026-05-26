fn main() {
    // Embed Info.plist directly into the binary's __TEXT,__info_plist section
    // on macOS. Without this, `cargo tauri dev` (which runs the raw binary,
    // not the .app bundle) crashes the instant it hits any TCC-gated API
    // — Speech Recognition, Microphone, Camera, etc. — because macOS reads
    // the Info.plist from the binary section when the process is not
    // launched from a bundle. Production `.app` builds get the same
    // Info.plist merged via Tauri's bundler, so both code paths see the
    // same NSSpeechRecognitionUsageDescription / NSMicrophoneUsageDescription
    // strings.
    //
    // The linker flag has to come from build.rs because cargo doesn't
    // re-evaluate it per-feature; emit it unconditionally for macOS
    // targets and let the dead-code stripper drop the section when it's
    // not loaded. Path is relative to the crate root (`src-tauri/`).
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
        let plist_path = format!("{}/Info.plist", manifest_dir);
        println!("cargo:rerun-if-changed={plist_path}");
        println!("cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{plist_path}");
    }

    tauri_build::build()
}
