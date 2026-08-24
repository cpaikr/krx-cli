use std::fmt::Debug;
use std::io::{self, IsTerminal, Read};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::locale;
use krx_sdk::{
    ApiKey, CacheInspectOptions, CacheObservation, CachePolicy, CachePruneOptions, CallOptions,
    Cancellation, Client, Completeness, CompletenessState, CredentialSource, DirectRequest,
    Freshness, KrxError, KrxErrorKind, MarketComponent, MarketSummaryRequest, ObservationBuffer,
    ObservationPhase, OperationDescription, OperationId, RangeMode, RangeRequest, ResultProvenance,
    ResultSource, Row, SearchMarket, SecurityCode, StockSearchRequest, TradingDate, WatchlistEntry,
    WatchlistMarket, WatchlistPricesRequest,
};
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use crate::args::{
    AuthArgs, AuthCommand, CacheArgs, CacheCommand, Cli, MarketArgs, MarketCommand, OutputFormat,
    SchemaArgs, StockArgs, StockCommand, TopCommand, WatchlistArgs, WatchlistCommand, filter_parts,
};

pub async fn execute(cli: Cli) -> i32 {
    match execute_inner(&cli).await {
        Ok(exit) => exit,
        Err(error) => {
            eprintln!(
                "krx: error[{}/{}]: {}",
                error.kind, error.code, error.message
            );
            error.exit
        }
    }
}

#[derive(Debug)]
struct Failure {
    kind: &'static str,
    code: &'static str,
    message: String,
    exit: i32,
}

impl Failure {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid_request",
            code: "invalid_argument",
            message: message.into(),
            exit: 2,
        }
    }
    fn local(message: impl Into<String>) -> Self {
        Self {
            kind: "local_state",
            code: "internal_failure",
            message: message.into(),
            exit: 1,
        }
    }
}

impl From<KrxError> for Failure {
    fn from(error: KrxError) -> Self {
        let exit = match error.kind() {
            KrxErrorKind::InvalidRequest => 2,
            KrxErrorKind::Authentication => 4,
            KrxErrorKind::Approval => 6,
            KrxErrorKind::RateLimit => 5,
            _ => 1,
        };
        Self {
            kind: error.kind().as_str(),
            code: error.code().as_str(),
            message: error.message().to_owned(),
            exit,
        }
    }
}

async fn execute_inner(cli: &Cli) -> Result<i32, Failure> {
    if matches!(cli.command, TopCommand::Version) {
        println!(
            "{}",
            pretty(&json!({ "current": env!("CARGO_PKG_VERSION") }))?
        );
        return Ok(0);
    }

    let observations = ObservationBuffer::new();
    let client = Client::builder()
        .observations(observations.clone())
        .build()?;
    let cancellation = Cancellation::new();
    let signal_cancellation = cancellation.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancellation.cancel();
        }
    });

    if let Some((operation, leaf_date, adjusted)) = cli.endpoint() {
        return execute_endpoint(
            cli,
            &client,
            operation,
            leaf_date,
            adjusted,
            cancellation,
            &observations,
        )
        .await;
    }

    let result = async {
        match &cli.command {
        TopCommand::Auth(args) => execute_auth(args, cli, &client, cancellation).await,
        TopCommand::Stock(StockArgs {
            command: StockCommand::Search { query },
        }) => {
            let result = client
                .search_stocks(StockSearchRequest::new(
                    query,
                    call_options(cli, cancellation)?,
                )?)
                .await?;
            let fields = selected_fields(cli);
            let data = result
                .data
                .iter()
                .map(|item| {
                    let row = json!({
                        "ISU_CD": item.isu_cd, "ISU_SRT_CD": item.isu_srt_cd,
                        "ISU_NM": item.isu_nm, "MKT_NM": market_name(item.market),
                    });
                    project_value(row, fields.as_deref())
                })
                .collect::<Vec<_>>();
            let value = composite_value(
                result.success,
                Value::Array(data),
                &result.completeness,
                &result.provenance,
                result.error.as_ref(),
                search_market_id,
            );
            println!("{}", pretty(&value)?);
            composite_exit(
                &result.completeness,
                result.error.as_ref(),
                "Stock search",
                search_market_id,
            )
        }
        TopCommand::Schema(args) => execute_schema(args, &client),
        TopCommand::Cache(args) => execute_cache(args, &client).await,
        TopCommand::Market(MarketArgs {
            command: MarketCommand::Summary { date },
        }) => {
            let date = requested_or_recent(date.as_deref(), &client)?;
            let result = client
                .market_summary(MarketSummaryRequest::new(
                    date,
                    call_options(cli, cancellation)?,
                ))
                .await?;
            let data = json!({
                "date": result.data.date.as_str(),
                "kospiIndex": result.data.kospi_index.as_ref().map(|rows| rows_value(rows, None)),
                "kosdaqIndex": result.data.kosdaq_index.as_ref().map(|rows| rows_value(rows, None)),
                "stockStats": result.data.stock_stats.as_ref().map(|s| json!({"advancing":s.advancing,"declining":s.declining,"unchanged":s.unchanged,"totalVolume":s.total_volume,"totalValue":s.total_value})),
                "topGainers": result.data.top_gainers.as_ref().map(|rows| rows_value(rows, None)),
                "topLosers": result.data.top_losers.as_ref().map(|rows| rows_value(rows, None)),
            });
            let value = composite_value(
                result.success,
                data,
                &result.completeness,
                &result.provenance,
                result.error.as_ref(),
                market_component_id,
            );
            println!("{}", pretty(&value)?);
            composite_exit(
                &result.completeness,
                result.error.as_ref(),
                "Market summary",
                market_component_id,
            )
        }
        TopCommand::Watchlist(args) => execute_watchlist(args, cli, &client, cancellation).await,
        TopCommand::Index(_)
        | TopCommand::Etp(_)
        | TopCommand::Bond(_)
        | TopCommand::Derivative(_)
        | TopCommand::Commodity(_)
        | TopCommand::Esg(_)
        | TopCommand::Version => unreachable!(),
            TopCommand::Stock(_) => unreachable!(),
        }
    }
    .await;
    render_sdk_observations(cli, &observations);
    result
}

