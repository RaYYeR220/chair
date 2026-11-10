//! Entry point inside OutLayer (`wasm32-wasip2`): request bytes on stdin, one
//! JSON object on stdout. Natively it only explains itself; the logic is
//! tested through the library.

/// The manifest, embedded in a custom section covered by the wasm's sha256.
/// `#[used]` keeps the linker from dropping a static nothing references.
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!(concat!(env!("OUT_DIR"), "/manifest.json")).len()] =
    *include_bytes!(concat!(env!("OUT_DIR"), "/manifest.json"));

#[cfg(target_os = "wasi")]
fn main() {
    use std::io::{Read, Write};
    // stderr is public: a panic must not print anything that could carry the key.
    std::panic::set_hook(Box::new(|_| {
        let _ = std::io::stderr().write_all(b"test-signer: internal error\n");
    }));
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        input.clear();
    }
    let key = std::env::var(chair_test_signer::MODEL_KEY_ENV).ok();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = chair_test_signer::run(&input, key.as_deref(), now);
    if out.starts_with("{\"error\"") {
        let _ = std::io::stderr().write_all(b"test-signer: failed, see output\n");
    }
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!(
        "chair-test-signer runs inside OutLayer: build it with `cargo build --target wasm32-wasip2 --release` (token: {})",
        env!("CHAIR_TEST_SIGNER_TOKEN")
    );
    std::process::exit(2);
}
