use serde::Serialize;
use std::path::Path;
use std::time::Instant;

use super::fs::{
    err_string, search_files, validate_for_read, validate_for_write, workspace_root_clone,
    SearchResult, ToolError, MAX_READ_BYTES,
};
use super::injection_scan;

/* ── find_definition / find_references ───────────────────────────────────── */

pub async fn find_definition(symbol: String, path: Option<String>) -> Result<SearchResult, String> {
    if symbol.is_empty() || symbol.len() > 128 {
        return Err(err_string(ToolError::invalid("symbol length invalid")));
    }
    // Word-boundary literal escape (no regex metachars in symbol — basic guard).
    if !symbol
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(err_string(ToolError::invalid(
            "symbol must be [A-Za-z0-9_]+",
        )));
    }
    let root = match path {
        Some(p) => p,
        None => workspace_root_clone()
            .ok_or_else(|| err_string(ToolError::invalid("no workspace root set; pass path")))?
            .to_string_lossy()
            .into_owned(),
    };
    // Heuristic definition patterns across common languages.
    let pat = format!(
        r"(\bfn\s+{s}\b|\bdef\s+{s}\b|\bfunction\s+{s}\b|\bclass\s+{s}\b|\bstruct\s+{s}\b|\benum\s+{s}\b|\btrait\s+{s}\b|\binterface\s+{s}\b|\btype\s+{s}\b|\bconst\s+{s}\b|\blet\s+{s}\b|\bvar\s+{s}\b|\bpub\s+(struct|enum|fn|trait|type|const|static)\s+{s}\b)",
        s = regex::escape(&symbol),
    );
    search_files(root, pat, None, Some(true), None).await
}

pub async fn find_references(symbol: String, path: Option<String>) -> Result<SearchResult, String> {
    if symbol.is_empty() || symbol.len() > 128 {
        return Err(err_string(ToolError::invalid("symbol length invalid")));
    }
    if !symbol
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(err_string(ToolError::invalid(
            "symbol must be [A-Za-z0-9_]+",
        )));
    }
    let root = match path {
        Some(p) => p,
        None => workspace_root_clone()
            .ok_or_else(|| err_string(ToolError::invalid("no workspace root set; pass path")))?
            .to_string_lossy()
            .into_owned(),
    };
    let pat = format!(r"\b{}\b", regex::escape(&symbol));
    search_files(root, pat, None, Some(true), None).await
}

/* ── format_code ─────────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct FormatResult {
    pub formatter: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

fn formatter_for(path: &Path) -> Option<(&'static str, Vec<&'static str>)> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "json" | "css" | "html" | "md" | "yaml" | "yml" => {
            Some(("prettier", vec!["--write"]))
        }
        "rs" => Some(("rustfmt", vec![])),
        "py" => Some(("black", vec![])),
        "go" => Some(("gofmt", vec!["-w"])),
        "swift" => Some(("swift-format", vec!["-i"])),
        _ => None,
    }
}

pub async fn format_code(path: String) -> Result<FormatResult, String> {
    let resolved = validate_for_write(&path).map_err(err_string)?;
    let (cmd, base_args) = formatter_for(&resolved).ok_or_else(|| {
        err_string(ToolError::invalid(format!(
            "no formatter mapping for extension on {}",
            resolved.display()
        )))
    })?;
    let started = Instant::now();
    let path_str = resolved.to_string_lossy().into_owned();
    let mut process_cmd = tokio::process::Command::new(cmd);
    for a in base_args {
        process_cmd.arg(a);
    }
    process_cmd.arg(&path_str);
    process_cmd.kill_on_drop(true);
    // capped_output bounds stdout/stderr buffering instead of `.output()`.
    let (out, err, code) = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        super::shell::capped_output(process_cmd, MAX_READ_BYTES, false),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(err_string(ToolError::io(e.to_string()))),
        Err(_) => {
            return Err(err_string(ToolError::Timeout {
                message: format!("{cmd} timed out"),
            }))
        }
    };
    // Fence both channels: a formatter echoes offending source lines on syntax
    // errors, so a poisoned source file's injection tokens can surface in
    // stdout/stderr. Wrap like every other subprocess output channel.
    let (stdout, _) = super::injection_scan::scan_and_wrap(&String::from_utf8_lossy(&out));
    let (stderr, _) = super::injection_scan::scan_and_wrap(&String::from_utf8_lossy(&err));
    Ok(FormatResult {
        formatter: cmd.to_string(),
        stdout,
        stderr,
        exit_code: code,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/* ── PDF text extraction ─────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct PdfResult {
    pub content: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub truncated: bool,
}

pub async fn read_pdf(path: String, limit: Option<u64>) -> Result<PdfResult, String> {
    let resolved = validate_for_read(&path).map_err(err_string)?;
    // Pre-read size cap (sec audit 2026-06). read_pdf previously slurped the
    // whole file with no bound and handed it to pdf-extract, whose FlateDecode
    // inflation is unbounded — a small compression-bomb PDF can expand to GBs and
    // OOM the app (the `limit` arg only truncates OUTPUT text). read_file and the
    // RAG ingest path both pre-cap by file size; this path didn't. Reject
    // oversized input up front. (Bounds the compressed input; the residual
    // expansion-ratio risk is a recoverable local self-DoS, and extraction runs
    // on a blocking thread whose panics are isolated into a tool error.)
    const MAX_PDF_BYTES: u64 = 32 * 1024 * 1024;
    let meta = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| err_string(super::fs::classify_io(&e)))?;
    if meta.len() > MAX_PDF_BYTES {
        return Err(err_string(ToolError::invalid(format!(
            "PDF too large to extract: {} bytes (cap {MAX_PDF_BYTES})",
            meta.len()
        ))));
    }
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| err_string(super::fs::classify_io(&e)))?;
    let total = bytes.len() as u64;
    // pdf-extract is sync + can block — push to a blocking thread.
    let extracted = tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bytes))
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?
        .map_err(|e| err_string(ToolError::invalid(format!("pdf extract failed: {e}"))))?;
    let cap = limit.unwrap_or(MAX_READ_BYTES as u64) as usize;
    let truncated = extracted.len() > cap;
    let bytes_read = extracted.len().min(cap) as u64;
    let content = if truncated {
        // Clamp to a char boundary so slicing non-Latin text never panics mid-codepoint.
        let mut boundary = cap.min(extracted.len());
        while boundary > 0 && !extracted.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let mut s = extracted[..boundary].to_string();
        s.push_str(&format!(
            "\n[... truncated — full text is {} chars]",
            extracted.len()
        ));
        s
    } else {
        extracted
    };
    // PDFs are often pulled from the web or user-shared sources — scan the
    // extracted text for prompt-injection patterns before handing it back
    // to the agent.
    let (content, _n) = injection_scan::scan_and_wrap(&content);
    Ok(PdfResult {
        content,
        bytes_read,
        total_bytes: total,
        truncated,
    })
}