fn call_options(cli: &Cli, cancellation: Cancellation) -> Result<CallOptions, Failure> {
    let defaults = CallOptions::default();
    let default_retries = defaults.retries;
    let default_cache = defaults.cache;
    let cache = if cli.offline {
        CachePolicy::Offline
    } else if cli.no_cache {
        CachePolicy::Bypass
    } else if cli.refresh {
        CachePolicy::Refresh
    } else {
        match std::env::var_os("KRX_CACHE_MAX_AGE_HOURS") {
            Some(value) => {
                let hours = value
                    .to_str()
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|hours| *hours <= 8_760)
                    .ok_or_else(|| {
                        Failure::invalid("KRX_CACHE_MAX_AGE_HOURS must be between 0 and 8760")
                    })?;
                CachePolicy::Prefer {
                    max_age: Duration::from_secs(hours * 3_600),
                }
            }
            None => default_cache,
        }
    };
    Ok(CallOptions {
        cache,
        retries: cli.retries.unwrap_or(default_retries),
        cancellation,
    })
}

async fn execute_endpoint(
    cli: &Cli,
    client: &Client,
    operation: OperationId,
    leaf_date: Option<&str>,
    adjusted: bool,
    cancellation: Cancellation,
    observations: &ObservationBuffer,
) -> Result<i32, Failure> {
    let description = client
        .capabilities()
        .iter()
        .find(|d| d.operation_id == operation)
        .ok_or_else(|| Failure::invalid("unknown operation"))?;
    verbose(cli, format!("endpoint: {}", description.path));
    let explicit_date = leaf_date.or(cli.from.as_deref());
    let date = if let Some(value) = explicit_date {
        parse_date(value)?
    } else if is_base_info(operation) {
        client.recent_trading_date()?
    } else {
        return Err(Failure::invalid("either --date or --from/--to is required"));
    };
    let should_adjust = adjusted
        && cli.from.is_some()
        && cli.code.as_deref().and_then(short_security_code).is_some();

    if cli.dry_run {
        if client.credentials().status().await?.source == CredentialSource::Missing {
            return Err(Failure {
                kind: "authentication",
                code: "credential_missing",
                message: "No API key configured".into(),
                exit: 4,
            });
        }
        let mut params = Map::new();
        params.insert(description.request_field.to_owned(), json!(date.as_str()));
        let mut headers = Map::new();
        headers.insert(description.auth_header.to_owned(), json!("***"));
        let output = json!({
            "method": description.method,
            "endpoint": description.path,
            "params": params,
            "clientFilter": cli.code.as_ref().map(|code| json!({"ISU_CD": code})),
            "adjusted": should_adjust,
            "headers": headers,
        });
        println!("{}", pretty(&output)?);
        return Ok(0);
    }

    let options = call_options(cli, cancellation)?;
    let (mut rows, envelope, provenance) = if let (Some(from), Some(to)) = (&cli.from, &cli.to) {
        let range = krx_sdk::DateRange::new(parse_date(from)?, parse_date(to)?)?;
        let mode = if should_adjust {
            RangeMode::Adjusted {
                security_code: SecurityCode::parse(
                    short_security_code(cli.code.as_deref().unwrap()).expect("checked"),
                )?,
            }
        } else {
            RangeMode::Raw
        };
        let result = client
            .range(RangeRequest {
                operation,
                range,
                mode,
                options,
            })
            .await;
        render_sdk_observations(cli, observations);
        let result = result?;
        let rows = result.result.data.clone();
        if result.failed_days > 0 {
            verbose(
                cli,
                format!("{} date-range component(s) failed", result.failed_days),
            );
        }
        (rows, Some(range_value(&result)), None)
    } else {
        let result = client
            .query(DirectRequest {
                operation,
                date: date.clone(),
                options,
            })
            .await;
        render_sdk_observations(cli, observations);
        let result = result?;
        let provenance = result.provenance.clone();
        (result.rows, None, Some(provenance))
    };

    if let Some(code) = cli.code.as_deref() {
        rows.retain(|row| matches_code(row, code));
    }
    if envelope.is_none() && rows.is_empty() {
        return Ok(no_data(&direct_no_data_message(operation, &date, None)));
    }
    let before_pipeline = rows.len();
    apply_pipeline(&mut rows, cli)?;
    verbose(
        cli,
        format!("pipeline: {} → {} rows", before_pipeline, rows.len()),
    );
    if envelope.is_none() && rows.is_empty() {
        return Ok(no_data(&direct_no_data_message(
            operation,
            &date,
            cli.filter.as_deref(),
        )));
    }
    let fields = selected_fields(cli);

    if cli.offline
        && let Some(provenance) = provenance.as_ref()
    {
        eprintln!(
            "krx: provenance {}",
            compact(&provenance_value(provenance))?
        );
    }

    let rendered = if let Some(mut value) = envelope {
        value["data"] = rows_value(&rows, fields.as_deref());
        if rows.is_empty()
            && value.pointer("/completeness/state").and_then(Value::as_str) == Some("complete")
        {
            value["completeness"]["state"] = json!("empty");
        }
        let exit_code = envelope_exit(&value, "Date-range result")?;
        let rendered = pretty(&value)?;
        if let Some(path) = &cli.save {
            save_output(path, &rendered)?;
            println!("{}", compact(&json!({"saved":path,"records":rows.len()}))?);
        } else {
            println!("{rendered}");
        }
        return Ok(exit_code);
    } else {
        render_rows(&rows, cli.output, fields.as_deref(), description)?
    };
    if let Some(path) = &cli.save {
        save_output(path, &rendered)?;
        println!("{}", compact(&json!({"saved":path,"records":rows.len()}))?);
    } else {
        println!("{rendered}");
    }
    Ok(0)
}

