//! Scraper for <https://ollama.com/library>.
//!
//! Ollama's REST API doesn't expose the public library catalogue (only your
//! local `/api/tags`), so we scrape the HTML listing page. The page uses
//! Alpine.js `x-test-*` attributes as stable test hooks, which we target as
//! CSS selectors via the `scraper` crate.
//!
//! SSRF defense: we route the request through the same `is_safe_public_host`
//! and `resolve_to_safe_addrs` helpers that guard `agent::web::web_fetch`;
//! ollama.com resolves to a public IP, so those checks pass on every call.
//!
//! Caching: results are kept in-memory for 10 minutes. The library page
//! changes a few times a week at most, so a short TTL is plenty and keeps us
//! off Cloudflare's bad list if a user spam-opens the model browser.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;
use std::time::{Duration, Instant};

use crate::agent::web::{is_safe_public_host, resolve_to_safe_addrs};

/// Single row in the scraped library catalogue.
///
/// Field order mirrors what the card UI consumes top-to-bottom: name, body
/// text, capability/size chips, then the metadata footer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct OllamaLibraryEntry {
    /// Model slug, e.g. `nemotron3`. This is what gets fed to `ollama pull`.
    pub name: String,
    /// Long-form description paragraph. Capped at 500 chars to keep the IPC
    /// payload bounded.
    pub description: String,
    /// Lower-case capability tags: `vision`, `tools`, `thinking`, `audio`,
    /// `cloud`, `embedding`.
    pub capabilities: Vec<String>,
    /// Parameter-size variants offered, e.g. `7b`, `33b`, `670b`.
    pub sizes: Vec<String>,
    /// Total pulls. `"587.4K Pulls"` → `587_400`. `"1.2M Pulls"` → `1_200_000`.
    pub pulls: u64,
    /// Tag count (different model versions/quants on the model page).
    pub tag_count: u32,
    /// Raw relative-time string from the page, e.g. `"3 weeks ago"`. We keep
    /// it verbatim instead of parsing — the page already does the rendering
    /// work and the frontend doesn't need a real timestamp.
    pub updated_relative: String,
}

const LIBRARY_URL: &str = "https://ollama.com/library";
/// Cloud model catalogue. Ollama's newest cloud-hosted models live on a
/// separate search page, not the main `/library` listing.
const CLOUD_URL: &str = "https://ollama.com/search?c=cloud";
/// Hard cap on entries returned to the frontend. The page typically lists
/// 30-100 models — 200 is a generous upper bound that still keeps the IPC
/// payload small.
const MAX_ENTRIES: usize = 200;
/// Max chars of description text to keep per entry.
const DESC_CAP: usize = 500;
/// In-memory cache TTL.
const CACHE_TTL: Duration = Duration::from_secs(600);
/// User-Agent string — Ollama's CDN gates abusive bots by UA.
const USER_AGENT: &str = "Froglips/0.10 (+https://github.com/Jeritano/FrogLips)";

/// Cache entry: (fetched_at, parsed entries). Stored behind a Mutex so
/// concurrent ModelBrowser opens don't race on the network fetch.
type CacheCell = Option<(Instant, Vec<OllamaLibraryEntry>)>;

static CACHE: Lazy<Mutex<CacheCell>> = Lazy::new(|| Mutex::new(None));

/// Card-field selectors, compiled once per process (perf: low). These are
/// static and identical across every card, so recompiling them per call to
/// `parse_card` was wasted parser work — ~7 compiles for each of the 30-100
/// cards on each of the two pages, per fetch. `expect` is safe: these are
/// hard-coded literals that always compile.
static NAME_SEL: Lazy<Selector> = Lazy::new(|| Selector::parse("h2").expect("h2 selector"));
static DESC_SEL: Lazy<Selector> = Lazy::new(|| Selector::parse("p").expect("p selector"));
static CAP_SEL: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span[x-test-capability]").expect("capability selector"));
static SIZE_SEL: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span[x-test-size]").expect("size selector"));
static PULL_SEL: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span[x-test-pull-count]").expect("pull-count selector"));
static TAGC_SEL: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span[x-test-tag-count]").expect("tag-count selector"));
static UPD_SEL: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span[x-test-updated]").expect("updated selector"));

