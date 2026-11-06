//! Cached, advisory comparison of the running CLI with published GitHub releases.
//!
//! The check never installs anything and never changes command success; the
//! explicit `krx upgrade` command owns installation. Release evidence is cached;
//! the comparison is recomputed from the running version on every check so a
//! replaced installation is compared correctly immediately.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use jiff::{SignedDuration, Timestamp};
use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Release target id from `contracts/product/v1/native-targets.json` for this build, if any.
pub const TARGET: Option<&str> = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    Some("darwin-arm64")
} else if cfg!(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu"
)) {
    Some("linux-x64-gnu")
} else if cfg!(all(
    target_os = "linux",
    target_arch = "aarch64",
    target_env = "gnu"
)) {
    Some("linux-arm64-gnu")
} else if cfg!(all(
    target_os = "windows",
    target_arch = "x86_64",
    target_env = "msvc"
)) {
    Some("win32-x64-msvc")
} else {
    None
};

pub const RELEASE_ORIGIN: &str = "https://github.com";
/// The repository path that owns releases, relative to the release origin.
pub const RELEASE_PATH: &str = "/cpaikr/krx-cli/releases";
// GitHub's documented latest-release asset link. It is served through
// github.com and the release asset host, not the REST API, so the
// unauthenticated API limit does not apply. "Latest" is GitHub's latest stable
// release: drafts and prereleases are never latest.
const LATEST_MANIFEST_PATH: &str = "/cpaikr/krx-cli/releases/latest/download/release-manifest.json";
pub const RELEASE_PAGE_PREFIX: &str = "https://github.com/cpaikr/krx-cli/releases/tag/";
const CACHE_FILE: &str = "release-check-v1.json";
// Agents may run the CLI many times per hour; a daily interval keeps release
// traffic negligible even when many processes share one address.
const REFRESH_INTERVAL_SECONDS: i64 = 24 * 60 * 60;
const RETRY_COOLDOWN_SECONDS: i64 = 60 * 60;
// An incidental refresh delays a finished command, so it gets a short budget;
// an explicit check is what the person is waiting for, so a slow, high-latency
// path through github.com and the asset host still completes.
const INCIDENTAL_BUDGET: Duration = Duration::from_millis(1_500);
const EXPLICIT_BUDGET: Duration = Duration::from_secs(10);
pub const MAX_MANIFEST_BYTES: usize = 64 << 10;
pub const DISABLE_ENV: &str = "KRX_NO_UPDATE_CHECK";

/// A plain `MAJOR.MINOR.PATCH` release version. Prerelease and build
/// identities are deliberately unrepresentable: they are not stable releases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split('.');
        let mut component = || {
            parts
                .next()
                .filter(|part| {
                    !part.is_empty()
                        && part.bytes().all(|byte| byte.is_ascii_digit())
                        && (part.len() == 1 || !part.starts_with('0'))
                })
                .and_then(|part| part.parse().ok())
        };
        let version = Self {
            major: component()?,
            minor: component()?,
            patch: component()?,
        };
        parts.next().is_none().then_some(version)
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl TryFrom<String> for Version {
    type Error = String;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value).ok_or_else(|| format!("invalid release version {value:?}"))
    }
}

impl From<Version> for String {
    fn from(value: Version) -> Self {
        value.to_string()
    }
}

/// The fields krx needs from a release's `release-manifest.json`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    tag: String,
    targets: Vec<ManifestTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTarget {
    pub target: String,
    pub archive: String,
    pub sha256: String,
}

/// The latest stable release, assessed for one target.
#[derive(Debug)]
pub struct Release {
    pub version: Version,
    pub tag: String,
    /// This target's archive, absent while the release is incomplete for it.
    pub entry: Option<ManifestTarget>,
}

impl Release {
    pub fn url(&self) -> String {
        format!("{RELEASE_PAGE_PREFIX}{}", self.tag)
    }
}

