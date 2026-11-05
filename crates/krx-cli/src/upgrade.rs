//! Upgrade of a pnpm global installation from the latest GitHub release.
//!
//! The documented installation is `pnpm add --global --ignore-scripts` of a
//! release `.tgz`, and the documented upgrade is the same command with a newer
//! archive. `krx upgrade` automates exactly that path: it manages only the
//! running package when pnpm reports it as a global `krx-cli` dependency,
//! verifies the archive against the release manifest, `SHA256SUMS`, and its own
//! `package.json`, then hands installation to pnpm and confirms the result.
//! pnpm owns the replacement and its atomicity; krx never edits pnpm's tree.

use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{IsTerminal, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::release_check::{self, ManifestTarget, Release, Version};

const PACKAGE_NAME: &str = "krx-cli";
const EXECUTABLE: &str = if cfg!(windows) { "krx.exe" } else { "krx" };
const MAX_PACKAGE_JSON_BYTES: u64 = 64 << 10;
const MAX_CHECKSUMS_BYTES: usize = 64 << 10;
// Release archives are under ten megabytes; the bounds leave room for growth
// while stopping a corrupt or hostile response early.
const MAX_ARCHIVE_BYTES: usize = 128 << 20;
const MAX_UNPACKED_BYTES: u64 = 512 << 20;
const METADATA_TIMEOUT: Duration = Duration::from_secs(15);
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const PNPM_LIST_TIMEOUT: Duration = Duration::from_secs(60);
const REINSTALL_HINT: &str = "Install a release archive with pnpm add --global --ignore-scripts as described in the README; krx upgrade manages only that installation.";

/// Runs `krx upgrade`, returning its JSON result or a failure.
pub async fn run(check: bool) -> Result<Value, UpgradeError> {
    let mut progress = Progress::for_stderr();
    upgrade(check, &mut progress)
        .await
        .map(|outcome| outcome.value())
}

async fn upgrade(check: bool, progress: &mut Progress) -> Result<Outcome, UpgradeError> {
    let target = release_check::TARGET.ok_or_else(|| {
        UpgradeError::new(
            "unsupported",
            "This build is not a release target, so no release archive can replace it.",
        )
    })?;
    let running = Version::parse(release_check::CURRENT_VERSION).ok_or_else(|| {
        UpgradeError::new(
            "unsupported",
            format!(
                "Running version {} is not a release version; only release installations can upgrade.",
                release_check::CURRENT_VERSION
            ),
        )
    })?;
    let archives = archive_directory()?;
    let pnpm = Pnpm::locate(archives.clone())?;
    // Reject an unmanaged installation before any download.
    let package = installed_package(&pnpm, running)?;
    progress.stage(format_args!("Checking for the latest krx release..."));
    let client = release_check::http_client().map_err(source_unavailable)?;
    let release = latest_release(&client, target).await?;
    let mut outcome = Outcome {
        running,
        latest: release.version,
        target,
        release_url: release.url(),
        package_directory: package.path.clone(),
        installable: release.entry.is_some(),
        updated: false,
    };
    if release.version <= running {
        progress.stage(format_args!("krx {running} is up to date."));
        return Ok(outcome);
    }
    if check {
        progress.stage(format_args!("{}", outcome.next_step()));
        return Ok(outcome);
    }
    let entry = release
        .entry
        .as_ref()
        .ok_or_else(|| release_invalid(outcome.next_step()))?;
    progress.stage(format_args!("Downloading {}...", entry.archive));
    let archive = download_verified(&client, &release, entry, progress).await?;
    let archive_path = persist_archive(&archives, &entry.archive, &archive)?;
    progress.stage(format_args!(
        "Installing krx {} with pnpm...",
        release.version
    ));
    let terminal = progress.is_terminal();
    if let Err(error) = pnpm.install(&archive_path, terminal) {
        // pnpm 10 keeps every global package in one project and re-reads each
        // `file:` tarball it recorded, so replacing a package whose original
        // archive is gone fails. Only then remove it and install again; the
        // verified archive is already stored, so the failure names the fix.
        if package.source.as_ref().is_none_or(|source| source.exists()) {
            return Err(error);
        }
        pnpm.remove(&archive_path, terminal)?;
        pnpm.install(&archive_path, terminal)
            .map_err(|error| error.after_removal(running))?;
    }
    outcome.package_directory = confirm_installed(&pnpm, release.version)?;
    remove_other_archives(&archives, &entry.archive);
    progress.stage(format_args!(
        "Upgraded krx {running} to {}.",
        release.version
    ));
    outcome.updated = true;
    Ok(outcome)
}

struct Outcome {
    running: Version,
    latest: Version,
    target: &'static str,
    release_url: String,
    package_directory: PathBuf,
    /// The latest release has an archive for this target.
    installable: bool,
    updated: bool,
}

impl Outcome {
    fn next_step(&self) -> String {
        if self.installable {
            format!("Run krx upgrade to install krx {}.", self.latest)
        } else {
            format!(
                "krx {} has no {} archive in its release manifest; keep {} until the release is complete.",
                self.latest, self.target, self.running
            )
        }
    }

    fn value(&self) -> Value {
        let update_available = self.latest > self.running;
        let mut value = json!({
            "runningVersion": self.running,
            "latestVersion": self.latest,
            "installedVersion": if self.updated { self.latest } else { self.running },
            "updateAvailable": update_available,
            "updated": self.updated,
            "distribution": if self.installable { "complete" } else { "incomplete_distribution" },
            "target": self.target,
            "releaseUrl": self.release_url,
            "packageDirectory": self.package_directory,
        });
        if update_available && !self.updated {
            value["help"] = json!(self.next_step());
        }
        value
    }
}

/// A failure rendered as `krx: error[upgrade/<code>]: <message>`.
#[derive(Debug)]
pub struct UpgradeError {
    pub code: &'static str,
    message: String,
    hint: Option<String>,
}

impl UpgradeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }

    #[must_use]
    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// The failure of an install that followed removing the previous package.
    fn after_removal(self, previous: Version) -> Self {
        let hint = self.hint.unwrap_or_default();
        Self::new(
            "install_failed",
            format!(
                "pnpm removed krx-cli {previous} because its original archive is gone, but installing the new release failed, so krx is not installed."
            ),
        )
        .hint(hint.replacen("Retry, or run", "To finish, run", 1))
    }

    pub fn message(&self) -> String {
        match &self.hint {
            Some(hint) => format!("{} {hint}", self.message),
            None => self.message.clone(),
        }
    }
}

