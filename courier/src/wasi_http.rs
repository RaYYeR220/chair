//! WASI HTTP (`wasi:http/outgoing-handler`) for the courier, after
//! Blindbook's `matcher/src/wasi_host.rs`: one request at a time, body streamed
//! in after the request is handed over, bounded response read.

use chair_courier::{Http, Method as M, Request, Response};
use wasi::http::outgoing_handler;
use wasi::http::types::{ErrorCode, Fields, IncomingBody, IncomingResponse, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
use wasi::io::streams::{OutputStream, StreamError};

const MS: u64 = 1_000_000;
const CONNECT_TIMEOUT_NS: u64 = 10_000 * MS;
/// A chat completion can take a while before its first byte; OutLayer's yield
/// window is ~120 s in total.
const FIRST_BYTE_TIMEOUT_NS: u64 = 90_000 * MS;
const BETWEEN_BYTES_TIMEOUT_NS: u64 = 30_000 * MS;
/// Largest response body read.
const MAX_BODY: usize = 4 << 20;

pub struct WasiHttp;

impl Http for WasiHttp {
    fn send(&mut self, req: &Request) -> Result<Response, String> {
        let future = start(req)?;
        future.subscribe().block();
        let r = future.get().ok_or("no response")?;
        read(r)
    }

    fn sleep_ms(&mut self, ms: u64) {
        wasi::clocks::monotonic_clock::subscribe_duration(ms * MS).block();
    }
}

fn start(req: &Request) -> Result<wasi::http::types::FutureIncomingResponse, String> {
    let rest = req.url.strip_prefix("https://").ok_or("https only")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let mut entries: Vec<(String, Vec<u8>)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.as_bytes().to_vec()))
        .collect();
    entries.push(("user-agent".into(), b"chair-courier/0.1".to_vec()));
    if req.method == M::Post {
        entries.push(("content-length".into(), req.body.len().to_string().into_bytes()));
    }
    let headers = match Fields::from_list(&entries) {
        Ok(h) => h,
        Err(_) => {
            // Some hosts forbid setting content-length; they compute it.
            entries.retain(|(k, _)| k != "content-length");
            Fields::from_list(&entries).map_err(|_| "headers")?
        }
    };
    let request = OutgoingRequest::new(headers);
    let method = match req.method {
        M::Get => Method::Get,
        M::Post => Method::Post,
    };
    request.set_method(&method).map_err(|_| "method")?;
    request.set_scheme(Some(&Scheme::Https)).map_err(|_| "scheme")?;
    request.set_authority(Some(authority)).map_err(|_| "authority")?;
    request.set_path_with_query(Some(path)).map_err(|_| "path")?;
    let body = request.body().map_err(|_| "body")?;
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(CONNECT_TIMEOUT_NS));
    let _ = options.set_first_byte_timeout(Some(FIRST_BYTE_TIMEOUT_NS));
    let _ = options.set_between_bytes_timeout(Some(BETWEEN_BYTES_TIMEOUT_NS));
    // Hand the request over first, then stream the body into it.
    let future = outgoing_handler::handle(request, Some(options)).map_err(|c| format!("{c:?}"))?;
    if !req.body.is_empty() {
        let stream = body.write().map_err(|_| "body stream")?;
        write_all(&stream, &req.body)?;
    }
    OutgoingBody::finish(body, None).map_err(|c| format!("{c:?}"))?;
    Ok(future)
}

fn write_all(stream: &OutputStream, mut bytes: &[u8]) -> Result<(), String> {
    while !bytes.is_empty() {
        let permit = stream.check_write().map_err(|e| format!("{e:?}"))? as usize;
        if permit == 0 {
            stream.subscribe().block();
            continue;
        }
        let n = permit.min(bytes.len());
        stream.write(&bytes[..n]).map_err(|e| format!("{e:?}"))?;
        bytes = &bytes[n..];
    }
    stream.blocking_flush().map_err(|e| format!("{e:?}"))
}

fn read(r: Result<Result<IncomingResponse, ErrorCode>, ()>) -> Result<Response, String> {
    let resp = r.map_err(|_| "response taken")?.map_err(|c| format!("{c:?}"))?;
    let status = resp.status();
    let body = resp.consume().map_err(|_| "consume")?;
    drop(resp);
    let mut buf = Vec::new();
    {
        let stream = body.stream().map_err(|_| "body stream")?;
        loop {
            match stream.blocking_read(64 * 1024) {
                Ok(chunk) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() > MAX_BODY {
                        return Err("body too large".into());
                    }
                }
                Err(StreamError::Closed) => break,
                Err(e) => return Err(format!("{e:?}")),
            }
        }
    }
    let _ = IncomingBody::finish(body);
    Ok(Response { status, body: buf })
}