pub fn archive_name(version: Version, target: &str) -> String {
    format!("krx-cli-{version}-{target}.tgz")
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Parses a release manifest and selects this target's archive.
///
/// Release publication uploads and verifies every asset on a draft before
/// publishing, so a published manifest implies its listed archives and
/// checksums exist; a missing target entry is what remains incomplete.
pub fn parse_release(body: &[u8], target: Option<&str>) -> Result<Release, String> {
    let manifest: Manifest = serde_json::from_slice(body).map_err(|_| {
        "The latest release manifest is not valid release-manifest JSON.".to_owned()
    })?;
    let version = Version::parse(&manifest.version)
        .filter(|version| manifest.tag == format!("v{version}"))
        .ok_or_else(|| {
            "The latest release manifest does not name a stable v<version> release.".to_owned()
        })?;
    let Some(target) = target else {
        return Ok(Release {
            version,
            tag: manifest.tag,
            entry: None,
        });
    };
    let mut entries = manifest
        .targets
        .into_iter()
        .filter(|entry| entry.target == target);
    let entry = entries.next();
    if entries.next().is_some()
        || entry.as_ref().is_some_and(|entry| {
            entry.archive != archive_name(version, target) || !is_sha256(&entry.sha256)
        })
    {
        return Err(format!(
            "The latest release manifest does not list exactly one valid {target} archive."
        ));
    }
    Ok(Release {
        version,
        tag: manifest.tag,
        entry,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Distribution {
    Complete,
    IncompleteDistribution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Newer,
    Equal,
    Ahead,
    NoStableRelease,
    Uncomparable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Unavailable,
}

/// Latest stable release observed at `observed_at`, assessed for this target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    observed_at: Timestamp,
    latest: Option<LatestRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestRelease {
    version: Version,
    url: String,
    distribution: Distribution,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheRecord {
    target: Option<String>,
    evidence: Option<Evidence>,
    last_failure_at: Option<Timestamp>,
}

/// The release report of `krx version --check`, also behind incidental notices.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    target: Option<&'static str>,
    comparison: Option<Comparison>,
    latest_version: Option<Version>,
    release_url: Option<String>,
    distribution: Option<Distribution>,
    freshness: Freshness,
    observed_at: Option<Timestamp>,
    age_seconds: Option<i64>,
    last_refresh_failed_at: Option<Timestamp>,
    problems: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    help: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Incidental,
    Explicit,
}

struct Settings {
    disabled: Option<&'static str>,
    manifest_url: String,
    cache_directory: Result<PathBuf, String>,
}

impl Settings {
    fn from_environment() -> Self {
        Self {
            disabled: disabled_by_environment()
                .then_some("Release checks are disabled by KRX_NO_UPDATE_CHECK."),
            manifest_url: format!("{RELEASE_ORIGIN}{LATEST_MANIFEST_PATH}"),
            cache_directory: cache_directory()
                .ok_or_else(|| "No user cache directory is available.".to_owned()),
        }
    }
}

fn disabled_by_environment() -> bool {
    std::env::var_os(DISABLE_ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

/// The disposable per-user cache directory for release evidence.
///
/// This is deliberately not the `.krx-cli` state root: release evidence is
/// re-creatable and must not share that root's owner-only state guarantees.
pub fn cache_directory() -> Option<PathBuf> {
    let absolute = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    if cfg!(windows) {
        absolute("LOCALAPPDATA").map(|root| root.join("krx-cli").join("cache"))
    } else if cfg!(target_os = "macos") {
        absolute("HOME").map(|root| root.join("Library/Caches/krx-cli"))
    } else {
        absolute("XDG_CACHE_HOME")
            .map(|root| root.join("krx-cli"))
            .or_else(|| absolute("HOME").map(|root| root.join(".cache/krx-cli")))
    }
}

/// A one-line update notice for a person after a successful network command.
pub async fn incidental_notice() -> Option<String> {
    let settings = Settings::from_environment();
    if settings.disabled.is_some() {
        return None;
    }
    run_check(&settings, Mode::Incidental, Timestamp::now())
        .await
        .notice()
}

/// The explicit report for `krx version --check`; evidence problems are part of it.
pub async fn explicit_check() -> ReleaseCheck {
    run_check(
        &Settings::from_environment(),
        Mode::Explicit,
        Timestamp::now(),
    )
    .await
}

async fn run_check(settings: &Settings, mode: Mode, now: Timestamp) -> ReleaseCheck {
    let now = truncate(now);
    if let Some(reason) = settings.disabled {
        return report(None, now, vec![reason.to_owned()]);
    }
    let mut problems = Vec::new();
    let directory = match &settings.cache_directory {
        Ok(directory) => Some(directory.as_path()),
        Err(problem) => {
            problems.push(problem.clone());
            None
        }
    };
    let mut record = directory
        .map(|directory| {
            load(directory).unwrap_or_else(|problem| {
                problems.push(problem);
                CacheRecord::default()
            })
        })
        .unwrap_or_default();
    if refresh_due(&record, now, mode) {
        // Record the attempt before any network work. It doubles as the failure
        // cooldown if this process dies mid-refresh and proves the cache
        // persists: incidental checks refresh only then, so an unreadable or
        // unwritable cache cannot turn every invocation into GitHub requests.
        let attempt = CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence: record.evidence.clone(),
            last_failure_at: Some(now),
        };
        let persisted = directory.is_some_and(|directory| {
            save(directory, &attempt)
                .map_err(|problem| problems.push(problem))
                .is_ok()
        });
        if persisted || mode == Mode::Explicit {
            record = attempt;
            refresh(
                settings,
                mode,
                directory.filter(|_| persisted),
                &mut record,
                &mut problems,
                now,
            )
            .await;
        }
    }
    report(Some(&record), now, problems)
}

async fn refresh(
    settings: &Settings,
    mode: Mode,
    directory: Option<&Path>,
    record: &mut CacheRecord,
    problems: &mut Vec<String>,
    now: Timestamp,
) {
    let budget = match mode {
        Mode::Incidental => INCIDENTAL_BUDGET,
        Mode::Explicit => EXPLICIT_BUDGET,
    };
    let refreshed = tokio::time::timeout(budget, fetch_evidence(&settings.manifest_url, now))
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "Release refresh exceeded its {} ms budget.",
                budget.as_millis()
            ))
        });
    match refreshed {
        Ok(evidence) => {
            record.evidence = Some(evidence);
            record.last_failure_at = None;
        }
        Err(problem) => {
            problems.push(problem);
            // A concurrent process may have saved fresh evidence since this one
            // loaded the cache; keep it rather than overwrite it with a failure.
            if let Some(directory) = directory
                && let Ok(current) = load(directory)
                && current.evidence.as_ref().is_some_and(|evidence| {
                    within(evidence.observed_at, now, REFRESH_INTERVAL_SECONDS)
                })
            {
                *record = current;
                return;
            }
            // Otherwise the attempt already recorded `now` as the last failure.
        }
    }
    if let Some(directory) = directory
        && let Err(problem) = save(directory, record)
    {
        problems.push(problem);
    }
}

fn truncate(now: Timestamp) -> Timestamp {
    Timestamp::from_second(now.as_second()).unwrap_or(now)
}

/// Whether stale evidence should be refreshed now.
///
/// Incidental checks wait out the failure cooldown so a network outage cannot
/// slow every command; an explicit check is a person asking now, so it retries.
fn refresh_due(record: &CacheRecord, now: Timestamp, mode: Mode) -> bool {
    let evidence_fresh = record
        .evidence
        .as_ref()
        .is_some_and(|evidence| within(evidence.observed_at, now, REFRESH_INTERVAL_SECONDS));
    let cooling_down = mode == Mode::Incidental
        && record
            .last_failure_at
            .is_some_and(|failure| within(failure, now, RETRY_COOLDOWN_SECONDS));
    !evidence_fresh && !cooling_down
}

// A timestamp in the future is not trusted; it would otherwise suppress refreshes.
fn within(then: Timestamp, now: Timestamp, seconds: i64) -> bool {
    then <= now && now.duration_since(then) < SignedDuration::from_secs(seconds)
}

fn report(record: Option<&CacheRecord>, now: Timestamp, problems: Vec<String>) -> ReleaseCheck {
    let evidence = record.and_then(|record| record.evidence.as_ref());
    let latest = evidence.and_then(|evidence| evidence.latest.as_ref());
    let freshness = match evidence {
        None => Freshness::Unavailable,
        Some(evidence) if within(evidence.observed_at, now, REFRESH_INTERVAL_SECONDS) => {
            Freshness::Fresh
        }
        Some(_) => Freshness::Stale,
    };
    let comparison = match Version::parse(CURRENT_VERSION) {
        None => Some(Comparison::Uncomparable),
        Some(current) => evidence.map(|evidence| match &evidence.latest {
            None => Comparison::NoStableRelease,
            Some(latest) => match latest.version.cmp(&current) {
                std::cmp::Ordering::Greater => Comparison::Newer,
                std::cmp::Ordering::Equal => Comparison::Equal,
                std::cmp::Ordering::Less => Comparison::Ahead,
            },
        }),
    };
    let distribution = latest.map(|latest| latest.distribution);
    ReleaseCheck {
        target: TARGET,
        comparison,
        latest_version: latest.map(|latest| latest.version),
        release_url: latest.map(|latest| latest.url.clone()),
        distribution,
        freshness,
        observed_at: evidence.map(|evidence| evidence.observed_at),
        // A future observation has no meaningful age.
        age_seconds: evidence
            .filter(|evidence| evidence.observed_at <= now)
            .map(|evidence| now.duration_since(evidence.observed_at).as_secs()),
        last_refresh_failed_at: record.and_then(|record| record.last_failure_at),
        problems,
        help: match (comparison, distribution) {
            (Some(Comparison::Newer), Some(Distribution::Complete)) => {
                Some("Run krx upgrade to install it.".to_owned())
            }
            (Some(Comparison::Newer), _) if TARGET.is_none() => Some(
                "This build is not a release target; no release archive can replace it.".to_owned(),
            ),
            (Some(Comparison::Newer), _) => Some(format!(
                "The release has no {} archive yet; keep {CURRENT_VERSION} until it is complete.",
                TARGET.unwrap_or_default()
            )),
            _ => None,
        },
    }
}

impl ReleaseCheck {
    /// A notice only when a newer installable release exists.
    ///
    /// Stale or unavailable evidence stays silent here: an offline terminal
    /// session would otherwise repeat it on every command. `krx version --check`
    /// reports those states explicitly.
    fn notice(&self) -> Option<String> {
        let latest = self.latest_version?;
        (self.comparison == Some(Comparison::Newer)
            && self.distribution == Some(Distribution::Complete))
        .then(|| {
            format!(
                "krx: notice: krx {latest} is available; this is {CURRENT_VERSION}. Run krx upgrade to install it."
            )
        })
    }
}

/// The GitHub release HTTP client. Only this module names the HTTP library, so
/// the cutover gate can confirm the KRX provider transport stays in the SDK.
pub type HttpClient = reqwest::Client;

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("krx-cli/", env!("CARGO_PKG_VERSION")))
        // Never follow a redirect off TLS.
        .https_only(true)
        .build()
        .map_err(|_| "Failed to initialize the release HTTP client.".to_owned())
}

