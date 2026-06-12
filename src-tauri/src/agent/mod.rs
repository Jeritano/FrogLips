//! Agent tooling — file/shell/web/git/system/code helpers exposed to the
//! frontend via tauri commands in `lib.rs`. This module is a thin facade
//! that re-exports the per-domain submodules so `agent::read_file`,
//! `agent::run_shell`, etc. resolve unchanged.

// Re-exports preserve the original public surface of the pre-refactor
// `agent.rs`. Not every type is referenced by name in `lib.rs` (some are
// reached only via their parent struct's field types), so suppress the
// unused-import noise rather than narrow the surface.
#![allow(unused_imports)]

pub mod browser;
pub mod code;
pub mod extras;
pub mod fs;
pub mod fs_watcher;
pub mod git;
pub mod injection_scan;
pub mod shell;
pub mod snapshot;
pub mod system;
pub mod web;

// Re-export the public API surface so existing `agent::foo` call-sites in
// lib.rs keep working without churn.

pub use fs::{
    apply_patch, confine_ingest_root, edit_file, file_exists, get_workspace_root,
    is_protected_read_path, list_dir, multi_edit, read_file, read_files, search_files,
    set_workspace_root, write_file, write_files, ApplyPatchFileResult, DirEntry, DirListing, EditOp,
    EditResult, ExistsResult, MultiEditResult, MultiReadEntry, ReadResult, SearchHit, SearchResult,
    WriteFileSpec,
};

pub use shell::{cancel_shell, classify_shell_risk, run_code, run_shell, ShellOpts, ShellResult};

pub use web::{
    call_api, classify_http_risk, http_request, web_fetch, web_search, CallApiInput, HttpReqInput,
    HttpResp, WebFetchResult, WebSearchHit, WebSearchResult,
};

pub use git::{git_branches, git_commit, git_diff, git_log, git_show, git_status, GitResult};

pub use system::{
    applescript_run, classify_applescript_risk, clipboard_get, clipboard_set, open_app,
    open_path_in_editor, screenshot, show_notification, ScreenshotResult,
};

pub use code::{find_definition, find_references, format_code, read_pdf, FormatResult, PdfResult};

pub use browser::{
    BrowserNavigateResult, BrowserOkResult, BrowserScreenshotResult, BrowserTextResult,
};
