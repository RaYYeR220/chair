//! Entry point inside OutLayer (`wasm32-wasip2`): request bytes on stdin, one
//! JSON object on stdout. Natively it only explains itself; the logic is
//! tested through the library with a mock HTTP layer.

#[cfg(target_os = "wasi")]
mod wasi_http;

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
        let _ = std::io::stderr().write_all(b"courier: internal error\n");
    }));
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        input.clear();
    }
    let key = std::env::var(chair_courier::API_KEY_ENV).ok();
    let out = chair_courier::run(&input, key.as_deref(), &mut wasi_http::WasiHttp);
    if out.starts_with("{\"error\"") {
        let _ = std::io::stderr().write_all(b"courier: failed, see output\n");
    }
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!(
        "chair-courier runs inside OutLayer: build it with `cargo build --target wasm32-wasip2 --release` (token: {})",
        env!("CHAIR_COURIER_TOKEN")
    );
    std::process::exit(2);
}