/// GET a release resource of at most `limit` bytes; `None` when GitHub answers 404.
///
/// Redirects lead from github.com to the release asset host.
pub async fn fetch_bounded(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    label: &str,
) -> Result<Option<Vec<u8>>, String> {
    let too_large = || format!("The {label} exceeds {limit} bytes.");
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| format!("The {label} request failed."))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "The {label} request returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| usize::try_from(length).map_or(true, |length| length > limit))
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("The {label} response was interrupted."))?
    {
        if body.len() + chunk.len() > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// The latest release manifest; `None` when no published release provides one.
pub async fn fetch_latest_manifest(
    client: &reqwest::Client,
    origin: &str,
) -> Result<Option<Vec<u8>>, String> {
    fetch_bounded(
        client,
        &format!("{origin}{LATEST_MANIFEST_PATH}"),
        MAX_MANIFEST_BYTES,
        "release manifest",
    )
    .await
}

async fn fetch_evidence(manifest_url: &str, now: Timestamp) -> Result<Evidence, String> {
    let client = http_client()?;
    // GitHub answers 404 when no published release provides a manifest.
    let Some(body) = fetch_bounded(
        &client,
        manifest_url,
        MAX_MANIFEST_BYTES,
        "release manifest",
    )
    .await?
    else {
        return Ok(Evidence {
            observed_at: now,
            latest: None,
        });
    };
    let release = parse_release(&body, TARGET)?;
    Ok(Evidence {
        observed_at: now,
        latest: Some(LatestRelease {
            version: release.version,
            url: release.url(),
            distribution: if release.entry.is_some() {
                Distribution::Complete
            } else {
                Distribution::IncompleteDistribution
            },
        }),
    })
}

/// Unreadable or corrupt cache is reported and treated as absent.
fn load(directory: &Path) -> Result<CacheRecord, String> {
    let path = directory.join(CACHE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CacheRecord::default());
        }
        Err(_) => return Err("Could not read the release check cache.".to_owned()),
    };
    let record: CacheRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "Ignored a corrupt release check cache; it will be replaced.".to_owned())?;
    // Evidence assessed for another target says nothing about this one.
    Ok(if record.target.as_deref() == TARGET {
        record
    } else {
        CacheRecord::default()
    })
}