/// Fetch + parse the public library and cloud catalogues. Cached for 10 min
/// per-process.
///
/// Fetches both `/library` and the cloud search page, merging the results.
/// If one page fails we still return the other; only when both fail (or yield
/// zero entries) do we return `Err` so the frontend can fall back to its
/// curated list. Never panics on malformed HTML — a parser miss just yields
/// an empty Vec.
pub async fn fetch() -> Result<Vec<OllamaLibraryEntry>, String> {
    // Cache hit path — copy out and drop the lock before any awaits.
    if let Some(cached) = {
        let guard = CACHE.lock();
        guard.as_ref().and_then(|(when, list)| {
            if when.elapsed() < CACHE_TTL {
                Some(list.clone())
            } else {
                None
            }
        })
    } {
        return Ok(cached);
    }

    // Fetch both pages. Either may fail independently; we only give up if
    // both yield nothing.
    let library = match fetch_html(LIBRARY_URL).await {
        Ok(html) => parse_library(&html),
        Err(_) => Vec::new(),
    };
    let cloud = match fetch_html(CLOUD_URL).await {
        Ok(html) => parse_library(&html),
        Err(_) => Vec::new(),
    };

    let merged = merge_catalogues(cloud, library);
    if merged.is_empty() {
        return Err("ollama.com returned no parseable entries".into());
    }
    let capped: Vec<OllamaLibraryEntry> = merged.into_iter().take(MAX_ENTRIES).collect();
    *CACHE.lock() = Some((Instant::now(), capped.clone()));
    Ok(capped)
}

/// Merge cloud-page and library-page entries into one de-duplicated list.
///
/// Cloud entries are force-tagged `cloud` (so the Cloud filter works even if
/// the page markup omits the capability chip) and placed first. De-dup is by
/// model `name`: a model on both pages keeps one entry with the union of its
/// capability tags.
fn merge_catalogues(
    cloud: Vec<OllamaLibraryEntry>,
    library: Vec<OllamaLibraryEntry>,
) -> Vec<OllamaLibraryEntry> {
    let mut out: Vec<OllamaLibraryEntry> = Vec::with_capacity(cloud.len() + library.len());

    for mut entry in cloud {
        if !entry.capabilities.iter().any(|c| c == "cloud") {
            entry.capabilities.push("cloud".to_string());
        }
        out.push(entry);
    }

    for entry in library {
        if let Some(existing) = out.iter_mut().find(|e| e.name == entry.name) {
            for cap in entry.capabilities {
                if !existing.capabilities.contains(&cap) {
                    existing.capabilities.push(cap);
                }
            }
        } else {
            out.push(entry);
        }
    }

    out
}

