import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { announce } from "../lib/announce";
import { useTauriEvent } from "../hooks/useTauriEvent";
import type { ImageGenOpts, ImageMeta } from "../types";
import type { UseImageGenerationResult } from "../hooks/useImageGeneration";
import { ImagePromptPanel } from "./image/ImagePromptPanel";
import { ImageGallery } from "./image/ImageGallery";
import { ImageDetail } from "./image/ImageDetail";
import { ImageContextMenu, type ImageContextMenuAction } from "./image/ImageContextMenu";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

interface Props {
  /**
   * Active chat conversation id. New images get tagged with this so the
   * gallery can scope by conv. `null` = global (no chat selected).
   */
  conversationId: number | null;
  /**
   * Called when the user clicks "Send to current chat" on the detail pane.
   * Parent (App) routes the image into the active chat via `api.addMessage`
   * with a populated `images` array.
   */
  onSendToChat: (meta: ImageMeta) => void;
  /**
   * In-flight image-gen state — owned by App so it survives tab navigation.
   * Earlier this view called `useImageGeneration()` itself, so unmounting on
   * tab nav tore down the Tauri listeners and silently dropped the
   * `image-done` payload mid-run.
   */
  running: boolean;
  progress: UseImageGenerationResult["progress"];
  error: string | null;
  generate: UseImageGenerationResult["generate"];
}

/** Three-state gallery scope chip. Stored as a string for stable test selectors. */
type FilterMode = "all" | "this-chat" | "standalone";

/**
 * Generic page-size cap for `imageList`. Until BACK ships paginated metadata
 * (item count + cursor) we fetch up to PAGE_LIMIT rows and show a "Load more"
 * button when the server returns exactly that many — indicating there might
 * be additional rows we haven't fetched.
 *
 * TODO(image-gen-back-ready): swap to the paginated `imageList` shape and
 * surface a real `total` count when the BACK agent ships it.
 */
const PAGE_LIMIT = 200;

/**
 * Top-level Image view. Canvas-left + vertical thumb strip on the right; the
 * prompt composer sits in a sticky bar at the bottom of the surface. Under
 * 1100 px wide the strip collapses into a horizontal scroller below the
 * composer — see images.css. Detail metadata lives behind an "ℹ" disclosure
 * inside the canvas pane (own column eliminated in the 2026-05-23 rework).
 */
