use clap::{Args, Parser, Subcommand, ValueEnum};
use krx_sdk::{
    ApprovalCategory, CallOptions, DateRange, OperationId, StockSearchRequest, TradingDate,
    validate_local_input,
};

#[derive(Debug, Parser)]
#[command(
    name = "krx",
    version,
    about = "Agent-native CLI for KRX (Korea Exchange) Open API"
)]
pub struct Cli {
    #[arg(short, long, global = true, value_enum)]
    pub output: Option<OutputFormat>,
    #[arg(short, long, global = true)]
    pub fields: Option<String>,
    #[arg(long, global = true)]
    pub dry_run: bool,
    #[arg(short, long, global = true)]
    pub verbose: bool,
    #[arg(long, global = true)]
    pub code: Option<String>,
    #[arg(long, global = true)]
    pub sort: Option<String>,
    #[arg(long, global = true)]
    pub asc: bool,
    #[arg(long, global = true, value_parser = clap::value_parser!(usize))]
    pub offset: Option<usize>,
    #[arg(long, global = true, value_parser = clap::value_parser!(usize))]
    pub limit: Option<usize>,
    #[arg(long, global = true)]
    pub no_cache: bool,
    #[arg(long, global = true)]
    pub refresh: bool,
    #[arg(long, global = true)]
    pub from: Option<String>,
    #[arg(long, global = true)]
    pub to: Option<String>,
    #[arg(long, global = true)]
    pub filter: Option<String>,
    #[arg(long, global = true)]
    pub save: Option<String>,
    #[arg(long, global = true, value_parser = clap::value_parser!(u8).range(0..=3))]
    pub retries: Option<u8>,
    #[arg(long, global = true)]
    pub offline: bool,
    #[command(subcommand)]
    pub command: TopCommand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    Json,
    Table,
    Ndjson,
    Csv,
}

#[derive(Debug, Subcommand)]
pub enum TopCommand {
    Auth(AuthArgs),
    Index(IndexArgs),
    Stock(StockArgs),
    Etp(EtpArgs),
    Bond(BondArgs),
    Derivative(DerivativeArgs),
    Commodity(CommodityArgs),
    Esg(EsgArgs),
    Schema(SchemaArgs),
    Cache(CacheArgs),
    Market(MarketArgs),
    Watchlist(WatchlistArgs),
    Version,
}

#[derive(Debug, Args)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}
#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    Set {
        #[arg(long)]
        stdin: bool,
    },
    Remove,
    Status,
    Check {
        #[arg(value_enum)]
        category: Category,
    },
    Migrate,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Category {
    Index,
    Stock,
    Etp,
    Bond,
    Derivative,
    Commodity,
    Esg,
}
impl From<Category> for ApprovalCategory {
    fn from(value: Category) -> Self {
        match value {
            Category::Index => Self::Index,
            Category::Stock => Self::Stock,
            Category::Etp => Self::Etp,
            Category::Bond => Self::Bond,
            Category::Derivative => Self::Derivative,
            Category::Commodity => Self::Commodity,
            Category::Esg => Self::Esg,
        }
    }
}

