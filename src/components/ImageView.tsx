import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { announce } from "../lib/announce";
import type { ImageGenOpts, ImageMeta } from "../types";
import { useImageGeneration } from "../hooks/useImageGeneration";
import { ImagePromptPanel } from "./image/ImagePromptPanel";
import { ImageGallery } from "./image/ImageGallery";
import { ImageDetail } from "./image/ImageDetail";

interface Props {
  /**
   * Active chat conversation id. New images get tagged with this so the
   * gallery can scope by conv when we add that filter later. `null` = global
   * (no chat selected).
   */
  conversationId: number | null;
  /**
   * Called when the user clicks "Send to current chat" on the detail pane.
   * Parent (App) routes the image into the active chat via `api.addMessage`
   * with a populated `images` array. We don't do the routing here because the
   * Image view is a sibling of the chat — it doesn't own the conversation.
   */
  onSendToChat: (meta: ImageMeta) => void;
}

/**
 * Top-level Image view. Three columns at desktop sizes: prompt panel on the
 * left, gallery in the middle, detail pane on the right. Mobile-friendly
 * fallback (one column, gallery scrolls) handled via CSS.
 */
export function ImageView({ conversationId, onSendToChat }: Props) {
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [selected, setSelected] = useState<ImageMeta | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const { running, progress, error, generate, cancel } = useImageGeneration();

  const refresh = useCallback(async (selectId?: number) => {
    try {
      // `null` conv id pulls the cross-conversation list. Once the gallery
      // grows beyond a few hundred rows we'll add pagination + a per-conv
      // toggle; for now the unfiltered view is the right default because
      // images are a creative workspace separate from any single chat.
      const list = await api.imageList(null, 200);
      setImages(list);
      if (selectId != null) {
        const found = list.find((i) => i.id === selectId) ?? null;
        if (found) setSelected(found);
      } else if (list.length > 0) {
        setSelected((cur) => cur ?? list[0]);
      } else {
        setSelected(null);
      }
      setListErr(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setListErr(msg);
      logDiag({
        level: "warn",
        source: "image-view",
        message: "imageList failed",
        detail: err,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onGenerate = useCallback(
    async (args: { prompt: string; model: string; opts: ImageGenOpts }) => {
      try {
        const id = await generate({
          prompt: args.prompt,
          model: args.model,
          opts: args.opts,
          convId: conversationId,
        });
        announce("Image generated");
        await refresh(id);
      } catch (err) {
        // useImageGeneration already routed the message into its `error`
        // state — we just log here so a developer-facing diag exists.
        logDiag({
          level: "info",
          source: "image-view",
          message: "generate rejected",
          detail: err,
        });
      }
    },
    [generate, refresh, conversationId],
  );

  const onDeleted = useCallback(
    (id: number) => {
      announce("Image deleted");
      setImages((prev) => prev.filter((i) => i.id !== id));
      setSelected((cur) => (cur && cur.id === id ? null : cur));
      void refresh();
    },
    [refresh],
  );

  return (
    <div className="image-view" data-testid="image-view">
      <section className="image-view-composer">
        <h2 className="image-view-heading">Image generation</h2>
        <ImagePromptPanel
          onGenerate={onGenerate}
          onCancel={() => void cancel()}
          running={running}
          progress={progress}
          error={error}
        />
      </section>
      <section className="image-view-gallery" aria-label="Generated images">
        {listErr && (
          <div className="image-view-error" role="alert">
            Failed to load images: {listErr}
          </div>
        )}
        <ImageGallery
          images={images}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      </section>
      <section className="image-view-detail" aria-label="Image detail">
        {selected ? (
          <ImageDetail
            image={selected}
            onDeleted={onDeleted}
            onSendToChat={onSendToChat}
          />
        ) : (
          <div className="image-view-detail-empty">
            Select an image to see its details.
          </div>
        )}
      </section>
    </div>
  );
}
