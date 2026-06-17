//! Email connector — IMAP (receive) + SMTP (send) over TLS, all pure-Rust rustls.
//!
//! `run` polls IMAP `INBOX` for UNSEEN mail every ~20s, parses each message with
//! `mail_parser`, runs it through the gateway `accept()` gate, then emits it to
//! the agent. `send` relays an SMTP reply back to the originating address with
//! `lettre`. Secrets: `ctx.token` / `token` is the account PASSWORD; the username
//! + host/port config come from `ctx.fields` / `fields`.

use std::sync::Arc;
use std::time::Duration;

use futures::TryStreamExt;
use serde_json::Value;

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{AsyncTransport, Message, Tokio1Executor};

use mail_parser::MessageParser;

use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use super::{accept, chunk, emit, set_error, set_username, GwCtx};

/// SMTP bodies aren't hard-capped like chat platforms; keep parts large.
const MAX_CHARS: usize = 50_000;
/// How long to wait between IMAP polls.
const POLL_SECS: u64 = 20;
/// Backoff after a transient IMAP/connect failure.
const RETRY_SECS: u64 = 8;

fn field_str(fields: &Value, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn field_port(fields: &Value, key: &str, default: u16) -> u16 {
    fields
        .get(key)
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0 && *n <= u64::from(u16::MAX))
        .map(|n| n as u16)
        .or_else(|| {
            // tolerate a numeric port stored as a string
            fields
                .get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| s.trim().parse::<u16>().ok())
        })
        .filter(|p| *p != 0)
        .unwrap_or(default)
}

/// Build a rustls `ClientConfig` trusting the bundled Mozilla webpki roots.
/// Installs the default crypto provider once (idempotent) so building the
/// config never panics for lack of a process-level provider.
fn tls_config() -> Arc<ClientConfig> {
    // Idempotent: returns Err if one is already installed, which we ignore.
    let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider().install_default();
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

/// Open a TLS-wrapped TCP stream to (host, port).
async fn tls_connect(
    host: &str,
    port: u16,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let config = tls_config();
    let connector = TlsConnector::from(config);
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| format!("invalid hostname: {host}"))?;
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect {host}:{port} failed: {e}"))?;
    let _ = tcp.set_nodelay(true);
    connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake to {host} failed: {e}"))
}

/// Log in to IMAP and return an authenticated session. The greeting is read
/// before LOGIN (required by async-imap for a freshly-wrapped stream).
async fn imap_login(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<async_imap::Session<tokio_rustls::client::TlsStream<TcpStream>>, String> {
    let tls = tls_connect(host, port).await?;
    let mut client = async_imap::Client::new(tls);
    // Consume the server greeting.
    let _greeting = client
        .read_response()
        .await
        .ok_or_else(|| "no IMAP greeting".to_string())?
        .map_err(|e| format!("IMAP greeting error: {e}"))?;
    client
        .login(username, password)
        .await
        .map_err(|(e, _client)| format!("IMAP login failed: {e}"))
}

pub async fn validate(token: &str, fields: &Value) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("no password stored".into());
    }
    let host = field_str(fields, "imap_host").ok_or("imap_host not set")?;
    let port = field_port(fields, "imap_port", 993);
    let username = field_str(fields, "username").ok_or("username not set")?;

    let mut session = imap_login(&host, port, &username, token).await?;
    // Verify we can actually open the mailbox before declaring success.
    session
        .select("INBOX")
        .await
        .map_err(|e| format!("select INBOX failed: {e}"))?;
    let _ = session.logout().await;
    Ok(format!("connected ({username})"))
}

