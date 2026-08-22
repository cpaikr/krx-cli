use std::process::ExitCode;
use std::time::Duration;

use clap::error::ErrorKind;
use clap::{Args, Parser, Subcommand, ValueEnum};
use krx_sdk::{
    ApiKey, CachePolicy, CallOptions, Cancellation, Client, DirectRequest, KrxError, KrxErrorKind,
    OperationId, TradingDate,
};
use serde_json::{Map, Value, json};

#[derive(Debug, Parser)]
#[command(
    name = "krx",
    version = env!("CARGO_PKG_VERSION"),
    about = "Native CLI probe for the KRX Open API",
    disable_help_subcommand = true
)]
struct Cli {
    #[arg(short, long, global = true, value_enum)]
    output: Option<OutputFormat>,

    #[arg(
        long,
        global = true,
        conflicts_with_all = ["refresh", "no_cache", "dry_run", "retries"]
    )]
    offline: bool,

    #[arg(long, global = true)]
    refresh: bool,

    #[arg(long = "no-cache", global = true)]
    no_cache: bool,

    #[arg(long, global = true)]
    dry_run: bool,

    #[arg(long, global = true, value_parser = clap::value_parser!(u8).range(0..=3))]
    retries: Option<u8>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Json,
    Table,
    Ndjson,
    Csv,
}

#[derive(Debug, Subcommand)]
enum Command {
    Stock(StockArgs),
}

#[derive(Debug, Args)]
struct StockArgs {
    #[command(subcommand)]
    command: StockCommand,
}

#[derive(Debug, Subcommand)]
enum StockCommand {
    List(StockListArgs),
}

#[derive(Debug, Args)]
struct StockListArgs {
    #[arg(long)]
    date: Option<String>,

    #[arg(long, value_enum, default_value_t = StockMarket::Kospi)]
    market: StockMarket,

    #[arg(long = "no-adjusted")]
    no_adjusted: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum StockMarket {
    Kospi,
    Kosdaq,
    Konex,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            let code = if error.kind() == ErrorKind::ArgumentConflict {
                "conflicting_options"
            } else {
                "invalid_argument"
            };
            diagnostic(
                "invalid_request",
                code,
                "arguments do not satisfy the native CLI contract",
            );
            return ExitCode::from(2);
        }
    };

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            diagnostic(
                error.kind().as_str(),
                error.code().as_str(),
                error.message(),
            );
            ExitCode::from(exit_code(error.kind()))
        }
    }
}

async fn run(cli: Cli) -> Result<(), KrxError> {
    match &cli.command {
        Command::Stock(StockArgs {
            command: StockCommand::List(args),
        }) => run_stock_list(&cli, args).await,
    }
}

async fn run_stock_list(cli: &Cli, args: &StockListArgs) -> Result<(), KrxError> {
    let date = TradingDate::parse(args.date.as_deref().unwrap_or(""))?;
    let operation = match args.market {
        StockMarket::Kospi => OperationId::StockStkByddTrd,
        StockMarket::Kosdaq => OperationId::StockKsqByddTrd,
        StockMarket::Konex => OperationId::StockKnxByddTrd,
    };
    let _ = args.no_adjusted;
    let output = cli.output.unwrap_or(OutputFormat::Json);
    if cli.dry_run {
        println!(
            "{}",
            json!({
                "operationId": operation.as_str(),
                "date": date.as_str(),
                "output": output_name(output),
            })
        );
        return Ok(());
    }

    let mut builder = Client::builder();
    if let Ok(secret) = std::env::var("KRX_API_KEY") {
        builder = builder.api_key(ApiKey::parse(&secret)?);
    }
    if let Ok(base_url) = std::env::var("KRX_PROBE_BASE_URL") {
        builder = builder.probe_base_url(&base_url)?;
    }
    if let Ok(milliseconds) = std::env::var("KRX_PROBE_TIMEOUT_MS") {
        let milliseconds = milliseconds.parse::<u64>().map_err(|_| {
            KrxError::from_probe_invalid_argument("KRX_PROBE_TIMEOUT_MS must be an integer")
        })?;
        builder = builder.probe_attempt_timeout(Duration::from_millis(milliseconds));
    }
    let client = builder.build()?;
    let cancellation = Cancellation::new();
    let signal_cancellation = cancellation.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancellation.cancel();
        }
    });
    let cache = if cli.offline {
        CachePolicy::Offline
    } else if cli.no_cache {
        CachePolicy::Bypass
    } else if cli.refresh {
        CachePolicy::Refresh
    } else {
        CachePolicy::Prefer {
            max_age: Duration::from_secs(168 * 60 * 60),
        }
    };
    let result = client
        .query(DirectRequest {
            operation,
            date,
            options: CallOptions {
                cache,
                retries: cli.retries.unwrap_or(3),
                cancellation,
            },
        })
        .await?;

    let rows = result
        .rows
        .iter()
        .map(|row| {
            Value::Object(
                row.iter()
                    .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
                    .collect::<Map<_, _>>(),
            )
        })
        .collect::<Vec<_>>();
    println!("{}", Value::Array(rows));
    Ok(())
}

fn output_name(output: OutputFormat) -> &'static str {
    match output {
        OutputFormat::Json => "json",
        OutputFormat::Table => "table",
        OutputFormat::Ndjson => "ndjson",
        OutputFormat::Csv => "csv",
    }
}

fn diagnostic(kind: &str, code: &str, message: &str) {
    eprintln!("krx: error[{kind}/{code}]: {message}");
}

fn exit_code(kind: KrxErrorKind) -> u8 {
    match kind {
        KrxErrorKind::InvalidRequest => 2,
        KrxErrorKind::Authentication => 4,
        KrxErrorKind::RateLimit => 5,
        KrxErrorKind::Approval => 6,
        KrxErrorKind::Cancelled
        | KrxErrorKind::Timeout
        | KrxErrorKind::Offline
        | KrxErrorKind::Network
        | KrxErrorKind::Upstream
        | KrxErrorKind::InvalidResponse
        | KrxErrorKind::Integrity
        | KrxErrorKind::LocalState
        | KrxErrorKind::Internal => 1,
    }
}