#[derive(Debug, Args)]
pub struct IndexArgs {
    #[command(subcommand)]
    pub command: IndexCommand,
}
#[derive(Debug, Subcommand)]
pub enum IndexCommand {
    List {
        #[arg(long)]
        date: Option<String>,
        #[arg(long, value_enum, default_value_t = IndexMarket::Kospi)]
        market: IndexMarket,
    },
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum IndexMarket {
    Kospi,
    Kosdaq,
    Krx,
    Bond,
    Derivative,
}

#[derive(Debug, Args)]
pub struct StockArgs {
    #[command(subcommand)]
    pub command: StockCommand,
}
#[derive(Debug, Subcommand)]
pub enum StockCommand {
    List {
        #[arg(long)]
        date: Option<String>,
        #[arg(long, value_enum, default_value_t = StockMarket::Kospi)]
        market: StockMarket,
        #[arg(long)]
        no_adjusted: bool,
    },
    Info {
        #[arg(long, value_enum, default_value_t = StockMarket::Kospi)]
        market: StockMarket,
    },
    Search {
        query: String,
    },
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum StockMarket {
    Kospi,
    Kosdaq,
    Konex,
}

macro_rules! list_group {
    ($args:ident, $command:ident, $field:ident, $kind:ty, $default:expr) => {
        #[derive(Debug, Args)]
        pub struct $args {
            #[command(subcommand)]
            pub command: $command,
        }
        #[derive(Debug, Subcommand)]
        pub enum $command {
            List {
                #[arg(long)]
                date: Option<String>,
                #[arg(long, value_enum, default_value_t = $default)]
                $field: $kind,
            },
        }
    };
}

list_group!(EtpArgs, EtpCommand, r#type, EtpType, EtpType::Etf);
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum EtpType {
    Etf,
    Etn,
    Elw,
}
list_group!(
    BondArgs,
    BondCommand,
    market,
    BondMarket,
    BondMarket::General
);
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum BondMarket {
    Kts,
    General,
    Small,
}
list_group!(
    DerivativeArgs,
    DerivativeCommand,
    r#type,
    DerivativeType,
    DerivativeType::Futures
);
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum DerivativeType {
    Futures,
    FuturesKospi,
    FuturesKosdaq,
    Options,
    OptionsKospi,
    OptionsKosdaq,
}
list_group!(
    CommodityArgs,
    CommodityCommand,
    r#type,
    CommodityType,
    CommodityType::Gold
);
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum CommodityType {
    Oil,
    Gold,
    Emission,
}
list_group!(EsgArgs, EsgCommand, r#type, EsgType, EsgType::Index);
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum EsgType {
    SriBond,
    Etp,
    Index,
}

#[derive(Debug, Args)]
pub struct SchemaArgs {
    pub command: Option<String>,
    #[arg(long)]
    pub all: bool,
}

#[derive(Debug, Args)]
pub struct CacheArgs {
    #[command(subcommand)]
    pub command: CacheCommand,
}
#[derive(Debug, Subcommand)]
pub enum CacheCommand {
    Status,
    Clear,
    Inspect {
        #[arg(long)]
        operation: Option<String>,
        #[arg(long)]
        date: Option<String>,
        #[arg(long, default_value_t = 100, value_parser = parse_inspect_limit)]
        limit: usize,
    },
    Prune {
        #[arg(long)]
        older_than: Option<String>,
        #[arg(long, value_parser = parse_prune_limit)]
        max_entries: Option<usize>,
    },
}

fn parse_inspect_limit(value: &str) -> Result<usize, String> {
    parse_bounded(value, 1, 1_000, "cache inspect limit")
}

fn parse_prune_limit(value: &str) -> Result<usize, String> {
    parse_bounded(value, 0, 10_000, "cache prune maximum entries")
}

fn parse_bounded(
    value: &str,
    minimum: usize,
    maximum: usize,
    label: &str,
) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("{label} must be an integer"))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(format!("{label} must be between {minimum} and {maximum}"));
    }
    Ok(parsed)
}

#[derive(Debug, Args)]
pub struct MarketArgs {
    #[command(subcommand)]
    pub command: MarketCommand,
}
#[derive(Debug, Subcommand)]
pub enum MarketCommand {
    Summary {
        #[arg(short, long)]
        date: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct WatchlistArgs {
    #[command(subcommand)]
    pub command: WatchlistCommand,
}
#[derive(Debug, Subcommand)]
pub enum WatchlistCommand {
    Add {
        name: String,
    },
    Remove {
        name: String,
    },
    List,
    Show {
        #[arg(short, long)]
        date: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope {
    Endpoint,
    Search,
    Summary,
    WatchlistPrices,
    AuthStatus,
    CacheStatus,
    Other,
}

impl Cli {
    pub fn scope(&self) -> Scope {
        match &self.command {
            TopCommand::Index(_)
            | TopCommand::Etp(_)
            | TopCommand::Bond(_)
            | TopCommand::Derivative(_)
            | TopCommand::Commodity(_)
            | TopCommand::Esg(_) => Scope::Endpoint,
            TopCommand::Stock(StockArgs {
                command: StockCommand::List { .. } | StockCommand::Info { .. },
            }) => Scope::Endpoint,
            TopCommand::Stock(StockArgs {
                command: StockCommand::Search { .. },
            }) => Scope::Search,
            TopCommand::Market(_) => Scope::Summary,
            TopCommand::Watchlist(WatchlistArgs {
                command: WatchlistCommand::Show { .. },
            }) => Scope::WatchlistPrices,
            TopCommand::Auth(AuthArgs {
                command: AuthCommand::Status,
            }) => Scope::AuthStatus,
            TopCommand::Cache(CacheArgs {
                command: CacheCommand::Status,
            }) => Scope::CacheStatus,
            _ => Scope::Other,
        }
    }

    pub fn validate_policy(&self) -> Result<(), String> {
        let scope = self.scope();
        let active = |allowed: &[Scope]| allowed.contains(&scope);
        let checks = [
            (
                self.output.is_some(),
                "--output",
                active(&[Scope::Endpoint, Scope::AuthStatus, Scope::CacheStatus]),
            ),
            (
                self.fields.is_some(),
                "--fields",
                active(&[Scope::Endpoint, Scope::Search]),
            ),
            (self.dry_run, "--dry-run", scope == Scope::Endpoint),
            (self.verbose, "--verbose", scope == Scope::Endpoint),
            (self.code.is_some(), "--code", scope == Scope::Endpoint),
            (self.sort.is_some(), "--sort", scope == Scope::Endpoint),
            (self.asc, "--asc", scope == Scope::Endpoint),
            (self.offset.is_some(), "--offset", scope == Scope::Endpoint),
            (self.limit.is_some(), "--limit", scope == Scope::Endpoint),
            (
                self.no_cache,
                "--no-cache",
                active(&[Scope::Endpoint, Scope::Summary, Scope::WatchlistPrices]),
            ),
            (
                self.refresh,
                "--refresh",
                active(&[Scope::Endpoint, Scope::Summary, Scope::WatchlistPrices]),
            ),
            (self.from.is_some(), "--from", scope == Scope::Endpoint),
            (self.to.is_some(), "--to", scope == Scope::Endpoint),
            (self.filter.is_some(), "--filter", scope == Scope::Endpoint),
            (self.save.is_some(), "--save", scope == Scope::Endpoint),
            (
                self.retries.is_some(),
                "--retries",
                scope == Scope::Endpoint,
            ),
            (
                self.offline,
                "--offline",
                active(&[
                    Scope::Endpoint,
                    Scope::Search,
                    Scope::Summary,
                    Scope::WatchlistPrices,
                ]),
            ),
        ];
        if let Some((_, name, _)) = checks.into_iter().find(|(set, _, valid)| *set && !*valid) {
            return Err(format!("{name} is not valid for this command"));
        }
        if scope == Scope::CacheStatus
            && self
                .output
                .is_some_and(|format| format != OutputFormat::Json)
        {
            return Err("cache status supports only --output json".into());
        }
        if self.offline {
            for (set, name) in [
                (self.refresh, "--refresh"),
                (self.no_cache, "--no-cache"),
                (self.dry_run, "--dry-run"),
                (self.retries.is_some(), "--retries"),
            ] {
                if set {
                    return Err(format!("--offline cannot be combined with {name}"));
                }
            }
        }
        if self.refresh && self.no_cache {
            return Err("--refresh cannot be combined with --no-cache".into());
        }
        if self.from.is_some() != self.to.is_some() {
            return Err("both --from and --to must be provided together".into());
        }
        if self.retries.is_some() && self.from.is_some() {
            return Err("--retries is only valid for a direct single-endpoint request".into());
        }
        if let TopCommand::Stock(StockArgs {
            command: StockCommand::List { no_adjusted, .. },
        }) = &self.command
            && *no_adjusted
            && (self.from.is_none()
                || self
                    .code
                    .as_deref()
                    .is_none_or(|code| !is_exact_security_code(code)))
        {
            return Err("--no-adjusted is only valid for an exact-code stock date range".into());
        }
        if self
            .filter
            .as_deref()
            .is_some_and(|expression| filter_parts(expression).is_none())
        {
            return Err("Invalid filter expression. Expected \"FIELD <operator> VALUE\".".into());
        }
        self.validate_command_inputs()?;
        Ok(())
    }

    fn validate_command_inputs(&self) -> Result<(), String> {
        if let Some((operation, leaf_date, _)) = self.endpoint() {
            if let Some(value) = leaf_date {
                parse_cli_date(value)?;
            }
            match (self.from.as_deref(), self.to.as_deref()) {
                (Some(from), Some(to)) => {
                    DateRange::new(parse_cli_date(from)?, parse_cli_date(to)?)
                        .map_err(|error| error.message().to_owned())?;
                }
                (None, None) if leaf_date.is_none() && !is_base_info(operation) => {
                    return Err("Either --date or --from/--to is required".into());
                }
                _ => {}
            }
        }

        match &self.command {
            TopCommand::Stock(StockArgs {
                command: StockCommand::Search { query },
            }) => {
                StockSearchRequest::new(query, CallOptions::default())
                    .map_err(|error| error.message().to_owned())?;
            }
            TopCommand::Schema(SchemaArgs {
                command: Some(command),
                all: false,
            }) if !is_schema_command(command) => {
                return Err(format!(
                    "Unknown command: {command}. Use 'krx schema --all' to list all."
                ));
            }
            TopCommand::Cache(CacheArgs {
                command:
                    CacheCommand::Inspect {
                        operation,
                        date,
                        limit: _,
                    },
            }) => {
                if let Some(operation) = operation {
                    parse_operation_value(operation)?;
                }
                if let Some(date) = date {
                    parse_cli_date(date)?;
                }
            }
            TopCommand::Cache(CacheArgs {
                command: CacheCommand::Prune { older_than, .. },
            }) => {
                if older_than
                    .as_deref()
                    .is_some_and(|value| value.parse::<jiff::Timestamp>().is_err())
                {
                    return Err("--older-than must be an RFC 3339 instant".into());
                }
            }
            TopCommand::Market(MarketArgs {
                command: MarketCommand::Summary { date: Some(date) },
            })
            | TopCommand::Watchlist(WatchlistArgs {
                command: WatchlistCommand::Show { date: Some(date) },
            }) => {
                parse_cli_date(date)?;
            }
            TopCommand::Watchlist(WatchlistArgs {
                command: WatchlistCommand::Add { name },
            }) => {
                StockSearchRequest::new(name, CallOptions::default())
                    .map_err(|error| error.message().to_owned())?;
            }
            TopCommand::Watchlist(WatchlistArgs {
                command: WatchlistCommand::Remove { name },
            }) => {
                validate_local_input(name).map_err(|error| error.message().to_owned())?;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn endpoint(&self) -> Option<(OperationId, Option<&str>, bool)> {
        let mapped = match &self.command {
            TopCommand::Index(IndexArgs {
                command: IndexCommand::List { date, market },
            }) => (
                match market {
                    IndexMarket::Kospi => OperationId::IndexKospiDdTrd,
                    IndexMarket::Kosdaq => OperationId::IndexKosdaqDdTrd,
                    IndexMarket::Krx => OperationId::IndexKrxDdTrd,
                    IndexMarket::Bond => OperationId::IndexBonDdTrd,
                    IndexMarket::Derivative => OperationId::IndexDrvprodDdTrd,
                },
                date.as_deref(),
                false,
            ),
            TopCommand::Stock(StockArgs {
                command:
                    StockCommand::List {
                        date,
                        market,
                        no_adjusted,
                    },
            }) => (
                match market {
                    StockMarket::Kospi => OperationId::StockStkByddTrd,
                    StockMarket::Kosdaq => OperationId::StockKsqByddTrd,
                    StockMarket::Konex => OperationId::StockKnxByddTrd,
                },
                date.as_deref(),
                !*no_adjusted,
            ),
            TopCommand::Stock(StockArgs {
                command: StockCommand::Info { market },
            }) => (
                match market {
                    StockMarket::Kospi => OperationId::StockStkIsuBaseInfo,
                    StockMarket::Kosdaq => OperationId::StockKsqIsuBaseInfo,
                    StockMarket::Konex => OperationId::StockKnxIsuBaseInfo,
                },
                None,
                false,
            ),
            TopCommand::Etp(EtpArgs {
                command: EtpCommand::List { date, r#type },
            }) => (
                match r#type {
                    EtpType::Etf => OperationId::EtpEtfByddTrd,
                    EtpType::Etn => OperationId::EtpEtnByddTrd,
                    EtpType::Elw => OperationId::EtpElwByddTrd,
                },
                date.as_deref(),
                false,
            ),
            TopCommand::Bond(BondArgs {
                command: BondCommand::List { date, market },
            }) => (
                match market {
                    BondMarket::Kts => OperationId::BondKtsByddTrd,
                    BondMarket::General => OperationId::BondBndByddTrd,
                    BondMarket::Small => OperationId::BondSmbByddTrd,
                },
                date.as_deref(),
                false,
            ),
            TopCommand::Derivative(DerivativeArgs {
                command: DerivativeCommand::List { date, r#type },
            }) => (
                match r#type {
                    DerivativeType::Futures => OperationId::DerivativeFutByddTrd,
                    DerivativeType::FuturesKospi => OperationId::DerivativeEqsfuStkByddTrd,
                    DerivativeType::FuturesKosdaq => OperationId::DerivativeEqkfuKsqByddTrd,
                    DerivativeType::Options => OperationId::DerivativeOptByddTrd,
                    DerivativeType::OptionsKospi => OperationId::DerivativeEqsopByddTrd,
                    DerivativeType::OptionsKosdaq => OperationId::DerivativeEqkopByddTrd,
                },
                date.as_deref(),
                false,
            ),
            TopCommand::Commodity(CommodityArgs {
                command: CommodityCommand::List { date, r#type },
            }) => (
                match r#type {
                    CommodityType::Oil => OperationId::CommodityOilByddTrd,
                    CommodityType::Gold => OperationId::CommodityGoldByddTrd,
                    CommodityType::Emission => OperationId::CommodityEtsByddTrd,
                },
                date.as_deref(),
                false,
            ),
            TopCommand::Esg(EsgArgs {
                command: EsgCommand::List { date, r#type },
            }) => (
                match r#type {
                    EsgType::SriBond => OperationId::EsgSriBondInfo,
                    EsgType::Etp => OperationId::EsgEsgEtpInfo,
                    EsgType::Index => OperationId::EsgEsgIndexInfo,
                },
                date.as_deref(),
                false,
            ),
            _ => return None,
        };
        Some(mapped)
    }
}

pub(crate) fn filter_parts(expression: &str) -> Option<(&str, &str, &str)> {
    ["==", ">=", "<=", "!=", ">", "<"]
        .into_iter()
        .find_map(|operator| {
            expression.split_once(operator).and_then(|(field, value)| {
                if !field.chars().next_back().is_some_and(char::is_whitespace)
                    || !value.chars().next().is_some_and(char::is_whitespace)
                {
                    return None;
                }
                let field = field.trim();
                let value = value.trim();
                (!field.is_empty()
                    && !value.is_empty()
                    && !field.chars().any(char::is_whitespace)
                    && !field.chars().any(|ch| "=!<>".contains(ch)))
                .then_some((field, operator, value))
            })
        })
}

fn parse_cli_date(value: &str) -> Result<TradingDate, String> {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Date must be YYYYMMDD format (8 digits)".into());
    }
    let date = TradingDate::parse(value)
        .map_err(|_| "Invalid date. Must be a valid date from 2010 onwards.".to_owned())?;
    let year = value
        .get(..4)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if !(2010..=2100).contains(&year) {
        return Err("Invalid date. Must be a valid date from 2010 onwards.".into());
    }
    Ok(date)
}

fn parse_operation_value(value: &str) -> Result<OperationId, String> {
    OperationId::ALL
        .into_iter()
        .find(|operation| operation.as_str() == value)
        .ok_or_else(|| format!("unknown operation: {value}"))
}

fn is_schema_command(value: &str) -> bool {
    OperationId::ALL.into_iter().any(|operation| {
        operation.as_str().eq_ignore_ascii_case(value)
            || operation
                .as_str()
                .split_once('_')
                .is_some_and(|(category, suffix)| {
                    format!("{category}.{suffix}").eq_ignore_ascii_case(value)
                })
    })
}

fn is_base_info(operation: OperationId) -> bool {
    matches!(
        operation,
        OperationId::StockStkIsuBaseInfo
            | OperationId::StockKsqIsuBaseInfo
            | OperationId::StockKnxIsuBaseInfo
    )
}

fn is_exact_security_code(value: &str) -> bool {
    (value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit()))
        || (value.len() == 12
            && value.starts_with("KR")
            && value[2..].bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).expect("valid topology")
    }

    #[test]
    fn filter_grammar_requires_exact_double_equals() {
        assert_eq!(
            filter_parts("MKT_NM == 'KOSPI'"),
            Some(("MKT_NM", "==", "'KOSPI'"))
        );
        assert!(filter_parts("MKT_NM = KOSPI").is_none());
        assert!(filter_parts("MKT_NM === KOSPI").is_none());
        assert!(filter_parts("MKT_NM==KOSPI").is_none());
    }

    #[test]
    fn retries_are_rejected_for_ranges() {
        let cli = parse(&[
            "krx",
            "--from",
            "20260101",
            "--to",
            "20260102",
            "--retries",
            "1",
            "stock",
            "list",
        ]);
        assert_eq!(
            cli.validate_policy().unwrap_err(),
            "--retries is only valid for a direct single-endpoint request"
        );
    }

    #[test]
    fn no_adjusted_requires_an_exact_code_range() {
        let direct = parse(&[
            "krx",
            "stock",
            "list",
            "--no-adjusted",
            "--date",
            "20260102",
        ]);
        assert!(direct.validate_policy().is_err());

        let range = parse(&[
            "krx",
            "--from",
            "20260101",
            "--to",
            "20260102",
            "--code",
            "005930",
            "stock",
            "list",
            "--no-adjusted",
        ]);
        assert!(range.validate_policy().is_ok());
    }

    #[test]
    fn semantic_leaf_values_are_rejected_during_policy_validation() {
        for args in [
            &["krx", "stock", "list"][..],
            &["krx", "stock", "list", "--date", "not-a-date"],
            &[
                "krx", "--from", "20260103", "--to", "20260102", "stock", "list",
            ],
            &["krx", "cache", "inspect", "--operation", "unknown"],
            &["krx", "cache", "prune", "--older-than", "yesterday"],
            &["krx", "watchlist", "remove", "../watchlist"],
        ] {
            let cli = parse(args);
            assert!(cli.validate_policy().is_err(), "accepted {args:?}");
        }
        assert_eq!(
            parse_cli_date("not-a-date").unwrap_err(),
            "Date must be YYYYMMDD format (8 digits)"
        );
        assert_eq!(
            parse_cli_date("20091231").unwrap_err(),
            "Invalid date. Must be a valid date from 2010 onwards."
        );
    }
}
