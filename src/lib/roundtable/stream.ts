/**
 * Per-turn streaming dispatch. A roundtable seat = a (backend, model) pair;
 * map it to the right plain streaming client. v1 supports the clean-streaming
 * backends: custom (OpenAI-compatible), OpenRouter, and Ollama (local loopback).
 * MLX/native need server-lifecycle management and are deferred.
 *
 * The plain clients yield `{delta, done}` and report no token usage — the
 * engine estimates tokens (cost.ts).
 */

import type { Message, ServerStatus } from "../../types";
import { streamChat } from "../mlx-client";
import { streamCustomChat } from "../custom-client";
import type { Seat } from "./types";

/** Build a minimal ServerStatus for an Ollama seat (fixed loopback daemon). */
function ollamaStatus(model: string): ServerStatus {
  return {
    running: true,
    ready: true,
    model,
    backend: "ollama",
    host: "127.0.0.1",
    port: 11434,
  };
}

export interface TurnStreamOpts {
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
}

/**
 * Stream one seat's turn to completion. Returns the accumulated text.
 * Throws on transport error / abort (the engine catches → skip-and-continue).
 */
export async function streamSeatTurn(seat: Seat, messages: Message[], opts: TurnStreamOpts): Promise<string> {
  const { temperature, maxTokens, signal, onDelta } = opts;
  let stream: AsyncGenerator<{ delta: string; done: boolean }>;

  switch (seat.backend) {
    case "openrouter":
      stream = streamCustomChat("openrouter", messages, {
        model: seat.model,
        temperature,
        maxTokens,
        signal,
      });
      break;
    case "custom":
      // seat.model holds the CustomBackend id; the Rust side resolves
      // base_url + key from the Keychain by that id.
      stream = streamCustomChat(seat.model, messages, { temperature, maxTokens, signal });
      break;
    case "ollama":
      stream = streamChat(ollamaStatus(seat.model), messages, { temperature, maxTokens, signal });
      break;
    default: {
      const _exhaustive: never = seat.backend;
      throw new Error(`unsupported roundtable backend: ${String(_exhaustive)}`);
    }
  }

  let acc = "";
  for await (const chunk of stream) {
    if (chunk.done) break;
    if (chunk.delta) {
      acc += chunk.delta;
      onDelta(chunk.delta);
    }
  }
  return acc;
}