export function ImageView({
  conversationId,
  onSendToChat,
  running,
  progress,
  error,
  generate,
}: Props) {
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [selected, setSelected] = useState<ImageMeta | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>(() =>
    conversationId != null ? "this-chat" : "all",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageLimit, setPageLimit] = useState(PAGE_LIMIT);
  const [totalCount, setTotalCount] = useState<number>(0);

  // Whenever the parent's selected conversation changes, switch the default
  // scope back to "This chat" if a real conv is active. The user can still
  // flip the chip manually after that.
  useEffect(() => {
    setFilter(conversationId != null ? "this-chat" : "all");
  }, [conversationId]);

  // What we pass to the IPC depends on the chip. "this-chat" scopes server-
  // side; "all" and "standalone" both fetch the unscoped list and filter
  // client-side for now.
  // TODO(image-gen-back-ready): when BACK ships a "standalone-only" arg,
  // switch the standalone branch over so we don't pull all rows just to
  // discard the chat-tagged ones.
  // `imageList` returns either a paginated `{ rows, total }` page (current
  // BACK contract) or a bare `ImageMeta[]` (legacy/mocked tests). Normalize
  // here so the rest of the component sees a single shape.
  const refresh = useCallback(
    async (selectId?: number) => {
      try {
        const convArg =
          filter === "this-chat" && conversationId != null ? conversationId : null;
        const raw = await api.imageList(convArg, pageLimit);
        let rows: import("../types").ImageMeta[];
        let total: number;
        if (Array.isArray(raw)) {
          rows = raw;
          total = raw.length;
        } else if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) {
          const page = raw as { rows: import("../types").ImageMeta[]; total?: number };
          rows = page.rows;
          total = typeof page.total === "number" ? page.total : page.rows.length;
        } else {
          rows = [];
          total = 0;
        }
        const filtered =
          filter === "standalone" ? rows.filter((i) => i.conv_id == null) : rows;
        setImages(filtered);
        setTotalCount(filter === "standalone" ? filtered.length : total);
        if (selectId != null) {
          const found = filtered.find((i) => i.id === selectId) ?? null;
          if (found) setSelected(found);
        } else if (filtered.length > 0) {
          setSelected((cur) => {
            if (cur && filtered.find((i) => i.id === cur.id)) return cur;
            return filtered[0];
          });
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
    },
    [conversationId, filter, pageLimit],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Global subscription: any `image-done` event refreshes the gallery, so an
  // agent-driven `generate_image` tool call shows up immediately instead of
  // requiring a view swap. `useImageGeneration` already handles the local UI
  // op state; this listener fires for ALL ops (including loop-issued ones
  // that don't run through this hook).
  useTauriEvent<{ op_id?: string; image_id?: number }>(
    "image-done",
    (e) => {
      const id = typeof e.payload?.image_id === "number" ? e.payload.image_id : undefined;
      void refresh(id);
    },
    [refresh],
  );

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

  // In-app right-click menu for image surfaces. WebKit's default
  // context-menu entries fail on `asset://` URLs (Tauri 2 blocks
  // new-window creation; WKWebView doesn't support downloads from
  // custom schemes), so every gallery tile + the big detail canvas
  // route through this menu and Rust IPCs operating on the on-disk
  // path instead.
  const [ctxMenu, setCtxMenu] = useState<{
    image: ImageMeta;
    x: number;
    y: number;
  } | null>(null);

  const openContextMenu = useCallback((image: ImageMeta, x: number, y: number) => {
    setCtxMenu({ image, x, y });
  }, []);

  const closeContextMenu = useCallback(() => setCtxMenu(null), []);

  const ctxActions = useMemo<ImageContextMenuAction[]>(() => {
    if (!ctxMenu) return [];
    const img = ctxMenu.image;
    return [
      {
        id: "open-preview",
        label: "Open in Preview",
        icon: "🖼",
        onClick: () => {
          api.imageOpenExternal(img.id).catch((e) =>
            logDiag({
              level: "warn",
              source: "image-view",
              message: "imageOpenExternal failed",
              detail: e,
            }),
          );
        },
      },
      {
        id: "save-as",
        label: "Save image as…",
        icon: "💾",
        onClick: () => {
          void (async () => {
            try {
              const dest = await saveDialog({
                title: "Save image as",
                defaultPath: `froglips-image-${img.id}.png`,
                filters: [{ name: "PNG", extensions: ["png"] }],
              });
              if (!dest) return;
              await api.imageSaveTo(img.id, dest);
              announce("Saved.");
            } catch (e) {
              logDiag({
                level: "warn",
                source: "image-view",
                message: "save dialog / imageSaveTo failed",
                detail: e,
              });
            }
          })();
        },
      },
      {
        id: "reveal",
        label: "Reveal in Finder",
        icon: "📂",
        onClick: () => {
          api.imageRevealInFinder(img.id).catch((e) =>
            logDiag({
              level: "warn",
              source: "image-view",
              message: "imageRevealInFinder failed",
              detail: e,
            }),
          );
        },
      },
      {
        id: "copy-path",
        label: "Copy file path",
        icon: "📋",
        onClick: () => {
          void navigator.clipboard.writeText(img.path).catch(() => {});
          announce("Path copied to clipboard.");
        },
      },
      {
        id: "send-to-chat",
        label: "Send to current chat",
        icon: "💬",
        onClick: () => onSendToChat(img),
      },
    ];
  }, [ctxMenu, onSendToChat]);

  const maybeLoadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      // TODO(image-gen-back-ready): use the paginated IPC. For now we bump
      // the limit by another PAGE_LIMIT and re-fetch.
      setPageLimit((n) => n + PAGE_LIMIT);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  // BACK now ships `total`; compare it against what we've actually got to
  // decide whether a Load more button should appear. The fallback (no total)
  // is "show when we hit the limit", same as before.
  const hasMore = totalCount > images.length || images.length >= pageLimit;

  const filterButtons = useMemo<Array<{ id: FilterMode; label: string }>>(
    () => [
      { id: "all", label: "All" },
      { id: "this-chat", label: "This chat" },
      { id: "standalone", label: "Standalone" },
    ],
    [],
  );

  return (
    <div className="image-view" data-testid="image-view">
      <section className="image-view-canvas-pane" aria-label="Image canvas">
        <header className="image-view-canvas-header">
          <h2 className="image-view-heading">Image generation</h2>
          <div className="image-filter-chip" role="group" aria-label="Gallery scope">
            {filterButtons.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`image-filter-btn${filter === b.id ? " active" : ""}`}
                onClick={() => setFilter(b.id)}
                aria-pressed={filter === b.id}
                data-testid={`image-filter-${b.id}`}
                disabled={b.id === "this-chat" && conversationId == null}
                title={
                  b.id === "this-chat" && conversationId == null
                    ? "Select a conversation to scope by chat"
                    : undefined
                }
              >
                {b.label}
              </button>
            ))}
          </div>
        </header>
        {listErr && (
          <div className="image-view-error" role="alert">
            Failed to load images: {listErr}
          </div>
        )}
        <div className="image-view-canvas-body">
          {selected ? (
            <ImageDetail
              image={selected}
              onDeleted={onDeleted}
              onSendToChat={onSendToChat}
              onContextMenu={openContextMenu}
            />
          ) : (
            <div className="image-view-detail-empty">
              {images.length === 0
                ? "Type a prompt below — your images will appear here."
                : "Select an image from the strip to see its details."}
            </div>
          )}
        </div>
      </section>

      <aside className="image-view-strip" aria-label="Generated images">
        <ImageGallery
          images={images}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onContextMenu={openContextMenu}
        />
        {hasMore && (
          <button
            type="button"
            className="image-load-more-btn"
            onClick={() => void maybeLoadMore()}
            disabled={loadingMore}
            data-testid="image-load-more-btn"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </aside>

      <section className="image-view-composer" aria-label="Image composer">
        <ImagePromptPanel
          onGenerate={onGenerate}
          running={running}
          progress={progress}
          error={error}
        />
      </section>

      {ctxMenu && (
        <ImageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          actions={ctxActions}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
