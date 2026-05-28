//! LoRA pre-merge pipeline for Flux.1 [dev|schnell].
//!
//! Why pre-merge instead of runtime hooks: mistralrs 0.8.1 exposes no LoRA
//! application API on its `FluxLoader`. The workaround is to compute
//! `base + α * (B @ A)` deltas in-process via candle-core, write the
//! resulting tensors back into a content-addressed copy of the base model's
//! safetensors layout under `~/.local-llm-app/lora-merges/<sha>/`, and point
//! mistralrs at the merged directory as if it were a normal HF repo
//! snapshot. The dispatcher in `engine.rs` routes `<base>+lora:<sha>` model
//! ids to the merged path.
//!
//! ## Naming convention coverage
//!
//! - **Diffusers**:
//!     `transformer.X.lora_A.weight` + `transformer.X.lora_B.weight`
//!     → strips the `transformer.` prefix + `.lora_{A,B}.weight` suffix, the
//!     remainder is the base tensor target (matches the Flux safetensors
//!     "X.weight" key shape).
//! - **Kohya / ComfyUI**:
//!     `lora_unet_X_lora_down.weight` + `lora_unet_X_lora_up.weight`
//!     → strips `lora_unet_` + `_lora_{down,up}.weight`, converts the
//!     remaining `_`-joined path back into the dotted base form.
//!
//! Both LoRA halves (A/down, B/up) for the same canonical target are
//! discovered, multiplied as `B @ A`, scaled by `weight`, added to the base
//! tensor (in f32, then cast back to base dtype), and written into the
//! correct shard.
//!
//! ## Cache layout
//!
//! ```text
//! ~/.local-llm-app/lora-merges/
//!     <sha>/                          ← `merged_path` column
//!         model_index.json            ← copied verbatim from HF snapshot
//!         transformer/
//!             diffusion_pytorch_model-00001-of-00003.safetensors
//!             ...
//!         text_encoder/...
//!         vae/...
//! ```
//!
//! Only shards that actually contain modified keys are rewritten; everything
//! else is copied. Atomic write: build everything under `<sha>.tmp/`, then
//! `rename` to `<sha>/` so a crashed merge leaves no half-written variant
//! visible.

use anyhow::{anyhow, Context, Result};
use candle_core::{DType, Device, Tensor};
use safetensors::tensor::{Dtype as StDtype, SafeTensors};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex as PLMutex;

use crate::history;

/// Per-sha mutex registry. Two concurrent merges for the same cache key
/// must serialize so the second one observes the first's cache write
/// instead of racing the `fs::rename(&tmp_dir, &final_dir)` and yanking
/// the just-promoted dir out from under itself. Audit M-R3 (2026-05-28).
///
/// Entries are content-addressed by sha; the registry grows at most to
/// the number of distinct LoRA merges attempted this session (typically
/// <20). Per-entry overhead ~50 bytes — not cleaned up on completion to
/// avoid the register-deregister dance, since the memory ceiling is
/// negligible.
static MERGE_LOCKS: Lazy<PLMutex<HashMap<String, Arc<PLMutex<()>>>>> =
    Lazy::new(|| PLMutex::new(HashMap::new()));

fn acquire_merge_lock(sha: &str) -> Arc<PLMutex<()>> {
    let mut reg = MERGE_LOCKS.lock();
    reg.entry(sha.to_string())
        .or_insert_with(|| Arc::new(PLMutex::new(())))
        .clone()
}

/// Allowed Flux bases for v1. Anything else hits an `unsupported_base`
/// error; the frontend dropdown only emits these two.
pub const ALLOWED_BASES: &[&str] = &[
    "black-forest-labs/FLUX.1-dev",
    "black-forest-labs/FLUX.1-schnell",
];

/// Hard cap on total cache size (200 GiB). When `current + projected >
/// CAP`, the eviction pass drops LRU rows until the new merge fits.
pub const LORA_CACHE_CAP_BYTES: u64 = 200 * 1024 * 1024 * 1024;

/// JS contract type — must use snake_case wire keys, NOT serde-camelCase.
/// Mirrors `src/types.ts::LoraMergeRow`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoraMergeRow {
    pub id: i64,
    pub sha: String,
    pub base_repo: String,
    pub lora_path: String,
    pub lora_sha: String,
    pub weight: f32,
    pub merged_path: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub bytes: i64,
}

/// JS contract type for the inspect IPC. Mirrors `src/types.ts::LoraMetadata`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoraMetadata {
    pub triggers: Vec<String>,
    /// `"diffusers" | "kohya" | "unknown"` — string rather than an enum so the
    /// JS contract sees a plain string.
    pub convention: String,
    pub base_model_hint: Option<String>,
    pub key_count: usize,
    pub bytes: u64,
}

/// Progress variants the IPC layer fans out as `lora-merge-progress` /
/// `lora-merge-evicted` events. Every non-Evicted/Indexing variant carries
/// a 0..1 float matching the frontend's contract.
#[derive(Clone, Debug)]
pub enum MergeProgress {
    ReadingLora { progress: f32 },
    ReadingBase { progress: f32 },
    ApplyingDeltas { progress: f32 },
    Writing { progress: f32 },
    Indexing,
    Evicted { sha: String },
}

/// Map a `MergeProgress` variant to its stage-name string for the
/// `lora-merge-progress` event. The IPC layer uses this so we keep the
/// stage-name authority in one place.
impl MergeProgress {
    pub fn stage_name(&self) -> Option<&'static str> {
        Some(match self {
            MergeProgress::ReadingLora { .. } => "reading_lora",
            MergeProgress::ReadingBase { .. } => "reading_base",
            MergeProgress::ApplyingDeltas { .. } => "applying_deltas",
            MergeProgress::Writing { .. } => "writing",
            MergeProgress::Indexing => "indexing",
            MergeProgress::Evicted { .. } => return None,
        })
    }

    pub fn progress(&self) -> Option<f32> {
        Some(match *self {
            MergeProgress::ReadingLora { progress } => progress,
            MergeProgress::ReadingBase { progress } => progress,
            MergeProgress::ApplyingDeltas { progress } => progress,
            MergeProgress::Writing { progress } => progress,
            MergeProgress::Indexing | MergeProgress::Evicted { .. } => return None,
        })
    }
}

/// Detected LoRA key-naming convention.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Convention {
    Diffusers,
    Kohya,
    Unknown,
}

impl Convention {
    fn as_str(&self) -> &'static str {
        match self {
            Convention::Diffusers => "diffusers",
            Convention::Kohya => "kohya",
            Convention::Unknown => "unknown",
        }
    }
}

/// Cache root: `~/.local-llm-app/lora-merges/`. Created if missing.
pub fn cache_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot determine home directory"))?;
    let root = home.join(".local-llm-app").join("lora-merges");
    fs::create_dir_all(&root)
        .with_context(|| format!("failed to create {}", root.display()))?;
    Ok(root)
}

/// One-shot startup sweep that removes any `*.tmp/` directories under
/// the lora cache root left behind by a crashed merge. The per-sha
/// `merge()` cleanup at lines ~1018 only catches the SAME sha as it
/// starts; orphans from a different sha would accumulate forever
/// without this sweep.
///
/// Best-effort: failures are diagnostics-warn-only. Audit R3-H2
/// (2026-05-28).
pub fn cleanup_orphan_tmp_dirs() {
    let root = match cache_root() {
        Ok(r) => r,
        Err(e) => {
            crate::diagnostics::warn_with(
                "lora",
                "cleanup_orphan_tmp_dirs: cache_root unavailable",
                serde_json::json!({ "error": format!("{e:#}") }),
            );
            return;
        }
    };
    let entries = match fs::read_dir(&root) {
        Ok(it) => it,
        Err(e) => {
            crate::diagnostics::warn_with(
                "lora",
                "cleanup_orphan_tmp_dirs: read_dir failed",
                serde_json::json!({
                    "root": root.display().to_string(),
                    "error": e.to_string(),
                }),
            );
            return;
        }
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_tmp = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.ends_with(".tmp"))
            .unwrap_or(false);
        if !is_tmp {
            continue;
        }
        // `symlink_metadata` so we never traverse a symlink dropped into
        // the cache root by a hostile peer process.
        let md = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.file_type().is_symlink() || !md.is_dir() {
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(_) => removed += 1,
            Err(e) => {
                crate::diagnostics::warn_with(
                    "lora",
                    "cleanup_orphan_tmp_dirs: failed to remove orphan",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "error": e.to_string(),
                    }),
                );
            }
        }
    }
    if removed > 0 {
        crate::diagnostics::info(
            "lora",
            &format!("cleaned up {removed} orphan *.tmp/ director(y/ies) from prior crash"),
        );
    }
}