async fn execute_auth(
    args: &AuthArgs,
    cli: &Cli,
    client: &Client,
    cancellation: Cancellation,
) -> Result<i32, Failure> {
    match &args.command {
        AuthCommand::Set { stdin } => {
            let secret = Zeroizing::new(read_secret(*stdin)?);
            client
                .credentials()
                .set(ApiKey::parse(secret.as_str())?)
                .await?;
            println!(
                "{}",
                compact(&json!({"success":true,"message":"API key saved"}))?
            );
        }
        AuthCommand::Remove => {
            let removed = client.credentials().remove().await?;
            let mut value = json!({"success":true,"message":if removed {"Persisted API key removed"} else {"No persisted API key found"}});
            if std::env::var_os("KRX_API_KEY").is_some() {
                value["note"] = json!("KRX_API_KEY remains active for this process");
            }
            println!("{}", compact(&value)?);
        }
        AuthCommand::Status => {
            let status = client.credentials().status().await?;
            if status.source == CredentialSource::Missing {
                return Err(Failure {
                    kind: "authentication",
                    code: "credential_missing",
                    message: "KRX credential is missing".into(),
                    exit: 4,
                });
            }
            eprintln!("Error: Checking service approvals...");
            let credentials = client.credentials();
            let observations = credentials.check_all_approvals(cancellation).await?;
            let services = Map::from_iter(observations.iter().map(|observation| {
                (
                    observation.category.as_str().to_owned(),
                    approval_value(observation, false),
                )
            }));
            let value = json!({"api_key_set":true,"services":services});
            let format = cli.output.unwrap_or_else(|| {
                if io::stdout().is_terminal() {
                    OutputFormat::Table
                } else {
                    OutputFormat::Json
                }
            });
            match format {
                OutputFormat::Json | OutputFormat::Ndjson => println!("{}", pretty(&value)?),
                OutputFormat::Table | OutputFormat::Csv => {
                    println!("{}", auth_status_table(&observations));
                }
            }
        }
        AuthCommand::Check { category } => {
            let observation = client
                .credentials()
                .check_approval((*category).into(), cancellation)
                .await?;
            println!("{}", pretty(&approval_value(&observation, true))?);
        }
        AuthCommand::Migrate => {
            let result = client.credentials().migrate_legacy().await?;
            println!(
                "{}",
                pretty(
                    &json!({"migrated":result.migrated,"legacySecretRemoved":result.legacy_secret_removed,"approvalsMigrated":result.approvals_migrated})
                )?
            );
        }
    }
    Ok(0)
}

fn approval_value(value: &krx_sdk::ApprovalObservation, include_category: bool) -> Value {
    let state = debug_name(value.state);
    let mut output = Map::from_iter([
        ("state".to_owned(), json!(state)),
        ("fresh".to_owned(), json!(value.fresh)),
        ("checkedAt".to_owned(), json!(time_value(value.checked_at))),
        (
            "validUntil".to_owned(),
            json!(time_value(value.valid_until)),
        ),
    ]);
    if include_category {
        output.insert("category".to_owned(), json!(debug_name(value.category)));
    }
    match value.state {
        krx_sdk::ApprovalState::Approved => {
            output.insert("approved".to_owned(), json!(true));
        }
        krx_sdk::ApprovalState::Rejected => {
            output.insert("approved".to_owned(), json!(false));
        }
        krx_sdk::ApprovalState::Inconclusive => {}
    }
    if let Some(error) = value.error.as_ref() {
        output.insert("failureType".to_owned(), json!(error.kind().as_str()));
        output.insert("error".to_owned(), json!(error.message()));
    } else if value.state == krx_sdk::ApprovalState::Inconclusive {
        output.insert("failureType".to_owned(), json!("no_data"));
    }
    Value::Object(output)
}

fn auth_status_table(observations: &[krx_sdk::ApprovalObservation]) -> String {
    let headers = ["category", "name", "approved", "checked_at"]
        .map(str::to_owned)
        .to_vec();
    let rows = observations
        .iter()
        .map(|observation| {
            vec![
                observation.category.as_str().to_owned(),
                observation.category.display_name_ko().to_owned(),
                debug_name(observation.state).to_ascii_uppercase(),
                time_value(observation.checked_at),
            ]
        })
        .collect::<Vec<_>>();
    format_table(&headers, &rows)
}

fn execute_schema(args: &SchemaArgs, client: &Client) -> Result<i32, Failure> {
    let schemas = client
        .capabilities()
        .iter()
        .map(schema_value)
        .collect::<Vec<_>>();
    if args.all || args.command.is_none() {
        println!("{}", pretty(&Value::Array(schemas))?);
        return Ok(0);
    }
    let needle = args.command.as_deref().unwrap();
    let found = client
        .capabilities()
        .iter()
        .find(|description| {
            description
                .operation_id
                .as_str()
                .eq_ignore_ascii_case(needle)
                || legacy_command(description).eq_ignore_ascii_case(needle)
        })
        .ok_or_else(|| {
            Failure::invalid(format!(
                "unknown command: {needle}; use 'krx schema --all' to list all"
            ))
        })?;
    println!("{}", pretty(&schema_value(found))?);
    Ok(0)
}

fn schema_value(description: &OperationDescription) -> Value {
    let mut value = json!({
        "command":legacy_command(description), "endpoint":description.path,
        "description":description.description, "descriptionKo":description.description_ko,
        "category":debug_name(description.category),
        "params":description.request_fields.iter().map(|f|json!({"name":f.name,"type":"string","required":true,"description":f.description})).collect::<Vec<_>>(),
        "responseFields":description.response_fields.iter().map(|f|json!({"name":f.name,"description":f.description})).collect::<Vec<_>>(),
    });
    if let Some(derived) = description.derived_output {
        value["derivedOutput"] = json!({
            "provenance": derived.provenance,
            "eligibleEndpoints": derived.eligible_endpoints,
            "defaultForEligibleSingleSecurityRanges": derived.default_for_eligible_single_security_ranges,
            "optOut": {"cli": derived.cli_opt_out},
            "fields": derived.fields.iter().map(|field| json!({
                "name": field.name,
                "type": field.field_type,
                "description": field.description,
            })).collect::<Vec<_>>(),
            "envelopeField": derived.envelope_field,
        });
    }
    value
}

fn legacy_command(description: &OperationDescription) -> String {
    let category = debug_name(description.category);
    let suffix = description
        .operation_id
        .as_str()
        .strip_prefix(&format!("{category}_"))
        .unwrap_or(description.operation_id.as_str());
    format!("{category}.{suffix}")
}

