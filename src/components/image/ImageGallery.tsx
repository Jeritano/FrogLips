import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageMeta } from "../../types";
import { EmptyState } from "../EmptyState";

interface Props {
  images: ImageMeta[];
  selectedId: number | null;
  onSelect: (image: ImageMeta) => void;
}

/**
 * Grid of saved generated images. Thumbnails are rendered via Tauri's asset
 * protocol (`convertFileSrc`) so the webview can fetch the PNG straight off
 * disk without round-tripping bytes through IPC. Each tile is a real
 * `<button>` for keyboard accessibility.
 */
export function ImageGallery({ images, selectedId, onSelect }: Props) {
  if (images.length === 0) {
    return (
      <div className="image-gallery-empty">
        <EmptyState
          icon="🎨"
          heading="No images yet"
          sub="Type a prompt and hit Generate — your images will appear here."
        />
      </div>
    );
  }
  return (
    <ul className="image-gallery-grid" data-testid="image-gallery">
      {images.map((img) => {
        const active = img.id === selectedId;
        return (
          <li key={img.id}>
            <button
              type="button"
              className={`image-gallery-tile${active ? " active" : ""}`}
              onClick={() => onSelect(img)}
              aria-label={`Open image: ${img.prompt.slice(0, 80)}`}
              aria-pressed={active}
              data-testid="image-gallery-tile"
            >
              <img
                src={convertFileSrc(img.path)}
                alt={img.prompt.slice(0, 120)}
                loading="lazy"
                draggable={false}
              />
              <span className="image-gallery-caption">{img.prompt}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