pub async fn run(ctx: GwCtx) {
    let host = match field_str(&ctx.fields, "imap_host") {
        Some(h) => h,
        None => {
            set_error("email", Some("imap_host not set".into()));
            // Keep the task alive (aborted externally) rather than exiting.
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
    };
    let port = field_port(&ctx.fields, "imap_port", 993);
    let username = match field_str(&ctx.fields, "username") {
        Some(u) => u,
        None => {
            set_error("email", Some("username not set".into()));
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
    };
    if ctx.token.trim().is_empty() {
        set_error("email", Some("no password stored".into()));
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    }

    set_username("email", Some(username.clone()));
    let username_lc = username.to_lowercase();
    let parser = MessageParser::default();

    loop {
        match poll_once(&ctx, &host, port, &username, &username_lc, &parser).await {
            Ok(()) => {
                set_error("email", None);
                tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
            }
            Err(e) => {
                set_error("email", Some(e));
                tokio::time::sleep(Duration::from_secs(RETRY_SECS)).await;
            }
        }
    }
}

/// One IMAP poll cycle: login, select INBOX, fetch UNSEEN, emit + mark \Seen.
async fn poll_once(
    ctx: &GwCtx,
    host: &str,
    port: u16,
    username: &str,
    username_lc: &str,
    parser: &MessageParser,
) -> Result<(), String> {
    let mut session = imap_login(host, port, username, &ctx.token).await?;
    session
        .select("INBOX")
        .await
        .map_err(|e| format!("select INBOX failed: {e}"))?;

    let unseen = session
        .search("UNSEEN")
        .await
        .map_err(|e| format!("search UNSEEN failed: {e}"))?;
    if unseen.is_empty() {
        let _ = session.logout().await;
        return Ok(());
    }

    // Stable, ascending order so we process oldest first.
    let mut seqs: Vec<u32> = unseen.into_iter().collect();
    seqs.sort_unstable();

    for seq in seqs {
        // Fetch the raw RFC822 body. Collect the stream into owned Fetches inside
        // an inner scope so the mutable borrow on `session` (held by the fetch
        // stream) is fully released before we issue the STORE below.
        let raw: Result<Option<Vec<u8>>, String> = async {
            let stream = session
                .fetch(seq.to_string(), "RFC822")
                .await
                .map_err(|e| format!("fetch {seq} failed: {e}"))?;
            let fetches: Vec<_> = stream
                .try_collect()
                .await
                .map_err(|e| format!("fetch {seq} collect failed: {e}"))?;
            Ok(fetches.iter().find_map(|f| f.body().map(|b| b.to_vec())))
        }
        .await;
        let raw = match raw {
            Ok(v) => v,
            Err(e) => return Err(e),
        };

        let Some(bytes) = raw else {
            // Nothing to parse; still mark it seen so we don't loop on it.
            mark_seen(&mut session, seq).await;
            continue;
        };

        if let Some(parsed) = parser.parse(&bytes[..]) {
            let from_addr = parsed
                .from()
                .and_then(|a| a.first())
                .and_then(|addr| addr.address())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let from_name = parsed
                .from()
                .and_then(|a| a.first())
                .and_then(|addr| addr.name())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| from_addr.clone());

            // Never act on mail the bot sent to itself.
            let is_self = from_addr.eq_ignore_ascii_case(username_lc);

            if !from_addr.is_empty() && !is_self && accept(ctx, &from_addr) {
                let subject = parsed.subject().unwrap_or("(no subject)").trim().to_string();
                let body = parsed
                    .body_text(0)
                    .map(|c| c.into_owned())
                    .unwrap_or_default();
                let body = body.trim();
                let text = format!("Subject: {subject}\n\n{body}");
                // target == reply address so send() routes the answer back.
                emit(ctx, &from_addr, &from_addr, &from_name, &text);
            }
        }

        // Mark processed regardless so a parse failure / blocked sender doesn't
        // make us re-process the same message every cycle.
        mark_seen(&mut session, seq).await;
    }

    let _ = session.logout().await;
    Ok(())
}

/// Best-effort `STORE <seq> +FLAGS (\Seen)`; drains the response stream so the
/// session stays in sync. Errors are swallowed (next poll will retry the flag).
async fn mark_seen<T>(session: &mut async_imap::Session<T>, seq: u32)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    if let Ok(stream) = session.store(seq.to_string(), "+FLAGS (\\Seen)").await {
        let _ = stream.try_collect::<Vec<_>>().await;
    }
}

pub async fn send(token: &str, fields: &Value, target: &str, text: &str) -> Result<(), String> {
    let smtp_host = field_str(fields, "smtp_host").ok_or("smtp_host not set")?;
    let smtp_port = field_port(fields, "smtp_port", 465);
    let username = field_str(fields, "username").ok_or("username not set")?;

    let from: Mailbox = username
        .parse()
        .map_err(|e| format!("bad from address {username}: {e}"))?;
    let to: Mailbox = target
        .parse()
        .map_err(|e| format!("bad recipient {target}: {e}"))?;

    // Email isn't chunked into separate messages — keep one body, but cap the
    // individual pieces so an enormous reply can't blow the line length.
    let body = chunk(text, MAX_CHARS).join("");

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject("Re: Froglips")
        .body(body)
        .map_err(|e| format!("build message failed: {e}"))?;

    let creds = Credentials::new(username.clone(), token.to_string());

    // Port 465 = implicit TLS (SMTPS); anything else (587 etc.) = STARTTLS.
    let builder = if smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp_host)
            .map_err(|e| format!("smtp relay setup failed: {e}"))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
            .map_err(|e| format!("smtp starttls setup failed: {e}"))?
    };
    let mailer: AsyncSmtpTransport<Tokio1Executor> =
        builder.port(smtp_port).credentials(creds).build();

    mailer
        .send(email)
        .await
        .map_err(|e| format!("smtp send failed: {e}"))?;
    Ok(())
}