/// Atomic replace: concurrent processes may refresh redundantly but never read a partial file.
fn save(directory: &Path, record: &CacheRecord) -> Result<(), String> {
    let path = directory.join(CACHE_FILE);
    let temporary = directory.join(format!("{CACHE_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(record).expect("cache record serializes");
    let result = std::fs::create_dir_all(directory)
        .and_then(|()| std::fs::write(&temporary, bytes))
        .and_then(|()| std::fs::rename(&temporary, &path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| "Could not write the release check cache.".to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn time(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn manifest(tag: &str, targets: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"version": "1.9.0", "tag": tag, "targets": targets})).unwrap()
    }

    fn entry(target: &str, archive: &str) -> Value {
        json!({"target": target, "archive": archive, "sha256": "c".repeat(64), "nodeMajors": [22]})
    }

    fn evidence(observed_at: &str, version: Option<&str>) -> Evidence {
        Evidence {
            observed_at: time(observed_at),
            latest: version.map(|version| LatestRelease {
                version: Version::parse(version).unwrap(),
                url: format!("{RELEASE_PAGE_PREFIX}v{version}"),
                distribution: Distribution::Complete,
            }),
        }
    }

    fn record(evidence: Option<Evidence>) -> CacheRecord {
        CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence,
            last_failure_at: None,
        }
    }

    fn temporary_directory(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("krx-release-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }

    #[test]
    fn versions_order_numerically_and_reject_non_release_identities() {
        let parse = |text| Version::parse(text).unwrap();
        assert!(parse("1.10.0") > parse("1.9.9"));
        assert!(parse("2.0.0") > parse("1.99.99"));
        assert_eq!(parse("1.8.2").to_string(), "1.8.2");
        for invalid in [
            "",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-rc.1",
            "1.2.3+build",
            "v1.2.3",
            "1..3",
        ] {
            assert_eq!(Version::parse(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn published_manifest_shape_parses() {
        let published = br#"{"tag":"v1.8.2","version":"1.8.2","sourceRevision":"d9c300f",
            "targets":[{"target":"win32-x64-msvc","archive":"krx-cli-1.8.2-win32-x64-msvc.tgz",
            "sha256":"5e76f920b56fc8b16c63e32257050531b125cb466d6a6b89b16fb3cffd57007b","nodeMajors":[]}]}"#;
        let release = parse_release(published, Some("win32-x64-msvc")).unwrap();
        assert_eq!(release.version.to_string(), "1.8.2");
        assert_eq!(release.url(), format!("{RELEASE_PAGE_PREFIX}v1.8.2"));
        assert_eq!(
            release.entry.unwrap().archive,
            "krx-cli-1.8.2-win32-x64-msvc.tgz"
        );
    }

    #[test]
    fn manifest_must_name_one_valid_archive_for_the_target() {
        let good = entry("linux-x64-gnu", "krx-cli-1.9.0-linux-x64-gnu.tgz");
        let release =
            parse_release(&manifest("v1.9.0", json!([good])), Some("linux-x64-gnu")).unwrap();
        assert_eq!(release.entry.unwrap().sha256, "c".repeat(64));
        let incomplete =
            parse_release(&manifest("v1.9.0", json!([good])), Some("darwin-arm64")).unwrap();
        assert!(incomplete.entry.is_none());
        assert!(
            parse_release(&manifest("v1.9.0", json!([good])), None)
                .unwrap()
                .entry
                .is_none()
        );
        for (tag, targets) in [
            ("v1.8.0", json!([good])),
            ("1.9.0", json!([good])),
            ("v1.9.0", json!([good, good])),
            (
                "v1.9.0",
                json!([entry("linux-x64-gnu", "krx-cli-1.8.0-linux-x64-gnu.tgz")]),
            ),
        ] {
            assert!(
                parse_release(&manifest(tag, targets), Some("linux-x64-gnu")).is_err(),
                "{tag}"
            );
        }
        assert!(parse_release(b"not json", Some("linux-x64-gnu")).is_err());
    }

    #[test]
    fn build_targets_match_the_native_target_manifest() {
        let manifest: Value = serde_json::from_str(include_str!(
            "../../../contracts/product/v1/native-targets.json"
        ))
        .unwrap();
        let ids: Vec<_> = manifest["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|target| target["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "darwin-arm64",
                "linux-x64-gnu",
                "linux-arm64-gnu",
                "win32-x64-msvc"
            ],
            "update TARGET for new release targets"
        );
        assert_eq!(
            manifest["distribution"]["assetNameTemplate"],
            "krx-cli-{version}-{target}.tgz"
        );
        if let Some(target) = TARGET {
            assert!(ids.contains(&target));
        }
    }

    #[test]
    fn freshness_and_comparison_are_reported_separately() {
        let now = time("2026-09-30T12:00:00Z");
        let current = Version::parse(CURRENT_VERSION).unwrap();
        let newer = Version {
            major: current.major + 1,
            ..current
        }
        .to_string();

        let check = report(
            Some(&record(Some(evidence(
                "2026-09-30T00:00:00Z",
                Some(CURRENT_VERSION),
            )))),
            now,
            vec![],
        );
        assert_eq!(
            (check.comparison, check.freshness),
            (Some(Comparison::Equal), Freshness::Fresh)
        );
        assert_eq!(check.age_seconds, Some(43_200));
        assert!(check.notice().is_none() && check.help.is_none());

        let check = report(
            Some(&record(Some(evidence(
                "2026-09-30T00:00:00Z",
                Some("0.0.0"),
            )))),
            now,
            vec![],
        );
        assert_eq!(check.comparison, Some(Comparison::Ahead));
        assert!(check.notice().is_none());

        let check = report(
            Some(&record(Some(evidence("2026-09-30T00:00:00Z", None)))),
            now,
            vec![],
        );
        assert_eq!(check.comparison, Some(Comparison::NoStableRelease));

        let check = report(
            Some(&record(Some(evidence(
                "2026-09-28T00:00:00Z",
                Some(&newer),
            )))),
            now,
            vec![],
        );
        assert_eq!(
            (check.comparison, check.freshness),
            (Some(Comparison::Newer), Freshness::Stale)
        );
        assert!(check.notice().unwrap().contains("Run krx upgrade"));
        assert_eq!(
            check.help.as_deref(),
            Some("Run krx upgrade to install it.")
        );

        let mut incomplete = evidence("2026-09-30T00:00:00Z", Some(&newer));
        incomplete.latest.as_mut().unwrap().distribution = Distribution::IncompleteDistribution;
        let check = report(Some(&record(Some(incomplete))), now, vec![]);
        assert!(check.notice().is_none());
        assert!(check.help.unwrap().contains("keep"));

        let check = report(Some(&record(None)), now, vec![]);
        assert_eq!(
            (check.comparison, check.freshness),
            (None, Freshness::Unavailable)
        );
    }

    fn refresh_due_incidental(record: &CacheRecord, now: Timestamp) -> bool {
        refresh_due(record, now, Mode::Incidental)
    }

    #[test]
    fn refresh_waits_for_the_interval_and_the_failure_cooldown() {
        let now = time("2026-09-30T12:00:00Z");
        let record = |observed: Option<&str>, failed: Option<&str>| CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence: observed.map(|observed| evidence(observed, None)),
            last_failure_at: failed.map(time),
        };
        assert!(refresh_due_incidental(&record(None, None), now));
        assert!(!refresh_due_incidental(
            &record(Some("2026-09-29T12:00:01Z"), None),
            now
        ));
        assert!(refresh_due_incidental(
            &record(Some("2026-09-29T12:00:00Z"), None),
            now
        ));
        assert!(!refresh_due_incidental(
            &record(None, Some("2026-09-30T11:00:01Z")),
            now
        ));
        assert!(refresh_due_incidental(
            &record(None, Some("2026-09-30T11:00:00Z")),
            now
        ));
        // An explicit check retries within the cooldown but not within the interval.
        let failed = record(None, Some("2026-09-30T11:30:00Z"));
        assert!(refresh_due(&failed, now, Mode::Explicit));
        let fresh = record(Some("2026-09-30T11:30:00Z"), None);
        assert!(!refresh_due(&fresh, now, Mode::Explicit));
        // Future timestamps are distrusted rather than suppressing refresh forever.
        assert!(refresh_due_incidental(
            &record(Some("2026-10-30T00:00:00Z"), None),
            now
        ));
        assert!(refresh_due_incidental(
            &record(None, Some("2026-10-30T00:00:00Z")),
            now
        ));
    }

    #[test]
    fn corrupt_cache_is_an_inspection_problem_and_saves_round_trip() {
        let directory = temporary_directory("cache");
        assert_eq!(load(&directory), Ok(CacheRecord::default()));
        let saved = CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence: Some(evidence("2026-09-30T00:00:00Z", Some("1.2.3"))),
            last_failure_at: Some(time("2026-09-30T01:00:00Z")),
        };
        save(&directory, &CacheRecord::default()).unwrap();
        save(&directory, &saved).unwrap();
        assert_eq!(load(&directory), Ok(saved));
        std::fs::write(directory.join(CACHE_FILE), b"{\"evidence\":").unwrap();
        assert!(load(&directory).unwrap_err().contains("corrupt"));
        std::fs::write(
            directory.join(CACHE_FILE),
            br#"{"target":"other","evidence":null,"lastFailureAt":null}"#,
        )
        .unwrap();
        assert_eq!(load(&directory), Ok(CacheRecord::default()));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[tokio::test]
    async fn disabled_checks_do_no_cache_or_network_work() {
        let directory = temporary_directory("disabled");
        let settings = Settings {
            disabled: Some("Release checks are disabled by KRX_NO_UPDATE_CHECK."),
            manifest_url: "https://127.0.0.1:9/unreachable".to_owned(),
            cache_directory: Ok(directory.clone()),
        };
        let check = run_check(&settings, Mode::Explicit, Timestamp::now()).await;
        assert_eq!(check.freshness, Freshness::Unavailable);
        assert_eq!(check.problems.len(), 1);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn incidental_checks_without_a_cache_do_not_refresh() {
        let settings = Settings {
            disabled: None,
            manifest_url: "https://127.0.0.1:9/unreachable".to_owned(),
            cache_directory: Err("No user cache directory is available.".to_owned()),
        };
        let check = run_check(&settings, Mode::Incidental, Timestamp::now()).await;
        assert_eq!(check.freshness, Freshness::Unavailable);
        assert_eq!(check.problems.len(), 1, "{:?}", check.problems);
        assert!(check.last_refresh_failed_at.is_none());
    }

    #[tokio::test]
    async fn failed_refresh_keeps_fresh_evidence_saved_concurrently() {
        let directory = temporary_directory("concurrent");
        let now = truncate(Timestamp::now());
        let fresh = CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence: Some(Evidence {
                observed_at: now,
                latest: None,
            }),
            last_failure_at: None,
        };
        save(&directory, &fresh).unwrap();
        // This process loaded the cache before the other one saved evidence.
        let mut attempt = CacheRecord {
            target: TARGET.map(str::to_owned),
            evidence: None,
            last_failure_at: Some(now),
        };
        let settings = Settings {
            disabled: None,
            manifest_url: "https://127.0.0.1:9/unreachable".to_owned(),
            cache_directory: Ok(directory.clone()),
        };
        let mut problems = Vec::new();
        refresh(
            &settings,
            Mode::Incidental,
            Some(&directory),
            &mut attempt,
            &mut problems,
            now,
        )
        .await;
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert_eq!(attempt, fresh);
        assert_eq!(load(&directory), Ok(fresh));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[tokio::test]
    async fn incidental_checks_with_an_unwritable_cache_do_not_refresh() {
        let directory = temporary_directory("unwritable");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("not-a-directory");
        std::fs::write(&file, b"file").unwrap();
        let settings = Settings {
            disabled: None,
            manifest_url: "https://127.0.0.1:9/unreachable".to_owned(),
            cache_directory: Ok(file),
        };
        let check = run_check(&settings, Mode::Incidental, Timestamp::now()).await;
        assert!(
            check.last_refresh_failed_at.is_none(),
            "{:?}",
            check.problems
        );
        assert!(
            check
                .problems
                .iter()
                .all(|problem| problem.contains("cache")),
            "no network attempt: {:?}",
            check.problems
        );
        // The explicit check still refreshes and reports the failure.
        let check = run_check(&settings, Mode::Explicit, Timestamp::now()).await;
        assert!(check.last_refresh_failed_at.is_some());
        assert!(
            check
                .problems
                .iter()
                .any(|problem| problem.contains("request") || problem.contains("budget"))
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