fn unmanaged(message: impl Into<String>) -> UpgradeError {
    UpgradeError::new("unmanaged_installation", message).hint(REINSTALL_HINT)
}

fn source_unavailable(message: String) -> UpgradeError {
    UpgradeError::new("source_unavailable", message)
}

fn release_invalid(message: impl Into<String>) -> UpgradeError {
    UpgradeError::new("release_invalid", message)
}

fn verification_failed(message: impl Into<String>) -> UpgradeError {
    UpgradeError::new("verification_failed", message)
}

fn install_failed(message: impl Into<String>) -> UpgradeError {
    UpgradeError::new("install_failed", message)
}

/// Stage lines for a person watching in a terminal.
///
/// stdout carries only the JSON result, so stages go to stderr, and only when
/// stderr is interactive: pipes, CI, and agents keep an empty stderr.
struct Progress(Option<std::io::Stderr>);

impl Progress {
    fn for_stderr() -> Self {
        let stderr = std::io::stderr();
        Self(stderr.is_terminal().then_some(stderr))
    }

    fn is_terminal(&self) -> bool {
        self.0.is_some()
    }

    fn stage(&mut self, message: std::fmt::Arguments<'_>) {
        if let Some(sink) = &mut self.0 {
            // Progress is advisory; a closed terminal must not fail the upgrade.
            let _ = writeln!(sink, "{message}");
        }
    }
}

fn display_size(bytes: usize) -> String {
    let tenths = bytes.div_ceil(100_000);
    format!("{}.{} MB", tenths / 10, tenths % 10)
}