/// HF hub root used by the engine's mistralrs FluxLoader. Mirrors
/// `crate::models::hf_hub_dir` semantics so a `HF_HOME` override carries
/// over.
fn hf_hub_dir() -> PathBuf {
    if let Ok(p) = std::env::var("HF_HOME") {
        return PathBuf::from(p).join("hub");
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".cache/huggingface/hub")
}

/// Resolve the HF snapshot directory for `repo_id`. HF cache layout:
/// `<hub>/models--<org>--<name>/snapshots/<rev>/`. We pick the most-recent
/// snapshot (mtime DESC) — matches `huggingface-cli download --quiet`
/// behaviour when the cache holds multiple revisions.
fn resolve_hf_snapshot(repo_id: &str) -> Result<PathBuf> {
    let parts: Vec<&str> = repo_id.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(anyhow!("repo id must be org/name (got {repo_id})"));
    }
    let hub = hf_hub_dir();
    let encoded = format!("models--{}", repo_id.replace('/', "--"));
    let model_dir = hub.join(&encoded);
    let snapshots_dir = model_dir.join("snapshots");
    if !snapshots_dir.exists() {
        return Err(anyhow!(
            "HF cache miss for {repo_id} — expected {} (run image_generate once to populate)",
            snapshots_dir.display()
        ));
    }
    let mut picks: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&snapshots_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        picks.push((mtime, path));
    }
    picks.sort_by_key(|(t, _)| *t);
    picks
        .pop()
        .map(|(_, p)| p)
        .ok_or_else(|| anyhow!("no snapshots under {}", snapshots_dir.display()))
}

/// SHA-256 hex of a file's full byte contents. Used for `lora_sha`.
fn sha256_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Compute the content-addressed sha for a merge: the stable cache key the
/// dispatcher uses in `<base>+lora:<sha>`.
fn compute_merge_sha(base_repo: &str, lora_sha: &str, weight: f32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{base_repo}|{lora_sha}|{weight:.4}").as_bytes());
    hex(&hasher.finalize())
}

/// Hard cap on the safetensors header (key index + metadata blob). Real
/// LoRAs ship headers ≤ a few hundred KiB; capping at 16 MiB protects
/// against a malicious / corrupted file claiming a multi-GB header.
const MAX_LORA_HEADER_BYTES: u64 = 16 * 1024 * 1024;

