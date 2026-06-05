import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { X, Mic, Square, ArrowUp } from "lucide-react";
import type { ChatImage, ServerStatus } from "../types";
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from "../lib/model-capabilities";
import {
  resolveVisionSupport,
  prefetchVisionSupport,
} from "../lib/model-capability-lookup";
import {
  applyTemplate,
  filterByTrigger,
  loadAllTemplates,
  type PromptTemplate,
} from "../lib/prompt-templates";

// PromptLibrary is the full-screen template manager; only opens when the
// user clicks the library button. Lazy-load so the chat input itself stays
// in the first-paint chunk while the manager ships separately.
const PromptLibrary = lazy(() =>
  import("./PromptLibrary").then((m) => ({ default: m.PromptLibrary })),
);

/**
 * Minimal shape for the Web Speech API's `SpeechRecognition` instance —
 * not part of `lib.dom`. Captures only the methods + handlers used here.
 */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionCtor {
  new(): SpeechRecognitionLike;
}
interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/**
 * Detect a slash-command "trigger context" in the textarea.
 *
 * Returns the index of the `/` and the prefix typed after it iff the caret is
 * positioned right after a `/<word>` that itself sits at the start of the
 * value or immediately after whitespace. Returns null otherwise so callers
 * can hide the menu.
 */
function detectSlashContext(value: string, caret: number): { start: number; prefix: string } | null {
  if (caret === 0) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "/") {
      const before = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(before)) return null;
      const prefix = value.slice(i + 1, caret);
      if (!/^[a-zA-Z0-9_-]*$/.test(prefix)) return null;
      return { start: i, prefix };
    }
    if (!/[a-zA-Z0-9_-]/.test(ch)) return null;
    i--;
  }
  return null;
}

interface Props {
  disabled?: boolean;
  onSend: (text: string, images?: ChatImage[]) => void;
  onAbort?: () => void;
  streaming?: boolean;
  /** Active model id — used to gate the image-drop affordance. */
  currentModel?: string | null;
  /** Active backend status — lets the image-drop gate consult the
   *  backend's authoritative `capabilities` (Ollama /api/show) instead
   *  of the name-regex heuristic alone. */
  status?: ServerStatus | null;
}

const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif|bmp)$/i;

/** Re-encode an image File to PNG via Canvas. This strips EXIF (privacy)
 *  and gives us a uniform `image/png` MIME going forward. Returns the raw
 *  base64 (no data: prefix), plus the byte count of the new PNG. */
async function fileToScrubbedPng(file: File): Promise<{ base64: string; size_bytes: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("decode failed"));
    i.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0);
  // toDataURL is sync; toBlob would let us measure size before reading,
  // but the extra await pays for itself only on huge images.
  const png = canvas.toDataURL("image/png");
  const comma = png.indexOf(",");
  const base64 = comma >= 0 ? png.slice(comma + 1) : png;
  // 4 base64 chars ≈ 3 bytes; ignore padding for an estimate
  const size_bytes = Math.floor((base64.length * 3) / 4);
  return { base64, size_bytes };
}

