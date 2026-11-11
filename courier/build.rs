//! Writes the OutLayer manifest the module embeds in its `outlayer.manifest`
//! custom section. The manifest is covered by the wasm's sha256, so the caller
//! it admits and the host it may call are fixed per build:
//!
//! - `CHAIR_TOKEN=<account>` at build time: the token contract allowed to run
//!   the module (default `token.thechair.near`);
//! - `CHAIR_API_BASE=<url>` at build time: where the courier sends its two
//!   calls (default `https://cloud-api.near.ai`, NEAR AI Cloud itself). Any
//!   other base is CHAIR's NEAR AI relay, e.g.
//!   `https://chair-tau-khaki.vercel.app/api/nearai`. The manifest's network
//!   allowlist is exactly that base's host;
//! - feature `scratch` (testnet only): no `callers` gate, for direct test runs.
//!
//! Native builds (the `live` example) may also use `http://localhost` or
//! `http://127.0.0.1`, to run against a relay on this machine; the wasm never can.

use std::env;
use std::fs;
use std::path::Path;

const DEFAULT_TOKEN: &str = "token.thechair.near";
const DEFAULT_API_BASE: &str = "https://cloud-api.near.ai";

fn valid_account(id: &str) -> bool {
    (2..=64).contains(&id.len())
        && id.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
                && !part.starts_with(['-', '_'])
                && !part.ends_with(['-', '_'])
        })
}

/// `https://host[/path]` without query, fragment or trailing slash; returns
/// (base, host). Plain `http` only to localhost, and only off-wasm.
fn parse_base(raw: &str, wasm: bool) -> (String, String) {
    let base = raw.trim().trim_end_matches('/');
    let (https, rest) = match (base.strip_prefix("https://"), base.strip_prefix("http://")) {
        (Some(r), _) => (true, r),
        (None, Some(r)) => (false, r),
        _ => panic!("CHAIR_API_BASE must start with https://"),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && !host.starts_with(['-', '.'])
        && !host.ends_with(['-', '.']);
    if !host_ok {
        panic!("CHAIR_API_BASE: bad host (lowercase letters, digits, '-' and '.')");
    }
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~'))
    {
        panic!("CHAIR_API_BASE: the path may hold only unreserved characters and '/' (no query or fragment)");
    }
    let local = matches!(host, "localhost" | "127.0.0.1");
    if let Some(p) = port {
        if wasm || !local || p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            panic!("CHAIR_API_BASE: a port is allowed only for a localhost relay in a native build");
        }
    }
    if !https && (wasm || !local) {
        panic!("CHAIR_API_BASE: plain http is allowed only for a localhost relay in a native build");
    }
    (base.to_string(), host.to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=CHAIR_TOKEN");
    println!("cargo:rerun-if-env-changed=CHAIR_API_BASE");
    println!("cargo:rerun-if-changed=build.rs");

    let scratch = env::var_os("CARGO_FEATURE_SCRATCH").is_some();
    let wasm = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("wasi");
    let token = env::var("CHAIR_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_TOKEN.to_string());
    if !valid_account(&token) {
        panic!("CHAIR_TOKEN is not a valid NEAR account id");
    }
    if scratch && token.ends_with(".near") {
        panic!("the `scratch` build is testnet-only");
    }
    let raw_base = env::var("CHAIR_API_BASE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string());
    let (base, host) = parse_base(&raw_base, wasm);

    let callers = if scratch {
        String::new()
    } else {
        format!(r#","callers":{{"contract":{{"only":["{token}"]}}}}"#)
    };
    let manifest = format!(r#"{{"capabilities":{{"network":["{host}"]}}{callers}}}"#);

    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("manifest.json");
    fs::write(&out, manifest).expect("write manifest");
    println!("cargo:rustc-env=CHAIR_COURIER_TOKEN={token}");
    println!("cargo:rustc-env=CHAIR_COURIER_API_BASE={base}");
}