/// Inspect a LoRA file: convention, key count, trigger words, base hint,
/// size. Best-effort — a partially-malformed metadata block is logged but
/// doesn't fail the inspect (the user might still want to merge it).
///
/// Parses the safetensors header JSON directly instead of routing through
/// `SafeTensors::deserialize` (which requires the entire file in memory
/// because it validates tensor-data offsets against buffer length). The
/// header alone is sufficient to enumerate keys + extract `__metadata__`.
/// Audit H-R4 (2026-05-27): previous `fs::read(lora_path)` allocated up
/// to MAX_LORA_BYTES (4 GiB) on the blocking pool per inspect call.
pub fn inspect(lora_path: &Path) -> Result<LoraMetadata> {
    use std::io::Read;
    let bytes = fs::metadata(lora_path)
        .with_context(|| format!("failed to stat {}", lora_path.display()))?
        .len();
    let mut f = fs::File::open(lora_path)
        .with_context(|| format!("failed to open {}", lora_path.display()))?;
    let mut len_buf = [0u8; 8];
    f.read_exact(&mut len_buf)
        .with_context(|| format!("failed to read header length of {}", lora_path.display()))?;
    let header_len = u64::from_le_bytes(len_buf);
    if header_len == 0 || header_len > MAX_LORA_HEADER_BYTES {
        return Err(anyhow::anyhow!(
            "safetensors header length {} bytes is out of range (max {})",
            header_len,
            MAX_LORA_HEADER_BYTES,
        ));
    }
    // Allocate the 8-byte length prefix + header bytes so existing helpers
    // (`extract_metadata_hints` / `read_header_metadata`, which expect the
    // canonical safetensors layout starting with the length prefix) can
    // operate on this buffer without reading the tensor-data payload.
    let mut prefixed = Vec::with_capacity(8 + header_len as usize);
    prefixed.extend_from_slice(&len_buf);
    prefixed.resize(8 + header_len as usize, 0);
    f.read_exact(&mut prefixed[8..]).with_context(|| {
        format!("failed to read header bytes of {}", lora_path.display())
    })?;
    let header: serde_json::Value =
        serde_json::from_slice(&prefixed[8..]).with_context(|| {
            format!("failed to parse safetensors header JSON for {}", lora_path.display())
        })?;
    // Header is `{"key1": {...tensor info...}, ..., "__metadata__": {...}}`.
    // Filter out the metadata sentinel; everything else is a tensor key.
    let names: Vec<String> = header
        .as_object()
        .map(|obj| {
            obj.keys()
                .filter(|k| k.as_str() != "__metadata__")
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let convention = detect_convention(&names);
    let (triggers, base_model_hint) = extract_metadata_hints(&prefixed);
    Ok(LoraMetadata {
        triggers,
        convention: convention.as_str().to_string(),
        base_model_hint,
        key_count: names.len(),
        bytes,
    })
}

/// Detect the LoRA naming convention by sampling the first matching key.
/// Returns `Unknown` when nothing matches either pattern.
fn detect_convention(names: &[String]) -> Convention {
    for n in names {
        if is_diffusers_a(n) || is_diffusers_b(n) {
            return Convention::Diffusers;
        }
        if is_kohya_down(n) || is_kohya_up(n) {
            return Convention::Kohya;
        }
    }
    Convention::Unknown
}

fn is_diffusers_a(name: &str) -> bool {
    name.ends_with(".lora_A.weight")
}
fn is_diffusers_b(name: &str) -> bool {
    name.ends_with(".lora_B.weight")
}
fn is_kohya_down(name: &str) -> bool {
    name.ends_with("_lora_down.weight") || name.ends_with(".lora_down.weight")
}
fn is_kohya_up(name: &str) -> bool {
    name.ends_with("_lora_up.weight") || name.ends_with(".lora_up.weight")
}

/// Pulls trigger-word strings and a base-model hint out of the safetensors
/// `__metadata__` JSON block. Format varies across trainers (Kohya, AI-Toolkit,
/// diffusers), so we look at every value and pick out the plausible ones.
///
/// The safetensors crate's `Metadata::metadata` returns an
/// `Option<HashMap<String,String>>`; we re-parse via direct header-bytes
/// read because (a) we already have the bytes, (b) we want resilient
/// "any string-typed field that looks like a trigger" matching.
fn extract_metadata_hints(data: &[u8]) -> (Vec<String>, Option<String>) {
    // Re-parse the safetensors header JSON manually so we can inspect
    // `__metadata__` exactly as it was written, including nested JSON
    // strings (Kohya stuffs `ss_tag_frequency` in as a JSON-encoded string).
    let mut triggers: Vec<String> = Vec::new();
    let mut base_hint: Option<String> = None;
    let Some(meta_map) = read_header_metadata(data) else {
        return (triggers, base_hint);
    };

    // Direct trigger / activation fields.
    for key in ["triggers", "activation_text", "trigger_words", "tag"] {
        if let Some(v) = meta_map.get(key) {
            push_split_triggers(&mut triggers, v);
        }
    }
    // Kohya: `ss_tag_frequency` is a JSON object {dataset: {tag: count}}.
    if let Some(raw) = meta_map.get("ss_tag_frequency") {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
            collect_tag_frequency(&parsed, &mut triggers);
        }
    }
    // AI-Toolkit style.
    for key in ["modelspec.trigger_phrase", "trigger_phrase"] {
        if let Some(v) = meta_map.get(key) {
            push_split_triggers(&mut triggers, v);
        }
    }
    // Base model hint — different trainers use different keys.
    for key in [
        "ss_base_model_version",
        "modelspec.architecture",
        "modelspec.base_model",
        "base_model",
    ] {
        if let Some(v) = meta_map.get(key) {
            if !v.is_empty() {
                base_hint = Some(v.clone());
                break;
            }
        }
    }

    // Deduplicate while preserving first-occurrence order.
    let mut seen: HashSet<String> = HashSet::new();
    triggers.retain(|t| {
        let lower = t.to_ascii_lowercase();
        if seen.contains(&lower) {
            return false;
        }
        seen.insert(lower);
        true
    });
    // Cap so a runaway tag dump doesn't blow up the IPC payload.
    if triggers.len() > 64 {
        triggers.truncate(64);
    }
    (triggers, base_hint)
}

/// Strip the safetensors header back into the `__metadata__` JSON object.
/// Returns `None` for any parse error — callers treat metadata as
/// best-effort.
fn read_header_metadata(data: &[u8]) -> Option<HashMap<String, String>> {
    if data.len() < 8 {
        return None;
    }
    let n = u64::from_le_bytes(data[..8].try_into().ok()?) as usize;
    let header_end = 8usize.checked_add(n)?;
    if header_end > data.len() {
        return None;
    }
    let header = &data[8..header_end];
    let parsed: serde_json::Value = serde_json::from_slice(header).ok()?;
    let meta = parsed.get("__metadata__")?.as_object()?;
    let mut out = HashMap::new();
    for (k, v) in meta {
        if let Some(s) = v.as_str() {
            out.insert(k.clone(), s.to_string());
        }
    }
    Some(out)
}

/// Split a trigger blob — trainers use either commas, semicolons, or
/// newlines as separators. Empty/whitespace-only entries are skipped.
fn push_split_triggers(out: &mut Vec<String>, raw: &str) {
    for piece in raw.split(|c: char| matches!(c, ',' | ';' | '\n' | '\r')) {
        let t = piece.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
}

/// Walk a Kohya `ss_tag_frequency` JSON object and push every tag key into
/// `out`. The structure is `{ "<dataset>": { "<tag>": <count> } }`.
fn collect_tag_frequency(v: &serde_json::Value, out: &mut Vec<String>) {
    if let Some(obj) = v.as_object() {
        for (_dataset, tags) in obj {
            if let Some(tags) = tags.as_object() {
                for (tag, _count) in tags {
                    let trimmed = tag.trim();
                    if !trimmed.is_empty() {
                        out.push(trimmed.to_string());
                    }
                }
            }
        }
    }
}

/// One canonical LoRA pair, post-name-mapping. `target` is the base
/// safetensors key the deltas land on; `lora_a_key` / `lora_b_key` are the
/// original key names so we can pull the tensors out of the LoRA file.
#[derive(Debug)]
struct LoraPair {
    target: String,
    lora_a_key: String,
    lora_b_key: String,
}

/// Build the canonical target name from a LoRA key + the convention.
/// Diffusers: `transformer.X.lora_A.weight` → `X.weight`.
/// Kohya: `lora_unet_X_lora_down.weight` → `X.weight` (after `_` → `.`).
fn target_from_lora_key(name: &str, convention: Convention) -> Option<String> {
    match convention {
        Convention::Diffusers => {
            // Strip the lora_A / lora_B middle segment to leave the base key.
            let base = if let Some(stripped) = name.strip_suffix(".lora_A.weight") {
                stripped
            } else if let Some(stripped) = name.strip_suffix(".lora_B.weight") {
                stripped
            } else {
                return None;
            };
            // Drop the leading `transformer.` if present so the residual
            // matches Flux's safetensors key shape (which doesn't carry the
            // `transformer.` prefix on the tensor name — it's the directory
            // name instead).
            let core = base.strip_prefix("transformer.").unwrap_or(base);
            Some(format!("{core}.weight"))
        }
        Convention::Kohya => {
            let base = if let Some(stripped) = name.strip_suffix("_lora_down.weight") {
                stripped
            } else if let Some(stripped) = name.strip_suffix(".lora_down.weight") {
                stripped
            } else if let Some(stripped) = name.strip_suffix("_lora_up.weight") {
                stripped
            } else if let Some(stripped) = name.strip_suffix(".lora_up.weight") {
                stripped
            } else {
                return None;
            };
            // Strip the Kohya prefix and convert `_` separators back to dots.
            let core = base
                .strip_prefix("lora_unet_")
                .or_else(|| base.strip_prefix("lora_transformer_"))
                .unwrap_or(base);
            Some(format!("{}.weight", core.replace('_', ".")))
        }
        Convention::Unknown => None,
    }
}

fn is_a_side(name: &str, convention: Convention) -> bool {
    match convention {
        Convention::Diffusers => is_diffusers_a(name),
        Convention::Kohya => is_kohya_down(name),
        Convention::Unknown => false,
    }
}

/// Build LoRA pairs from a flat list of key names. Unpairable keys (an A
/// without a matching B, or vice versa) are dropped silently — the merge
/// proceeds with whatever does pair up.
fn build_pairs(
    names: &[String],
    convention: Convention,
) -> (Vec<LoraPair>, Vec<String>) {
    let mut by_target: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let mut unmapped: Vec<String> = Vec::new();
    for n in names {
        let Some(target) = target_from_lora_key(n, convention) else {
            unmapped.push(n.clone());
            continue;
        };
        let entry = by_target.entry(target).or_insert((None, None));
        if is_a_side(n, convention) {
            entry.0 = Some(n.clone());
        } else {
            entry.1 = Some(n.clone());
        }
    }
    let mut pairs = Vec::new();
    for (target, (a, b)) in by_target {
        if let (Some(a), Some(b)) = (a, b) {
            pairs.push(LoraPair {
                target,
                lora_a_key: a,
                lora_b_key: b,
            });
        }
    }
    pairs.sort_by(|x, y| x.target.cmp(&y.target));
    (pairs, unmapped)
}

/// Map a `safetensors::Dtype` to a `candle_core::DType`. Returns `None` for
/// dtypes candle can't round-trip (the merger refuses to touch such shards).
fn st_to_candle_dtype(d: StDtype) -> Option<DType> {
    Some(match d {
        StDtype::F32 => DType::F32,
        StDtype::F16 => DType::F16,
        StDtype::BF16 => DType::BF16,
        StDtype::U8 => DType::U8,
        StDtype::I64 => DType::I64,
        StDtype::U32 => DType::U32,
        _ => return None,
    })
}

/// Serialize a candle tensor back to safetensors-ready bytes + metadata.
fn tensor_to_serialized(t: &Tensor, dtype: StDtype) -> Result<(Vec<u8>, Vec<usize>)> {
    let shape = t.dims().to_vec();
    let casted = t
        .to_dtype(st_to_candle_dtype(dtype).ok_or_else(|| anyhow!("unsupported dtype on write"))?)?
        .contiguous()?;
    let bytes = match dtype {
        StDtype::F32 => {
            let v = casted.flatten_all()?.to_vec1::<f32>()?;
            f32_to_le_bytes(&v)
        }
        StDtype::F16 => {
            let v = casted.flatten_all()?.to_vec1::<half::f16>()?;
            f16_to_le_bytes(&v)
        }
        StDtype::BF16 => {
            let v = casted.flatten_all()?.to_vec1::<half::bf16>()?;
            bf16_to_le_bytes(&v)
        }
        _ => {
            return Err(anyhow!(
                "merge writeback only handles F32/F16/BF16 base tensors (got {dtype:?})"
            ))
        }
    };
    Ok((bytes, shape))
}

fn f32_to_le_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}
fn f16_to_le_bytes(v: &[half::f16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 2);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}
fn bf16_to_le_bytes(v: &[half::bf16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 2);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// A View wrapper so we can hand candle-merged data back to `safetensors::serialize`.
struct OwnedView {
    dtype: StDtype,
    shape: Vec<usize>,
    data: Vec<u8>,
}

/// Variant for the per-tensor map fed into safetensors::serialize: either a
/// pass-through (use the original bytes verbatim) or a re-computed tensor.
/// The safetensors `View` impl below operates on `&TensorPayload`, matching
/// the pattern the `TensorView` upstream impl uses, so the serialize call
/// site passes references into the IntoIterator.
enum TensorPayload<'a> {
    Original {
        dtype: StDtype,
        shape: Vec<usize>,
        data: &'a [u8],
    },
    Owned(OwnedView),
}

impl<'a> safetensors::View for &TensorPayload<'a> {
    fn dtype(&self) -> StDtype {
        // `self: &&TensorPayload`. Explicit deref so the variant patterns
        // match `TensorPayload` rather than the outer reference layer.
        match **self {
            TensorPayload::Original { dtype, .. } => dtype,
            TensorPayload::Owned(ref v) => v.dtype,
        }
    }
    fn shape(&self) -> &[usize] {
        match **self {
            TensorPayload::Original { ref shape, .. } => shape,
            TensorPayload::Owned(ref v) => &v.shape,
        }
    }
    fn data(&self) -> std::borrow::Cow<'_, [u8]> {
        match **self {
            TensorPayload::Original { data, .. } => std::borrow::Cow::Borrowed(data),
            TensorPayload::Owned(ref v) => std::borrow::Cow::Borrowed(&v.data),
        }
    }
    fn data_len(&self) -> usize {
        match **self {
            TensorPayload::Original { data, .. } => data.len(),
            TensorPayload::Owned(ref v) => v.data.len(),
        }
    }
}

