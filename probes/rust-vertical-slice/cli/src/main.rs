use std::collections::BTreeSet;
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    if args.no_adjusted {
        return Err(KrxError::from_probe_invalid_argument(
            "--no-adjusted requires an eligible exact-code stock range",
        ));
    }
    let output = cli.output.unwrap_or(OutputFormat::Json);
    if !cli.dry_run && !matches!(output, OutputFormat::Json) {
        return Err(KrxError::from_probe_invalid_argument(
            "the disposable native probe supports --output json only",
        ));
    }
    let date = match args.date.as_deref() {
        Some(date) => TradingDate::parse(date)?,
        None => {
            let recent = resolve_recent_trading_date(SystemTime::now())?;
            if let Some(warning) = recent.warning {
                eprintln!("[krx-cli] KRX_CALENDAR_FALLBACK: {warning}");
            }
            TradingDate::parse(&recent.date)?
        }
    };
    let operation = match args.market {
        StockMarket::Kospi => OperationId::StockStkByddTrd,
        StockMarket::Kosdaq => OperationId::StockKsqByddTrd,
        StockMarket::Konex => OperationId::StockKnxByddTrd,
    };
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

struct RecentTradingDate {
    date: String,
    warning: Option<String>,
}

fn resolve_recent_trading_date(now: SystemTime) -> Result<RecentTradingDate, KrxError> {
    const KST_OFFSET_SECONDS: u64 = 9 * 60 * 60;
    const DAY_SECONDS: u64 = 24 * 60 * 60;

    let seconds = now.duration_since(UNIX_EPOCH).map_err(|_| {
        KrxError::from_probe_invalid_argument("system time precedes the Unix epoch")
    })?;
    let current_kst_day = seconds
        .as_secs()
        .saturating_add(KST_OFFSET_SECONDS)
        .checked_div(DAY_SECONDS)
        .expect("nonzero day length") as i64;
    resolve_recent_trading_date_for_kst_day(current_kst_day)
}

fn resolve_recent_trading_date_for_kst_day(
    current_kst_day: i64,
) -> Result<RecentTradingDate, KrxError> {
    let calendar: Value = serde_json::from_str(include_str!(
        "../../../../src/calendar/krx-closures.json"
    ))
    .map_err(|_| KrxError::from_probe_invalid_argument("embedded KRX calendar is invalid"))?;
    let years = calendar
        .get("years")
        .and_then(Value::as_object)
        .ok_or_else(|| KrxError::from_probe_invalid_argument("embedded KRX calendar is invalid"))?;
    let source = calendar
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| KrxError::from_probe_invalid_argument("embedded KRX calendar is invalid"))?;
    let last_covered_year = years
        .keys()
        .filter_map(|year| year.parse::<i32>().ok())
        .max()
        .ok_or_else(|| KrxError::from_probe_invalid_argument("embedded KRX calendar is invalid"))?;
    let mut fallback_years = BTreeSet::new();
    let mut unverified_weekdays = 0_u16;

    for offset in 1..=370_i64 {
        let day = current_kst_day - offset;
        let weekday = (day + 4).rem_euclid(7);
        if weekday == 0 || weekday == 6 {
            continue;
        }
        let (year, month, month_day) = civil_from_days(day);
        let date = format!("{year:04}{month:02}{month_day:02}");
        let Some(closures) = years.get(&year.to_string()).and_then(Value::as_object) else {
            fallback_years.insert(year);
            if is_fallback_closure(year, month, month_day, weekday, last_covered_year) {
                continue;
            }
            unverified_weekdays += 1;
            continue;
        };
        if closures.contains_key(&date) {
            continue;
        }
        let warning = (!fallback_years.is_empty()).then(|| {
            let years = fallback_years
                .iter()
                .map(i32::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "Official KRX calendar coverage is unavailable for {years}; defaulted to last verified session {date} after {unverified_weekdays} unverified weekday(s). Run pnpm calendar:update before relying on newer defaults."
            )
        });
        return Ok(RecentTradingDate { date, warning });
    }

    Err(KrxError::from_probe_invalid_argument(format!(
        "Unable to find a verified recent KRX session within 370 days; official coverage ends in {last_covered_year}. Check {source} and run pnpm calendar:update."
    )))
}

fn is_fallback_closure(
    year: i32,
    month: u32,
    day: u32,
    weekday: i64,
    last_covered_year: i32,
) -> bool {
    if year <= last_covered_year {
        return false;
    }
    let fixed_closure = matches!(
        (month, day),
        (1, 1) | (3, 1) | (5, 1) | (5, 5) | (6, 6) | (8, 15) | (10, 3) | (12, 25)
    );
    let hangeul_day = year >= 2013 && (month, day) == (10, 9);
    let constitution_day = year >= 2026 && (month, day) == (7, 17);
    let year_end_closure = month == 12 && matches!((day, weekday), (31, 1..=5) | (30, 5) | (29, 5));

    fixed_closure || hangeul_day || constitution_day || year_end_closure
}

// Convert whole days since 1970-01-01 to a proleptic Gregorian date.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year as i32, month as u32, day as u32)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_date_walks_back_over_weekends_and_official_closures() {
        let weekend = UNIX_EPOCH + Duration::from_secs(1_787_529_600);
        assert_eq!(
            resolve_recent_trading_date(weekend)
                .expect("verified recent date")
                .date,
            "20260821"
        );

        let seollal = UNIX_EPOCH + Duration::from_secs(1_771_459_200);
        assert_eq!(
            resolve_recent_trading_date(seollal)
                .expect("verified recent date")
                .date,
            "20260213"
        );
    }

    #[test]
    fn recent_date_uses_an_observable_stale_fallback() {
        let uncovered = UNIX_EPOCH + Duration::from_secs(1_799_020_800);
        let recent = resolve_recent_trading_date(uncovered).expect("stale recent date");
        assert_eq!(recent.date, "20261230");
        assert_eq!(
            recent.warning.as_deref(),
            Some(
                "Official KRX calendar coverage is unavailable for 2027; defaulted to last verified session 20261230 after 0 unverified weekday(s). Run pnpm calendar:update before relying on newer defaults."
            )
        );
    }

    #[test]
    fn recent_date_counts_unverified_future_weekdays() {
        let uncovered = UNIX_EPOCH + Duration::from_secs(1_799_074_800);
        let recent = resolve_recent_trading_date(uncovered).expect("stale recent date");
        assert_eq!(recent.date, "20261230");
        assert!(
            recent
                .warning
                .expect("fallback warning")
                .contains("after 1 unverified weekday(s)")
        );
    }

    #[test]
    fn future_fallback_closures_match_the_canonical_calendar_policy() {
        for (month, day) in [
            (1, 1),
            (3, 1),
            (5, 1),
            (5, 5),
            (6, 6),
            (8, 15),
            (10, 3),
            (12, 25),
        ] {
            assert!(is_fallback_closure(2027, month, day, 1, 2026));
        }
        assert!(is_fallback_closure(2027, 10, 9, 1, 2026));
        assert!(!is_fallback_closure(2012, 10, 9, 1, 2011));
        assert!(is_fallback_closure(2027, 7, 17, 1, 2026));
        assert!(!is_fallback_closure(2025, 7, 17, 1, 2024));
        assert!(is_fallback_closure(2027, 12, 31, 5, 2026));
        assert!(is_fallback_closure(2027, 12, 30, 5, 2026));
        assert!(is_fallback_closure(2028, 12, 29, 5, 2026));
        assert!(!is_fallback_closure(2027, 1, 4, 1, 2026));
        assert!(!is_fallback_closure(2015, 1, 1, 4, 2026));
    }
}
