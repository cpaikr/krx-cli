use std::collections::BTreeSet;

use clap::{Command, CommandFactory, Parser};
use krx_cli::Cli;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct InventoryEntry {
    path: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    options: Vec<String>,
}

#[test]
fn clap_tree_matches_the_frozen_candidate_inventory() {
    let expected: Vec<InventoryEntry> = serde_json::from_str(include_str!(
        "../../../contracts/generated/candidate-command-inventory.json"
    ))
    .expect("valid checked inventory");
    let root = Cli::command();

    for entry in expected {
        let command = find_command(&root, &entry.path);
        let actual_commands = command
            .get_subcommands()
            .map(|child| child.get_name().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual_commands,
            entry.commands.into_iter().collect(),
            "subcommands at {:?}",
            entry.path
        );

        // Help presentation is intentionally allowed to differ. All other
        // frozen long options must be accepted, and no candidate-only option
        // may appear outside the checked inventory.
        let expected_options = entry
            .options
            .into_iter()
            .filter(|name| name != "help")
            .collect::<BTreeSet<_>>();
        let mut actual_options = command
            .get_arguments()
            .filter_map(|argument| argument.get_long())
            .filter(|name| *name != "help")
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if entry.path.is_empty() && command.get_version().is_some() {
            actual_options.insert("version".to_owned());
        }
        assert_eq!(
            actual_options, expected_options,
            "options at {:?}",
            entry.path
        );
    }
}

#[test]
fn semantic_policy_rejects_inactive_and_offline_conflicting_options() {
    for args in [
        vec!["krx", "--output", "table", "cache", "status"],
        vec![
            "krx",
            "--offline",
            "--refresh",
            "stock",
            "search",
            "samsung",
        ],
        vec![
            "krx",
            "--offline",
            "--retries",
            "0",
            "index",
            "list",
            "--date",
            "20260102",
        ],
        vec!["krx", "--from", "20260102", "index", "list"],
    ] {
        let cli = Cli::try_parse_from(args).expect("syntax accepted before semantic validation");
        assert!(cli.validate_policy().is_err());
    }
}

#[test]
fn cache_status_accepts_the_frozen_json_output_invocation() {
    let cli = Cli::try_parse_from(["krx", "--output", "json", "cache", "status"])
        .expect("cache status syntax");
    assert_eq!(cli.validate_policy(), Ok(()));
}

#[test]
fn full_operation_value_topology_parses_without_building_a_client() {
    let cases = [
        &[
            "krx",
            "index",
            "list",
            "--date",
            "20260102",
            "--market",
            "derivative",
        ][..],
        &[
            "krx",
            "--from",
            "20260102",
            "--to",
            "20260103",
            "--code",
            "005930",
            "stock",
            "list",
            "--market",
            "konex",
            "--no-adjusted",
        ],
        &["krx", "etp", "list", "--date", "20260102", "--type", "elw"],
        &[
            "krx", "bond", "list", "--date", "20260102", "--market", "small",
        ],
        &[
            "krx",
            "derivative",
            "list",
            "--date",
            "20260102",
            "--type",
            "options-kosdaq",
        ],
        &[
            "krx",
            "commodity",
            "list",
            "--date",
            "20260102",
            "--type",
            "emission",
        ],
        &[
            "krx", "esg", "list", "--date", "20260102", "--type", "sri-bond",
        ],
    ];
    for args in cases {
        let cli = Cli::try_parse_from(args).expect("frozen command value must parse");
        assert!(cli.validate_policy().is_ok());
        assert!(cli.endpoint().is_some());
    }
}

fn find_command<'a>(root: &'a Command, path: &[String]) -> &'a Command {
    path.iter().fold(root, |command, name| {
        command
            .get_subcommands()
            .find(|child| child.get_name() == name)
            .unwrap_or_else(|| panic!("missing command path {path:?}"))
    })
}