/// Compute the delta tensor for one LoRA pair and add it to the base
/// tensor.
///
/// **Precision contract (audit L-R5, 2026-05-28).** All math runs in f32
/// regardless of the base dtype:
///
///   1. `lora_a` and `lora_b` are up-cast to f32 before the matmul, because
///      bf16/f16 matmul on the rank-4–rank-128 inner dim can accumulate ~2-3
///      ULPs of error per row vs. f32, and we sum that error across every
///      pair stacked onto the same base tensor. Stacking 4-8 LoRAs at
///      weight 1.0 on a bf16-direct path produces visibly different output
///      images vs. the same stack run in f32 — colour banding in low-light
///      regions is the common failure mode.
///   2. `base_f32` is passed in already at f32 (the caller up-casts once
///      per shard via `Tensor::to_dtype`), so the `broadcast_add` is also
///      f32+f32.
///   3. The caller re-casts back to the original base dtype only at the
///      serialize step (see `tensor_to_serialized`), so per-shard f32
///      accumulation across multiple pairs stays exact.
///
/// `weight` is multiplied in as f64 to avoid a redundant f32 round-trip on
/// the scaling step itself; Candle accepts the wider scalar verbatim.
fn apply_delta_to_base(
    base_f32: &Tensor,
    lora_a: &Tensor,
    lora_b: &Tensor,
    weight: f32,
) -> Result<Tensor> {
    // delta = B @ A  (so the result shape matches base = (out, in))
    let a_f32 = lora_a.to_dtype(DType::F32)?;
    let b_f32 = lora_b.to_dtype(DType::F32)?;
    let delta = b_f32.matmul(&a_f32)?;
    let scaled = (delta * weight as f64)?;
    // Broadcast-add in case the base carries extra dims (rare for linear).
    let out = base_f32.broadcast_add(&scaled)?;
    Ok(out)
}

/// Walk the snapshot dir and return the relative paths of every
/// safetensors shard plus the relative paths of every other file (which
/// we'll copy verbatim).
fn enumerate_snapshot(snapshot: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let mut shards = Vec::new();
    let mut others = Vec::new();
    walk_relative(snapshot, snapshot, &mut shards, &mut others)?;
    Ok((shards, others))
}

fn walk_relative(
    root: &Path,
    dir: &Path,
    shards: &mut Vec<PathBuf>,
    others: &mut Vec<PathBuf>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        let md = entry.metadata()?;
        if md.is_dir() {
            walk_relative(root, &p, shards, others)?;
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .map_err(|_| anyhow!("path escaped snapshot root"))?
            .to_path_buf();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        if ext.as_deref() == Some("safetensors") {
            shards.push(rel);
        } else {
            others.push(rel);
        }
    }
    Ok(())
}

/// Sum every regular file under `dir`, returning the total byte count.
/// Used to compute the merged-variant's `bytes` column.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let read = match fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            if let Ok(md) = entry.metadata() {
                if md.is_dir() {
                    stack.push(entry.path());
                } else if md.is_file() {
                    total = total.saturating_add(md.len());
                }
            }
        }
    }
    total
}

/// Hardlink `src` into `dst`. Falls back to a regular copy if the hardlink
/// fails (cross-device, target FS doesn't support links, etc.). Atomicity
/// of the parent's rename is what we care about — these intermediate writes
/// only need to be present before the final rename.
fn link_or_copy(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }
    // Some HF cache entries are symlinks into the blob store — resolve to
    // the real file before copying so the merged dir is self-contained.
    let real = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    fs::copy(&real, dst)
        .with_context(|| format!("failed to copy {} → {}", real.display(), dst.display()))?;
    Ok(())
}

/// Evict LRU rows until `current + projected <= cap`. Emits one
/// `MergeProgress::Evicted` per row dropped. Each evicted row's on-disk
/// directory is best-effort deleted too. Returns the number of rows
/// dropped.
/// Paths whose `remove_dir_all` failed AFTER the corresponding DB row
/// was already deleted. The bytes still live on disk but accounting
/// has lost track of them — every subsequent eviction pass retries
/// these first so a transient fs error (locked file, antivirus scan)
/// doesn't permanently leak the bytes. R3-M1 (2026-05-28).
static ORPHAN_DIRS: Lazy<PLMutex<Vec<PathBuf>>> = Lazy::new(|| PLMutex::new(Vec::new()));

/// Retry-pass over `ORPHAN_DIRS`: re-attempt `remove_dir_all` on each.
/// Successes are removed from the list; persistent failures stay queued.
/// Called at the head of every eviction pass.
fn retry_orphan_dir_removals() {
    let mut orphans = ORPHAN_DIRS.lock();
    let mut still_failing = Vec::with_capacity(orphans.len());
    for path in orphans.drain(..) {
        if !path.exists() {
            // Already gone (user cleanup, separate process). Drop from
            // the list silently.
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(_) => {
                crate::diagnostics::info(
                    "lora-evict",
                    &format!("orphan dir retry succeeded: {}", path.display()),
                );
            }
            Err(_) => still_failing.push(path),
        }
    }
    *orphans = still_failing;
}

fn evict_if_needed<F: Fn(MergeProgress)>(
    projected_bytes: u64,
    emit: &F,
) -> Result<usize> {
    // R3-M1 (2026-05-28): retry previously-failed dir removals BEFORE
    // computing the cap math, so successful retries free disk space we
    // can credit against the projected merge.
    retry_orphan_dir_removals();

    let total = history::lora_total_bytes()? as u64;
    if total + projected_bytes <= LORA_CACHE_CAP_BYTES {
        return Ok(0);
    }
    let mut dropped = 0usize;
    let candidates = history::lora_list_lru()?;
    let mut running = total;
    for row in candidates {
        if running + projected_bytes <= LORA_CACHE_CAP_BYTES {
            break;
        }
        // Audit M-R1 (2026-05-28): previously the DB delete was swallowed
        // via `if let Ok(Some(...))`, so a transient DB-locked error
        // continued the loop without decrementing `running` — leaving
        // the cache permanently over cap with the merger silently
        // proceeding. Now propagates: a DB delete failure aborts the
        // eviction pass + returns an Err so the merge caller can
        // surface "cache eviction failed" to the user instead of
        // exceeding the disk cap.
        match history::lora_delete_by_sha(&row.sha)? {
            Some(path) => {
                let p = PathBuf::from(&path);
                if p.exists() {
                    if let Err(e) = fs::remove_dir_all(&p) {
                        // On-disk dir won't go away but the DB row is
                        // already gone. R3-M1 (2026-05-28): queue the
                        // path on ORPHAN_DIRS so subsequent eviction
                        // passes retry it. Without the queue a single
                        // transient fs error (antivirus scan, file
                        // locked by another process) permanently leaked
                        // the bytes — every later eviction was blind to
                        // them because the row is gone.
                        crate::diagnostics::warn_with(
                            "lora-evict",
                            &format!("on-disk eviction failed for {} (queued for retry)", p.display()),
                            serde_json::json!({ "sha": row.sha, "error": format!("{e:#}") }),
                        );
                        ORPHAN_DIRS.lock().push(p.clone());
                    }
                }
                running = running.saturating_sub(row.bytes as u64);
                dropped += 1;
                emit(MergeProgress::Evicted { sha: row.sha.clone() });
            }
            None => {
                // Row vanished between list_lru and delete (concurrent
                // delete via lora_delete IPC). Recompute running total
                // from DB so we don't double-count phantom bytes.
                running = history::lora_total_bytes()? as u64;
            }
        }
    }
    Ok(dropped)
}

