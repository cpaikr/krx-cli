mod args;
mod output;

use std::ffi::OsString;

use clap::{Parser, error::ErrorKind};

pub use args::Cli;

pub fn run_from(args: impl IntoIterator<Item = OsString>) -> i32 {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            if error.kind() == ErrorKind::DisplayVersion {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return 0;
            }
            if error.use_stderr() {
                let rendered = error.to_string();
                let mut meaningful = rendered
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty());
                let first = meaningful
                    .next()
                    .unwrap_or("invalid command line")
                    .trim_start_matches("error: ");
                let details = meaningful
                    .filter(|line| line.contains("possible values:"))
                    .collect::<Vec<_>>()
                    .join(" ");
                let message = if details.is_empty() {
                    first.to_owned()
                } else {
                    format!("{first} {details}")
                };
                eprintln!("krx: error[invalid_request/invalid_argument]: {message}");
                return 2;
            }
            let _ = error.print();
            return 0;
        }
    };

    if let Err(error) = cli.validate_policy() {
        eprintln!("krx: error[invalid_request/invalid_argument]: {error}");
        return 2;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("krx: error[internal/internal_failure]: {error}");
            return 1;
        }
    };
    runtime.block_on(async move { crate::output::execute(cli).await })
}
