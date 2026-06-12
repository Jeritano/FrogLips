/**
 * Shared display formatters. Previously copy-pasted (several byte-identical)
 * across ModelCard, LlmpmPanel, ModelScopeBrowserTab, InstalledModelsTab,
 * HuggingFaceLibraryView, AuditLog, RagPanel, and ModelPicker. Consolidated
 * here — impls preserved verbatim so displayed values don't change.
 *
 * Note the TWO distinct byte families: `fmtBytesDecimal` (base-1000, used for
 * model file sizes) and `fmtBytesBinary` (base-1024, used for log/corpus
 * sizes). They are intentionally separate; don't collapse them.
 */

/** Abbreviate a count: 1_500_000 → "1.5M", 2_400 → "2k". Falsy → "0". */
export function abbrev(n?: number): string {
  if (!n) return "0";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Parameter count → HF-style pill ("7B", "1.5B", "405B"); null if sub-million. */
export function paramPill(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1_000_000_000) {
    const v = n / 1_000_000_000;
    return v >= 100
      ? `${Math.round(v)}B`
      : `${v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "")}B`;
  }
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return null;
}

/** Relative time from an ISO timestamp ("today", "3 days ago", …). */
export function relTime(iso?: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const day = Math.floor((Date.now() - then) / 86_400_000);
  if (day < 1) return "today";
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

/** Relative time from a unix-epoch-seconds value. */
export function relTimeEpoch(epochSec?: number): string | null {
  if (!epochSec) return null;
  const day = Math.floor((Date.now() / 1000 - epochSec) / 86_400);
  if (day < 1) return "today";
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  return `${Math.floor(day / 365)} year${Math.floor(day / 365) === 1 ? "" : "s"} ago`;
}

/** Base-1000 bytes for model file sizes: 0 → "—", else "1.2 GB"/"512 MB"/… */
export function fmtBytesDecimal(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes === 0) return "—";
  return `${bytes} B`;
}

/** Base-1024 bytes for small log/corpus sizes ("512 B"/"1.5 KB"/"2.30 MB").
 *  `mbDigits` controls the MB-branch precision (AuditLog used 2, RagPanel 1). */
export function fmtBytesBinary(n: number, mbDigits = 2): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(mbDigits)} MB`;
}

/** Parenthesized base-1024 size for the model picker (" (3.5 GB)"); "" if 0. */
export function formatSizeParen(bytes: number): string {
  if (!bytes) return "";
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return ` (${v.toFixed(1)} ${units[i]})`;
}

/** Extract a GGUF quant tag (Q4_K_M, IQ3_XXS, F16, …) from a filename. */
export function parseGgufQuant(filename: string): string | null {
  const m = filename.match(/\b(IQ\d+_[A-Z]+|Q\d+_[A-Z0-9_]+|F16|F32|BF16)\b/i);
  return m ? m[1].toUpperCase() : null;
}