/// Public list helper, mapping the internal DB row to the JS-facing shape.
pub fn list() -> Result<Vec<LoraMergeRow>> {
    let rows = history::lora_list_all()?;
    Ok(rows.into_iter().map(internal_to_public).collect())
}

/// Public delete by sha: drops the row + the on-disk dir.
pub fn delete(sha: &str) -> Result<()> {
    if let Some(path) = history::lora_delete_by_sha(sha)? {
        let p = PathBuf::from(&path);
        if p.exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }
    Ok(())
}

/// Public last-used touch. No-op if the sha isn't in the DB.
/// Look up a merge row by sha. Used by `engine.rs::resolve_lora_merged_path`
/// to convert `<base>+lora:<sha>` model ids into on-disk merged-variant
/// paths. Compiled-in unconditionally even though only the
/// `native-mistralrs` build's engine actually calls it — the `--no-default-
/// features` build uses the stub engine and never reaches the LoRA dispatch
/// path, so the function is dead-code-allowed there.
#[allow(dead_code)]
pub fn get_by_sha(sha: &str) -> Result<Option<LoraMergeRow>> {
    let row = history::lora_get_by_sha(sha)?;
    Ok(row.map(internal_to_public))
}

/// Touch the `last_used_at` timestamp for a merge variant. Returns
/// `Ok(true)` when the row was updated, `Ok(false)` when no row
/// matched (evicted between lookup and this call). The IPC layer maps
/// `Ok(false)` into a user-facing `merge_evicted` error so the user
/// sees a clear "re-merge to cache" message instead of a downstream
/// "tensor not found" surfacing from the engine.
pub fn record_used(sha: &str) -> Result<bool> {
    history::lora_record_used(sha)
}

fn internal_to_public(r: history::LoraMergeRowInternal) -> LoraMergeRow {
    LoraMergeRow {
        id: r.id,
        sha: r.sha,
        base_repo: r.base_repo,
        lora_path: r.lora_path,
        lora_sha: r.lora_sha,
        weight: r.weight as f32,
        merged_path: r.merged_path,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        bytes: r.bytes,
    }
}

