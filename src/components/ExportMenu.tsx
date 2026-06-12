import { Download } from "lucide-react";
import {
  conversationToMarkdown,
  downloadText,
  safeFilename,
  type ExportMode,
} from "../lib/export";
import type { Conversation, Message } from "../types";

interface Props {
  conversation: Conversation;
  messages: Message[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  disabled: boolean;
}

/**
 * Export-as-Markdown dropdown. Extracted verbatim from ChatWindow's toolbar —
 * a button plus a `role="menu"` popover with plain / detailed Markdown modes.
 */
export function ExportMenu({
  conversation,
  messages,
  open,
  onToggle,
  onClose,
  disabled,
}: Props) {
  return (
    <div
      className="export-menu-wrap"
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        data-testid="export-btn"
        className="agent-toggle"
        disabled={disabled}
        onClick={onToggle}
        title="Export conversation as Markdown"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={16} /> Export ▾
      </button>
      {open && (
        <div
          role="menu"
          className="export-menu"
          data-testid="export-menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 100,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 4,
            minWidth: 180,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            marginTop: 2,
          }}
          onMouseLeave={onClose}
        >
          {(["plain", "detailed"] as ExportMode[]).map((mode) => (
            <button
              key={mode}
              role="menuitem"
              data-testid={`export-${mode}`}
              className="agent-toggle"
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "transparent",
              }}
              onClick={() => {
                const md = conversationToMarkdown(conversation, messages, mode);
                const suffix = mode === "detailed" ? "detailed" : undefined;
                downloadText(
                  md,
                  safeFilename(conversation.title, "md", suffix),
                );
                onClose();
              }}
            >
              {mode === "plain" ? "Plain Markdown" : "Detailed Markdown"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
