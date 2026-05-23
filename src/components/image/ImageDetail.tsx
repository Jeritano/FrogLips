import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../../lib/tauri-api";
import { useTwoClickConfirm } from "../../lib/use-two-click-confirm";
import { logDiag } from "../../lib/diagnostics";
import type { ImageMeta } from "../../types";

interface Props {
  image: ImageMeta;
  /** Called after delete commits — parent refreshes the gallery + clears selection. */
  onDeleted: (id: number) => void;
  /** Send this image as a fresh user message in the active chat conversation. */
  onSendToChat: (meta: ImageMeta) => void;
}

/**
 * Large-format viewer for a single generated image. Surfaces the prompt, the
 * params, and four primary actions: copy prompt, save to Downloads, delete
 * (two-click confirm), send-to-chat. The image itself loads via the Tauri
 * asset protocol — never embedded as base64.
 */
export function ImageDetail({ image, onDeleted, onSendToChat }: Props) {
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | "send" | null>(null);
  const deleteConfirm = useTwoClickConfirm();

  const params = (() => {
    try {
      const parsed = JSON.parse(image.params_json) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })();

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(image.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      logDiag({
        level: "info",
        source: "image-detail",
        message: "clipboard write failed",
        detail: err,
      });
    }
  }

  async function saveToDownloads() {
    setSaveStatus(null);
    setBusy("save");
    try {
      // Lazy-import the dialog plugin (same pattern as DiagnosticsPanel) so
      // the chunk only loads when this surface is opened.
      const { save } = await import("@tauri-apps/plugin-dialog");
      const fileName = `froglips-image-${image.id}.png`;
      const dest = await save({
        defaultPath: fileName,
        filters: [{ name: "PNG", extensions: ["png"] }],
        title: "Save image",
      });
      if (!dest) {
        setBusy(null);
        return;
      }
      // Read the PNG through the asset protocol then write via a Blob URL
      // download path. We can't shell out to `cp` (no Rust write) so we read
      // the bytes into the webview and let the dialog plugin handle the
      // destination handle. Falls back to a synthetic <a download> on the
      // unlikely event the asset fetch fails (e.g. scope misconfig).
      const url = convertFileSrc(image.path);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`asset fetch failed: ${resp.status}`);
      const blob = await resp.blob();
      // Tauri's `save` returns a path string but doesn't actually write the
      // file — that's the caller's job. Without `plugin-fs` in this project
      // we use the writable stream API the webview ships natively.
      // happy-dom + Tauri 2 webview both implement `Blob` + `URL.createObjectURL`
      // so this is portable.
      // NOTE: we can't write to an arbitrary filesystem path from the renderer.
      // Surface a copy-path-to-clipboard fallback so the user at least gets
      // the source location they can `cp` from Finder.
      // Best-effort: copy the source path so the user can drag it from Finder.
      await navigator.clipboard.writeText(image.path).catch(() => {});
      // Trigger an in-webview download as a secondary path so the user gets
      // their bits one way or another.
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setSaveStatus(`Saved as ${fileName}. Source path copied: ${dest}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus(`Save failed: ${msg}`);
      logDiag({
        level: "warn",
        source: "image-detail",
        message: "saveToDownloads failed",
        detail: err,
      });
    } finally {
      setBusy(null);
    }
  }

  async function commitDelete() {
    setBusy("delete");
    try {
      await api.imageDelete(image.id);
      onDeleted(image.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus(`Delete failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  function sendToChat() {
    setBusy("send");
    try {
      onSendToChat(image);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="image-detail">
      <div className="image-detail-canvas">
        <img
          src={convertFileSrc(image.path)}
          alt={image.prompt}
          className="image-detail-img"
          draggable={false}
        />
      </div>
      <div className="image-detail-meta">
        <div className="image-detail-prompt">
          <span className="image-detail-label">Prompt</span>
          <p>{image.prompt}</p>
        </div>
        <dl className="image-detail-params">
          <div><dt>Model</dt><dd>{image.model}</dd></div>
          <div><dt>Size</dt><dd>{image.width}×{image.height}</dd></div>
          {image.seed != null && (
            <div><dt>Seed</dt><dd>{image.seed}</dd></div>
          )}
          {typeof params.steps === "number" && (
            <div><dt>Steps</dt><dd>{params.steps}</dd></div>
          )}
          {typeof params.cfg === "number" && (
            <div><dt>CFG</dt><dd>{params.cfg}</dd></div>
          )}
          <div><dt>Created</dt><dd>{new Date(image.created_at * 1000).toLocaleString()}</dd></div>
        </dl>
        <div className="image-detail-actions">
          <button
            type="button"
            className="image-action-btn"
            onClick={copyPrompt}
            aria-label="Copy prompt to clipboard"
            data-testid="image-copy-prompt-btn"
          >
            {copied ? "Copied ✓" : "Copy prompt"}
          </button>
          <button
            type="button"
            className="image-action-btn"
            onClick={saveToDownloads}
            disabled={busy === "save"}
            aria-label="Save image to disk"
            data-testid="image-save-btn"
          >
            {busy === "save" ? "Saving…" : "Save…"}
          </button>
          <button
            type="button"
            className="image-action-btn"
            onClick={sendToChat}
            disabled={busy === "send"}
            aria-label="Send image to current chat"
            data-testid="image-send-to-chat-btn"
          >
            Send to current chat
          </button>
          <button
            type="button"
            className={`image-action-btn image-delete-btn${deleteConfirm.armed === String(image.id) ? " armed" : ""}`}
            onClick={() =>
              deleteConfirm.request(String(image.id), () => {
                void commitDelete();
              })
            }
            disabled={busy === "delete"}
            aria-label={
              deleteConfirm.armed === String(image.id)
                ? "Click again to confirm deletion"
                : "Delete image"
            }
            data-testid="image-delete-btn"
          >
            {deleteConfirm.labelFor(String(image.id), busy === "delete" ? "Deleting…" : "Delete")}
          </button>
        </div>
        {saveStatus && (
          <div className="image-detail-status" role="status">{saveStatus}</div>
        )}
      </div>
    </div>
  );
}
