use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Output};
use std::thread;

fn krx(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_krx"))
        .args(args)
        .env_remove("KRX_API_KEY")
        .output()
        .expect("run native CLI")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("UTF-8 CLI output")
}

#[test]
fn clap_owns_the_native_topology_and_removed_serve_surface() {
    let root = krx(&["--help"]);
    assert!(root.status.success());
    let stdout = text(&root.stdout);
    assert!(stdout.contains("stock"));
    assert!(stdout.contains("--offline"));
    assert!(!stdout.contains("serve"));

    let stock = krx(&["stock", "list", "--help"]);
    assert!(stock.status.success());
    let stdout = text(&stock.stdout);
    assert!(stdout.contains("--date"));
    assert!(stdout.contains("--market"));
    assert!(stdout.contains("--no-adjusted"));
}

#[test]
fn parser_and_semantic_failures_use_the_frozen_diagnostic_grammar() {
    for (args, expected) in [
        (
            vec![
                "--offline",
                "--refresh",
                "stock",
                "list",
                "--date",
                "20260821",
            ],
            "krx: error[invalid_request/conflicting_options]: arguments do not satisfy the native CLI contract\n",
        ),
        (
            vec!["--retries", "4", "stock", "list", "--date", "20260821"],
            "krx: error[invalid_request/invalid_argument]: arguments do not satisfy the native CLI contract\n",
        ),
    ] {
        let output = krx(&args);
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(text(&output.stderr), expected);
        assert!(output.stdout.is_empty());
    }

    let invalid_date = krx(&["stock", "list", "--date", "20260230"]);
    assert_eq!(invalid_date.status.code(), Some(2));
    assert_eq!(
        text(&invalid_date.stderr),
        "krx: error[invalid_request/invalid_date]: date must be a valid YYYYMMDD calendar date\n"
    );

    let inactive_adjustment = krx(&["stock", "list", "--date", "20260821", "--no-adjusted"]);
    assert_eq!(inactive_adjustment.status.code(), Some(2));
    assert_eq!(
        text(&inactive_adjustment.stderr),
        "krx: error[invalid_request/invalid_argument]: --no-adjusted requires an eligible exact-code stock range\n"
    );
    assert!(inactive_adjustment.stdout.is_empty());

    for format in ["table", "ndjson", "csv"] {
        let unsupported_output = krx(&["--output", format, "stock", "list", "--date", "20260821"]);
        assert_eq!(unsupported_output.status.code(), Some(2));
        assert_eq!(
            text(&unsupported_output.stderr),
            "krx: error[invalid_request/invalid_argument]: the disposable native probe supports --output json only\n"
        );
        assert!(unsupported_output.stdout.is_empty());
    }
}

#[test]
fn semantic_rejection_precedes_credentials_and_network() {
    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .args(["stock", "list", "--date", "not-a-date"])
        .env("KRX_PROBE_BASE_URL", "http://127.0.0.1:1/")
        .env_remove("KRX_API_KEY")
        .output()
        .expect("run native CLI");
    assert_eq!(output.status.code(), Some(2));
    assert!(text(&output.stderr).contains("invalid_request/invalid_date"));
    assert!(!text(&output.stderr).contains("credential"));
    assert!(!text(&output.stderr).contains("request failed"));
}

#[test]
fn native_cli_reaches_the_shared_sdk_without_a_javascript_launcher() {
    let wire = krx_sdk::probe_wire_contract();
    let path = wire.path.to_owned();
    let method = wire.method.to_owned();
    let auth_header = wire.auth_header.to_ascii_lowercase();
    let response = serde_json::json!({
        wire.success_envelope: [wire
            .representative_fields
            .iter()
            .map(|field| ((*field).to_owned(), serde_json::Value::String("1".to_owned())))
            .collect::<serde_json::Map<_, _>>()]
    })
    .to_string();
    let first_field = wire.representative_fields[0].to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind provider fixture");
    let address = listener.local_addr().expect("fixture address");
    let provider = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("provider call");
        let mut request = [0_u8; 4096];
        let read = stream.read(&mut request).expect("read provider request");
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.starts_with(&format!("{method} {path} HTTP/1.1")));
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("{auth_header}: fixture-key"))
        );
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            response.len(),
            response
        )
        .expect("write provider response");
    });

    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .args(["--no-cache", "stock", "list", "--date", "20260821"])
        .env("KRX_API_KEY", "fixture-key")
        .env("KRX_PROBE_BASE_URL", format!("http://{address}/"))
        .output()
        .expect("run native CLI");
    provider.join().expect("provider fixture");
    assert!(output.status.success(), "{}", text(&output.stderr));
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON rows");
    assert_eq!(rows[0][first_field], "1");
    assert!(output.stderr.is_empty());
}

#[test]
fn executable_is_a_native_binary() {
    let bytes = std::fs::read(env!("CARGO_BIN_EXE_krx")).expect("read native executable");
    assert_ne!(&bytes[..2], b"#!");
    assert!(!bytes.starts_with(b"#!/usr/bin/env node"));
}