async fn execute_cache(args: &CacheArgs, client: &Client) -> Result<i32, Failure> {
    match &args.command {
        CacheCommand::Status => {
            let result = client
                .cache()
                .inspect(CacheInspectOptions::default())
                .await?;
            println!(
                "{}",
                pretty(
                    &json!({"dates":result.total_dates,"files":result.total_entries,"sizeBytes":result.total_size_bytes,"sizeMB":((result.total_size_bytes as f64/1048576.0)*100.0).round()/100.0})
                )?
            );
        }
        CacheCommand::Clear => {
            let result = client.cache().clear().await?;
            println!(
                "{}",
                pretty(&json!({"cleared":true,"files":result.removed_entries,"directories":0}))?
            );
        }
        CacheCommand::Inspect {
            operation,
            date,
            limit,
        } => {
            let operation = operation.as_deref().map(parse_operation).transpose()?;
            let date = date.as_deref().map(parse_date).transpose()?;
            let result = client
                .cache()
                .inspect(CacheInspectOptions {
                    operation,
                    date,
                    limit: Some(*limit),
                })
                .await?;
            let entries = result.entries.iter().map(|e|json!({"operation":e.operation.as_str(),"date":e.date.as_str(),"fetchedAt":time_value(e.fetched_at),"freshness":debug_name(e.freshness),"sizeBytes":e.size_bytes,"contractId":e.contract_id})).collect::<Vec<_>>();
            println!(
                "{}",
                pretty(
                    &json!({"entries":entries,"totalEntries":result.total_entries,"totalDates":result.total_dates,"totalSizeBytes":result.total_size_bytes,"truncated":result.truncated})
                )?
            );
        }
        CacheCommand::Prune {
            older_than,
            max_entries,
        } => {
            let older_than = older_than.as_deref().map(parse_instant).transpose()?;
            let result = client
                .cache()
                .prune(CachePruneOptions {
                    older_than,
                    max_entries: *max_entries,
                })
                .await?;
            println!(
                "{}",
                pretty(
                    &json!({"removedEntries":result.removed_entries,"removedBytes":result.removed_bytes})
                )?
            );
        }
    }
    Ok(0)
}

async fn execute_watchlist(
    args: &WatchlistArgs,
    cli: &Cli,
    client: &Client,
    cancellation: Cancellation,
) -> Result<i32, Failure> {
    match &args.command {
        WatchlistCommand::List => {
            let entries = client.watchlist().list().await?;
            if entries.is_empty() {
                println!(
                    "{}",
                    compact(&json!({"message":"Watchlist is empty","entries":[]}))?
                );
            } else {
                println!(
                    "{}",
                    pretty(&Value::Array(
                        entries.iter().map(watchlist_entry_value).collect()
                    ))?
                );
            }
            Ok(0)
        }
        WatchlistCommand::Remove { name } => {
            if !client.watchlist().remove(name).await? {
                return Ok(no_data(&format!("'{name}' not found in watchlist")));
            }
            println!(
                "{}",
                compact(&json!({"message":format!("Removed '{name}' from watchlist")}))?
            );
            Ok(0)
        }
        WatchlistCommand::Add { name } => {
            let result = client
                .search_stocks(StockSearchRequest::new(
                    name,
                    call_options(cli, cancellation)?,
                )?)
                .await?;
            if result.completeness.state != CompletenessState::Complete {
                let value = composite_value(
                    result.success,
                    Value::Array(result.data.iter().map(search_match_value).collect()),
                    &result.completeness,
                    &result.provenance,
                    result.error.as_ref(),
                    search_market_id,
                );
                println!("{}", pretty(&value)?);
                return composite_exit(
                    &result.completeness,
                    result.error.as_ref(),
                    "Watchlist stock search",
                    search_market_id,
                );
            }
            if result.data.is_empty() {
                return Ok(no_data(&format!("No stock found matching '{name}'")));
            }
            if result.data.len() != 1 {
                println!(
                    "{}",
                    pretty(
                        &json!({"message":format!("Multiple matches found for '{name}'. Please be more specific."),"matches":result.data.iter().map(search_match_value).collect::<Vec<_>>() })
                    )?
                );
                return Ok(2);
            }
            let stock = &result.data[0];
            let market = match stock.market {
                krx_sdk::SearchMarket::Kospi => WatchlistMarket::Kospi,
                krx_sdk::SearchMarket::Kosdaq => WatchlistMarket::Kosdaq,
            };
            let entry =
                WatchlistEntry::new(&stock.isu_cd, &stock.isu_srt_cd, &stock.isu_nm, market)?;
            if !client.watchlist().add(entry.clone()).await? {
                eprintln!("Error: '{}' is already in watchlist", stock.isu_nm);
                return Ok(0);
            }
            println!(
                "{}",
                compact(
                    &json!({"message":format!("Added '{}' ({}) to watchlist",stock.isu_nm,stock.isu_cd),"entry":watchlist_entry_value(&entry)})
                )?
            );
            Ok(0)
        }
        WatchlistCommand::Show { date } => {
            let entries = client.watchlist().list().await?;
            if entries.is_empty() {
                println!(
                    "{}",
                    compact(&json!({"message":"Watchlist is empty","entries":[]}))?
                );
                return Ok(0);
            }
            let date = requested_or_recent(date.as_deref(), client)?;
            let codes = entries
                .iter()
                .map(|entry| entry.security_code.clone())
                .collect::<Vec<_>>();
            let result = client
                .watchlist_prices(WatchlistPricesRequest::new(
                    date,
                    codes,
                    call_options(cli, cancellation)?,
                )?)
                .await?;
            let data = json!({"date":result.data.date.as_str(),"stocks":rows_value(&result.data.stocks,None)});
            let value = composite_value(
                result.success,
                data,
                &result.completeness,
                &result.provenance,
                result.error.as_ref(),
                watchlist_market_id,
            );
            println!("{}", pretty(&value)?);
            composite_exit(
                &result.completeness,
                result.error.as_ref(),
                "Watchlist prices",
                watchlist_market_id,
            )
        }
    }
}

