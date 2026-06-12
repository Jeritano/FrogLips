import { useCallback, useEffect, useRef, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";

interface QuickToast {
  reply: string;
  error: string | null;
}

interface QuickPromptCompleted {
  op_id: string;
  reply: string;
  model: string | null;
  backend: string | null;
  error: string | null;
}

export interface QuickPromptToast {
  quickToast: QuickToast | null;
  dismissToast: () => void;
}

/**
 * Quick-prompt result toast. The backend fires `quick-prompt-completed` after
 * a menu-bar prompt finishes; this flashes a chip the user can inspect or
 * dismiss, auto-clearing after 8s so it doesn't linger.
 */
export function useQuickPromptToast(): QuickPromptToast {
  const [quickToast, setQuickToast] = useState<QuickToast | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useTauriEvent<QuickPromptCompleted>(
    "quick-prompt-completed",
    useCallback((e) => {
      const payload = e.payload;
      setQuickToast({
        reply: payload.reply ?? "",
        error: payload.error ?? null,
      });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setQuickToast(null), 8000);
    }, []),
  );

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const dismissToast = useCallback(() => setQuickToast(null), []);

  return { quickToast, dismissToast };
}
