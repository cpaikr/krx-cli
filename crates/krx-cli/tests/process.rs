use std::process::Command;

#[test]
fn removed_serve_and_argv_secrets_are_parser_errors() {
    for args in [
        &["serve"][..],
        &["auth", "set", "must-not-enter-process-arguments"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_krx"))
            .args(args)
            .output()
            .expect("native CLI runs");
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn semantic_rejection_happens_before_client_or_local_state_access() {
    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .args(["--offline", "--refresh", "stock", "search", "samsung"])
        .env("KRX_API_KEY", "would-be-ignored")
        .output()
        .expect("native CLI runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 diagnostic");
    assert!(stderr.starts_with("krx: error[invalid_request/invalid_argument]:"));
}

#[test]
fn version_is_stable_json_on_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .arg("version")
        .output()
        .expect("native CLI runs");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(value["current"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn clap_value_errors_retain_the_meaningful_possible_values() {
    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .args(["--output", "xml", "schema", "--all"])
        .output()
        .expect("native CLI runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 diagnostic");
    assert!(stderr.contains("invalid"));
    assert!(stderr.contains("json, table, ndjson, csv"));
}

#[test]
fn unrelated_commands_ignore_an_invalid_cache_age_environment_value() {
    let output = Command::new(env!("CARGO_BIN_EXE_krx"))
        .arg("version")
        .env("KRX_CACHE_MAX_AGE_HOURS", "not-a-duration")
        .output()
        .expect("native CLI runs");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_leaf_values_win_before_client_environment_or_local_state() {
    for args in [
        &["stock", "list", "--date", "not-a-date"][..],
        &["stock", "list"],
        &[
            "--filter",
            "FLUC_RT>5",
            "stock",
            "list",
            "--date",
            "20260102",
        ],
        &["cache", "prune", "--older-than", "yesterday"],
        &["watchlist", "add", ""],
        &["watchlist", "remove", "../watchlist"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_krx"))
            .args(args)
            .env_remove("HOME")
            .env_remove("USERPROFILE")
            .output()
            .expect("native CLI runs");
        assert_eq!(output.status.code(), Some(2), "args: {args:?}");
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).expect("UTF-8 diagnostic");
        assert!(
            stderr.starts_with("krx: error[invalid_request/invalid_argument]:"),
            "args: {args:?}; stderr: {stderr}"
        );
        assert!(!stderr.contains("local_state"), "args: {args:?}");
    }
}