fn search_match_value(item: &krx_sdk::StockSearchMatch) -> Value {
    json!({"ISU_CD":item.isu_cd,"ISU_SRT_CD":item.isu_srt_cd,"ISU_NM":item.isu_nm,"MKT_NM":market_name(item.market)})
}
fn watchlist_entry_value(entry: &WatchlistEntry) -> Value {
    json!({"isuCd":entry.isin,"isuSrtCd":entry.security_code.as_str(),"name":entry.name,"market":watchlist_market_name(entry.market)})
}

fn requested_or_recent(value: Option<&str>, client: &Client) -> Result<TradingDate, Failure> {
    value
        .map(parse_date)
        .unwrap_or_else(|| client.recent_trading_date().map_err(Into::into))
}
fn parse_date(value: &str) -> Result<TradingDate, Failure> {
    let date = TradingDate::parse(value)?;
    let year = value
        .get(..4)
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(0);
    if !(2010..=2100).contains(&year) {
        return Err(Failure::invalid("date year must be between 2010 and 2100"));
    }
    Ok(date)
}
fn parse_operation(value: &str) -> Result<OperationId, Failure> {
    OperationId::ALL
        .into_iter()
        .find(|v| v.as_str() == value)
        .ok_or_else(|| Failure::invalid(format!("unknown operation: {value}")))
}
fn parse_instant(value: &str) -> Result<SystemTime, Failure> {
    let timestamp: jiff::Timestamp = value
        .parse()
        .map_err(|_| Failure::invalid("--older-than must be an RFC 3339 instant"))?;
    Ok(SystemTime::from(timestamp))
}

fn apply_pipeline(rows: &mut Vec<Row>, cli: &Cli) -> Result<(), Failure> {
    if let Some(expression) = &cli.filter {
        rows.retain(|row| matches_filter(row, expression).unwrap_or(false));
    }
    if let Some(field) = &cli.sort {
        let collator = Collator::try_new(locale!("ko").into(), CollatorOptions::default())
            .map_err(|_| Failure::local("Korean collation data is unavailable"))?;
        rows.sort_by(|a, b| {
            compare_sort_values(
                a.get(field).unwrap_or(""),
                b.get(field).unwrap_or(""),
                &collator,
            )
        });
        if !cli.asc {
            rows.reverse();
        }
    }
    let offset = cli.offset.unwrap_or(0).min(rows.len());
    if offset > 0 {
        rows.drain(..offset);
    }
    if let Some(limit) = cli.limit {
        rows.truncate(limit);
    }
    Ok(())
}
fn matches_filter(row: &Row, expression: &str) -> Option<bool> {
    let (field, op, want) = filter_parts(expression)?;
    let got = row.get(field)?;
    let order = compare_filter_values(got, want);
    Some(match op {
        "==" => order.is_eq(),
        "!=" => !order.is_eq(),
        ">" => order.is_gt(),
        "<" => order.is_lt(),
        ">=" => !order.is_lt(),
        "<=" => !order.is_gt(),
        _ => false,
    })
}
fn compare_filter_values(left: &str, right: &str) -> std::cmp::Ordering {
    match (
        left.replace(',', "").parse::<f64>(),
        right.replace(',', "").parse::<f64>(),
    ) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        _ => left.cmp(right),
    }
}
fn compare_sort_values(
    left: &str,
    right: &str,
    collator: &CollatorBorrowed<'_>,
) -> std::cmp::Ordering {
    match (
        left.replace(',', "").parse::<f64>(),
        right.replace(',', "").parse::<f64>(),
    ) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        _ => collator.compare(left, right),
    }
}
fn matches_code(row: &Row, query: &str) -> bool {
    let isin = row.get("ISU_CD").unwrap_or("");
    let short = row.get("ISU_SRT_CD").unwrap_or("");
    isin == query
        || short == query
        || (short_security_code(query).is_some_and(|code| isin == code || short == code))
}
fn short_security_code(value: &str) -> Option<&str> {
    if value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit()) {
        Some(value)
    } else if value.len() == 12
        && value.starts_with("KR")
        && value[2..].bytes().all(|b| b.is_ascii_digit())
    {
        value.get(3..9)
    } else {
        None
    }
}
fn is_base_info(operation: OperationId) -> bool {
    matches!(
        operation,
        OperationId::StockStkIsuBaseInfo
            | OperationId::StockKsqIsuBaseInfo
            | OperationId::StockKnxIsuBaseInfo
    )
}

fn direct_no_data_message(
    operation: OperationId,
    date: &TradingDate,
    filter: Option<&str>,
) -> String {
    if let Some(expression) = filter {
        format!("No results matched filter: {expression}")
    } else if is_base_info(operation) {
        "No data".to_owned()
    } else {
        format!("No data for date {}", date.as_str())
    }
}

fn selected_fields(cli: &Cli) -> Option<Vec<&str>> {
    cli.fields.as_deref().map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect()
    })
}
fn row_value(row: &Row, fields: Option<&[&str]>) -> Value {
    let mut map = Map::new();
    if let Some(fields) = fields {
        for field in fields {
            if let Some(value) = row.get(field) {
                map.insert((*field).to_owned(), json!(value));
            }
        }
    } else {
        for (field, value) in row.iter() {
            map.insert(field.to_owned(), json!(value));
        }
    }
    Value::Object(map)
}
fn rows_value(rows: &[Row], fields: Option<&[&str]>) -> Value {
    Value::Array(rows.iter().map(|row| row_value(row, fields)).collect())
}
fn project_value(value: Value, fields: Option<&[&str]>) -> Value {
    let Some(fields) = fields else { return value };
    let Value::Object(source) = value else {
        return value;
    };
    let mut target = Map::new();
    for field in fields {
        if let Some(value) = source.get(*field) {
            target.insert((*field).to_owned(), value.clone());
        }
    }
    Value::Object(target)
}