/// Network fetch with the same SSRF guards as `agent::web::web_fetch`.
async fn fetch_html(target: &str) -> Result<String, String> {
    let url = url::Url::parse(target).map_err(|e| format!("bad ollama url: {e}"))?;
    let host = url.host_str().unwrap_or("").to_string();
    if !is_safe_public_host(&host) {
        return Err(format!("host '{host}' rejected by SSRF guard"));
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let safe_addrs = resolve_to_safe_addrs(&host, port).await?;

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        // No redirects: the SSRF guard above (resolve_to_safe_addrs + the
        // resolve_to_addrs pinning on the client below) only protect the
        // INITIAL request. A 30x to a different host would bypass both —
        // reqwest by default resolves the redirect target via the system
        // resolver, ignoring our pinned addresses. ollama.com/library and
        // /search?c=cloud don't redirect, so denying redirects outright is
        // strictly tighter than the previous `limited(3)`.
        .redirect(reqwest::redirect::Policy::none());
    for a in &safe_addrs {
        builder = builder.resolve_to_addrs(&host, &[*a]);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ollama.com fetch failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("ollama.com returned HTTP {}", status.as_u16()));
    }
    // 2 MiB is plenty — the library HTML is ~300 KiB. Cap defends against a
    // misbehaving CDN handing us a runaway response.
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(format!(
            "ollama.com response too large: {} bytes",
            bytes.len()
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Parse the library HTML. Returns an empty Vec on selector failure rather
/// than panicking — the caller treats empty as "fallback to curated list".
pub fn parse_library(html: &str) -> Vec<OllamaLibraryEntry> {
    let doc = Html::parse_document(html);

    // The page wraps each model in `<li x-test-model>`. If Ollama drops that
    // hook we fall through to a broader `ul > li` scan via h2 presence — but
    // the primary path is x-test-model because it's been stable for 18+ months.
    let primary = Selector::parse("li[x-test-model]").ok();
    let fallback = Selector::parse("ul li").ok();

    let cards: Vec<ElementRef<'_>> = match primary {
        Some(sel) => {
            let v: Vec<_> = doc.select(&sel).collect();
            if !v.is_empty() {
                v
            } else if let Some(fb) = fallback {
                doc.select(&fb)
                    .filter(|el| el.select(&NAME_SEL).next().is_some())
                    .collect()
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    };

    let mut out = Vec::with_capacity(cards.len());
    for card in cards {
        if let Some(e) = parse_card(card) {
            out.push(e);
        }
    }
    out
}

fn parse_card(card: ElementRef<'_>) -> Option<OllamaLibraryEntry> {
    // Selectors are compiled once at module scope (see *_SEL statics) rather
    // than per card — they're static and identical for every card.
    let name = card
        .select(&NAME_SEL)
        .next()
        .map(|el| collect_text(el))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;

    // First <p> in the card. Ollama's cards put the description first; any
    // secondary <p> (e.g. release-note callouts on featured models) gets
    // ignored.
    let description = card
        .select(&DESC_SEL)
        .next()
        .map(|el| collect_text(el))
        .map(|s| trim_to(&s, DESC_CAP))
        .unwrap_or_default();

    let capabilities: Vec<String> = card
        .select(&CAP_SEL)
        .map(|el| collect_text(el).to_ascii_lowercase())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let sizes: Vec<String> = card
        .select(&SIZE_SEL)
        .map(|el| collect_text(el).to_ascii_lowercase())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let pulls = card
        .select(&PULL_SEL)
        .next()
        .map(|el| collect_text(el))
        .map(|s| parse_pulls(&s))
        .unwrap_or(0);

    let tag_count = card
        .select(&TAGC_SEL)
        .next()
        .map(|el| collect_text(el))
        .map(|s| parse_first_u32(&s))
        .unwrap_or(0);

    let updated_relative = card
        .select(&UPD_SEL)
        .next()
        .map(|el| collect_text(el))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    Some(OllamaLibraryEntry {
        name,
        description,
        capabilities,
        sizes,
        pulls,
        tag_count,
        updated_relative,
    })
}

/// Recursively pull text content, collapsing whitespace.
fn collect_text(el: ElementRef<'_>) -> String {
    let raw: String = el.text().collect::<Vec<_>>().concat();
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

fn trim_to(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Parse strings like `"587.4K Pulls"`, `"1.2M Pulls"`, `"42K"`, `"832"`
/// into a raw count.
pub fn parse_pulls(s: &str) -> u64 {
    let t = s.trim();
    // Pull the first numeric token (digits + optional . + optional suffix).
    let mut chars = t.chars().peekable();
    let mut num = String::new();
    let mut suffix = '\0';
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() || c == '.' || c == ',' {
            num.push(c);
            chars.next();
        } else {
            break;
        }
    }
    // Allow whitespace between number and suffix ("1.2 M").
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
    if let Some(&c) = chars.peek() {
        if c.is_ascii_alphabetic() {
            suffix = c.to_ascii_uppercase();
        }
    }
    let num_clean: String = num.chars().filter(|&c| c != ',').collect();
    let base: f64 = num_clean.parse().unwrap_or(0.0);
    let multiplier: f64 = match suffix {
        'K' => 1_000.0,
        'M' => 1_000_000.0,
        'B' => 1_000_000_000.0,
        _ => 1.0,
    };
    (base * multiplier).round() as u64
}

/// Extract the first integer from a string like `"4 Tags"` → `4`.
fn parse_first_u32(s: &str) -> u32 {
    let mut digits = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic two-card fixture mimicking the structure of ollama.com/library.
    /// Field positions + x-test-* hooks match the live page; content is
    /// abbreviated but representative.
    const FIXTURE: &str = r##"
<!doctype html><html><body>
<ul role="list">
  <li x-test-model>
    <a href="/library/nemotron3">
      <h2 x-test-search-response-title>nemotron3</h2>
      <p>NVIDIA Nemotron 3 Nano Omni is a multimodal large language model
      that unifies video, audio, image, and text understanding in a single
      compact 9B-parameter architecture.</p>
      <div>
        <span x-test-capability>vision</span>
        <span x-test-capability>tools</span>
        <span x-test-capability>thinking</span>
        <span x-test-size>9b</span>
        <span x-test-size>33b</span>
      </div>
      <p class="meta">
        <span x-test-pull-count>587.4K</span> Pulls
        <span x-test-tag-count>4</span> Tags
        <span x-test-updated>3 weeks ago</span>
      </p>
    </a>
  </li>
  <li x-test-model>
    <a href="/library/llama4">
      <h2 x-test-search-response-title>llama4</h2>
      <p>Meta's flagship open model, frontier-class quality with multimodal
      input and a tool-use head.</p>
      <div>
        <span x-test-capability>vision</span>
        <span x-test-capability>tools</span>
        <span x-test-size>70b</span>
        <span x-test-size>405b</span>
      </div>
      <p class="meta">
        <span x-test-pull-count>1.2M</span> Pulls
        <span x-test-tag-count>12</span> Tags
        <span x-test-updated>5 days ago</span>
      </p>
    </a>
  </li>
  <li x-test-model>
    <a href="/library/nomic-embed-text">
      <h2 x-test-search-response-title>nomic-embed-text</h2>
      <p>High-quality open embedding model from Nomic AI.</p>
      <div>
        <span x-test-capability>embedding</span>
        <span x-test-size>137m</span>
      </div>
      <p class="meta">
        <span x-test-pull-count>4,820</span> Pulls
        <span x-test-tag-count>3</span> Tags
        <span x-test-updated>2 months ago</span>
      </p>
    </a>
  </li>
</ul>
</body></html>
"##;

    #[test]
    fn parses_three_cards_with_full_fields() {
        let entries = parse_library(FIXTURE);
        assert_eq!(entries.len(), 3, "expected 3 cards, got {:?}", entries);

        let nem = &entries[0];
        assert_eq!(nem.name, "nemotron3");
        assert!(
            nem.description.starts_with("NVIDIA Nemotron 3"),
            "description should start with NVIDIA Nemotron 3, got: {:?}",
            nem.description
        );
        assert_eq!(
            nem.capabilities,
            vec!["vision", "tools", "thinking"],
            "capabilities should preserve order from HTML"
        );
        assert_eq!(nem.sizes, vec!["9b", "33b"]);
        assert_eq!(nem.pulls, 587_400, "587.4K → 587,400");
        assert_eq!(nem.tag_count, 4);
        assert_eq!(nem.updated_relative, "3 weeks ago");

        let lla = &entries[1];
        assert_eq!(lla.name, "llama4");
        assert_eq!(lla.pulls, 1_200_000, "1.2M → 1,200,000");
        assert_eq!(lla.capabilities, vec!["vision", "tools"]);
        assert_eq!(lla.sizes, vec!["70b", "405b"]);

        let nom = &entries[2];
        assert_eq!(nom.name, "nomic-embed-text");
        assert_eq!(nom.capabilities, vec!["embedding"]);
        assert_eq!(nom.pulls, 4_820, "comma-separated raw count parses cleanly");
    }

    #[test]
    fn pull_count_parser_handles_k_m_and_raw() {
        assert_eq!(parse_pulls("587.4K Pulls"), 587_400);
        assert_eq!(parse_pulls("1.2M Pulls"), 1_200_000);
        assert_eq!(parse_pulls("832"), 832);
        assert_eq!(parse_pulls("4,820 Pulls"), 4_820);
        assert_eq!(parse_pulls("3B"), 3_000_000_000);
        assert_eq!(parse_pulls("0"), 0);
        // Whitespace between number and unit.
        assert_eq!(parse_pulls("1.5 K"), 1_500);
        // Garbage in → 0, not a panic.
        assert_eq!(parse_pulls("not a number"), 0);
        assert_eq!(parse_pulls(""), 0);
    }

    #[test]
    fn malformed_html_returns_empty_vec_not_panic() {
        // Pages that don't match any model-card selector produce an empty Vec.
        assert!(parse_library("<html><body><p>no cards here</p></body></html>").is_empty());
        assert!(parse_library("not html at all <<<>>>").is_empty());
        assert!(parse_library("").is_empty());
        // Cards that match the selector but lack a name (the only required
        // field) should be dropped — never panic.
        assert!(parse_library("<li x-test-model><p>no h2 here</p></li>").is_empty());
        // A truncated card with just a name string is resilient: html5ever
        // auto-closes it, the parser yields a single skeletal entry rather
        // than panicking. Important guarantee: the call returns at all.
        let _ = parse_library("<li x-test-model><h2>broken");
    }

    #[test]
    fn description_is_truncated_at_cap() {
        let long = "a".repeat(DESC_CAP + 50);
        let html = format!(r#"<li x-test-model><h2>foo</h2><p>{}</p></li>"#, long);
        let entries = parse_library(&html);
        assert_eq!(entries.len(), 1);
        let desc = &entries[0].description;
        // +1 for the ellipsis char appended by trim_to.
        assert_eq!(desc.chars().count(), DESC_CAP + 1);
        assert!(desc.ends_with('…'));
    }

    #[test]
    fn first_u32_parser_extracts_leading_integer() {
        assert_eq!(parse_first_u32("4 Tags"), 4);
        assert_eq!(parse_first_u32("  12  "), 12);
        assert_eq!(parse_first_u32("v3 release"), 3);
        assert_eq!(parse_first_u32("none"), 0);
    }

    /// Cloud search page fixture. Same `x-test-*` card markup as `/library`.
    /// One model (`llama4`) overlaps with FIXTURE to exercise de-dup.
    const CLOUD_FIXTURE: &str = r##"
<!doctype html><html><head><title>Cloud models · Ollama</title></head><body>
<ul role="list">
  <li x-test-model>
    <a href="/library/deepseek-v4-pro">
      <h2 x-test-search-response-title>deepseek-v4-pro</h2>
      <p>DeepSeek V4 Pro is a frontier reasoning model served from Ollama's
      cloud with a 256K context window.</p>
      <div>
        <span x-test-capability>thinking</span>
        <span x-test-capability>tools</span>
        <span x-test-size>670b</span>
      </div>
      <p class="meta">
        <span x-test-pull-count>92.1K</span> Pulls
        <span x-test-tag-count>2</span> Tags
        <span x-test-updated>4 days ago</span>
      </p>
    </a>
  </li>
  <li x-test-model>
    <a href="/library/llama4">
      <h2 x-test-search-response-title>llama4</h2>
      <p>Meta's flagship open model, also available cloud-hosted.</p>
      <div>
        <span x-test-capability>cloud</span>
        <span x-test-size>405b</span>
      </div>
      <p class="meta">
        <span x-test-pull-count>1.2M</span> Pulls
        <span x-test-tag-count>12</span> Tags
        <span x-test-updated>5 days ago</span>
      </p>
    </a>
  </li>
</ul>
</body></html>
"##;

    #[test]
    fn parses_cloud_page_with_same_selectors() {
        let entries = parse_library(CLOUD_FIXTURE);
        assert_eq!(
            entries.len(),
            2,
            "expected 2 cloud cards, got {:?}",
            entries
        );
        assert_eq!(entries[0].name, "deepseek-v4-pro");
        assert_eq!(entries[0].capabilities, vec!["thinking", "tools"]);
    }

    #[test]
    fn merge_force_tags_cloud_and_unions_overlap() {
        let cloud = parse_library(CLOUD_FIXTURE);
        let library = parse_library(FIXTURE);
        let merged = merge_catalogues(cloud, library);

        // 2 cloud + 3 library, with llama4 overlapping → 4 unique entries.
        assert_eq!(merged.len(), 4, "llama4 should de-dup, got {:?}", merged);

        // Cloud entries come first and every one is tagged `cloud`.
        let deepseek = &merged[0];
        assert_eq!(deepseek.name, "deepseek-v4-pro");
        assert!(
            deepseek.capabilities.contains(&"cloud".to_string()),
            "cloud entry force-tagged cloud: {:?}",
            deepseek.capabilities
        );

        // llama4 appears once, with the union of cloud + library tags.
        let llama: Vec<_> = merged.iter().filter(|e| e.name == "llama4").collect();
        assert_eq!(llama.len(), 1, "llama4 must be de-duplicated");
        let caps = &llama[0].capabilities;
        assert!(caps.contains(&"cloud".to_string()), "keeps cloud tag");
        assert!(
            caps.contains(&"vision".to_string()),
            "unions library vision"
        );
        assert!(caps.contains(&"tools".to_string()), "unions library tools");
    }

    #[test]
    fn merge_one_page_empty_still_returns_other() {
        // Cloud fetch failed → empty; library still returns its entries.
        let only_library = merge_catalogues(Vec::new(), parse_library(FIXTURE));
        assert_eq!(only_library.len(), 3);

        // Library fetch failed → empty; cloud still returns, force-tagged.
        let only_cloud = merge_catalogues(parse_library(CLOUD_FIXTURE), Vec::new());
        assert_eq!(only_cloud.len(), 2);
        assert!(only_cloud
            .iter()
            .all(|e| e.capabilities.contains(&"cloud".to_string())));

        // Both empty → empty (fetch() promotes this to Err).
        assert!(merge_catalogues(Vec::new(), Vec::new()).is_empty());
    }
}
