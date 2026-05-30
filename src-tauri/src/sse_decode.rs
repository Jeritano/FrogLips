//! Incremental UTF-8 decoding for chunked HTTP/SSE streams.
//!
//! `reqwest`'s `bytes_stream()` yields chunks split on arbitrary byte
//! boundaries — a single UTF-8 codepoint (emoji, CJK, accented char) can land
//! with its leading byte at the end of one network chunk and its continuation
//! bytes at the start of the next. Decoding each chunk independently with
//! `String::from_utf8_lossy` turns each half into U+FFFD (`�`), permanently
//! corrupting that character in the streamed reply. (MED, 2026-05-29.)
//!
//! [`Utf8StreamDecoder`] holds back a trailing partial sequence until its
//! continuation bytes arrive, so codepoints survive chunk boundaries intact.

/// Stateful incremental UTF-8 decoder. Feed it raw network chunks via
/// [`push`](Self::push); it returns the decoded text that is safe to emit now
/// and retains any trailing incomplete multibyte sequence internally.
#[derive(Default)]
pub struct Utf8StreamDecoder {
    /// Bytes received but not yet decodable (a partial trailing codepoint).
    /// Bounded to at most 3 bytes in steady state — a valid prefix always
    /// flushes and genuinely-invalid bytes are consumed lossily.
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// Append `bytes` and return the maximal decodable UTF-8 text. A partial
    /// codepoint at the tail is kept for the next call. Genuinely invalid
    /// bytes (not mere truncation) are decoded lossily and consumed so the
    /// stream can never stall.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                // Whole buffer decodes → emit it and reset.
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.pending[..valid]).expect("valid prefix"),
                        );
                    }
                    match e.error_len() {
                        // Truncated trailing sequence: hold the remainder
                        // until its continuation bytes arrive next chunk.
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                        // Genuine garbage mid-stream: emit one replacement
                        // char, skip the bad bytes, keep decoding the rest so
                        // a trailing valid byte isn't stalled a whole chunk.
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codepoint_split_across_chunks_is_not_corrupted() {
        // "é" = 0xC3 0xA9. Split the two bytes across two pushes.
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push(&[0xC3]), ""); // leading byte held back
        assert_eq!(d.push(&[0xA9]), "é"); // completes the codepoint
    }

    #[test]
    fn emoji_split_three_ways() {
        // "🐸" = F0 9F 90 B8 (4 bytes). Drip one byte at a time.
        let bytes = "🐸".as_bytes().to_vec();
        let mut d = Utf8StreamDecoder::default();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.push(&[b]));
        }
        assert_eq!(out, "🐸");
    }

    #[test]
    fn ascii_passes_through_unbuffered() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push(b"hello"), "hello");
        assert_eq!(d.push(b" world"), " world");
    }

    #[test]
    fn mixed_multibyte_in_one_chunk() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push("café 日本".as_bytes()), "café 日本");
    }

    #[test]
    fn invalid_bytes_do_not_stall() {
        let mut d = Utf8StreamDecoder::default();
        // 0xFF is never valid UTF-8 → consumed lossily, stream advances.
        let out = d.push(&[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
        // A subsequent valid push still works.
        assert_eq!(d.push(b"c"), "c");
    }
}
