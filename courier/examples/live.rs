//! The courier's own logic, run natively against NEAR AI Cloud instead of
//! inside OutLayer. Same `chair_courier::run`, same requests and retries; only
//! the HTTP layer differs (curl here, WASI HTTP on OutLayer).
//!
//! ```sh
//! NEARAI_API_KEY=sk-... cargo run --example live -- <request file> > courier-output.json
//! ```
//!
//! The request file holds the exact bytes the token sends to OutLayer. stdout is
//! exactly what the module would print, so the token's `on_ruling` can be fed
//! with it (`pnpm courier:live` does all of this). The key goes to curl on
//! stdin, never on its command line.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use chair_courier::{run, Http, Method, Request, Response, API_KEY_ENV};

struct Curl {
    dir: std::path::PathBuf,
    n: u32,
}

impl Http for Curl {
    fn send(&mut self, r: &Request) -> Result<Response, String> {
        self.n += 1;
        let body_path = self.dir.join(format!("body-{}.bin", self.n));
        let out_path = self.dir.join(format!("out-{}.bin", self.n));
        let mut config = String::new();
        for (k, v) in &r.headers {
            config.push_str(&format!("header = \"{}: {}\"\n", k, v.replace('\\', "\\\\").replace('"', "\\\"")));
        }
        // The WASI layer adds the same User-Agent.
        config.push_str("header = \"user-agent: chair-courier/0.1\"\n");
        let mut cmd = Command::new("curl");
        cmd.args(["-sS", "--max-time", "120", "-o"]).arg(&out_path).args(["-w", "%{http_code}", "-K", "-"]);
        if r.method == Method::Post {
            std::fs::write(&body_path, &r.body).map_err(|e| e.to_string())?;
            cmd.arg("--data-binary").arg(format!("@{}", body_path.display()));
        }
        cmd.arg(&r.url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = Instant::now();
        let mut child = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
        child.stdin.take().unwrap().write_all(config.as_bytes()).map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let status: u16 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        let body = std::fs::read(&out_path).unwrap_or_default();
        let _ = std::fs::remove_file(&out_path);
        let _ = std::fs::remove_file(&body_path);
        let path = r.url.split('?').next().unwrap_or("");
        eprintln!("courier-live: {:?} {path} -> {status} ({} bytes, {} ms)", r.method, body.len(), started.elapsed().as_millis());
        if status == 0 {
            return Err(format!("curl failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(Response { status, body })
    }

    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: {API_KEY_ENV}=sk-... cargo run --example live -- <request file>");
        std::process::exit(2);
    };
    let input = std::fs::read(&path).unwrap_or_else(|e| {
        eprintln!("cannot read {path}: {e}");
        std::process::exit(2);
    });
    let dir = std::env::temp_dir().join(format!("chair-courier-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let key = std::env::var(API_KEY_ENV).ok();
    let out = run(&input, key.as_deref(), &mut Curl { dir: dir.clone(), n: 0 });
    let _ = std::fs::remove_dir_all(&dir);
    print!("{out}");
    if out.starts_with("{\"error\"") {
        std::process::exit(1);
    }
}
