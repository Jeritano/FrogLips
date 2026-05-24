/**
 * Defense-in-depth blocklist for non-chat HuggingFace repos that show up in
 * `list_mlx_models`. The same patterns live in Rust at
 * `src-tauri/src/models.rs::is_non_chat_repo` — that's the authoritative
 * filter; this module is a frontend safety net for cases where the user
 * runs an older binary, the IPC fails open, or a future contract change
 * leaks new repos through. Keep the two lists in sync.
 *
 * Anything matched here is either a diffusion weight set (FLUX) or a
 * standalone encoder repo a diffusion pipeline pulls as a dependency
 * (CLIP, SigLIP, T5 encoder-only / tokenizer-only, standalone VAE). None
 * of these are chat-usable, so they have no business in the chat
 * ModelPicker / workflow CardForm model dropdown.
 */
export function isNonChatRepo(id: string): boolean {
  const s = id.toLowerCase();
  if (s.startsWith("black-forest-labs/")) return true;
  if (s.includes("flux.1") || s.includes("/flux-")) return true;
  if (s.includes("/clip-vit-") || s.includes("/siglip-")) return true;
  if (
    s.includes("t5_tokenizer") ||
    s.includes("t5-v1_1-xxl-enc-only") ||
    s.includes("t5-v1_1-xxl_tokenizer")
  )
    return true;
  if (s.includes("/vae-") || s.endsWith("-vae")) return true;
  return false;
}