async fn latest_release(client: &reqwest::Client, target: &str) -> Result<Release, UpgradeError> {
    let body = timed(
        METADATA_TIMEOUT,
        "release manifest",
        release_check::fetch_latest_manifest(client, release_check::RELEASE_ORIGIN),
    )
    .await?
    .ok_or_else(|| release_invalid("No published krx release provides a release manifest."))?;
    release_check::parse_release(&body, Some(target)).map_err(release_invalid)
}

async fn timed<T>(
    timeout: Duration,
    label: &str,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, UpgradeError> {
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| {
            source_unavailable(format!(
                "The {label} download exceeded {} seconds.",
                timeout.as_secs()
            ))
        })?
        .map_err(source_unavailable)
}

/// Downloads this target's archive and verifies it before installation.
async fn download_verified(
    client: &reqwest::Client,
    release: &Release,
    entry: &ManifestTarget,
    progress: &mut Progress,
) -> Result<Vec<u8>, UpgradeError> {
    let base = format!(
        "{}{}/download/{}",
        release_check::RELEASE_ORIGIN,
        release_check::RELEASE_PATH,
        release.tag
    );
    let checksums = timed(
        METADATA_TIMEOUT,
        "release checksum list",
        release_check::fetch_bounded(
            client,
            &format!("{base}/SHA256SUMS"),
            MAX_CHECKSUMS_BYTES,
            "release checksum list",
        ),
    )
    .await?
    .ok_or_else(|| release_invalid("The release has no SHA256SUMS asset."))?;
    let expected = checksum_entry(&checksums, &entry.archive)?;
    if expected != entry.sha256.to_ascii_lowercase() {
        return Err(verification_failed(format!(
            "The release manifest and SHA256SUMS disagree about {}.",
            entry.archive
        )));
    }
    let archive = timed(
        ARCHIVE_TIMEOUT,
        "release archive",
        release_check::fetch_bounded(
            client,
            &format!("{base}/{}", entry.archive),
            MAX_ARCHIVE_BYTES,
            "release archive",
        ),
    )
    .await?
    .ok_or_else(|| release_invalid(format!("The release has no {} asset.", entry.archive)))?;
    progress.stage(format_args!(
        "Verifying {} ({})...",
        entry.archive,
        display_size(archive.len())
    ));
    if sha256_hex(&archive) != expected {
        return Err(verification_failed(
            "The downloaded archive does not match its published SHA-256 checksum.",
        ));
    }
    verify_package(&archive, release.version)?;
    Ok(archive)
}

fn checksum_entry(checksums: &[u8], archive: &str) -> Result<String, UpgradeError> {
    let text = std::str::from_utf8(checksums)
        .map_err(|_| release_invalid("The release SHA256SUMS is not UTF-8 text."))?;
    let mut matches = text
        .lines()
        .filter_map(|line| line.split_once("  "))
        .filter(|(_, name)| *name == archive);
    match (matches.next(), matches.next()) {
        (Some((digest, _)), None) if release_check::is_sha256(digest) => {
            Ok(digest.to_ascii_lowercase())
        }
        _ => Err(release_invalid(format!(
            "The release SHA256SUMS lacks exactly one valid digest for {archive}."
        ))),
    }
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    name: String,
    version: String,
    #[serde(default)]
    bin: Value,
}

impl PackageJson {
    fn parse(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }

    fn is_krx(&self, version: Version) -> bool {
        self.name == PACKAGE_NAME
            && self.version == version.to_string()
            && self.bin["krx"]
                .as_str()
                .is_some_and(|path| path.trim_start_matches("./") == format!("bin/{EXECUTABLE}"))
    }
}