export function ChatInput({ disabled, onSend, onAbort, streaming, currentModel, status }: Props) {
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const [images, setImages] = useState<ChatImage[]>([]);
  const [dropMsg, setDropMsg] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => loadAllTemplates());
  const [slashCtx, setSlashCtx] = useState<{ start: number; prefix: string } | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [showLibrary, setShowLibrary] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Audit L-F4 (2026-05-28): SpeechRecognition isn't in the lib.dom.d.ts
  // baseline (it's a non-standard Web Speech API, prefixed in WebKit). A
  // minimal local shape captures the surface this component touches —
  // enough to drop the `any` typings without committing to the upstream
  // proposal's full schema.
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");
  const lastVoiceTextRef = useRef("");
  const listeningRef = useRef(false);
  const mountedRef = useRef(true);

  // Bump on a successful backend capability lookup so the cache-first
  // `resolveVisionSupport` re-reads the authoritative answer without a
  // remount (mirrors ContextMeter's prefetch-tick pattern).
  const [visionTick, setVisionTick] = useState(0);
  useEffect(() => {
    if (!currentModel || !status?.running) return;
    let cancelled = false;
    void prefetchVisionSupport(currentModel, status).then((v) => {
      if (!cancelled && v != null) setVisionTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, [currentModel, status]);
  // visionTick forces a re-evaluation when the prefetch lands; the value
  // itself isn't read (the cache inside resolveVisionSupport holds it).
  void visionTick;
  const visionOK = resolveVisionSupport(currentModel, status ?? null);

  const matches = useMemo(
    () => (slashCtx ? filterByTrigger(templates, slashCtx.prefix) : []),
    [templates, slashCtx],
  );

  // Keep menuIndex valid when the candidate list shrinks (e.g. user typed
  // another character that narrows the match set).
  useEffect(() => {
    if (menuIndex >= matches.length) setMenuIndex(0);
  }, [matches.length, menuIndex]);

  function refreshTemplates() {
    setTemplates(loadAllTemplates());
  }

  function applyAndDismiss(tpl: PromptTemplate) {
    if (!slashCtx) return;
    const before = text.slice(0, slashCtx.start);
    const after = text.slice(slashCtx.start + 1 + slashCtx.prefix.length);
    const { text: filled, firstVarRange } = applyTemplate(tpl);
    const insertedStart = before.length;
    const newText = before + filled + after;
    setText(newText);
    setSlashCtx(null);
    // After paint, restore focus and (if the template had variables) auto-
    // select the first placeholder so the user can type over it directly.
    setTimeout(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      if (firstVarRange) {
        const start = insertedStart + firstVarRange.start;
        const end = insertedStart + firstVarRange.end;
        ta.setSelectionRange(start, end);
      } else {
        const pos = insertedStart + filled.length;
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  // auto-resize textarea on any text change (typing, voice, paste, drop)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  // stop recognition when component unmounts
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      recogRef.current?.stop?.();
    };
  }, []);

  // Auto-clear transient drop messages after a few seconds so the UI doesn't
  // pile up rejection toasts.
  useEffect(() => {
    if (!dropMsg) return;
    const t = setTimeout(() => setDropMsg(null), 4000);
    return () => clearTimeout(t);
  }, [dropMsg]);

  // Allow other components to prefill the composer (e.g. the first-run setup
  // wizard dropping a sample prompt into the input after closing). Dispatch a
  // `chat-input:prefill` CustomEvent with `{ detail: { text: "..." } }` from
  // anywhere in the tree. We intentionally never auto-send — the user must
  // press Enter to confirm so the wizard's "try a prompt" cards remain
  // editable starter points rather than surprise submissions.
  useEffect(() => {
    function handler(e: Event) {
      const ce = e as CustomEvent<{ text?: string }>;
      const value = ce.detail?.text;
      if (typeof value !== "string" || !value) return;
      setText(value);
      // Focus + caret-at-end so the user can immediately edit/submit.
      setTimeout(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(value.length, value.length);
      }, 0);
    }
    window.addEventListener("chat-input:prefill", handler);
    return () => window.removeEventListener("chat-input:prefill", handler);
  }, []);

  function send() {
    const t = text.trim();
    if (!t && images.length === 0) return;
    onSend(t, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
    setSlashCtx(null);
    // Fully tear down dictation BEFORE the async stop. `recogRef.stop()`
    // is asynchronous: the engine flushes a final `onresult` (and the
    // `onend`) AFTER this call, and that handler would call
    // `setText(base + combined)` — repopulating the composer we just
    // cleared (the leftover-text bug). Flipping `listeningRef` false +
    // blanking the base/last refs makes the trailing onresult a no-op
    // (it early-returns on `!listeningRef.current`).
    listeningRef.current = false;
    baseTextRef.current = "";
    lastVoiceTextRef.current = "";
    if (listening) {
      recogRef.current?.stop?.();
      setListening(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Don't treat Enter as "send" (or as a slash-menu pick) while an IME is
    // composing — for CJK input the Enter that confirms a candidate would
    // otherwise fire the message mid-composition. (2026-05-30)
    if (e.nativeEvent.isComposing) return;
    if (slashCtx && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyAndDismiss(matches[menuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashCtx(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function ingestFiles(files: File[]) {
    // Partition: images go through the vision pipeline; the rest fall back to
    // the legacy text-attachment path so drag-drop of a mixed selection still
    // works.
    const imageFiles = files.filter((f) => IMAGE_MIME_RE.test(f.type));
    const otherFiles = files.filter((f) => !IMAGE_MIME_RE.test(f.type));

    if (imageFiles.length > 0) {
      if (!visionOK) {
        setDropMsg("Selected model doesn't support images. Switch to a vision-capable model (llava, qwen2-vl, gemma3, etc).");
      } else {
        const slotsLeft = MAX_IMAGES_PER_MESSAGE - images.length;
        const accepted: ChatImage[] = [];
        let rejectedSize = 0;
        let rejectedSlots = 0;
        for (const f of imageFiles) {
          if (accepted.length >= slotsLeft) { rejectedSlots++; continue; }
          if (f.size > MAX_IMAGE_BYTES) { rejectedSize++; continue; }
          try {
            const { base64, size_bytes } = await fileToScrubbedPng(f);
            // Re-check AFTER the canvas PNG re-encode: a lossy source (JPEG/
            // WebP) routinely balloons 3–6× as lossless PNG, so a sub-4 MiB
            // file can exceed the cap once scrubbed. Reject rather than ship a
            // payload several times larger than the stated limit. (2026-05-30)
            if (size_bytes > MAX_IMAGE_BYTES) { rejectedSize++; continue; }
            accepted.push({
              base64,
              mime: "image/png",
              filename: f.name,
              size_bytes,
            });
          } catch {
            // decode/canvas failed — silently skip the offender
          }
        }
        if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
        if (rejectedSize > 0 || rejectedSlots > 0) {
          const parts: string[] = [];
          if (rejectedSize > 0) parts.push(`${rejectedSize} too large (>4 MiB — crop first)`);
          if (rejectedSlots > 0) parts.push(`${rejectedSlots} over the ${MAX_IMAGES_PER_MESSAGE}-image limit`);
          setDropMsg(`Skipped: ${parts.join(", ")}`);
        }
      }
    }

    if (otherFiles.length === 0) return;

    // Legacy text-attachment path (unchanged behaviour for non-image drops).
    const MAX_TOTAL_BYTES = 1_048_576; // 1 MiB combined cap, matches backend MAX_MESSAGE_BYTES
    const enc = new TextEncoder();
    let usedBytes = enc.encode(text).length;
    let added = "";
    for (const f of otherFiles) {
      const headerEst = f.name.length + 64;
      if (usedBytes + f.size + headerEst > MAX_TOTAL_BYTES) {
        added += `\n\n--- file: ${f.name} (skipped, would exceed 1 MB combined limit) ---\n`;
        continue;
      }
      try {
        const content = await f.text();
        const chunk = `\n\n--- file: ${f.name} ---\n${content}\n--- end file ---\n`;
        const chunkBytes = enc.encode(chunk).length;
        if (usedBytes + chunkBytes > MAX_TOTAL_BYTES) {
          added += `\n\n--- file: ${f.name} (skipped, would exceed 1 MB combined limit) ---\n`;
          continue;
        }
        added += chunk;
        usedBytes += chunkBytes;
      } catch {
        // binary; skip
      }
    }
    if (added) setText((t) => t + added);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    await ingestFiles(files);
  }

  // Paste an image (the Cmd+V-after-screenshot flow). The textarea's default
  // paste handles text; here we pull any image items off the clipboard and
  // route them through the same vision pipeline as drop / the file picker.
  // (2026-05-30)
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (const it of items) {
      if (it.kind === "file" && IMAGE_MIME_RE.test(it.type)) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length === 0) return; // let plain-text paste proceed
    e.preventDefault();
    await ingestFiles(imgs);
  }

  function onTextChange(v: string, caret: number | null) {
    if (listeningRef.current && v !== lastVoiceTextRef.current) {
      // User edited the textarea while dictation is active — rebase voice on top
      // of the manual edit so the next recognition event doesn't clobber it.
      baseTextRef.current = v + (v.endsWith(" ") || v === "" ? "" : " ");
    }
    setText(v);
    if (caret == null) {
      setSlashCtx(null);
      return;
    }
    const ctx = detectSlashContext(v, caret);
    setSlashCtx(ctx);
    if (ctx) setMenuIndex(0);
  }

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (files.length > 0) await ingestFiles(files);
  }

  function toggleVoice() {
    setVoiceErr(null);
    if (listening) {
      recogRef.current?.stop?.();
      return;
    }
    const w = window as WindowWithSpeech;
    const Recog = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Recog) {
      setVoiceErr("Speech recognition unavailable in this build");
      return;
    }
    try {
      const r = new Recog();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || "en-US";
      baseTextRef.current = text ? text + (text.endsWith(" ") ? "" : " ") : "";

      r.onresult = (e) => {
        // Ignore a final result flushed after stop() (e.g. send() tore
        // dictation down) — otherwise it repopulates the cleared input.
        if (!listeningRef.current) return;
        const segments = [];
        for (let i = 0; i < e.results.length; i++) {
          const seg = e.results[i][0].transcript.trim();
          if (seg) segments.push(seg);
        }
        const combined = segments.join(" ");
        const base = baseTextRef.current;
        const next =
          base && combined && !base.endsWith(" ")
            ? base + " " + combined
            : base + combined;
        lastVoiceTextRef.current = next;
        setText(next);
      };
      r.onerror = (e) => {
        listeningRef.current = false;
        if (!mountedRef.current) return;
        const code = e?.error || "unknown";
        if (code === "not-allowed" || code === "service-not-allowed") {
          setVoiceErr("Microphone permission denied. Grant access in System Settings → Privacy → Microphone.");
        } else if (code === "no-speech") {
          // silent timeout — not really an error
        } else {
          setVoiceErr(`Voice error: ${code}`);
        }
        setListening(false);
      };
      r.onend = () => {
        listeningRef.current = false;
        if (!mountedRef.current) return;
        setListening(false);
      };

      r.start();
      recogRef.current = r;
      listeningRef.current = true;
      setListening(true);
    } catch (err) {
      setVoiceErr(err instanceof Error ? err.message : String(err));
      listeningRef.current = false;
      setListening(false);
    }
  }

  // Detect drag-hover content type so we can show a vision-rejection tooltip
  // when an unsupported model is selected. dataTransfer.items is only
  // reliably populated on dragenter/over.
  function dragHasImage(e: React.DragEvent): boolean {
    const items = Array.from(e.dataTransfer?.items ?? []);
    return items.some((it) => it.kind === "file" && IMAGE_MIME_RE.test(it.type));
  }

  return (
    <>
      {voiceErr && <div className="voice-err">{voiceErr}</div>}
      {dropMsg && <div className="voice-err" data-testid="drop-msg">{dropMsg}</div>}
      {images.length > 0 && (
        <div className="image-chips" data-testid="image-chips">
          {images.map((img, i) => (
            // Audit LOW (2026-05-27): key was `img.base64.slice(0, 64)`
            // which collides for two PNGs sharing the same header (common
            // for screenshots from the same source). Combine with the
            // array index + (filename ?? "") so collisions can't reorder
            // chips on add/remove. Index alone would be wrong (React
            // re-uses DOM across rerenders); the hybrid stays stable for
            // each chip's lifetime.
            <div
              className="image-chip"
              key={`${i}-${img.filename ?? ""}-${img.base64.slice(0, 32)}`}
              data-testid="image-chip"
            >
              <img
                src={`data:${img.mime};base64,${img.base64}`}
                alt={img.filename ?? `image ${i + 1}`}
                style={{ maxWidth: 96, maxHeight: 96, objectFit: "cover", borderRadius: 4 }}
              />
              <div className="image-chip-meta" style={{ fontSize: 11, marginLeft: 6 }}>
                <div className="image-chip-name" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {img.filename ?? "image"}
                </div>
                <div className="image-chip-size" style={{ opacity: 0.7 }}>
                  {(img.size_bytes / 1024).toFixed(0)} KB
                </div>
              </div>
              <button
                type="button"
                className="image-chip-remove"
                title="Remove"
                aria-label="Remove image"
                onClick={() => removeImage(i)}
                style={{ marginLeft: 4 }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`chat-input ${dropping ? "dropping" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
          if (!visionOK && dragHasImage(e)) {
            setDropMsg("Selected model doesn't support images. Switch to a vision-capable model.");
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        {dropping && (
          <div className="chat-input-drop-overlay" aria-hidden="true">
            {visionOK
              ? `Drop image${images.length < MAX_IMAGES_PER_MESSAGE - 1 ? "s" : ""} or files here`
              : "Drop files for context (model doesn't accept images)"}
          </div>
        )}
        {slashCtx && matches.length > 0 && (
          <div
            className="prompt-autocomplete"
            data-testid="prompt-autocomplete"
            role="listbox"
          >
            {matches.map((t, i) => (
              <div
                key={t.id}
                role="option"
                aria-selected={i === menuIndex}
                data-testid={`prompt-option-${t.trigger}`}
                className={`prompt-autocomplete-item ${i === menuIndex ? "active" : ""}`}
                onMouseDown={(e) => {
                  // Block default so the textarea retains focus (otherwise
                  // blur would race the click and dismiss the menu).
                  e.preventDefault();
                  applyAndDismiss(t);
                }}
                onMouseEnter={() => setMenuIndex(i)}
              >
                <code className="prompt-autocomplete-trigger">/{t.trigger}</code>
                <span className="prompt-autocomplete-name">{t.name}</span>
                {t.builtIn === false && (
                  <span className="prompt-autocomplete-tag">custom</span>
                )}
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          data-testid="chat-input"
          value={text}
          onChange={(e) => onTextChange(e.target.value, e.target.selectionStart)}
          onPaste={onPaste}
          onKeyDown={onKey}
          onKeyUp={(e) => {
            // Arrow-key caret moves don't fire onChange; recompute the slash
            // context from the new selection so the menu stays in sync.
            if (slashCtx === null && !["/", "Backspace"].includes(e.key)) return;
            const target = e.currentTarget;
            const ctx = detectSlashContext(target.value, target.selectionStart ?? 0);
            setSlashCtx(ctx);
          }}
          onClick={(e) => {
            const target = e.currentTarget;
            const ctx = detectSlashContext(target.value, target.selectionStart ?? 0);
            setSlashCtx(ctx);
          }}
          onBlur={() => {
            // Delay so option onMouseDown can fire before the menu unmounts.
            setTimeout(() => setSlashCtx(null), 120);
          }}
          placeholder={
            !status?.running
              ? "Pick a model in the top bar and press Start to begin…"
              : listening
                ? "Listening…"
                : "Message… (drop files, / for prompts)"
          }
          disabled={disabled}
          rows={1}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={onPickFiles}
          data-testid="image-file-input"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="attach-btn"
          title={visionOK ? "Attach image" : "Selected model doesn't support images"}
          aria-label="Attach image"
          disabled={!visionOK || images.length >= MAX_IMAGES_PER_MESSAGE}
          data-testid="attach-image-btn"
        >
          {/* paperclip glyph */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={() => { setShowLibrary(true); refreshTemplates(); }}
          className="mic-btn"
          title="Prompt library"
          aria-label="Open prompt library"
          data-testid="open-prompt-library"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 4h10v2H4zm0 4h10v2H4zm0 4h7v2H4zm12-8h4v16h-4z"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={toggleVoice}
          className={`mic-btn ${listening ? "listening" : ""}`}
          title={listening ? "Stop dictation" : "Start dictation"}
          aria-label="Voice input"
        >
          <Mic size={16} />
        </button>
        {streaming ? (
          <button data-testid="stop-btn" onClick={onAbort} className="send-btn stop" title="Stop"><Square size={16} /></button>
        ) : (
          <button data-testid="send-btn" onClick={send} disabled={disabled || (!text.trim() && images.length === 0)} className="send-btn" title="Send"><ArrowUp size={16} /></button>
        )}
      </div>
      {/*
       * Only mount the library while open. Keeps the chunk fetch deferred
       * until the user actually opens the manager. Suspense fallback is
       * null because PromptLibrary is a modal overlay — a spinner over the
       * chat surface would be more noise than signal.
       */}
      {showLibrary && (
        <Suspense fallback={null}>
          <PromptLibrary
            open={showLibrary}
            onClose={() => { setShowLibrary(false); refreshTemplates(); }}
            onChange={refreshTemplates}
          />
        </Suspense>
      )}
    </>
  );
}
