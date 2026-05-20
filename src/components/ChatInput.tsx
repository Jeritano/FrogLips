import { useEffect, useRef, useState } from "react";

interface Props {
  disabled?: boolean;
  onSend: (text: string) => void;
  onAbort?: () => void;
  streaming?: boolean;
}

export function ChatInput({ disabled, onSend, onAbort, streaming }: Props) {
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recogRef = useRef<any>(null);
  const baseTextRef = useRef("");
  const lastVoiceTextRef = useRef("");
  const listeningRef = useRef(false);

  // auto-resize textarea on any text change (typing, voice, paste, drop)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  // stop recognition when component unmounts
  useEffect(() => {
    return () => { recogRef.current?.stop?.(); };
  }, []);

  function send() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    if (listening) recogRef.current?.stop?.();
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropping(false);
    const MAX_TOTAL_BYTES = 1_048_576; // 1 MiB combined cap, matches backend MAX_MESSAGE_BYTES
    const files = Array.from(e.dataTransfer.files);
    const enc = new TextEncoder();
    let usedBytes = enc.encode(text).length;
    let added = "";
    for (const f of files) {
      const headerEst = f.name.length + 64;
      if (usedBytes + f.size + headerEst > MAX_TOTAL_BYTES) {
        added += `\n\n--- file: ${f.name} (skipped, would exceed 1 MB combined limit) ---\n`;
        continue;
      }
      try {
        const content = await f.text();
        const chunk = `\n\n--- file: ${f.name} ---\n${content}\n--- end file ---\n`;
        const chunkBytes = enc.encode(chunk).length;
        if (usedBytes + chunkBytes > MAX_TOTAL_BYTES) {
          added += `\n\n--- file: ${f.name} (skipped, would exceed 1 MB combined limit) ---\n`;
          continue;
        }
        added += chunk;
        usedBytes += chunkBytes;
      } catch {
        // binary; skip
      }
    }
    if (added) setText((t) => t + added);
  }

  function onTextChange(v: string) {
    if (listeningRef.current && v !== lastVoiceTextRef.current) {
      // User edited the textarea while dictation is active — rebase voice on top
      // of the manual edit so the next recognition event doesn't clobber it.
      baseTextRef.current = v + (v.endsWith(" ") || v === "" ? "" : " ");
    }
    setText(v);
  }

  function toggleVoice() {
    setVoiceErr(null);
    if (listening) {
      recogRef.current?.stop?.();
      return;
    }
    const Recog =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!Recog) {
      setVoiceErr("Speech recognition unavailable in this build");
      return;
    }
    try {
      const r = new Recog();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || "en-US";
      baseTextRef.current = text ? text + (text.endsWith(" ") ? "" : " ") : "";

      r.onresult = (e: any) => {
        let combined = "";
        for (let i = 0; i < e.results.length; i++) {
          combined += e.results[i][0].transcript;
        }
        const next = baseTextRef.current + combined;
        lastVoiceTextRef.current = next;
        setText(next);
      };
      r.onerror = (e: any) => {
        const code = e?.error || "unknown";
        if (code === "not-allowed" || code === "service-not-allowed") {
          setVoiceErr("Microphone permission denied. Grant access in System Settings → Privacy → Microphone.");
        } else if (code === "no-speech") {
          // silent timeout — not really an error
        } else {
          setVoiceErr(`Voice error: ${code}`);
        }
        listeningRef.current = false;
        setListening(false);
      };
      r.onend = () => {
        listeningRef.current = false;
        setListening(false);
      };

      r.start();
      recogRef.current = r;
      listeningRef.current = true;
      setListening(true);
    } catch (err: any) {
      setVoiceErr(String(err?.message || err));
      listeningRef.current = false;
      setListening(false);
    }
  }

  return (
    <>
      {voiceErr && <div className="voice-err">{voiceErr}</div>}
      <div
        className={`chat-input ${dropping ? "dropping" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <textarea
          ref={taRef}
          data-testid="chat-input"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKey}
          placeholder={listening ? "Listening…" : "Message… (drop files for context)"}
          disabled={disabled}
          rows={1}
        />
        <button
          type="button"
          onClick={toggleVoice}
          className={`mic-btn ${listening ? "listening" : ""}`}
          title={listening ? "Stop dictation" : "Start dictation"}
          aria-label="Voice input"
        >
          {/* simple mic glyph */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
          </svg>
        </button>
        {streaming ? (
          <button data-testid="stop-btn" onClick={onAbort} className="send-btn stop" title="Stop">■</button>
        ) : (
          <button data-testid="send-btn" onClick={send} disabled={disabled || !text.trim()} className="send-btn" title="Send">↑</button>
        )}
      </div>
    </>
  );
}
