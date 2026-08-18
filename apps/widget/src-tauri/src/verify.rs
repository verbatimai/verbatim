//! Onboarding O2 — API-key verification (one authenticated GET per vendor).
//!
//! Called from the onboarding webview on `Continue`, BEFORE the key is stored: a wrong
//! key must be rejected in-window instead of turning into a mystery banner on the first
//! dictation. See docs/product/onboarding-plan.md §4 and
//! docs/onboarding/implementation-plan.md §2.1 for the frozen contract.
//!
//! Two booleans, and only two, reach the UI:
//!   ok        false ONLY for an authoritative rejection (401/403). This is the only
//!             value that blocks the flow.
//!   reachable false when we could not get an authoritative answer (timeout, DNS,
//!             offline, 429/5xx) — the caller saves the key anyway and says so.
//! A network failure must never look like a bad key.
//!
//! ⚠ The `secret` is a parameter and NOTHING here may log it, `dbg!` it, or fold it into
//! an error string — it only ever reaches the outbound Authorization header. This module
//! also stores nothing: on `ok` the caller invokes the existing `keys::set_key`.

/// The verdict handed back to the webview. Serialize-only — the renderer never sends one.
#[derive(serde::Serialize)]
pub struct VerifyOutcome {
    pub ok: bool,
    pub reachable: bool,
}

/// Couldn't get an authoritative answer ⇒ "saved anyway" (never "rejected").
fn unreachable() -> VerifyOutcome {
    VerifyOutcome {
        ok: true,
        reachable: false,
    }
}

/// One blocking `ureq` GET with a 2s cap. `ureq` is already a dependency (Cargo.toml:44,
/// used by wake.rs::download for the wake-word models), so no new crate is introduced.
fn probe(vendor: &str, secret: &str) -> Result<VerifyOutcome, String> {
    // PyAI: the cheapest authenticated GET is an open item (onboarding-plan.md §9 #1),
    // so we deliberately take the "couldn't reach — saved anyway" path. It blocks
    // nothing and claims nothing. Revisit once the endpoint is known (Mac-verify M12).
    if vendor == "pyai" {
        return Ok(unreachable());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(2))
        .build();

    let req = match vendor {
        "openai" => {
            let auth = format!("Bearer {secret}");
            agent
                .get("https://api.openai.com/v1/models")
                .set("Authorization", &auth)
        }
        "anthropic" => agent
            .get("https://api.anthropic.com/v1/models")
            .set("x-api-key", secret)
            .set("anthropic-version", "2023-06-01"),
        "deepgram" => {
            let auth = format!("Token {secret}");
            agent
                .get("https://api.deepgram.com/v1/auth/token")
                .set("Authorization", &auth)
        }
        // Unknown id: the ONLY Err this command can return. The vendor id is not a secret.
        _ => return Err(format!("unknown vendor: {vendor}")),
    };

    match req.call() {
        // 2xx — ureq 2 returns Err(Error::Status(..)) for anything else.
        Ok(_) => Ok(VerifyOutcome {
            ok: true,
            reachable: true,
        }),
        // The vendor answered, authoritatively, that this key is no good.
        Err(ureq::Error::Status(401 | 403, _)) => Ok(VerifyOutcome {
            ok: false,
            reachable: true,
        }),
        // Every other status (429/5xx) and every transport error (timeout, DNS, TLS,
        // offline). Note the error is dropped, not logged — it can echo request headers.
        Err(_) => Ok(unreachable()),
    }
}

/// `#[tauri::command(async)]` runs a SYNC body on Tauri's worker pool. Without it a plain
/// command body executes on the main thread and this 2s blocking GET would freeze the
/// whole app, overlay included (implementation-plan.md §8 R6 — fallback documented there).
#[tauri::command(async)]
pub fn key_verify(vendor: String, secret: String) -> Result<VerifyOutcome, String> {
    probe(&vendor, &secret)
}