/// Drive the full merge pipeline. Idempotent: a cache hit returns the
/// existing row immediately (and bumps `last_used_at`).
pub fn merge<F: Fn(MergeProgress)>(
    base_repo: &str,
    lora_path: &Path,
    weight: f32,
    _op_id: &str,
    emit: F,
) -> Result<LoraMergeRow> {
    if !ALLOWED_BASES.iter().any(|b| *b == base_repo) {
        return Err(anyhow!(
            "kind:\"unsupported_base\" base_repo {base_repo} is not in the allowlist (Flux.1 dev/schnell only)"
        ));
    }

    emit(MergeProgress::ReadingLora { progress: 0.0 });
    let lora_sha = sha256_file(lora_path)?;
    let sha = compute_merge_sha(base_repo, &lora_sha, weight);

    // Audit M-R3: acquire a per-sha mutex so two concurrent merges for
    // the same cache key serialize instead of racing the rename. The
    // SECOND caller blocks here, then re-checks the cache below and
    // sees the FIRST caller's just-promoted entry.
    let merge_lock = acquire_merge_lock(&sha);
    let _guard = merge_lock.lock();

    // Cache hit: return the row without rewriting any files. `record_used`
    // bumps the LRU clock so subsequent eviction passes see the touch.
    // Re-checked AFTER acquiring the per-sha lock so a concurrent merge
    // that finished while we were waiting is observed correctly.
    if let Some(existing) = history::lora_get_by_sha(&sha)? {
        history::lora_record_used(&sha)?;
        emit(MergeProgress::ReadingLora { progress: 1.0 });
        return Ok(internal_to_public(existing));
    }

    // Read the full LoRA bytes once; we'll borrow the SafeTensors view
    // against this buffer for the rest of the merge.
    let lora_bytes = fs::read(lora_path)
        .with_context(|| format!("failed to read {}", lora_path.display()))?;
    let lora_st = SafeTensors::deserialize(&lora_bytes)
        .with_context(|| format!("failed to parse LoRA safetensors header"))?;
    let lora_names: Vec<String> = lora_st.names().into_iter().cloned().collect();
    let convention = detect_convention(&lora_names);
    if convention == Convention::Unknown {
        return Err(anyhow!(
            "kind:\"no_keys_matched\" no LoRA keys matched the base model (convention undetected)"
        ));
    }
    emit(MergeProgress::ReadingLora { progress: 1.0 });

    let (pairs, unmapped) = build_pairs(&lora_names, convention);
    if pairs.is_empty() {
        return Err(anyhow!(
            "kind:\"no_keys_matched\" no LoRA keys matched the base model"
        ));
    }
    for u in &unmapped {
        crate::diagnostics::warn_with(
            "lora",
            "LoRA key did not map to any base tensor — skipped",
            serde_json::json!({ "key": u, "convention": convention.as_str() }),
        );
    }

    // Resolve the HF cache snapshot for the base. Mirrors what mistralrs's
    // FluxLoader does when handed the same repo id.
    let snapshot = resolve_hf_snapshot(base_repo)?;
    emit(MergeProgress::ReadingBase { progress: 0.0 });
    let (shards, others) = enumerate_snapshot(&snapshot)?;

    // Build a per-shard map of `{ target_name: pair_index }` so each shard
    // touches only the pairs whose targets live in that shard. Iterates
    // every shard once to read its key list.
    let target_set: HashSet<String> =
        pairs.iter().map(|p| p.target.clone()).collect();
    let mut pair_by_target: HashMap<String, &LoraPair> = HashMap::new();
    for p in &pairs {
        pair_by_target.insert(p.target.clone(), p);
    }

    let device = Device::Cpu;

    // Stage the merged write under `<sha>.tmp/` for atomic rename.
    let cache = cache_root()?;
    let tmp_dir = cache.join(format!("{sha}.tmp"));
    let final_dir = cache.join(&sha);
    if tmp_dir.exists() {
        // A previous crashed run — clean up.
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    fs::create_dir_all(&tmp_dir)?;

    // Copy non-safetensors files verbatim (config.json, tokenizer.json,
    // model_index.json, …) so the merged dir is a self-contained snapshot.
    for rel in &others {
        let src = snapshot.join(rel);
        let dst = tmp_dir.join(rel);
        if let Err(e) = link_or_copy(&src, &dst) {
            // Non-fatal — log + continue. A missing tokenizer might break
            // mistralrs at load time, but better to surface the real error
            // there than to fail the merge here.
            crate::diagnostics::warn_with(
                "lora",
                "failed to copy non-shard file into merged variant",
                serde_json::json!({ "rel": rel.display().to_string(), "error": e.to_string() }),
            );
        }
    }

    let mut matched_targets_total: HashSet<String> = HashSet::new();
    let n_shards = shards.len().max(1);
    for (shard_idx, rel) in shards.iter().enumerate() {
        let progress_base = shard_idx as f32 / n_shards as f32;
        emit(MergeProgress::ReadingBase {
            progress: progress_base,
        });
        let src = snapshot.join(rel);
        let dst = tmp_dir.join(rel);
        let shard_bytes = fs::read(&src)
            .with_context(|| format!("failed to read base shard {}", src.display()))?;
        let shard_st = SafeTensors::deserialize(&shard_bytes)
            .with_context(|| format!("failed to parse shard {}", src.display()))?;
        let shard_names: Vec<String> =
            shard_st.names().into_iter().cloned().collect();
        let modified_in_shard: Vec<&String> = shard_names
            .iter()
            .filter(|n| target_set.contains(*n))
            .collect();
        if modified_in_shard.is_empty() {
            // No targets land in this shard — link/copy and move on.
            link_or_copy(&src, &dst)?;
            continue;
        }

        emit(MergeProgress::ApplyingDeltas {
            progress: progress_base,
        });

        // Build the per-tensor payload list. Tensors we don't touch are
        // emitted as Original (zero-copy borrow into shard_bytes). Tensors
        // we touch get a fresh OwnedView with the merged bytes.
        let mut payload_map: BTreeMap<String, TensorPayload> = BTreeMap::new();
        // Carry the original `__metadata__` block through so trainer-side
        // info survives the round-trip. `SafeTensors::deserialize` doesn't
        // expose its inner `Metadata` directly; re-parse the header bytes
        // to pull the block out.
        let original_metadata: Option<HashMap<String, String>> =
            read_header_metadata(&shard_bytes);

        for name in &shard_names {
            let view = shard_st
                .tensor(name)
                .with_context(|| format!("tensor missing from header: {name}"))?;
            if !target_set.contains(name) {
                payload_map.insert(
                    name.clone(),
                    TensorPayload::Original {
                        dtype: view.dtype(),
                        shape: view.shape().to_vec(),
                        data: view.data(),
                    },
                );
                continue;
            }
            // It's a target. Pull the matching LoRA pair, compute the delta,
            // write the f32 result back at the original base dtype.
            let pair = pair_by_target.get(name).copied().ok_or_else(|| {
                anyhow!("internal: target {name} in set but no matching pair")
            })?;
            let base_dtype = view.dtype();
            let candle_dtype = st_to_candle_dtype(base_dtype).ok_or_else(|| {
                anyhow!("unsupported base dtype for target {name}: {base_dtype:?}")
            })?;
            let base_tensor = Tensor::from_raw_buffer(
                view.data(),
                candle_dtype,
                view.shape(),
                &device,
            )?;
            let base_f32 = base_tensor.to_dtype(DType::F32)?;
            let lora_a_view = lora_st.tensor(&pair.lora_a_key).with_context(|| {
                format!("LoRA tensor missing: {}", pair.lora_a_key)
            })?;
            let lora_b_view = lora_st.tensor(&pair.lora_b_key).with_context(|| {
                format!("LoRA tensor missing: {}", pair.lora_b_key)
            })?;
            let lora_a = Tensor::from_raw_buffer(
                lora_a_view.data(),
                st_to_candle_dtype(lora_a_view.dtype()).ok_or_else(|| {
                    anyhow!("unsupported LoRA dtype for {}", pair.lora_a_key)
                })?,
                lora_a_view.shape(),
                &device,
            )?;
            let lora_b = Tensor::from_raw_buffer(
                lora_b_view.data(),
                st_to_candle_dtype(lora_b_view.dtype()).ok_or_else(|| {
                    anyhow!("unsupported LoRA dtype for {}", pair.lora_b_key)
                })?,
                lora_b_view.shape(),
                &device,
            )?;
            let merged = apply_delta_to_base(&base_f32, &lora_a, &lora_b, weight)?;
            let (bytes, shape) = tensor_to_serialized(&merged, base_dtype)?;
            payload_map.insert(
                name.clone(),
                TensorPayload::Owned(OwnedView {
                    dtype: base_dtype,
                    shape,
                    data: bytes,
                }),
            );
            matched_targets_total.insert(name.clone());
        }

        emit(MergeProgress::Writing {
            progress: progress_base,
        });

        // Serialize the modified shard. We pass references so the
        // safetensors `View` impl above kicks in on `&TensorPayload`.
        let pairs_for_write: Vec<(&str, &TensorPayload)> = payload_map
            .iter()
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        let serialized =
            safetensors::tensor::serialize(pairs_for_write, &original_metadata)
                .map_err(|e| anyhow!("failed to serialize merged shard: {e}"))?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        // Atomic per-shard write: `<dst>.tmp` -> rename. Without this, a
        // poisoned writer in the middle of a multi-shard merge would leave
        // a half-written shard inside `<sha>.tmp/` which the final dir
        // rename would then atomically promote.
        let shard_tmp = {
            let mut p = dst.clone();
            let name = p
                .file_name()
                .map(|s| {
                    let mut n = s.to_os_string();
                    n.push(".tmp");
                    n
                })
                .ok_or_else(|| anyhow!("shard dst has no file name"))?;
            p.set_file_name(name);
            p
        };
        fs::write(&shard_tmp, &serialized).with_context(|| {
            format!("failed to write merged shard {}", shard_tmp.display())
        })?;
        fs::rename(&shard_tmp, &dst).with_context(|| {
            format!(
                "failed to rename shard {} → {}",
                shard_tmp.display(),
                dst.display()
            )
        })?;
    }

    // Final progress tick before commit.
    emit(MergeProgress::Writing { progress: 1.0 });

    if matched_targets_total.is_empty() {
        // We had pairs but none of them mapped to any tensor in the base
        // shards — partial rollback, surface as `no_keys_matched`.
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(anyhow!(
            "kind:\"no_keys_matched\" no LoRA pairs matched any tensor in the base shards"
        ));
    }

    emit(MergeProgress::Indexing);

    // Run LRU eviction BEFORE we promote the tmp dir, so a freshly-merged
    // variant whose projected size puts us over cap evicts older entries
    // (per spec: "Before writing"). Computing the projected size requires
    // walking the tmp dir.
    let projected_bytes = dir_size(&tmp_dir);
    evict_if_needed(projected_bytes, &emit)?;

    // Promote the tmp dir atomically. A crash before this line leaves
    // `<sha>.tmp/` for the next merge to clean up; nothing under `<sha>/`
    // ever exists half-written.
    if final_dir.exists() {
        // Concurrent merge or stale dir from a crashed run — clean it up.
        let _ = fs::remove_dir_all(&final_dir);
    }
    fs::rename(&tmp_dir, &final_dir).with_context(|| {
        format!(
            "failed to finalize merged variant {} → {}",
            tmp_dir.display(),
            final_dir.display()
        )
    })?;

    let final_bytes = dir_size(&final_dir);
    let row_id = history::lora_insert(
        &sha,
        base_repo,
        &lora_path.to_string_lossy(),
        &lora_sha,
        weight as f64,
        &final_dir.to_string_lossy(),
        final_bytes as i64,
    )?;
    let row = history::lora_get_by_sha(&sha)?
        .ok_or_else(|| anyhow!("internal: row {row_id} missing after insert"))?;
    Ok(internal_to_public(row))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use safetensors::tensor::serialize as st_serialize;
    use safetensors::View;
    use std::sync::Mutex;

    /// Lock around the global DB state so the test suite — which all hits
    /// the same `~/.local-llm-app/db.sqlite` via `history::get_db()` — runs
    /// the LRU/cache-dedup tests sequentially. Without this, concurrent
    /// tests would race the eviction sweep and the row counts assertion
    /// would flake.
    static DB_LOCK: Mutex<()> = Mutex::new(());

    fn install_isolated_home() -> tempfile::TempDir {
        // Many tests touch dirs::home_dir() through history::get_db(); the
        // pool is process-global so we can't fully isolate. Instead the
        // tests share one process-global DB but each test cleans up after
        // itself via `cleanup_lora_state`.
        tempfile::TempDir::new().expect("tempdir")
    }

    fn cleanup_lora_state() {
        let conn = history::__test_get_db().expect("db");
        conn.execute("DELETE FROM lora_merges", [])
            .expect("clear lora_merges");
        if let Ok(root) = cache_root() {
            for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    /// Build a minimal safetensors file in `path` from `(name, dtype, shape, bytes)` triples.
    fn write_safetensors(
        path: &Path,
        entries: &[(&str, StDtype, Vec<usize>, Vec<u8>)],
        metadata: Option<HashMap<String, String>>,
    ) {
        struct Raw {
            dtype: StDtype,
            shape: Vec<usize>,
            data: Vec<u8>,
        }
        impl View for &Raw {
            fn dtype(&self) -> StDtype {
                self.dtype
            }
            fn shape(&self) -> &[usize] {
                &self.shape
            }
            fn data(&self) -> std::borrow::Cow<'_, [u8]> {
                std::borrow::Cow::Borrowed(&self.data)
            }
            fn data_len(&self) -> usize {
                self.data.len()
            }
        }
        let raws: Vec<(String, Raw)> = entries
            .iter()
            .map(|(name, dtype, shape, data)| {
                (
                    name.to_string(),
                    Raw {
                        dtype: *dtype,
                        shape: shape.clone(),
                        data: data.clone(),
                    },
                )
            })
            .collect();
        let pairs: Vec<(&str, &Raw)> = raws.iter().map(|(n, r)| (n.as_str(), r)).collect();
        let bytes = st_serialize(pairs, &metadata).expect("serialize");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, bytes).expect("write");
    }

    fn f32_le(v: &[f32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(v.len() * 4);
        for f in v {
            out.extend_from_slice(&f.to_le_bytes());
        }
        out
    }

    #[test]
    fn migration_v16_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        history::ensure_lora_merges_table(&conn).expect("first");
        history::ensure_lora_merges_table(&conn).expect("second");
        history::ensure_lora_merges_table(&conn).expect("third");
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lora_merges'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);
    }

    #[test]
    fn sha_is_stable_and_weight_sensitive() {
        let a = compute_merge_sha("black-forest-labs/FLUX.1-dev", "abc", 1.0);
        let b = compute_merge_sha("black-forest-labs/FLUX.1-dev", "abc", 1.0);
        assert_eq!(a, b);
        let c = compute_merge_sha("black-forest-labs/FLUX.1-dev", "abc", 1.5);
        assert_ne!(a, c);
        // Same string repr difference matters too — `1.0` vs `1.0000`
        // must hash identically thanks to the `{:.4}` format spec.
        let d = compute_merge_sha("black-forest-labs/FLUX.1-dev", "abc", 1.0000);
        assert_eq!(a, d);
    }

    #[test]
    fn inspect_detects_diffusers_convention() {
        let dir = install_isolated_home();
        let p = dir.path().join("lora.safetensors");
        write_safetensors(
            &p,
            &[
                (
                    "transformer.layer0.lora_A.weight",
                    StDtype::F32,
                    vec![2, 4],
                    f32_le(&[0.0; 8]),
                ),
                (
                    "transformer.layer0.lora_B.weight",
                    StDtype::F32,
                    vec![4, 2],
                    f32_le(&[0.0; 8]),
                ),
            ],
            None,
        );
        let meta = inspect(&p).expect("inspect");
        assert_eq!(meta.convention, "diffusers");
        assert_eq!(meta.key_count, 2);
        assert!(meta.bytes > 0);
    }

    #[test]
    fn inspect_detects_kohya_convention() {
        let dir = install_isolated_home();
        let p = dir.path().join("lora.safetensors");
        write_safetensors(
            &p,
            &[
                (
                    "lora_unet_layer0_lora_down.weight",
                    StDtype::F32,
                    vec![2, 4],
                    f32_le(&[0.0; 8]),
                ),
                (
                    "lora_unet_layer0_lora_up.weight",
                    StDtype::F32,
                    vec![4, 2],
                    f32_le(&[0.0; 8]),
                ),
            ],
            None,
        );
        let meta = inspect(&p).expect("inspect");
        assert_eq!(meta.convention, "kohya");
    }

    #[test]
    fn inspect_unknown_convention() {
        let dir = install_isolated_home();
        let p = dir.path().join("random.safetensors");
        write_safetensors(
            &p,
            &[(
                "totally_unrelated_key",
                StDtype::F32,
                vec![1],
                f32_le(&[0.0]),
            )],
            None,
        );
        let meta = inspect(&p).expect("inspect");
        assert_eq!(meta.convention, "unknown");
    }

    #[test]
    fn inspect_extracts_kohya_triggers() {
        let dir = install_isolated_home();
        let p = dir.path().join("with-meta.safetensors");
        let mut meta_map = HashMap::new();
        meta_map.insert(
            "ss_tag_frequency".to_string(),
            r#"{"dataset_a":{"my_trigger":42,"another":3}}"#.to_string(),
        );
        meta_map.insert("activation_text".to_string(), "alpha, beta".to_string());
        write_safetensors(
            &p,
            &[(
                "transformer.layer.lora_A.weight",
                StDtype::F32,
                vec![1],
                f32_le(&[0.0]),
            )],
            Some(meta_map),
        );
        let m = inspect(&p).expect("inspect");
        assert!(m.triggers.iter().any(|t| t == "my_trigger"));
        assert!(m.triggers.iter().any(|t| t == "alpha"));
        assert!(m.triggers.iter().any(|t| t == "beta"));
    }

    /// Build a fake HF snapshot dir under `tmp` for `repo_id`.
    fn install_fake_hf_snapshot(repo_id: &str, entries: &[(PathBuf, Vec<u8>)]) -> PathBuf {
        let hub = hf_hub_dir();
        let encoded = format!("models--{}", repo_id.replace('/', "--"));
        // Use a unique snapshot id per call so concurrent tests don't collide.
        let snap_id = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let snap_dir = hub.join(&encoded).join("snapshots").join(&snap_id);
        fs::create_dir_all(&snap_dir).expect("snap dir");
        for (rel, bytes) in entries {
            let p = snap_dir.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(&p, bytes).expect("write entry");
        }
        snap_dir
    }

    /// Build a tiny base shard with a single 1x2 F32 tensor named `linear.weight`.
    fn base_shard_bytes(values: &[f32], name: &str, shape: Vec<usize>) -> Vec<u8> {
        struct Raw {
            dtype: StDtype,
            shape: Vec<usize>,
            data: Vec<u8>,
        }
        impl View for &Raw {
            fn dtype(&self) -> StDtype {
                self.dtype
            }
            fn shape(&self) -> &[usize] {
                &self.shape
            }
            fn data(&self) -> std::borrow::Cow<'_, [u8]> {
                std::borrow::Cow::Borrowed(&self.data)
            }
            fn data_len(&self) -> usize {
                self.data.len()
            }
        }
        let r = Raw {
            dtype: StDtype::F32,
            shape,
            data: f32_le(values),
        };
        st_serialize(vec![(name, &r)], &None).expect("serialize base shard")
    }

    /// Math test: matmul + add path through real candle tensors.
    /// base = [[1.0, 2.0]] (1x2), lora_A = [[1.0],[0.0]] (2x1),
    /// lora_B = [[0.5, 0.0]] (1x2)? No wait the spec gives different shapes.
    /// Spec: A=[[1.0],[0.0]] (2x1), B=[[0.5,0.0]] (1x2). delta = B @ A doesn't
    /// work — (1x2) @ (2x1) = (1x1), shape mismatch with base.
    /// Re-read spec: "Expected delta = 2.0 * B @ A = [[1.0, 0.0]]."
    /// So B@A must yield (1x2). For B @ A to be (1x2): B is (1xK), A is (Kx2).
    /// Reverse: A=[[1.0,0.0]] (1x2), B=[[0.5],[0.0]]... but spec writes
    /// `A=[[1.0],[0.0]], B=[[0.5,0.0]]`. We use the spec's exact bytes:
    /// reinterpreting as A=(1x2)=[1.0, 0.0] and B=(2x1)... still doesn't match.
    /// Most reasonable interpretation: A is (rank x in_features), B is
    /// (out_features x rank). For base=(out=1, in=2), need:
    ///   A: (rank=1, in=2) so A=[[1.0, 0.0]] gives delta when picked right.
    ///   B: (out=1, rank=1) → B=[[0.5]]. Then B@A=[[0.5*1.0, 0.5*0.0]]=[[0.5,0.0]].
    /// 2.0 * delta = [[1.0, 0.0]]. matches!
    /// Adjusting the test: write A as a 1×2 [1.0, 0.0] and B as a 1×1 [0.5].
    #[test]
    fn merge_math_roundtrip() {
        let _lock = DB_LOCK.lock().expect("db lock");
        cleanup_lora_state();

        let dir = install_isolated_home();
        let lora_path = dir.path().join("test-lora.safetensors");
        // Pair name: target = "linear.weight"
        write_safetensors(
            &lora_path,
            &[
                (
                    "transformer.linear.lora_A.weight",
                    StDtype::F32,
                    vec![1, 2],
                    f32_le(&[1.0, 0.0]),
                ),
                (
                    "transformer.linear.lora_B.weight",
                    StDtype::F32,
                    vec![1, 1],
                    f32_le(&[0.5]),
                ),
            ],
            None,
        );
        // Build a fake HF snapshot for the dev repo.
        let repo = "black-forest-labs/FLUX.1-dev";
        // Clean any older snapshots so we don't accumulate state.
        let hub_repo = hf_hub_dir().join(format!("models--{}", repo.replace('/', "--")));
        let _ = fs::remove_dir_all(&hub_repo);
        let snap_path = PathBuf::from("transformer/model.safetensors");
        let base_bytes = base_shard_bytes(&[1.0, 2.0], "linear.weight", vec![1, 2]);
        let _ = install_fake_hf_snapshot(repo, &[(snap_path.clone(), base_bytes)]);

        let row = merge(repo, &lora_path, 2.0, "test-op", |_| {}).expect("merge");
        // Read back the merged shard and verify the tensor at "linear.weight".
        let shard = PathBuf::from(&row.merged_path).join(&snap_path);
        let bytes = fs::read(&shard).expect("read merged shard");
        let st = SafeTensors::deserialize(&bytes).expect("parse merged");
        let view = st.tensor("linear.weight").expect("tensor present");
        assert_eq!(view.shape(), &[1, 2]);
        let raw = view.data();
        let a = f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
        let b = f32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]);
        // Expected: base [1.0, 2.0] + 2.0 * (B@A = [0.5, 0.0]) = [2.0, 2.0]
        assert!((a - 2.0).abs() < 1e-5, "got a={a}");
        assert!((b - 2.0).abs() < 1e-5, "got b={b}");

        // Cache-dedup: re-running with identical inputs must reuse the row.
        let mtime_before = fs::metadata(&shard).and_then(|m| m.modified()).unwrap();
        let row2 = merge(repo, &lora_path, 2.0, "test-op-2", |_| {}).expect("merge dedup");
        assert_eq!(row.sha, row2.sha);
        let mtime_after = fs::metadata(&shard).and_then(|m| m.modified()).unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "cache hit must not rewrite the shard"
        );

        // Cleanup so other tests start fresh.
        let _ = fs::remove_dir_all(&hub_repo);
        cleanup_lora_state();
    }

    #[test]
    fn merge_rejects_unknown_convention() {
        let _lock = DB_LOCK.lock().expect("db lock");
        cleanup_lora_state();
        let dir = install_isolated_home();
        let lora_path = dir.path().join("garbage.safetensors");
        write_safetensors(
            &lora_path,
            &[(
                "totally_random_key",
                StDtype::F32,
                vec![1],
                f32_le(&[0.0]),
            )],
            None,
        );
        let err = merge(
            "black-forest-labs/FLUX.1-dev",
            &lora_path,
            1.0,
            "op",
            |_| {},
        )
        .err()
        .expect("must fail");
        assert!(format!("{err}").contains("no_keys_matched"));
        cleanup_lora_state();
    }

    #[test]
    fn merge_rejects_unsupported_base() {
        let _lock = DB_LOCK.lock().expect("db lock");
        cleanup_lora_state();
        let dir = install_isolated_home();
        let lora_path = dir.path().join("any.safetensors");
        write_safetensors(
            &lora_path,
            &[(
                "transformer.x.lora_A.weight",
                StDtype::F32,
                vec![1, 1],
                f32_le(&[0.0]),
            )],
            None,
        );
        let err = merge("runwayml/stable-diffusion-v1-5", &lora_path, 1.0, "op", |_| {})
            .err()
            .expect("must fail");
        assert!(format!("{err}").contains("unsupported_base"));
        cleanup_lora_state();
    }

    #[test]
    fn lru_eviction_orders_oldest_first() {
        let _lock = DB_LOCK.lock().expect("db lock");
        cleanup_lora_state();

        // Insert three synthetic rows. The first two get explicit
        // `last_used_at` values so the LRU sort is deterministic; the third
        // keeps `last_used_at = NULL` ("never used since insert") which the
        // sort places ahead of the others per the `nulls first` clause.
        let dir = install_isolated_home();
        let mock_path1 = dir.path().join("variant1");
        let mock_path2 = dir.path().join("variant2");
        let mock_path3 = dir.path().join("variant3");
        for p in [&mock_path1, &mock_path2, &mock_path3] {
            fs::create_dir_all(p).expect("mock dir");
            fs::write(p.join("placeholder.txt"), b"x").expect("placeholder");
        }
        let id1 = history::lora_insert(
            "sha1",
            "black-forest-labs/FLUX.1-dev",
            "/tmp/lora1.safetensors",
            "lsha1",
            1.0,
            &mock_path1.to_string_lossy(),
            1,
        )
        .expect("insert1");
        let id2 = history::lora_insert(
            "sha2",
            "black-forest-labs/FLUX.1-dev",
            "/tmp/lora2.safetensors",
            "lsha2",
            1.0,
            &mock_path2.to_string_lossy(),
            1,
        )
        .expect("insert2");
        let _id3 = history::lora_insert(
            "sha3",
            "black-forest-labs/FLUX.1-dev",
            "/tmp/lora3.safetensors",
            "lsha3",
            1.0,
            &mock_path3.to_string_lossy(),
            1,
        )
        .expect("insert3");
        // Touch id1 furthest in the past, id2 more recently. id3 stays NULL.
        {
            let conn = history::__test_get_db().expect("db");
            conn.execute(
                "UPDATE lora_merges SET last_used_at = 1000 WHERE id = ?1",
                rusqlite::params![id1],
            )
            .unwrap();
            conn.execute(
                "UPDATE lora_merges SET last_used_at = 2000 WHERE id = ?1",
                rusqlite::params![id2],
            )
            .unwrap();
        }
        let lru = history::lora_list_lru().expect("lru");
        // nulls first (id3), then id1 (oldest used), then id2.
        assert_eq!(lru[0].sha, "sha3");
        assert_eq!(lru[1].sha, "sha1");
        assert_eq!(lru[2].sha, "sha2");
        cleanup_lora_state();
    }

    #[test]
    fn diffusers_target_mapping() {
        assert_eq!(
            target_from_lora_key("transformer.blocks.0.attn.to_q.lora_A.weight", Convention::Diffusers).unwrap(),
            "blocks.0.attn.to_q.weight"
        );
        assert_eq!(
            target_from_lora_key("transformer.blocks.0.attn.to_q.lora_B.weight", Convention::Diffusers).unwrap(),
            "blocks.0.attn.to_q.weight"
        );
    }

    #[test]
    fn kohya_target_mapping() {
        assert_eq!(
            target_from_lora_key("lora_unet_blocks_0_attn_to_q_lora_down.weight", Convention::Kohya).unwrap(),
            "blocks.0.attn.to.q.weight"
        );
        assert_eq!(
            target_from_lora_key("lora_unet_blocks_0_attn_to_q_lora_up.weight", Convention::Kohya).unwrap(),
            "blocks.0.attn.to.q.weight"
        );
    }

    // ── Audit H3 (2026-05-28): per-sha merge-lock registry invariants ──
    //
    // The image-layer review flagged a gap in coverage around the
    // concurrent-merge path: two callers requesting the same `(base, sha)`
    // merge in parallel must serialize on a SINGLE lock, but two callers
    // working on DIFFERENT shas must NOT block each other. These tests pin
    // both invariants. The real merge() body is heavy (candle math, fs
    // shard rewrites) — too expensive for the unit suite — but the
    // registry primitive is what guarantees the concurrency contract, so
    // exercising it directly is the high-value coverage.

    #[test]
    fn merge_lock_registry_dedupes_by_sha() {
        let sha = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = acquire_merge_lock(sha);
        let b = acquire_merge_lock(sha);
        // Same sha → same Arc<Mutex<()>>. Two concurrent merges with the
        // same content hash serialize through this single mutex so we
        // never write the same shard twice.
        assert!(
            Arc::ptr_eq(&a, &b),
            "expected the registry to return the same Arc for identical shas"
        );
    }

    #[test]
    fn merge_lock_registry_distinguishes_distinct_shas() {
        let sha_a = "00000000000000000000000000000000000000000000000000000000000000aa";
        let sha_b = "00000000000000000000000000000000000000000000000000000000000000bb";
        let a = acquire_merge_lock(sha_a);
        let b = acquire_merge_lock(sha_b);
        // Different shas → different Arcs. Two unrelated merges running
        // in parallel must not block each other; the lock granularity
        // matters here.
        assert!(
            !Arc::ptr_eq(&a, &b),
            "expected distinct shas to map to distinct mutex Arcs"
        );
    }
}
