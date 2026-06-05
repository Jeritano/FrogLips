const EXAMPLE_PROMPTS: { title: string; text: string }[] = [
  { title: "Explain a concept", text: "Explain how async/await works in JavaScript, with a small example." },
  { title: "Summarize the README", text: "Summarize the README in this repo." },
  { title: "Draft something", text: "Draft a concise commit message for a bug fix in the login flow." },
  { title: "Debug an error", text: "Help me debug this error: " },
];

/**
 * Landing shown in the chat surface when a conversation has no messages.
 * Clicking an example chip prefills the composer via the existing
 * `chat-input:prefill` CustomEvent — no auto-send, the user reviews first.
 * The host hides this the moment the conversation has messages or streams.
 */
export function EmptyChatLanding({ modelReady = true }: { modelReady?: boolean }) {
  const prefill = (text: string) => {
    window.dispatchEvent(
      new CustomEvent("chat-input:prefill", { detail: { text } }),
    );
  };

  return (
    <div className="empty-chat-landing" data-testid="empty-chat-landing">
      <div className="empty-chat-heading">Start a conversation</div>
      <div className="empty-chat-sub">
        {modelReady
          ? "Pick a starter prompt or type your own below."
          : "First, pick a model in the top bar and press Start — then chat below."}
      </div>
      <div className="empty-chat-chips">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p.title}
            type="button"
            className="empty-chat-chip"
            data-testid="empty-chat-chip"
            onClick={() => prefill(p.text)}
            title={p.text}
          >
            {p.title}
          </button>
        ))}
      </div>
      <div className="empty-chat-pointer">
        Need file, shell or web access? Turn on <strong>Agent</strong> mode in the toolbar.
      </div>
    </div>
  );
}