fn render_rows(
    rows: &[Row],
    format: Option<OutputFormat>,
    fields: Option<&[&str]>,
    description: &OperationDescription,
) -> Result<String, Failure> {
    let format = format.unwrap_or_else(|| {
        if io::stdout().is_terminal() {
            OutputFormat::Table
        } else {
            OutputFormat::Json
        }
    });
    let values = rows
        .iter()
        .map(|row| row_value(row, fields))
        .collect::<Vec<_>>();
    match format {
        OutputFormat::Json => pretty(&Value::Array(values)),
        OutputFormat::Ndjson => values
            .iter()
            .map(compact)
            .collect::<Result<Vec<_>, _>>()
            .map(|v| v.join("\n")),
        OutputFormat::Csv | OutputFormat::Table => {
            let headers: Vec<String> = fields
                .map(|requested| {
                    let Some(row) = rows.first() else {
                        return Vec::new();
                    };
                    let mut headers = Vec::new();
                    for field in requested {
                        if row.get(field).is_some()
                            && !headers.iter().any(|existing| existing == field)
                        {
                            headers.push((*field).to_owned());
                        }
                    }
                    headers
                })
                .unwrap_or_else(|| {
                    let Some(row) = rows.first() else {
                        return Vec::new();
                    };
                    let mut headers = description
                        .response_fields
                        .iter()
                        .filter(|field| row.get(field.name).is_some())
                        .map(|field| field.name.to_owned())
                        .collect::<Vec<_>>();
                    if let Some(derived) = description.derived_output {
                        headers.extend(
                            derived
                                .fields
                                .iter()
                                .filter(|field| row.get(field.name).is_some())
                                .map(|field| field.name.to_owned()),
                        );
                    }
                    let extra_headers = row
                        .iter()
                        .map(|(field, _)| field)
                        .filter(|field| !headers.iter().any(|known| known == field))
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    headers.extend(extra_headers);
                    headers
                });
            let rendered_rows = rows
                .iter()
                .map(|row| {
                    headers
                        .iter()
                        .map(|header| row.get(header).unwrap_or("").to_owned())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            if format == OutputFormat::Table {
                return Ok(format_table(&headers, &rendered_rows));
            }
            let mut lines = vec![
                headers
                    .iter()
                    .map(|header| csv(header))
                    .collect::<Vec<_>>()
                    .join(","),
            ];
            lines.extend(rendered_rows.iter().map(|row| {
                row.iter()
                    .map(|value| csv(value))
                    .collect::<Vec<_>>()
                    .join(",")
            }));
            Ok(lines.join("\n"))
        }
    }
}

fn format_table(headers: &[String], rows: &[Vec<String>]) -> String {
    let widths = headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            rows.iter()
                .filter_map(|row| row.get(index))
                .map(|value| value.chars().count())
                .fold(header.chars().count(), usize::max)
        })
        .collect::<Vec<_>>();
    let padded = |value: &str, width: usize| {
        format!(
            "{value}{}",
            " ".repeat(width.saturating_sub(value.chars().count()))
        )
    };
    let mut lines = vec![
        headers
            .iter()
            .zip(&widths)
            .map(|(header, width)| padded(header, *width))
            .collect::<Vec<_>>()
            .join("  "),
        widths
            .iter()
            .map(|width| "-".repeat(*width))
            .collect::<Vec<_>>()
            .join("  "),
    ];
    lines.extend(rows.iter().map(|row| {
        headers
            .iter()
            .enumerate()
            .map(|(index, _)| {
                padded(
                    row.get(index).map(String::as_str).unwrap_or(""),
                    widths[index],
                )
            })
            .collect::<Vec<_>>()
            .join("  ")
    }));
    lines.join("\n")
}

