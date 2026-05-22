import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "../lib/tauri-api";

interface CitationConfirm {
  resolved: string;
  line?: number;
}

export interface CitationOpener {
  /** Event-delegated chat-window click handler for `.citation-chip` anchors. */
  onCitationClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** Pending confirmation (resolved absolute path) or null. */
  citationConfirm: CitationConfirm | null;
  /** Dismiss the confirmation modal. */
  dismissConfirm: () => void;
  /** Confirm + open; marks the session trusted so later opens skip the prompt. */
  confirmOpen: () => void;
}

/**
 * File-citation opener. Citation chips carry model-authored, therefore
 * untrusted, `data-path` text — this hook confines the path to the workspace
 * root, refuses traversal/absolute escapes, and requires explicit user confirm
 * of the resolved absolute path before the first open of a session.
 *
 * `onError` surfaces refusals to the host; `onOpened` reports the editor that
 * handled a successful open.
 */
export function useCitationOpener(
  workspaceRoot: string | null,
  onError: (msg: string) => void,
  onOpened: (label: string) => void,
): CitationOpener {
  const [citationConfirm, setCitationConfirm] = useState<CitationConfirm | null>(null);
  // Once the user confirms a citation open in a session we don't re-prompt.
  const citationTrustRef = useRef(false);

  // Perform the actual editor-open IPC call. Only reached with a path that has
  // already passed confinement checks and (first time) user confirm.
  const doOpenCitation = useCallback((resolved: string, line?: number) => {
    api.agentOpenPathInEditor(resolved, line)
      .then((prog) => {
        const label = prog === "code" ? "VS Code"
          : prog === "cursor" ? "Cursor"
          : "default app";
        onOpened(label);
      })
      .catch((err2) => onError(`Open failed: ${err2}`));
  }, [onError, onOpened]);

  const onCitationClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const chip = target.closest(".citation-chip") as HTMLAnchorElement | null;
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const path = (chip.getAttribute("data-path") ?? "").trim();
    const lineRaw = chip.getAttribute("data-line");
    const line = lineRaw ? Number(lineRaw) : undefined;
    if (!path) return;

    // Reject anything that isn't a clearly-relative, non-traversing path.
    // Absolute (`/…`), home-relative (`~/…`), Windows-drive (`C:\…`) and any
    // `..` segment are refused outright.
    const isAbsolute = path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
    const hasTraversal = path.split(/[\\/]/).some((seg) => seg === "..");
    if (isAbsolute || hasTraversal) {
      onError("Refused to open citation: path escapes the workspace.");
      return;
    }

    // A relative path is only safe if we have a workspace root to anchor it.
    if (!workspaceRoot) {
      onError("Set a workspace root before opening file citations.");
      return;
    }
    const sep = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
    const root = workspaceRoot.replace(/[\\/]+$/, "");
    const resolved = `${root}${sep}${path.replace(/^[\\/]+/, "")}`;
    // Guard the join: the resolved path must remain under the root prefix.
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      onError("Refused to open citation: path escapes the workspace.");
      return;
    }

    if (citationTrustRef.current) {
      doOpenCitation(resolved, line);
    } else {
      setCitationConfirm({ resolved, line });
    }
  }, [workspaceRoot, doOpenCitation, onError]);

  const dismissConfirm = useCallback(() => setCitationConfirm(null), []);

  const confirmOpen = useCallback(() => {
    if (!citationConfirm) return;
    citationTrustRef.current = true;
    doOpenCitation(citationConfirm.resolved, citationConfirm.line);
    setCitationConfirm(null);
  }, [citationConfirm, doOpenCitation]);

  return { onCitationClick, citationConfirm, dismissConfirm, confirmOpen };
}
