//! Writes the OutLayer manifest the module embeds in its `outlayer.manifest`
//! custom section. The manifest is covered by the wasm's sha256, so the caller
//! it admits is fixed per build:
//!
//! - `CHAIR_TOKEN=<account>` at build time: the token contract allowed to run
//!   the module (default `token.thechair.near`);
//! - feature `scratch` (testnet only): no `callers` gate, for direct test runs.
//!
//! The only outbound host is NEAR AI Cloud.

use std::env;
use std::fs;
use std::path::Path;

const DEFAULT_TOKEN: &str = "token.thechair.near";
const NETWORK: &[&str] = &["cloud-api.near.ai"];

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

fn main() {
    println!("cargo:rerun-if-env-changed=CHAIR_TOKEN");
    println!("cargo:rerun-if-changed=build.rs");

    let scratch = env::var_os("CARGO_FEATURE_SCRATCH").is_some();
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

    let network: Vec<String> = NETWORK.iter().map(|h| format!("\"{h}\"")).collect();
    let callers = if scratch {
        String::new()
    } else {
        format!(r#","callers":{{"contract":{{"only":["{token}"]}}}}"#)
    };
    let manifest = format!(
        r#"{{"capabilities":{{"network":[{network}]}}{callers}}}"#,
        network = network.join(","),
        callers = callers,
    );

    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("manifest.json");
    fs::write(&out, manifest).expect("write manifest");
    println!("cargo:rustc-env=CHAIR_COURIER_TOKEN={token}");
}
