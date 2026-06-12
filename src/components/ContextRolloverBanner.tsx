import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_CONTINUE_THRESHOLD,
  runContinuation,
  shouldAutoContinue,
} from "../lib/auto-continue";
import { logDiag } from "../lib/diagnostics";
import { announce } from "../lib/announce";
import type { Conversation, Message, ServerStatus } from "../types";

interface Props {
  messages: Message[];
  status: ServerStatus | null;
  conversation: Conversation | null;
  /** Called with the new conversation id after a successful rollover. */
  onContinued: (newConvId: number) => void;
}

/** Seconds to wait before auto-firing the rollover after the banner appears. */
const AUTO_FIRE_DELAY_S = 5;

/**
 * Banner that appears just above the composer when the active conversation
 * is past the auto-continue threshold (~85% of the model's context window).
 *
 * Behaviour:
 *  - Counts down `AUTO_FIRE_DELAY_S` seconds and fires the rollover.
 *  - "Continue now" fires immediately.
 *  - "Not yet" dismisses for the current conversation until the next time
 *    it crosses the threshold from below.
 *
 * The rollover summarizes the prior history via the active backend, creates
 * a fresh conversation seeded with that summary, then calls `onContinued`
 * so the App can switch to the new thread.
 */
export function ContextRolloverBanner({
  messages,
  status,
  conversation,
  onContinued,
}: Props) {
  const due = useMemo(
    () => shouldAutoContinue(messages, status?.model ?? null, status),
    [messages, status],
  );

  const [rolling, setRolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(AUTO_FIRE_DELAY_S);

  // Per-conversation dismissal: a user "Not yet" suppresses the banner until
  // the conversation grows further (we re-arm when usage drops below the
  // threshold and then crosses it again, but the simplest signal is the
  // conversation id changing).
  // Dismissal must be STATE, not a ref: it's read in the render-time `visible`
  // expression, and a ref mutation doesn't re-render — "Not yet" would only
  // take effect on the next unrelated render (the countdown tick), leaving the
  // banner briefly stuck. State makes the dismiss immediate.
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  useEffect(() => {
    // Re-arm whenever the active conversation changes.
    setDismissedId(null);
    setErr(null);
    setRolling(false);
  }, [conversation?.id]);

  // Don't offer to roll over if the backend isn't actually serving a model.
  // The summary call needs a live model to talk to; without one we'd just
  // pop "auto-continue: no active model" the moment the countdown fired.
  const backendReady = !!status?.running && !!status.model;

  const visible =
    due &&
    !rolling &&
    backendReady &&
    conversation != null &&
    dismissedId !== conversation.id;

  // Countdown — armed only while the banner is visible. Resets each time the
  // banner re-appears.
  useEffect(() => {
    if (!visible) {
      setCountdown(AUTO_FIRE_DELAY_S);
      return;
    }
    setCountdown(AUTO_FIRE_DELAY_S);
    const id = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [visible]);

  // Fire when countdown lands at 0. Using a separate effect keeps the timer
  // independent of the fire path so a state update doesn't restart the clock.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!visible || countdown !== 0 || !status || !conversation) return;
    fire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, visible]);

  function fire() {
    if (!status || !conversation || rolling) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRolling(true);
    setErr(null);
    announce("Summarizing this conversation and continuing in a new chat…");
    runContinuation(conversation, messages, status, ctrl.signal)
      .then((newId) => {
        announce(
          "Continued in a new chat. Older history is kept in the previous thread.",
        );
        onContinued(newId);
      })
      .catch((e) => {
        logDiag({
          level: "warn",
          source: "auto-continue",
          message: "rollover failed",
          detail: e,
        });
        setErr(`Could not summarize and continue: ${e}`);
      })
      .finally(() => {
        setRolling(false);
        abortRef.current = null;
      });
  }

  function cancel() {
    abortRef.current?.abort();
    setRolling(false);
    if (conversation) setDismissedId(conversation.id);
    setErr(null);
  }

  if (!visible && !rolling && !err) return null;

  return (
    <div className="ctx-rollover" role="status" aria-live="polite">
      {rolling ? (
        <span className="ctx-rollover-msg">
          Summarizing & continuing in a new chat…
        </span>
      ) : err ? (
        <>
          <span className="ctx-rollover-msg">⚠ {err}</span>
          <button
            type="button"
            className="ctx-rollover-btn"
            onClick={() => setErr(null)}
          >
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span className="ctx-rollover-msg">
            Conversation is {Math.round(AUTO_CONTINUE_THRESHOLD * 100)}%+ full —
            auto-continuing in {countdown}s.
          </span>
          <div className="ctx-rollover-actions">
            <button
              type="button"
              className="ctx-rollover-btn ctx-rollover-btn-primary"
              onClick={fire}
            >
              Continue now
            </button>
            <button type="button" className="ctx-rollover-btn" onClick={cancel}>
              Not yet
            </button>
          </div>
        </>
      )}
    </div>
  );
}
