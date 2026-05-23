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
  /** Right-click on the big canvas opens the in-app context menu. */
  onContextMenu?: (image: ImageMeta, x: number, y: number) => void;
}

/**
 * Large-format viewer for a single generated image. Surfaces the prompt and a
 * compact "ℹ" disclosure for the params. The image itself loads via the Tauri
 * asset protocol — never embedded as base64.
 *
 * Note on Seed / Steps / CFG: mistralrs 0.8.1 ignores the user-supplied
 * versions of these (C1 / M1 in the remediation tracker). The Seed row is
 * hidden until C1 lands; Steps and CFG only render when non-default so a
 * future engine update can show real values without code change.
 */
export function ImageDetail({ image, onDeleted, onSendToChat, onContextMenu }: Props) {
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | "send" | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
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

  async function saveImage() {
    setSaveStatus(null);
    setBusy("save");
    try {
      // Lazy-import the dialog plugin so the chunk only loads when this surface
      // is opened.
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
      // Feature-detect the BACK-side `imageSaveTo` IPC. When BACK ships it we
      // get an honest "copy from validated source to validated dest" — until
      // then we fall back to the <a download> path that always lands in
      // Downloads (the dest path the user picked is at least informational).
      // TODO(image-gen-back-ready): drop the fallback branch once
      // `api.imageSaveTo` is stable.
      if ("imageSaveTo" in api) {
        const saveTo = (api as { imageSaveTo: (id: number, dest: string) => Promise<unknown> })
          .imageSaveTo;
        const result = await saveTo(image.id, dest);
        // BACK currently returns the canonical destination path as a string.
        // Treat any truthy string as authoritative; fall back to the original
        // `dest` when the wrapper is older / returns void.
        const written = typeof result === "string" && result.length > 0 ? result : dest;
        setSaveStatus(`Saved to ${written}`);
        return;
      }
      // Legacy fallback. Read the PNG through the asset protocol then trigger
      // an in-webview download. The chosen dest path is reported to the user
      // as info; the file itself always lands in Downloads.
      const url = convertFileSrc(image.path);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`asset fetch failed: ${resp.status}`);
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setSaveStatus(
        `Saved to Downloads/${fileName}. (Backend save-to-path IPC pending; chosen path was ${dest}.)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus(`Save failed: ${msg}`);
      logDiag({
        level: "warn",
        source: "image-detail",
        message: "saveImage failed",
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

  const stepsNum = typeof params.steps === "number" ? params.steps : null;
  const cfgNum = typeof params.cfg === "number" ? params.cfg : null;
  // Show Steps only when it differs from the model default (schnell=4, dev=28).
  // Same for CFG (model-defined default; only render when non-null + non-zero).
  const showSteps =
    stepsNum != null &&
    !((image.model.includes("schnell") && stepsNum === 4) ||
      (image.model.includes("dev") && stepsNum === 28));
  const showCfg = cfgNum != null && cfgNum > 0;

  return (
    <div className="image-detail">
      <div className="image-detail-canvas">
        <img
          src={convertFileSrc(image.path)}
          alt={image.prompt}
          className="image-detail-img"
          draggable={false}
          onContextMenu={(e) => {
            if (!onContextMenu) return;
            // Native "Open image in new window" / "Save image as…" don't
            // work on asset:// URLs; route through in-app menu instead.
            e.preventDefault();
            onContextMenu(image, e.clientX, e.clientY);
          }}
        />
      </div>
      <div className="image-detail-meta">
        <div className="image-detail-prompt">
          <span className="image-detail-label">Prompt</span>
          <p>{image.prompt}</p>
        </div>
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
            onClick={saveImage}
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
          <button
            type="button"
            className="image-info-toggle"
            onClick={() => setParamsOpen((v) => !v)}
            aria-expanded={paramsOpen}
            aria-label="Toggle image details"
            data-testid="image-info-toggle"
            title="Show image details"
          >
            ℹ
          </button>
        </div>
        {paramsOpen && (
          <dl className="image-detail-params" data-testid="image-detail-params">
            <div><dt>Model</dt><dd>{image.model}</dd></div>
            <div><dt>Size</dt><dd>{image.width}×{image.height}</dd></div>
            {/* U8: the Seed row is intentionally hidden — the recorded value
                doesn't correspond to anything the engine consumed (M1). Bring
                it back when C1 lands. */}
            {showSteps && (
              <div><dt>Steps</dt><dd>{stepsNum}</dd></div>
            )}
            {showCfg && (
              <div><dt>CFG</dt><dd>{cfgNum}</dd></div>
            )}
            <div><dt>Created</dt><dd>{new Date(image.created_at * 1000).toLocaleString()}</dd></div>
          </dl>
        )}
        {saveStatus && (
          <div className="image-detail-status" role="status">{saveStatus}</div>
        )}
      </div>
    </div>
  );
}