fn csv(value: &str) -> String {
    if value.contains(',') || value.contains('\"') || value.contains('\n') {
        format!("\"{}\"", value.replace('\"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn range_value(result: &krx_sdk::RangeResult) -> Value {
    let mut value = composite_value(
        result.result.success,
        rows_value(&result.result.data, None),
        &result.result.completeness,
        &result.result.provenance,
        result.result.error.as_ref(),
        |date: &TradingDate| date.as_str().to_owned(),
    );
    value["fetchedDays"] = json!(result.fetched_days);
    value["failedDays"] = json!(result.failed_days);
    value["calendar"] = json!({
        "version": result.calendar.version.parse::<u64>().map(Value::from).unwrap_or_else(|_| json!(result.calendar.version)),
        "source": result.calendar.source,
        "retrievedAt": result.calendar.retrieved_at.as_str(),
        "coverage": match result.calendar.coverage {
            krx_sdk::CalendarCoverage::Official => "verified",
            krx_sdk::CalendarCoverage::Fallback => "fallback",
        },
        "fallbackYears": result.calendar.fallback_years,
        "unverifiedDates": result.calendar.unverified_dates.iter().map(|d|d.as_str()).collect::<Vec<_>>()
    });
    if let Some(a) = &result.adjustment {
        value["adjustment"] = json!({"method":a.method,"version":a.version,"asOf":a.as_of.as_str(),"rounding":a.rounding,"rawFields":a.raw_fields,"adjustedFields":a.adjusted_fields,"factorField":"ADJ_FACTOR","transitions":a.basis_transitions.iter().map(|v|serde_json::from_str::<Value>(v).unwrap_or(json!(v))).collect::<Vec<_>>(),"cashDividends":"excluded"});
    }
    value
}
fn composite_value<Id: Ord>(
    success: bool,
    data: Value,
    completeness: &Completeness<Id>,
    provenance: &std::collections::BTreeMap<Id, ResultProvenance>,
    error: Option<&KrxError>,
    id_value: impl Fn(&Id) -> String,
) -> Value {
    let mut value = json!({
        "success": success,
        "data": data,
        "completeness": {
            "state": debug_name(completeness.state),
            "requested": completeness.requested.iter().map(&id_value).collect::<Vec<_>>(),
            "succeeded": completeness.succeeded.iter().map(&id_value).collect::<Vec<_>>(),
            "failed": completeness.failed.iter().map(|failure| json!({
                "id": id_value(&failure.id),
                "error": failure.error.message(),
                "errorType": failure.error.kind().as_str(),
            })).collect::<Vec<_>>(),
            "skipped": completeness.skipped.iter().map(&id_value).collect::<Vec<_>>(),
        },
        "provenance": provenance
            .iter()
            .map(|(id, value)| (id_value(id), provenance_value(value)))
            .collect::<serde_json::Map<_, _>>(),
    });
    if let Some(error) = error {
        value["error"] = json!(error.message());
        value["errorType"] = json!(error.kind().as_str());
    }
    value
}
fn provenance_value(value: &ResultProvenance) -> Value {
    json!({"source":result_source_name(value.source),"fetchedAt":time_value(value.fetched_at),"freshness":freshness_name(value.freshness),"contractId":value.contract_id})
}

fn result_source_name(source: ResultSource) -> &'static str {
    match source {
        ResultSource::Network => "network",
        ResultSource::Cache => "cache",
    }
}

fn freshness_name(freshness: Freshness) -> &'static str {
    match freshness {
        Freshness::Fresh => "fresh",
        Freshness::Stale => "stale",
    }
}

fn verbose(cli: &Cli, message: impl std::fmt::Display) {
    if cli.verbose {
        eprintln!("[verbose] {message}");
    }
}

fn render_sdk_observations(cli: &Cli, observations: &ObservationBuffer) {
    for observation in observations.take() {
        if let ObservationPhase::Quota {
            count,
            limit,
            warning: true,
            ..
        } = &observation.phase
        {
            eprintln!("Warning: {count}/{limit} advisory KRX API calls reserved today (KST)");
        }
        if !cli.verbose {
            continue;
        }
        match observation.phase {
            ObservationPhase::Cache { path, action, .. } => {
                let label = match action {
                    CacheObservation::Hit => "cache hit",
                    CacheObservation::Miss => "cache miss",
                    CacheObservation::Refresh => "cache refresh",
                    CacheObservation::Bypass => "cache bypass",
                    CacheObservation::Invalid => "cache invalid",
                };
                verbose(cli, format!("{label} — {path}"));
            }
            ObservationPhase::Range {
                to,
                requestable_days,
                known_non_trading_days,
                fallback_years,
                unverified_days,
            } => {
                verbose(
                    cli,
                    format!(
                        "date range: {}~{} → {requestable_days} requestable, {known_non_trading_days} known non-trading",
                        observation.date.as_str(),
                        to.as_str()
                    ),
                );
                if !fallback_years.is_empty() {
                    verbose(
                        cli,
                        format!(
                            "KRX calendar fallback: {unverified_days} uncovered weekday(s) will be probed"
                        ),
                    );
                }
            }
            ObservationPhase::Request { method, url, body } => {
                verbose(cli, format!("{method} {url} {body}"));
            }
            ObservationPhase::Quota { count, limit, .. } => verbose(
                cli,
                format!("advisory rate limit: {count}/{limit} calls reserved today (KST)"),
            ),
            ObservationPhase::Retry {
                attempt,
                maximum_retries,
                delay_ms,
                ..
            } => verbose(
                cli,
                format!("retry {attempt}/{maximum_retries} after {delay_ms}ms"),
            ),
            ObservationPhase::Response {
                rows: Some(rows),
                elapsed_ms,
                ..
            } => verbose(cli, format!("response: {rows} rows in {elapsed_ms}ms")),
            ObservationPhase::Response { rows: None, .. } => {}
        }
    }
}
fn composite_exit<Id>(
    completeness: &Completeness<Id>,
    error: Option<&KrxError>,
    label: &str,
    id_value: impl Fn(&Id) -> String,
) -> Result<i32, Failure> {
    match completeness.state {
        CompletenessState::Complete => Ok(0),
        CompletenessState::Partial => {
            let failed = completeness
                .failed
                .iter()
                .map(|failure| id_value(&failure.id))
                .collect::<Vec<_>>()
                .join(", ");
            eprintln!(
                "Warning: {label} is partial; failed component(s): {}",
                if failed.is_empty() {
                    "unknown"
                } else {
                    &failed
                }
            );
            Ok(7)
        }
        CompletenessState::Empty => Ok(3),
        CompletenessState::Failed => Ok(error.map(|e| Failure::from(e.clone()).exit).unwrap_or(1)),
    }
}
fn envelope_exit(value: &Value, label: &str) -> Result<i32, Failure> {
    match value.pointer("/completeness/state").and_then(Value::as_str) {
        Some("complete") => Ok(0),
        Some("partial") => {
            let failed = value
                .pointer("/completeness/failed")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|failure| failure.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            eprintln!(
                "Warning: {label} is partial; failed component(s): {}",
                if failed.is_empty() {
                    "unknown"
                } else {
                    &failed
                }
            );
            Ok(7)
        }
        Some("empty") => Ok(3),
        Some("failed") => Ok(match value.get("errorType").and_then(Value::as_str) {
            Some("invalid_request") => 2,
            Some("authentication") => 4,
            Some("rate_limit") => 5,
            Some("approval") => 6,
            _ => 1,
        }),
        _ => Ok(1),
    }
}

fn no_data(message: &str) -> i32 {
    eprintln!("Error: {message}");
    3
}
fn save_output(path: &str, output: &str) -> Result<(), Failure> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Failure::local(format!("failed to create output directory: {e}")))?;
    }
    std::fs::write(path, format!("{output}\n"))
        .map_err(|e| Failure::local(format!("failed to save output: {e}")))
}
fn pretty(value: &Value) -> Result<String, Failure> {
    serde_json::to_string_pretty(value)
        .map_err(|e| Failure::local(format!("JSON serialization failed: {e}")))
}
fn compact(value: &Value) -> Result<String, Failure> {
    serde_json::to_string(value)
        .map_err(|e| Failure::local(format!("JSON serialization failed: {e}")))
}
fn time_value(value: SystemTime) -> String {
    jiff::Timestamp::try_from(value)
        .map(|value| format!("{value:.3}"))
        .unwrap_or_else(|_| {
            value
                .duration_since(UNIX_EPOCH)
                .map(|v| v.as_secs().to_string())
                .unwrap_or_default()
        })
}
fn debug_name(value: impl Debug) -> String {
    let source = format!("{value:?}");
    let mut out = String::new();
    for (index, ch) in source.chars().enumerate() {
        if ch.is_ascii_uppercase() && index > 0 {
            out.push('_');
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

fn market_name(value: krx_sdk::SearchMarket) -> &'static str {
    match value {
        krx_sdk::SearchMarket::Kospi => "KOSPI",
        krx_sdk::SearchMarket::Kosdaq => "KOSDAQ",
    }
}

fn search_market_id(value: &SearchMarket) -> String {
    market_name(*value).to_owned()
}

fn market_component_id(value: &MarketComponent) -> String {
    match value {
        MarketComponent::KospiIndex => "kospiIndex",
        MarketComponent::KosdaqIndex => "kosdaqIndex",
        MarketComponent::KospiStocks => "kospiStocks",
        MarketComponent::KosdaqStocks => "kosdaqStocks",
    }
    .to_owned()
}

fn watchlist_market_id(value: &WatchlistMarket) -> String {
    watchlist_market_name(*value).to_owned()
}

fn watchlist_market_name(value: WatchlistMarket) -> &'static str {
    match value {
        WatchlistMarket::Kospi => "KOSPI",
        WatchlistMarket::Kosdaq => "KOSDAQ",
        WatchlistMarket::Konex => "KONEX",
    }
}

fn read_secret(from_stdin: bool) -> Result<String, Failure> {
    if from_stdin {
        let mut secret = String::new();
        io::stdin()
            .read_to_string(&mut secret)
            .map_err(|e| Failure::local(format!("failed to read API key: {e}")))?;
        return Ok(secret);
    }
    if !io::stdin().is_terminal() {
        return Err(Failure::invalid(
            "auth set requires an interactive terminal or --stdin",
        ));
    }
    rpassword::prompt_password("KRX API key: ")
        .map_err(|error| Failure::local(format!("failed to read hidden API key: {error}")))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn composite_projection_uses_contract_ids_and_provenance() {
        let completeness = Completeness {
            state: CompletenessState::Complete,
            requested: vec![SearchMarket::Kospi, SearchMarket::Kosdaq],
            succeeded: vec![SearchMarket::Kospi, SearchMarket::Kosdaq],
            failed: Vec::new(),
            skipped: Vec::new(),
        };
        let mut provenance = BTreeMap::new();
        provenance.insert(
            SearchMarket::Kospi,
            ResultProvenance {
                source: ResultSource::Cache,
                fetched_at: UNIX_EPOCH,
                freshness: Freshness::Stale,
                contract_id: "contract-kospi",
            },
        );
        let value = composite_value(
            true,
            json!([]),
            &completeness,
            &provenance,
            None,
            search_market_id,
        );

        assert_eq!(
            value["completeness"]["requested"],
            json!(["KOSPI", "KOSDAQ"])
        );
        assert_eq!(
            value["provenance"]["KOSPI"],
            json!({
                "source": "cache",
                "fetchedAt": "1970-01-01T00:00:00.000Z",
                "freshness": "stale",
                "contractId": "contract-kospi",
            })
        );
        assert!(value.get("error").is_none());
        assert!(value.get("errorType").is_none());
    }

    #[test]
    fn composite_projection_keeps_required_provenance_empty_when_no_components_succeed() {
        let completeness = Completeness {
            state: CompletenessState::Empty,
            requested: vec![SearchMarket::Kospi],
            succeeded: Vec::new(),
            failed: Vec::new(),
            skipped: vec![SearchMarket::Kospi],
        };
        let value = composite_value(
            false,
            json!([]),
            &completeness,
            &BTreeMap::new(),
            None,
            search_market_id,
        );

        assert_eq!(value["provenance"], json!({}));
    }

    #[test]
    fn table_renderer_matches_the_frozen_padding_and_separator() {
        let headers = vec!["name".to_owned(), "value".to_owned()];
        let rows = vec![
            vec!["A".to_owned(), "1".to_owned()],
            vec!["Long".to_owned(), "22".to_owned()],
        ];
        assert_eq!(
            format_table(&headers, &rows),
            "name  value\n----  -----\nA     1    \nLong  22   "
        );
    }

    #[test]
    fn auth_table_uses_the_frozen_category_order_names_and_columns() {
        let observations = krx_sdk::ApprovalCategory::ALL
            .into_iter()
            .map(|category| krx_sdk::ApprovalObservation {
                category,
                state: krx_sdk::ApprovalState::Approved,
                checked_at: UNIX_EPOCH,
                valid_until: UNIX_EPOCH,
                fresh: true,
                error: None,
            })
            .collect::<Vec<_>>();
        let rendered = auth_status_table(&observations);
        let lines = rendered.lines().collect::<Vec<_>>();
        assert!(lines[0].starts_with("category"));
        assert!(lines[0].contains("name"));
        assert!(lines[0].contains("approved"));
        assert!(lines[0].contains("checked_at"));
        assert!(lines[2].starts_with("index       지수"));
        assert!(lines[3].starts_with("stock       주식"));
        assert!(lines[4].starts_with("etp         증권상품"));
        assert!(lines[8].starts_with("esg         ESG"));
        assert!(lines[2].contains("APPROVED"));
        assert!(lines[2].ends_with("1970-01-01T00:00:00.000Z"));
    }

    #[test]
    fn direct_empty_messages_preserve_endpoint_and_filter_context() {
        let date = TradingDate::parse("20260102").unwrap();
        assert_eq!(
            direct_no_data_message(OperationId::StockStkByddTrd, &date, None),
            "No data for date 20260102"
        );
        assert_eq!(
            direct_no_data_message(OperationId::StockStkByddTrd, &date, Some("FLUC_RT > 5")),
            "No results matched filter: FLUC_RT > 5"
        );
        assert_eq!(
            direct_no_data_message(OperationId::StockStkIsuBaseInfo, &date, None),
            "No data"
        );
    }

    #[test]
    fn text_sorting_uses_the_frozen_korean_collation() {
        let collator = Collator::try_new(locale!("ko").into(), CollatorOptions::default()).unwrap();
        let mut values = ["SK하이닉스", "카카오", "삼성전자"];
        values.sort_by(|left, right| compare_sort_values(left, right, &collator));
        assert_eq!(values, ["삼성전자", "카카오", "SK하이닉스"]);
    }
}