/// Requires the archive to be the `krx-cli` package of `version` with its executable.
///
/// The checksum proves the archive is the published asset; this proves the
/// published asset is the package pnpm will install under that version.
fn verify_package(archive: &[u8], version: Version) -> Result<(), UpgradeError> {
    let invalid = || {
        verification_failed(format!(
            "The release archive is not a {PACKAGE_NAME} {version} package with bin/{EXECUTABLE}."
        ))
    };
    let decoder = GzDecoder::new(archive).take(MAX_UNPACKED_BYTES);
    let mut archive = tar::Archive::new(decoder);
    let mut manifest = None;
    let mut executable = false;
    for entry in archive.entries().map_err(|_| invalid())? {
        let mut entry = entry.map_err(|_| invalid())?;
        let path = entry
            .path()
            .ok()
            .and_then(|path| path.to_str().map(str::to_owned))
            .ok_or_else(invalid)?;
        let is_file = entry.header().entry_type().is_file();
        if path == "package/package.json" && is_file && entry.size() <= MAX_PACKAGE_JSON_BYTES {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|_| invalid())?;
            manifest = PackageJson::parse(&bytes);
        } else if path == format!("package/bin/{EXECUTABLE}") && is_file && entry.size() > 0 {
            executable = true;
        }
    }
    match manifest {
        Some(manifest) if executable && manifest.is_krx(version) => Ok(()),
        _ => Err(invalid()),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The private per-user directory that keeps the installed release archive.
///
/// pnpm records a global tarball dependency by its `file:` path, and pnpm 10
/// re-reads it on every later global install, so the archive lives in a data
/// directory that the system does not purge, not in a cache directory.
fn archive_directory() -> Result<PathBuf, UpgradeError> {
    let absolute = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let root = if cfg!(windows) {
        absolute("LOCALAPPDATA").map(|root| root.join("krx-cli"))
    } else if cfg!(target_os = "macos") {
        absolute("HOME").map(|root| root.join("Library/Application Support/krx-cli"))
    } else {
        absolute("XDG_DATA_HOME")
            .map(|root| root.join("krx-cli"))
            .or_else(|| absolute("HOME").map(|root| root.join(".local/share/krx-cli")))
    };
    let directory = root
        .map(|root| root.join("releases"))
        .ok_or_else(|| {
            install_failed(
                "No user data directory is available to keep the release archive; the installation was not changed.",
            )
        })?;
    fs::create_dir_all(&directory).map_err(|_| {
        install_failed(
            "Could not create the release archive directory; the installation was not changed.",
        )
    })?;
    Ok(directory)
}

/// Writes the verified archive under its release name, replacing atomically.
fn persist_archive(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, UpgradeError> {
    let path = directory.join(name);
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = fs::create_dir_all(directory)
        .and_then(|()| {
            let mut file = File::create(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, &path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| path).map_err(|_| {
        install_failed(
            "Could not store the verified release archive; the installation was not changed.",
        )
    })
}

/// Removes archives of releases that are no longer installed.
fn remove_other_archives(directory: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_str().is_some_and(|name| {
            name != keep && name.starts_with(&format!("{PACKAGE_NAME}-")) && name.ends_with(".tgz")
        }) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The running package, when pnpm manages it as a global dependency.
fn installed_package(pnpm: &Pnpm, running: Version) -> Result<GlobalPackage, UpgradeError> {
    let not_package = || {
        unmanaged(format!(
            "This krx executable is not inside an installed {PACKAGE_NAME} {running} package."
        ))
    };
    let executable = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| not_package())?;
    let package = executable
        .parent()
        .filter(|bin| bin.file_name() == Some(OsStr::new("bin")))
        .and_then(Path::parent)
        .filter(|_| executable.file_name() == Some(OsStr::new(EXECUTABLE)))
        .ok_or_else(not_package)?
        .to_path_buf();
    let manifest = read_bounded(&package.join("package.json"), MAX_PACKAGE_JSON_BYTES)
        .as_deref()
        .and_then(PackageJson::parse);
    if !manifest.is_some_and(|manifest| manifest.is_krx(running)) {
        return Err(not_package());
    }
    pnpm.global_packages()?
        .into_iter()
        .find(|installed| fs::canonicalize(&installed.path).ok().as_ref() == Some(&package))
        .map(|installed| GlobalPackage {
            path: plain_path(package),
            ..installed
        })
        .ok_or_else(|| {
            unmanaged(
                "pnpm does not list this krx as its global krx-cli package, so krx upgrade does not manage it.",
            )
        })
}

/// `path` without the Windows verbatim prefix that canonicalization adds.
fn plain_path(path: PathBuf) -> PathBuf {
    let plain = path
        .to_str()
        .and_then(|text| text.strip_prefix(r"\\?\"))
        .filter(|text| !text.starts_with(r"UNC\"))
        .map(PathBuf::from);
    plain.unwrap_or(path)
}

/// Confirms pnpm's global krx-cli is `version` and its executable reports it.
fn confirm_installed(pnpm: &Pnpm, version: Version) -> Result<PathBuf, UpgradeError> {
    let unconfirmed = |detail: &str| {
        verification_failed(format!(
            "pnpm reported success, but {detail}. Check the installation with krx --version."
        ))
    };
    let installed = pnpm.global_packages()?;
    let [package] = installed.as_slice() else {
        return Err(unconfirmed(
            "pnpm does not list exactly one global krx-cli package",
        ));
    };
    if package.version != version.to_string() {
        return Err(unconfirmed(&format!(
            "pnpm lists krx-cli {} instead of {version}",
            package.version
        )));
    }
    let executable = package.path.join("bin").join(EXECUTABLE);
    if reported_version(&executable).as_deref() != Some(version.to_string().as_str()) {
        return Err(unconfirmed(&format!(
            "the installed executable does not report {version}"
        )));
    }
    Ok(plain_path(
        fs::canonicalize(&package.path).unwrap_or_else(|_| package.path.clone()),
    ))
}

fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// The bare version an executable prints for `--version`, if it does in time.
fn reported_version(executable: &Path) -> Option<String> {
    let mut command = Command::new(executable);
    command.arg("--version");
    let output = run_bounded(&mut command, VERSION_TIMEOUT)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Runs `command` with piped output, killing it after `timeout`.
fn run_bounded(command: &mut Command, timeout: Duration) -> Option<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = (&mut stdout).take(16 << 20).read_to_end(&mut output);
        output
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(Output {
        status,
        stdout: reader.join().unwrap_or_default(),
        stderr: Vec::new(),
    })
}

#[derive(Debug, PartialEq, Eq)]
struct GlobalPackage {
    version: String,
    path: PathBuf,
    /// The `file:` tarball pnpm resolved the package from, when it reports one.
    source: Option<PathBuf>,
}

/// Global `krx-cli` dependencies in `pnpm list --global --json` output.
///
/// pnpm 10 lists one global project and each dependency's `file:` source
/// relative to it; pnpm 11 and later list one isolated project per global
/// installation without a source. Both carry each dependency's version and path.
fn parse_global_list(stdout: &[u8]) -> Option<Vec<GlobalPackage>> {
    let projects: Vec<Value> = serde_json::from_slice(stdout).ok()?;
    Some(
        projects
            .iter()
            .filter_map(|project| {
                let dependency = project["dependencies"].get(PACKAGE_NAME)?;
                let source = dependency["resolved"]
                    .as_str()
                    .and_then(|resolved| resolved.strip_prefix("file:"))
                    .zip(project["path"].as_str())
                    .map(|(file, project)| Path::new(project).join(file));
                Some(GlobalPackage {
                    version: dependency["version"].as_str()?.to_owned(),
                    path: PathBuf::from(dependency["path"].as_str()?),
                    source,
                })
            })
            .collect(),
    )
}

/// The pnpm executable on `PATH`, run from a private working directory.
struct Pnpm {
    program: PathBuf,
    working_directory: PathBuf,
}

impl Pnpm {
    fn locate(working_directory: PathBuf) -> Result<Self, UpgradeError> {
        // Windows installs pnpm as a native executable or as a `.cmd` shim.
        let names: &[&str] = if cfg!(windows) {
            &["pnpm.exe", "pnpm.cmd"]
        } else {
            &["pnpm"]
        };
        std::env::var_os("PATH")
            .iter()
            .flat_map(std::env::split_paths)
            .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
            .find(|candidate| candidate.is_file())
            .map(|program| Self {
                program,
                working_directory,
            })
            .ok_or_else(|| {
                unmanaged("pnpm is not on PATH, so krx upgrade cannot manage this installation.")
            })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        // A project directory can pin another pnpm version or configuration;
        // global operations must not depend on where krx was started, nor on
        // a shared directory such as /tmp that other users can write.
        command.current_dir(&self.working_directory);
        command
    }

    fn global_packages(&self) -> Result<Vec<GlobalPackage>, UpgradeError> {
        let mut command = self.command();
        command.args(["list", "--global", "--json", "--depth", "0"]);
        run_bounded(&mut command, PNPM_LIST_TIMEOUT)
            .filter(|output| output.status.success())
            .and_then(|output| parse_global_list(&output.stdout))
            .ok_or_else(|| unmanaged("pnpm list --global did not report its global packages."))
    }

    /// Installs `archive` globally; pnpm keeps the previous installation on failure.
    fn install(&self, archive: &Path, terminal: bool) -> Result<(), UpgradeError> {
        let mut command = self.command();
        command
            .args(["add", "--global", "--ignore-scripts"])
            .arg(archive);
        let status = Self::run_visible(&mut command, terminal)
            .map_err(|_| install_failed("Could not start pnpm to install the release."))?;
        if status.success() {
            return Ok(());
        }
        Err(install_failed(format!(
            "pnpm add --global exited with {status}; pnpm keeps the previous installation when an install fails."
        ))
        .hint(format!(
            "Retry, or run pnpm add --global --ignore-scripts {} to see pnpm's diagnostics.",
            archive.display()
        )))
    }

    /// Removes the global krx-cli package before installing `archive` again.
    fn remove(&self, archive: &Path, terminal: bool) -> Result<(), UpgradeError> {
        let mut command = self.command();
        command.args(["remove", "--global", PACKAGE_NAME]);
        match Self::run_visible(&mut command, terminal) {
            Ok(status) if status.success() => Ok(()),
            // A failed removal may have unlinked part of the package.
            _ => Err(install_failed(
                "pnpm could not remove the global krx-cli package whose original archive is gone, so the new release was not installed.",
            )
            .hint(format!(
                "Check krx --version; to finish, run pnpm add --global --ignore-scripts {}.",
                archive.display()
            ))),
        }
    }

    /// Runs pnpm, showing its output on stderr only in a terminal.
    fn run_visible(
        command: &mut Command,
        terminal: bool,
    ) -> std::io::Result<std::process::ExitStatus> {
        command.stdin(Stdio::null());
        if terminal {
            command.stdout(std::io::stderr()).stderr(std::io::stderr());
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        command.status()
    }
}

#[cfg(test)]
mod tests {
    use flate2::{Compression, write::GzEncoder};

    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn package_json(name: &str, version: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "name": name, "version": version, "bin": {"krx": format!("./bin/{EXECUTABLE}")}
        }))
        .unwrap()
    }

    fn archive(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        for (name, bytes, kind) in entries {
            let mut header = tar::Header::new_ustar();
            header.set_entry_type(*kind);
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            if kind.is_symlink() {
                header.set_link_name("elsewhere").unwrap();
            }
            builder.append_data(&mut header, name, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn checksum_list_requires_one_exact_digest() {
        let digest = "a".repeat(64);
        let archive = "krx-cli-1.9.0-linux-x64-gnu.tgz";
        let list = format!("{digest}  {archive}\n{}  other.tgz\n", "b".repeat(64));
        assert_eq!(checksum_entry(list.as_bytes(), archive).unwrap(), digest);
        let uppercase = format!("{}  {archive}\n", digest.to_uppercase());
        assert_eq!(
            checksum_entry(uppercase.as_bytes(), archive).unwrap(),
            digest
        );
        for invalid in [
            String::new(),
            format!("{digest}  {archive}\n{digest}  {archive}\n"),
            format!("{}  {archive}\n", "z".repeat(64)),
            format!("{digest} {archive}\n"),
            format!("{digest}  {archive}.sig\n"),
        ] {
            assert!(
                checksum_entry(invalid.as_bytes(), archive).is_err(),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn archive_must_be_the_krx_package_of_the_release_version() {
        let file = tar::EntryType::Regular;
        let executable = format!("package/bin/{EXECUTABLE}");
        let good = package_json(PACKAGE_NAME, "1.9.0");
        let valid = archive(&[
            ("package/package.json", &good, file),
            (&executable, b"binary", file),
            ("package/LICENSE", b"license", file),
        ]);
        verify_package(&valid, version("1.9.0")).unwrap();
        assert_eq!(
            verify_package(&valid, version("1.9.1")).unwrap_err().code,
            "verification_failed"
        );
        let other = package_json("other", "1.9.0");
        for invalid in [
            archive(&[("package/package.json", &good, file)]),
            archive(&[(&executable, b"binary", file)]),
            archive(&[
                ("package/package.json", &other, file),
                (&executable, b"binary", file),
            ]),
            archive(&[
                ("package/package.json", &good, file),
                (&executable, b"", tar::EntryType::Symlink),
            ]),
            archive(&[
                ("package/package.json", &good, file),
                (&executable, b"", file),
            ]),
            archive(&[
                ("package/package.json", b"not json", file),
                (&executable, b"binary", file),
            ]),
            b"not gzip".to_vec(),
        ] {
            assert_eq!(
                verify_package(&invalid, version("1.9.0")).unwrap_err().code,
                "verification_failed"
            );
        }
    }

    #[test]
    fn global_lists_of_pnpm_10_and_later_parse() {
        let pnpm10 = br#"[{"name":"global","path":"/g/5","dependencies":{
            "krx-cli":{"from":"krx-cli","version":"1.8.2","resolved":"file:../../a.tgz","path":"/g/5/node_modules/krx-cli"},
            "other":{"version":"1.0.0","path":"/g/5/node_modules/other"}}}]"#;
        assert_eq!(
            parse_global_list(pnpm10).unwrap(),
            [GlobalPackage {
                version: "1.8.2".to_owned(),
                path: PathBuf::from("/g/5/node_modules/krx-cli"),
                source: Some(Path::new("/g/5").join("../../a.tgz")),
            }]
        );
        let pnpm12 = br#"[{"path":"C:\\g\\v11","private":true,"dependencies":{
            "krx-cli":{"from":"krx-cli","version":"1.8.3","path":"\\\\?\\C:\\g\\v11\\b404\\node_modules\\krx-cli"}}},
            {"path":"C:\\g\\v11","dependencies":{"other":{"version":"1.0.0","path":"C:\\o"}}}]"#;
        let packages = parse_global_list(pnpm12).unwrap();
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].version, "1.8.3");
        assert_eq!(packages[0].source, None);
        assert_eq!(parse_global_list(b"[]").unwrap(), []);
        assert!(parse_global_list(b"not json").is_none());
    }

    #[test]
    fn archives_persist_atomically_and_old_releases_are_removed() {
        let directory =
            std::env::temp_dir().join(format!("krx-upgrade-archives-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let old = persist_archive(&directory, "krx-cli-1.8.2-linux-x64-gnu.tgz", b"old").unwrap();
        let new = persist_archive(&directory, "krx-cli-1.9.0-linux-x64-gnu.tgz", b"new").unwrap();
        fs::write(directory.join("unrelated.txt"), b"keep").unwrap();
        remove_other_archives(&directory, "krx-cli-1.9.0-linux-x64-gnu.tgz");
        assert!(!old.exists());
        assert_eq!(fs::read(&new).unwrap(), b"new");
        assert!(directory.join("unrelated.txt").exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn outcome_reports_installed_version_and_next_step() {
        let outcome = |updated, installable| {
            Outcome {
                running: version("1.8.2"),
                latest: version("1.9.0"),
                target: "linux-x64-gnu",
                release_url: "https://github.com/cpaikr/krx-cli/releases/tag/v1.9.0".to_owned(),
                package_directory: PathBuf::from("/g/node_modules/krx-cli"),
                installable,
                updated,
            }
            .value()
        };
        let checked = outcome(false, true);
        assert_eq!(checked["installedVersion"], "1.8.2");
        assert_eq!(checked["updateAvailable"], true);
        assert_eq!(checked["help"], "Run krx upgrade to install krx 1.9.0.");
        let upgraded = outcome(true, true);
        assert_eq!(upgraded["installedVersion"], "1.9.0");
        assert!(upgraded.get("help").is_none());
        let incomplete = outcome(false, false);
        assert_eq!(incomplete["distribution"], "incomplete_distribution");
        assert!(incomplete["help"].as_str().unwrap().contains("keep 1.8.2"));
        assert_eq!(display_size(7_730_862), "7.8 MB");
    }
}
