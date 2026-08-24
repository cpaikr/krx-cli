use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustix::fd::OwnedFd;
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};
use uuid::{Uuid, Variant};

use crate::{KrxError, KrxErrorCode};

const DIRECTORY_MODE: Mode = Mode::RWXU;
const FILE_MODE: Mode = Mode::RUSR.union(Mode::WUSR);
const STEAL_CLAIM_FILE: &str = "steal";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadSensitivity {
    NonSecret,
    LegacySecret,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u128,
    inode: u128,
    size: i128,
    modified_seconds: i128,
    modified_nanoseconds: i128,
}

#[derive(Clone, Debug)]
pub(crate) struct ObservedFile {
    bytes: Vec<u8>,
    identity: FileIdentity,
    complete: bool,
}

impl ObservedFile {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.complete
    }
}

#[derive(Clone, Debug)]
pub(crate) struct StateRoot {
    path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct AtomicWriteFailure {
    error: KrxError,
    committed: bool,
}

impl AtomicWriteFailure {
    pub(crate) fn committed(&self) -> bool {
        self.committed
    }

    pub(crate) fn into_error(self) -> KrxError {
        self.error
    }
}

#[derive(Debug)]
pub(crate) struct PlainDirectoryLock {
    parent: OwnedFd,
    leaf: OsString,
    owner: String,
}

#[derive(Debug)]
pub(crate) struct CacheDirectoryLease {
    parent: OwnedFd,
    leaf: OsString,
    directory: OwnedFd,
    identity: FileIdentity,
    owner: ObservedFile,
}

#[derive(Debug)]
pub(crate) struct ObservedCacheDirectoryLease {
    directory: OwnedFd,
    identity: FileIdentity,
    modified: SystemTime,
    owner: Option<ObservedFile>,
}

impl ObservedCacheDirectoryLease {
    pub(crate) fn owner_bytes(&self) -> Option<&[u8]> {
        self.owner
            .as_ref()
            .filter(|owner| owner.is_complete())
            .map(ObservedFile::bytes)
    }

    pub(crate) fn modified(&self) -> SystemTime {
        self.modified
    }
}

impl StateRoot {
    pub(crate) fn new(path: PathBuf) -> Result<Self, KrxError> {
        validate_absolute_root(&path)?;
        Ok(Self { path })
    }

    pub(crate) fn flight_namespace(&self) -> &Path {
        &self.path
    }

    pub(crate) fn read(
        &self,
        relative: &str,
        maximum_bytes: u64,
        sensitivity: ReadSensitivity,
        error_code: KrxErrorCode,
    ) -> Result<Option<ObservedFile>, KrxError> {
        self.read_internal(relative, maximum_bytes, sensitivity, error_code, false)
    }

    pub(crate) fn read_cache(
        &self,
        relative: &str,
        maximum_bytes: u64,
        error_code: KrxErrorCode,
    ) -> Result<Option<ObservedFile>, KrxError> {
        self.read_internal(
            relative,
            maximum_bytes,
            ReadSensitivity::NonSecret,
            error_code,
            true,
        )
    }

    fn read_internal(
        &self,
        relative: &str,
        maximum_bytes: u64,
        sensitivity: ReadSensitivity,
        error_code: KrxErrorCode,
        observe_oversized: bool,
    ) -> Result<Option<ObservedFile>, KrxError> {
        let components = relative_components(relative)?;
        let Some(root) = open_absolute_root(&self.path, false, sensitivity, error_code)? else {
            return Ok(None);
        };
        read_from_root(
            &root,
            &components,
            maximum_bytes,
            sensitivity,
            error_code,
            observe_oversized,
        )
    }

    pub(crate) fn atomic_write(
        &self,
        relative: &str,
        bytes: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<(), KrxError> {
        self.atomic_write_observed(relative, bytes, error_code)
            .map_err(AtomicWriteFailure::into_error)
    }

    /// Removes the observed file only while the pathname still names the same
    /// owned regular file with the exact bytes that were read. A concurrent
    /// atomic replacement is left untouched.
    pub(crate) fn remove_if_unchanged(
        &self,
        relative: &str,
        observed: &ObservedFile,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        self.change_observed_file(relative, observed, None, error_code)
    }

    /// Renames the observed file within its secured parent only while its
    /// identity and bytes are unchanged. `destination_leaf` must be a single
    /// filename; callers use a unique quarantine name.
    pub(crate) fn rename_if_unchanged(
        &self,
        relative: &str,
        observed: &ObservedFile,
        destination_leaf: &str,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        let destination = relative_components(destination_leaf)?;
        if destination.len() != 1 {
            return Err(invalid_state_path(
                "local state rename target must be one filename",
            ));
        }
        self.change_observed_file(relative, observed, Some(&destination[0]), error_code)
    }

    fn change_observed_file(
        &self,
        relative: &str,
        observed: &ObservedFile,
        destination_leaf: Option<&OsStr>,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        if !observed.complete {
            return Ok(false);
        }
        let components = relative_components(relative)?;
        let Some(root) =
            open_absolute_root(&self.path, false, ReadSensitivity::NonSecret, error_code)?
        else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(&root, parents, false, error_code)? else {
            return Ok(false);
        };
        if !path_matches_file(&parent, &leaf[0], &observed.identity, error_code)? {
            return Ok(false);
        }
        let Some(current) = read_from_parent(
            &parent,
            &leaf[0],
            observed.bytes.len() as u64,
            ReadSensitivity::NonSecret,
            error_code,
            false,
        )?
        else {
            return Ok(false);
        };
        if current.identity != observed.identity || current.bytes != observed.bytes {
            return Ok(false);
        }
        if !path_matches_file(&parent, &leaf[0], &observed.identity, error_code)? {
            return Ok(false);
        }
        match destination_leaf {
            Some(destination) => {
                match rustix::fs::renameat(&parent, &leaf[0], &parent, destination) {
                    Ok(()) => {}
                    Err(error)
                        if error == rustix::io::Errno::NOENT
                            || error == rustix::io::Errno::EXIST
                            || error == rustix::io::Errno::NOTEMPTY =>
                    {
                        return Ok(false);
                    }
                    Err(_) => {
                        return Err(state_error(error_code, "local state rename failed"));
                    }
                }
            }
            None => match rustix::fs::unlinkat(&parent, &leaf[0], AtFlags::empty()) {
                Ok(()) => {}
                Err(error) if error == rustix::io::Errno::NOENT => return Ok(false),
                Err(_) => return Err(state_error(error_code, "local state removal failed")),
            },
        }
        rustix::fs::fsync(&parent)
            .map_err(|_| state_error(error_code, "local state parent sync failed"))?;
        Ok(true)
    }

    pub(crate) fn atomic_write_observed(
        &self,
        relative: &str,
        bytes: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<(), AtomicWriteFailure> {
        self.atomic_write_observed_inner(relative, bytes, error_code, false, false)
            .map_err(|(error, committed)| AtomicWriteFailure { error, committed })
    }

    fn atomic_write_observed_inner(
        &self,
        relative: &str,
        bytes: &[u8],
        error_code: KrxErrorCode,
        fail_before_commit: bool,
        fail_after_commit: bool,
    ) -> Result<(), (KrxError, bool)> {
        let before_commit = |error| (error, false);
        let components = relative_components(relative).map_err(before_commit)?;
        let root = open_absolute_root(&self.path, true, ReadSensitivity::NonSecret, error_code)
            .map_err(before_commit)?
            .ok_or_else(|| state_error(error_code, "local state root could not be created"))
            .map_err(before_commit)?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(&root, parents, true, error_code)
            .map_err(before_commit)?
            .ok_or_else(|| state_error(error_code, "local state parent could not be created"))
            .map_err(before_commit)?;
        validate_destination(&parent, &leaf[0], error_code).map_err(before_commit)?;

        let temporary = temporary_name(&leaf[0]).map_err(before_commit)?;
        let descriptor = rustix::fs::openat(
            &parent,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            FILE_MODE,
        )
        .map_err(|_| {
            before_commit(state_error(
                error_code,
                "local state temporary file creation failed",
            ))
        })?;
        let mut file = File::from(descriptor);
        let mut committed = false;
        let result = (|| {
            file.write_all(bytes)
                .map_err(|_| state_error(error_code, "local state write failed"))?;
            rustix::fs::fchmod(&file, FILE_MODE)
                .map_err(|_| state_error(error_code, "local state permission repair failed"))?;
            file.sync_all()
                .map_err(|_| state_error(error_code, "local state file sync failed"))?;
            if fail_before_commit {
                return Err(state_error(
                    error_code,
                    "injected local state pre-commit failure",
                ));
            }
            drop(file);
            rustix::fs::renameat(&parent, &temporary, &parent, &leaf[0])
                .map_err(|_| state_error(error_code, "local state atomic replace failed"))?;
            committed = true;
            if fail_after_commit {
                return Err(state_error(
                    error_code,
                    "injected local state directory sync failure",
                ));
            }
            rustix::fs::fsync(&parent)
                .map_err(|_| state_error(error_code, "local state directory sync failed"))?;
            Ok(())
        })();
        if result.is_err() && !committed {
            let _ = rustix::fs::unlinkat(&parent, &temporary, AtFlags::empty());
        }
        result.map_err(|error| (error, committed))
    }

    #[cfg(test)]
    pub(crate) fn atomic_write_with_post_commit_failure(
        &self,
        relative: &str,
        bytes: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<(), AtomicWriteFailure> {
        self.atomic_write_observed_inner(relative, bytes, error_code, false, true)
            .map_err(|(error, committed)| AtomicWriteFailure { error, committed })
    }

    #[cfg(test)]
    fn atomic_write_with_pre_commit_failure(
        &self,
        relative: &str,
        bytes: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<(), AtomicWriteFailure> {
        self.atomic_write_observed_inner(relative, bytes, error_code, true, false)
            .map_err(|(error, committed)| AtomicWriteFailure { error, committed })
    }

    pub(crate) fn try_acquire_plain_lock(
        &self,
        relative: &str,
        owner: String,
        error_code: KrxErrorCode,
    ) -> Result<Option<PlainDirectoryLock>, KrxError> {
        self.try_acquire_plain_lock_with_sensitivity(
            relative,
            owner,
            ReadSensitivity::NonSecret,
            error_code,
        )
    }

    pub(crate) fn try_acquire_cache_lease(
        &self,
        relative: &str,
        owner_json: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<Option<CacheDirectoryLease>, KrxError> {
        if owner_json.is_empty() || owner_json.len() > 1024 {
            return Err(invalid_state_path("cache lease owner is malformed"));
        }
        let components = relative_components(relative)?;
        let root = open_absolute_root(&self.path, true, ReadSensitivity::NonSecret, error_code)?
            .ok_or_else(|| state_error(error_code, "local state root could not be created"))?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(&root, parents, true, error_code)?
            .ok_or_else(|| state_error(error_code, "cache lease parent could not be created"))?;
        match rustix::fs::mkdirat(&parent, &leaf[0], DIRECTORY_MODE) {
            Ok(()) => {}
            Err(error) if error == rustix::io::Errno::EXIST => {
                validate_lock_directory(&parent, &leaf[0], error_code)?;
                return Ok(None);
            }
            Err(_) => return Err(state_error(error_code, "cache lease creation failed")),
        }
        let directory = rustix::fs::openat(
            &parent,
            &leaf[0],
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| state_error(error_code, "cache lease open failed"))?;
        let identity = file_identity(
            &rustix::fs::fstat(&directory)
                .map_err(|_| state_error(error_code, "cache lease inspection failed"))?,
        );
        let owner = match write_cache_lease_owner(&directory, owner_json, error_code) {
            Ok(owner) => owner,
            Err(error) => {
                abandon_new_cache_lease(&directory);
                return Err(error);
            }
        };
        if rustix::fs::fsync(&parent).is_err() {
            abandon_new_cache_lease(&directory);
            return Err(state_error(error_code, "cache lease parent sync failed"));
        }
        if read_steal_claim(&directory, error_code)?.is_some() {
            abandon_new_cache_lease(&directory);
            return Ok(None);
        }
        if !path_matches_directory(&parent, &leaf[0], &identity, error_code)? {
            abandon_new_cache_lease(&directory);
            return Ok(None);
        }
        Ok(Some(CacheDirectoryLease {
            parent,
            leaf: leaf[0].clone(),
            directory,
            identity,
            owner,
        }))
    }

    pub(crate) fn observe_cache_lease(
        &self,
        relative: &str,
        maximum_owner_bytes: u64,
        error_code: KrxErrorCode,
    ) -> Result<Option<ObservedCacheDirectoryLease>, KrxError> {
        let components = relative_components(relative)?;
        let Some(root) =
            open_absolute_root(&self.path, false, ReadSensitivity::NonSecret, error_code)?
        else {
            return Ok(None);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(&root, parents, false, error_code)? else {
            return Ok(None);
        };
        if !validate_lock_directory(&parent, &leaf[0], error_code)? {
            return Ok(None);
        }
        let directory = match rustix::fs::openat(
            &parent,
            &leaf[0],
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(directory) => directory,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
            Err(_) => return Err(state_error(error_code, "cache lease open failed")),
        };
        inspect_open_cache_lease(&directory, maximum_owner_bytes, error_code)
    }

    pub(crate) fn steal_cache_lease_if_unchanged(
        &self,
        relative: &str,
        observed: &ObservedCacheDirectoryLease,
        tombstone_leaf: &str,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        let components = relative_components(relative)?;
        let tombstone = relative_components(tombstone_leaf)?;
        if tombstone.len() != 1 {
            return Err(invalid_state_path(
                "cache lease tombstone must be one filename",
            ));
        }
        let Some(root) =
            open_absolute_root(&self.path, false, ReadSensitivity::NonSecret, error_code)?
        else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(&root, parents, false, error_code)? else {
            return Ok(false);
        };
        if !path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)?
            || !cache_lease_owner_matches(
                &observed.directory,
                observed.owner.as_ref(),
                1024,
                error_code,
            )?
        {
            return Ok(false);
        }

        let claimant = format!("{}-{}", std::process::id(), Uuid::new_v4());
        if let Some(existing) = read_steal_claim(&observed.directory, error_code)? {
            if plain_lock_owner_is_alive(Some(&existing.owner)) {
                return Ok(false);
            }
            release_steal_claim(&observed.directory, &existing);
            if read_steal_claim(&observed.directory, error_code)?.is_some() {
                return Ok(false);
            }
        }
        let Some(claim) = publish_steal_claim(&observed.directory, &claimant, error_code)? else {
            return Ok(false);
        };
        let revalidated = (|| {
            Ok(
                path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)?
                    && cache_lease_owner_matches(
                        &observed.directory,
                        observed.owner.as_ref(),
                        1024,
                        error_code,
                    )?
                    && read_steal_claim(&observed.directory, error_code)?.is_some_and(|current| {
                        current.owner == claim.owner
                            && same_object_identity(&current.identity, &claim.identity)
                    }),
            )
        })();
        match revalidated {
            Ok(true) => {}
            Ok(false) => {
                release_steal_claim(&observed.directory, &claim);
                return Ok(false);
            }
            Err(error) => {
                release_steal_claim(&observed.directory, &claim);
                return Err(error);
            }
        }
        match rustix::fs::renameat(&parent, &leaf[0], &parent, &tombstone[0]) {
            Ok(()) => {}
            Err(error)
                if error == rustix::io::Errno::NOENT
                    || error == rustix::io::Errno::EXIST
                    || error == rustix::io::Errno::NOTEMPTY =>
            {
                release_steal_claim(&observed.directory, &claim);
                return Ok(false);
            }
            Err(_) => {
                release_steal_claim(&observed.directory, &claim);
                return Err(state_error(error_code, "stale cache lease rename failed"));
            }
        }
        if rustix::fs::fsync(&parent).is_err() {
            return Err(state_error(error_code, "stale cache lease sync failed"));
        }
        release_steal_claim(&observed.directory, &claim);
        cleanup_cache_lease_directory(
            &parent,
            &tombstone[0],
            &observed.directory,
            &observed.identity,
            observed.owner.as_ref(),
        );
        Ok(true)
    }

    pub(crate) fn try_acquire_legacy_secret_plain_lock(
        &self,
        relative: &str,
        owner: String,
        error_code: KrxErrorCode,
    ) -> Result<Option<PlainDirectoryLock>, KrxError> {
        self.try_acquire_plain_lock_with_sensitivity(
            relative,
            owner,
            ReadSensitivity::LegacySecret,
            error_code,
        )
    }

    fn try_acquire_plain_lock_with_sensitivity(
        &self,
        relative: &str,
        owner: String,
        sensitivity: ReadSensitivity,
        error_code: KrxErrorCode,
    ) -> Result<Option<PlainDirectoryLock>, KrxError> {
        validate_plain_lock_owner(&owner)?;
        let components = relative_components(relative)?;
        let root = open_absolute_root(&self.path, true, sensitivity, error_code)?
            .ok_or_else(|| state_error(error_code, "local state root could not be created"))?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(&root, parents, true, error_code)?
            .ok_or_else(|| state_error(error_code, "local lock parent could not be created"))?;
        match rustix::fs::mkdirat(&parent, &leaf[0], DIRECTORY_MODE) {
            Ok(()) => {}
            Err(error) if error == rustix::io::Errno::EXIST => {
                validate_lock_directory(&parent, &leaf[0], error_code)?;
                return Ok(None);
            }
            Err(_) => return Err(state_error(error_code, "local lock creation failed")),
        }
        let lock_directory = rustix::fs::openat(
            &parent,
            &leaf[0],
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| state_error(error_code, "local lock open failed"))?;
        let created_identity = file_identity(
            &rustix::fs::fstat(&lock_directory)
                .map_err(|_| state_error(error_code, "local lock inspection failed"))?,
        );
        let result = write_lock_owner(&lock_directory, &owner, error_code);
        if let Err(error) = result {
            abandon_new_lock(&lock_directory);
            return Err(error);
        }
        if rustix::fs::fsync(&parent).is_err() {
            abandon_new_lock(&lock_directory);
            return Err(state_error(error_code, "local lock parent sync failed"));
        }
        match read_steal_claim(&lock_directory, error_code) {
            Ok(Some(_)) => {
                abandon_new_lock(&lock_directory);
                return Ok(None);
            }
            Ok(None) => {}
            Err(error) => {
                abandon_new_lock(&lock_directory);
                return Err(error);
            }
        }
        if !path_matches_directory(&parent, &leaf[0], &created_identity, error_code)? {
            abandon_new_lock(&lock_directory);
            return Ok(None);
        }
        Ok(Some(PlainDirectoryLock {
            parent,
            leaf: leaf[0].clone(),
            owner,
        }))
    }

    pub(crate) fn steal_plain_lock_if_stale(
        &self,
        relative: &str,
        stale_after: Duration,
        now: SystemTime,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        self.steal_plain_lock_if_stale_with_sensitivity(
            relative,
            stale_after,
            now,
            ReadSensitivity::NonSecret,
            error_code,
        )
    }

    pub(crate) fn steal_legacy_secret_plain_lock_if_stale(
        &self,
        relative: &str,
        stale_after: Duration,
        now: SystemTime,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        self.steal_plain_lock_if_stale_with_sensitivity(
            relative,
            stale_after,
            now,
            ReadSensitivity::LegacySecret,
            error_code,
        )
    }

    fn steal_plain_lock_if_stale_with_sensitivity(
        &self,
        relative: &str,
        stale_after: Duration,
        now: SystemTime,
        sensitivity: ReadSensitivity,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        let components = relative_components(relative)?;
        let Some(root) = open_absolute_root(&self.path, false, sensitivity, error_code)? else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(&root, parents, false, error_code)? else {
            return Ok(false);
        };
        let Some(observed) = inspect_plain_lock(&parent, &leaf[0], error_code)? else {
            return Ok(false);
        };
        if now
            .duration_since(observed.modified)
            .unwrap_or(Duration::ZERO)
            <= stale_after
            || plain_lock_owner_is_alive(observed.owner.as_deref())
        {
            return Ok(false);
        }

        let claimant = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let (claim, owns_claim) = match read_steal_claim(&observed.directory, error_code)? {
            Some(claim) if plain_lock_owner_is_alive(Some(&claim.owner)) => return Ok(false),
            Some(claim) => (claim, false),
            None => {
                let Some(claim) = publish_steal_claim(&observed.directory, &claimant, error_code)?
                else {
                    return Ok(false);
                };
                (claim, true)
            }
        };

        let revalidated =
            path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)?
                && read_lock_owner(&observed.directory, error_code)? == observed.owner
                && plain_file_identity(&observed.directory, "owner", error_code)?
                    == observed.owner_identity
                && !plain_lock_owner_is_alive(observed.owner.as_deref())
                && read_steal_claim(&observed.directory, error_code)?.is_some_and(|current| {
                    current.owner == claim.owner
                        && same_object_identity(&current.identity, &claim.identity)
                });
        if !revalidated {
            if owns_claim {
                release_steal_claim(&observed.directory, &claim);
            }
            return Ok(false);
        }

        let moved = move_plain_lock_to_tombstone(&parent, &leaf[0], &observed, &claim, error_code);
        match moved {
            Ok(true) => Ok(true),
            Ok(false) => {
                if owns_claim {
                    release_steal_claim(&observed.directory, &claim);
                }
                Ok(false)
            }
            Err(error) => {
                if owns_claim
                    && path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)
                        .unwrap_or(false)
                {
                    release_steal_claim(&observed.directory, &claim);
                }
                Err(error)
            }
        }
    }
}

impl Drop for PlainDirectoryLock {
    fn drop(&mut self) {
        let Ok(lock_directory) = rustix::fs::openat(
            &self.parent,
            &self.leaf,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) else {
            return;
        };
        let Ok(Some(owner)) = read_lock_owner(&lock_directory, KrxErrorCode::InternalFailure)
        else {
            return;
        };
        if owner != self.owner {
            return;
        }
        if rustix::fs::unlinkat(&lock_directory, "owner", AtFlags::empty()).is_err() {
            return;
        }
        if rustix::fs::unlinkat(&self.parent, &self.leaf, AtFlags::REMOVEDIR).is_ok() {
            let _ = rustix::fs::fsync(&self.parent);
        }
    }
}

impl Drop for CacheDirectoryLease {
    fn drop(&mut self) {
        cleanup_cache_lease_directory(
            &self.parent,
            &self.leaf,
            &self.directory,
            &self.identity,
            Some(&self.owner),
        );
    }
}

struct PlainLockObservation {
    directory: OwnedFd,
    identity: FileIdentity,
    modified: SystemTime,
    owner: Option<String>,
    owner_identity: Option<FileIdentity>,
}

struct PlainClaimObservation {
    identity: FileIdentity,
    owner: String,
}

fn state_error(code: KrxErrorCode, message: &'static str) -> KrxError {
    KrxError::new(code, message)
}

fn invalid_state_path(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::InternalFailure, message)
}

fn validate_absolute_root(path: &Path) -> Result<(), KrxError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(invalid_state_path(
            "local state root must be an absolute path",
        ));
    }
    for component in path.components() {
        if matches!(component, Component::CurDir | Component::ParentDir) {
            return Err(invalid_state_path(
                "local state root must not contain relative components",
            ));
        }
    }
    Ok(())
}

fn relative_components(relative: &str) -> Result<Vec<OsString>, KrxError> {
    let path = Path::new(relative);
    if relative.is_empty() || path.is_absolute() {
        return Err(invalid_state_path("local state path must be relative"));
    }
    let components = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(invalid_state_path(
                "local state path contains an unsafe component",
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(invalid_state_path("local state path must name a file"));
    }
    Ok(components)
}

fn temporary_name(leaf: &OsStr) -> Result<OsString, KrxError> {
    let leaf = leaf
        .to_str()
        .ok_or_else(|| invalid_state_path("state filename must be UTF-8"))?;
    Ok(OsString::from(format!(
        ".{leaf}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    )))
}

fn validate_plain_lock_owner(owner: &str) -> Result<(), KrxError> {
    let Some((pid, nonce)) = owner.split_once('-') else {
        return Err(invalid_state_path("local lock owner is malformed"));
    };
    let valid_uuid = Uuid::parse_str(nonce)
        .ok()
        .is_some_and(|uuid| uuid.get_version_num() == 4 && uuid.get_variant() == Variant::RFC4122);
    if pid.starts_with('0')
        || pid.parse::<u32>().ok().filter(|value| *value > 0).is_none()
        || !valid_uuid
        || nonce.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(invalid_state_path("local lock owner is malformed"));
    }
    Ok(())
}

fn write_lock_owner(
    lock_directory: &OwnedFd,
    owner: &str,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    let candidate = OsString::from(format!(".owner.{owner}.tmp"));
    let descriptor = rustix::fs::openat(
        lock_directory,
        &candidate,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        FILE_MODE,
    )
    .map_err(|_| state_error(error_code, "local lock owner candidate creation failed"))?;
    let mut file = File::from(descriptor);
    let mut published_identity = None;
    let result = (|| {
        file.write_all(owner.as_bytes())
            .map_err(|_| state_error(error_code, "local lock owner candidate write failed"))?;
        rustix::fs::fchmod(&file, FILE_MODE).map_err(|_| {
            state_error(
                error_code,
                "local lock owner candidate permission repair failed",
            )
        })?;
        file.sync_all()
            .map_err(|_| state_error(error_code, "local lock owner candidate sync failed"))?;
        let candidate_identity = file_identity(&rustix::fs::fstat(&file).map_err(|_| {
            state_error(error_code, "local lock owner candidate inspection failed")
        })?);
        rustix::fs::linkat(
            lock_directory,
            &candidate,
            lock_directory,
            "owner",
            AtFlags::empty(),
        )
        .map_err(|_| state_error(error_code, "local lock owner publication failed"))?;
        published_identity = Some(candidate_identity.clone());
        rustix::fs::fsync(lock_directory)
            .map_err(|_| state_error(error_code, "local lock directory sync failed"))?;
        if read_lock_owner(lock_directory, error_code)?.as_deref() != Some(owner)
            || !plain_file_identity(lock_directory, "owner", error_code)?
                .is_some_and(|identity| same_object_identity(&identity, &candidate_identity))
        {
            return Err(state_error(
                error_code,
                "local lock owner publication changed",
            ));
        }
        Ok(())
    })();
    drop(file);
    if result.is_err()
        && let Some(expected) = &published_identity
        && plain_file_identity(lock_directory, "owner", error_code)
            .ok()
            .flatten()
            .is_some_and(|identity| same_object_identity(&identity, expected))
    {
        let _ = rustix::fs::unlinkat(lock_directory, "owner", AtFlags::empty());
    }
    let candidate_removed = rustix::fs::unlinkat(lock_directory, &candidate, AtFlags::empty());
    let directory_synced = rustix::fs::fsync(lock_directory);
    result?;
    candidate_removed
        .map_err(|_| state_error(error_code, "local lock owner candidate cleanup failed"))?;
    directory_synced.map_err(|_| state_error(error_code, "local lock directory sync failed"))
}

fn abandon_new_lock(lock_directory: &OwnedFd) {
    // Removing the pathname after an identity check still has a swap window.
    // Leave the ownerless directory for bounded stale-lock recovery instead of
    // ever deleting a replacement contender's lock.
    let _ = rustix::fs::unlinkat(lock_directory, "owner", AtFlags::empty());
    let _ = rustix::fs::fsync(lock_directory);
}

fn validate_lock_directory(
    parent: &OwnedFd,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let stat = match rustix::fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(false),
        Err(_) => return Err(state_error(error_code, "local lock inspection failed")),
    };
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return Err(state_error(
            error_code,
            "local lock path is not a directory",
        ));
    }
    if u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw()) {
        return Err(state_error(error_code, "local lock has a foreign owner"));
    }
    let actual = Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO);
    if actual != DIRECTORY_MODE {
        return Err(state_error(error_code, "local lock permissions are unsafe"));
    }
    Ok(true)
}

fn inspect_plain_lock(
    parent: &OwnedFd,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<Option<PlainLockObservation>, KrxError> {
    if !validate_lock_directory(parent, leaf, error_code)? {
        return Ok(None);
    }
    let directory = match rustix::fs::openat(
        parent,
        leaf,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(directory) => directory,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => return Err(state_error(error_code, "local lock open failed")),
    };
    inspect_open_plain_lock(&directory, error_code)
}

fn inspect_open_plain_lock(
    directory: &OwnedFd,
    error_code: KrxErrorCode,
) -> Result<Option<PlainLockObservation>, KrxError> {
    let Some(stat) = classify_lock_directory_stat(rustix::fs::fstat(directory), error_code)? else {
        return Ok(None);
    };
    validate_directory_stat(
        directory,
        &stat,
        false,
        ReadSensitivity::LegacySecret,
        error_code,
    )?;
    let seconds = u64::try_from(stat.st_mtime)
        .map_err(|_| state_error(error_code, "local lock timestamp is invalid"))?;
    let nanoseconds = u32::try_from(stat.st_mtime_nsec)
        .ok()
        .filter(|value| *value < 1_000_000_000)
        .ok_or_else(|| state_error(error_code, "local lock timestamp is invalid"))?;
    let modified = UNIX_EPOCH
        .checked_add(Duration::new(seconds, nanoseconds))
        .ok_or_else(|| state_error(error_code, "local lock timestamp is invalid"))?;
    let identity = file_identity(&stat);
    let owner = read_lock_owner(directory, error_code)?;
    let owner_identity = plain_file_identity(directory, "owner", error_code)?;
    Ok(Some(PlainLockObservation {
        directory: rustix::io::dup(directory)
            .map_err(|_| state_error(error_code, "local lock duplication failed"))?,
        identity,
        modified,
        owner,
        owner_identity,
    }))
}

fn classify_lock_directory_stat(
    result: Result<rustix::fs::Stat, rustix::io::Errno>,
    error_code: KrxErrorCode,
) -> Result<Option<rustix::fs::Stat>, KrxError> {
    match result {
        Ok(stat) => Ok(Some(stat)),
        // macOS can report ENOENT for a still-open directory descriptor after
        // another process removes the directory. This is ordinary lock
        // turnover, matching the Node implementation's retry-on-inspection-race
        // behavior, rather than corrupt persistent state.
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(_) => Err(state_error(error_code, "local lock inspection failed")),
    }
}

fn path_matches_directory(
    parent: &OwnedFd,
    leaf: &OsStr,
    expected: &FileIdentity,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    match rustix::fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(FileType::from_raw_mode(stat.st_mode) == FileType::Directory
            && u64::from(stat.st_uid) == u64::from(rustix::process::geteuid().as_raw())
            && Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO)
                == DIRECTORY_MODE
            && same_object_identity(&file_identity(&stat), expected)),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(false),
        Err(_) => Err(state_error(error_code, "local lock reinspection failed")),
    }
}

fn publish_steal_claim(
    lock_directory: &OwnedFd,
    claimant: &str,
    error_code: KrxErrorCode,
) -> Result<Option<PlainClaimObservation>, KrxError> {
    validate_plain_lock_owner(claimant)?;
    let candidate = OsString::from(format!(".steal.{claimant}.tmp"));
    let descriptor = rustix::fs::openat(
        lock_directory,
        &candidate,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        FILE_MODE,
    )
    .map_err(|_| state_error(error_code, "local steal candidate creation failed"))?;
    let mut file = File::from(descriptor);
    let mut published = None;
    let result = (|| {
        file.write_all(claimant.as_bytes())
            .map_err(|_| state_error(error_code, "local steal candidate write failed"))?;
        rustix::fs::fchmod(&file, FILE_MODE)
            .map_err(|_| state_error(error_code, "local steal candidate permission failed"))?;
        file.sync_all()
            .map_err(|_| state_error(error_code, "local steal candidate sync failed"))?;
        let candidate_identity = file_identity(
            &rustix::fs::fstat(&file)
                .map_err(|_| state_error(error_code, "local steal candidate inspection failed"))?,
        );
        match rustix::fs::linkat(
            lock_directory,
            &candidate,
            lock_directory,
            STEAL_CLAIM_FILE,
            AtFlags::empty(),
        ) {
            Ok(()) => {}
            Err(error)
                if error == rustix::io::Errno::EXIST || error == rustix::io::Errno::NOENT =>
            {
                return Ok(None);
            }
            Err(_) => {
                return Err(state_error(
                    error_code,
                    "local steal claim publication failed",
                ));
            }
        }
        published = Some(PlainClaimObservation {
            identity: candidate_identity.clone(),
            owner: claimant.to_owned(),
        });
        rustix::fs::fsync(lock_directory)
            .map_err(|_| state_error(error_code, "local steal claim sync failed"))?;
        let claim = read_steal_claim(lock_directory, error_code)?
            .ok_or_else(|| state_error(error_code, "local steal claim disappeared"))?;
        if claim.owner != claimant || !same_object_identity(&claim.identity, &candidate_identity) {
            return Err(state_error(
                error_code,
                "local steal claim identity changed",
            ));
        }
        Ok(Some(claim))
    })();
    if result.is_err()
        && let Some(claim) = &published
    {
        release_steal_claim(lock_directory, claim);
    }
    drop(file);
    let _ = rustix::fs::unlinkat(lock_directory, &candidate, AtFlags::empty());
    let _ = rustix::fs::fsync(lock_directory);
    result
}

fn read_steal_claim(
    lock_directory: &OwnedFd,
    error_code: KrxErrorCode,
) -> Result<Option<PlainClaimObservation>, KrxError> {
    let descriptor = match rustix::fs::openat(
        lock_directory,
        STEAL_CLAIM_FILE,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(descriptor) => descriptor,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => return Err(state_error(error_code, "local steal claim open failed")),
    };
    let stat = rustix::fs::fstat(&descriptor)
        .map_err(|_| state_error(error_code, "local steal claim inspection failed"))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
        || u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw())
        || Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO) != FILE_MODE
        || !(0..=128).contains(&stat.st_size)
    {
        return Err(state_error(error_code, "local steal claim is unsafe"));
    }
    let identity = file_identity(&stat);
    let mut file = File::from(descriptor);
    let mut bytes = Vec::with_capacity(stat.st_size as usize);
    Read::by_ref(&mut file)
        .take(129)
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "local steal claim read failed"))?;
    let after = rustix::fs::fstat(&file)
        .map_err(|_| state_error(error_code, "local steal claim reinspection failed"))?;
    let owner = String::from_utf8(bytes)
        .map_err(|_| state_error(error_code, "local steal claim is malformed"))?;
    if file_identity(&after) != identity || validate_plain_lock_owner(&owner).is_err() {
        return Err(state_error(error_code, "local steal claim is malformed"));
    }
    Ok(Some(PlainClaimObservation { identity, owner }))
}

fn release_steal_claim(lock_directory: &OwnedFd, expected: &PlainClaimObservation) {
    let Ok(Some(current)) = read_steal_claim(lock_directory, KrxErrorCode::InternalFailure) else {
        return;
    };
    if current.owner != expected.owner
        || !same_object_identity(&current.identity, &expected.identity)
    {
        return;
    }
    let _ = rustix::fs::unlinkat(lock_directory, STEAL_CLAIM_FILE, AtFlags::empty());
    let _ = rustix::fs::fsync(lock_directory);
}

fn read_lock_owner(
    lock_directory: &OwnedFd,
    error_code: KrxErrorCode,
) -> Result<Option<String>, KrxError> {
    let descriptor = match rustix::fs::openat(
        lock_directory,
        "owner",
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(descriptor) => descriptor,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => return Err(state_error(error_code, "local lock owner open failed")),
    };
    let stat = rustix::fs::fstat(&descriptor)
        .map_err(|_| state_error(error_code, "local lock owner inspection failed"))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
        || u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw())
    {
        return Err(state_error(error_code, "local lock owner is unsafe"));
    }
    let actual = Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO);
    if actual != FILE_MODE || !(0..=128).contains(&stat.st_size) {
        return Err(state_error(error_code, "local lock owner is unsafe"));
    }
    let identity = file_identity(&stat);
    let mut file = File::from(descriptor);
    let mut bytes = Vec::with_capacity(stat.st_size as usize);
    Read::by_ref(&mut file)
        .take(129)
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "local lock owner read failed"))?;
    if bytes.len() > 128 {
        return Err(state_error(error_code, "local lock owner is unsafe"));
    }
    let after = rustix::fs::fstat(&file)
        .map_err(|_| state_error(error_code, "local lock owner reinspection failed"))?;
    if file_identity(&after) != identity {
        return Ok(None);
    }
    let owner = String::from_utf8(bytes)
        .map_err(|_| state_error(error_code, "local lock owner is malformed"))?;
    if validate_plain_lock_owner(&owner).is_err() {
        return Err(state_error(error_code, "local lock owner is malformed"));
    }
    Ok(Some(owner))
}

fn plain_file_identity(
    directory: &OwnedFd,
    leaf: &str,
    error_code: KrxErrorCode,
) -> Result<Option<FileIdentity>, KrxError> {
    match rustix::fs::statat(directory, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(Some(file_identity(&stat))),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(_) => Err(state_error(
            error_code,
            "local lock file reinspection failed",
        )),
    }
}

fn write_cache_lease_owner(
    directory: &OwnedFd,
    bytes: &[u8],
    error_code: KrxErrorCode,
) -> Result<ObservedFile, KrxError> {
    let descriptor = rustix::fs::openat(
        directory,
        "owner.json",
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        FILE_MODE,
    )
    .map_err(|_| state_error(error_code, "cache lease owner creation failed"))?;
    let mut file = File::from(descriptor);
    file.write_all(bytes)
        .map_err(|_| state_error(error_code, "cache lease owner write failed"))?;
    rustix::fs::fchmod(&file, FILE_MODE)
        .map_err(|_| state_error(error_code, "cache lease owner permission repair failed"))?;
    file.sync_all()
        .map_err(|_| state_error(error_code, "cache lease owner sync failed"))?;
    let identity = file_identity(
        &rustix::fs::fstat(&file)
            .map_err(|_| state_error(error_code, "cache lease owner inspection failed"))?,
    );
    rustix::fs::fsync(directory)
        .map_err(|_| state_error(error_code, "cache lease directory sync failed"))?;
    let observed = read_cache_lease_owner(directory, bytes.len() as u64, error_code, false)?
        .ok_or_else(|| state_error(error_code, "cache lease owner disappeared"))?;
    if observed.bytes != bytes || !same_object_identity(&observed.identity, &identity) {
        return Err(state_error(error_code, "cache lease owner changed"));
    }
    Ok(observed)
}

fn read_cache_lease_owner(
    directory: &OwnedFd,
    maximum_bytes: u64,
    error_code: KrxErrorCode,
    observe_oversized: bool,
) -> Result<Option<ObservedFile>, KrxError> {
    read_from_parent(
        directory,
        OsStr::new("owner.json"),
        maximum_bytes,
        ReadSensitivity::NonSecret,
        error_code,
        observe_oversized,
    )
}

fn inspect_open_cache_lease(
    directory: &OwnedFd,
    maximum_owner_bytes: u64,
    error_code: KrxErrorCode,
) -> Result<Option<ObservedCacheDirectoryLease>, KrxError> {
    let Some(stat) = classify_lock_directory_stat(rustix::fs::fstat(directory), error_code)? else {
        return Ok(None);
    };
    validate_directory_stat(
        directory,
        &stat,
        false,
        ReadSensitivity::NonSecret,
        error_code,
    )?;
    let seconds = u64::try_from(stat.st_mtime)
        .map_err(|_| state_error(error_code, "cache lease timestamp is invalid"))?;
    let nanoseconds = u32::try_from(stat.st_mtime_nsec)
        .ok()
        .filter(|value| *value < 1_000_000_000)
        .ok_or_else(|| state_error(error_code, "cache lease timestamp is invalid"))?;
    let modified = UNIX_EPOCH
        .checked_add(Duration::new(seconds, nanoseconds))
        .ok_or_else(|| state_error(error_code, "cache lease timestamp is invalid"))?;
    Ok(Some(ObservedCacheDirectoryLease {
        directory: rustix::io::dup(directory)
            .map_err(|_| state_error(error_code, "cache lease duplication failed"))?,
        identity: file_identity(&stat),
        modified,
        owner: read_cache_lease_owner(directory, maximum_owner_bytes, error_code, true)?,
    }))
}

fn cache_lease_owner_matches(
    directory: &OwnedFd,
    expected: Option<&ObservedFile>,
    maximum_bytes: u64,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let current = read_cache_lease_owner(directory, maximum_bytes, error_code, true)?;
    Ok(match (current, expected) {
        (None, None) => true,
        (Some(current), Some(expected)) => {
            current.complete == expected.complete
                && current.bytes == expected.bytes
                && same_object_identity(&current.identity, &expected.identity)
        }
        _ => false,
    })
}

fn cleanup_cache_lease_directory(
    parent: &OwnedFd,
    leaf: &OsStr,
    directory: &OwnedFd,
    identity: &FileIdentity,
    owner: Option<&ObservedFile>,
) {
    let error_code = KrxErrorCode::InternalFailure;
    if !path_matches_directory(parent, leaf, identity, error_code).unwrap_or(false)
        || !cache_lease_owner_matches(directory, owner, 1024, error_code).unwrap_or(false)
    {
        return;
    }
    if owner.is_some() && rustix::fs::unlinkat(directory, "owner.json", AtFlags::empty()).is_err() {
        return;
    }
    let _ = rustix::fs::fsync(directory);
    if !path_matches_directory(parent, leaf, identity, error_code).unwrap_or(false) {
        return;
    }
    if rustix::fs::unlinkat(parent, leaf, AtFlags::REMOVEDIR).is_ok() {
        let _ = rustix::fs::fsync(parent);
    }
}

fn abandon_new_cache_lease(directory: &OwnedFd) {
    let _ = rustix::fs::unlinkat(directory, "owner.json", AtFlags::empty());
    let _ = rustix::fs::fsync(directory);
}

fn plain_lock_owner_is_alive(owner: Option<&str>) -> bool {
    let Some(owner) = owner else {
        return false;
    };
    let Some((pid, _)) = owner.split_once('-') else {
        return false;
    };
    let Some(pid) = pid
        .parse::<i32>()
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == rustix::io::Errno::PERM,
    }
}

pub(crate) fn process_is_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == rustix::io::Errno::PERM,
    }
}

fn move_plain_lock_to_tombstone(
    parent: &OwnedFd,
    leaf: &OsStr,
    observed: &PlainLockObservation,
    claim: &PlainClaimObservation,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let leaf = leaf
        .to_str()
        .ok_or_else(|| invalid_state_path("lock filename must be UTF-8"))?;
    let tombstone = OsString::from(format!("{leaf}.stale-{}", claim.owner));
    match rustix::fs::renameat(parent, leaf, parent, &tombstone) {
        Ok(()) => {}
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(false),
        Err(error) if error == rustix::io::Errno::EXIST || error == rustix::io::Errno::NOTEMPTY => {
            if path_matches_directory(parent, OsStr::new(leaf), &observed.identity, error_code)? {
                return Err(state_error(
                    error_code,
                    "stale local lock tombstone conflicts with observed lock",
                ));
            }
            return Ok(false);
        }
        Err(_) => return Err(state_error(error_code, "stale local lock rename failed")),
    }
    rustix::fs::fsync(parent)
        .map_err(|_| state_error(error_code, "stale local lock sync failed"))?;
    validate_retained_plain_lock(&observed.directory, error_code)?;
    Ok(true)
}

fn validate_retained_plain_lock(
    directory: &OwnedFd,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    validate_directory(directory, false, ReadSensitivity::LegacySecret, error_code)?;
    let mut entries = Dir::read_from(directory)
        .map_err(|_| state_error(error_code, "stale local lock listing failed"))?;
    let mut saw_claim = false;
    for entry in &mut entries {
        let entry =
            entry.map_err(|_| state_error(error_code, "stale local lock listing failed"))?;
        match entry.file_name().to_bytes() {
            b"." | b".." | b"owner" => {}
            name if name == STEAL_CLAIM_FILE.as_bytes() => saw_claim = true,
            _ => {
                return Err(state_error(
                    error_code,
                    "retained stale local lock contains unexpected entries",
                ));
            }
        }
    }
    if !saw_claim {
        return Err(state_error(
            error_code,
            "retained stale local lock is missing its claim fence",
        ));
    }
    Ok(())
}

fn open_absolute_root(
    path: &Path,
    create: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<Option<OwnedFd>, KrxError> {
    let mut current = rustix::fs::open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| state_error(error_code, "local state root traversal failed"))?;
    let normal = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            _ => None,
        })
        .collect::<Vec<_>>();
    for (index, component) in normal.iter().enumerate() {
        let is_root = index + 1 == normal.len();
        match rustix::fs::openat(
            &current,
            *component,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(next) => current = next,
            Err(error) if error == rustix::io::Errno::NOENT && is_root && !create => {
                return Ok(None);
            }
            Err(error) if error == rustix::io::Errno::NOENT && is_root && create => {
                match rustix::fs::mkdirat(&current, *component, DIRECTORY_MODE) {
                    Ok(()) => {}
                    Err(error) if error == rustix::io::Errno::EXIST => {}
                    Err(_) => {
                        return Err(state_error(error_code, "local state root creation failed"));
                    }
                }
                current = rustix::fs::openat(
                    &current,
                    *component,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| state_error(error_code, "local state root open failed"))?;
            }
            Err(_) => {
                return Err(state_error(
                    error_code,
                    "local state path contains an unsafe component",
                ));
            }
        }
    }
    validate_directory(&current, create, sensitivity, error_code)?;
    Ok(Some(current))
}

fn open_relative_directories(
    root: &OwnedFd,
    components: &[OsString],
    create: bool,
    error_code: KrxErrorCode,
) -> Result<Option<OwnedFd>, KrxError> {
    let mut current = rustix::fs::openat(
        root,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| state_error(error_code, "local state root duplication failed"))?;
    for component in components {
        match rustix::fs::openat(
            &current,
            component,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(next) => current = next,
            Err(error) if error == rustix::io::Errno::NOENT && create => {
                match rustix::fs::mkdirat(&current, component, DIRECTORY_MODE) {
                    Ok(()) => {}
                    Err(error) if error == rustix::io::Errno::EXIST => {}
                    Err(_) => {
                        return Err(state_error(
                            error_code,
                            "local state directory creation failed",
                        ));
                    }
                }
                current = rustix::fs::openat(
                    &current,
                    component,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| state_error(error_code, "local state directory open failed"))?;
            }
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
            Err(_) => {
                return Err(state_error(
                    error_code,
                    "local state directory is missing or unsafe",
                ));
            }
        }
        validate_directory(&current, create, ReadSensitivity::NonSecret, error_code)?;
    }
    Ok(Some(current))
}

fn validate_directory(
    directory: &OwnedFd,
    repair_mode: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    let stat = rustix::fs::fstat(directory)
        .map_err(|_| state_error(error_code, "local state directory inspection failed"))?;
    validate_directory_stat(directory, &stat, repair_mode, sensitivity, error_code)
}

fn validate_directory_stat(
    directory: &OwnedFd,
    stat: &rustix::fs::Stat,
    repair_mode: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
        return Err(state_error(
            error_code,
            "local state component is not a directory",
        ));
    }
    if u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw()) {
        return Err(state_error(
            error_code,
            "local state directory has a foreign owner",
        ));
    }
    let actual = Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO);
    if sensitivity == ReadSensitivity::LegacySecret && actual != DIRECTORY_MODE {
        return Err(state_error(
            error_code,
            "legacy secret directory permissions are unsafe",
        ));
    }
    if repair_mode && actual != DIRECTORY_MODE {
        rustix::fs::fchmod(directory, DIRECTORY_MODE).map_err(|_| {
            state_error(error_code, "local state directory permission repair failed")
        })?;
    }
    Ok(())
}

fn validate_destination(
    parent: &OwnedFd,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    match rustix::fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => {
            if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                return Err(state_error(
                    error_code,
                    "local state destination is not a regular file",
                ));
            }
            if u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw()) {
                return Err(state_error(
                    error_code,
                    "local state destination has a foreign owner",
                ));
            }
            Ok(())
        }
        Err(error) if error == rustix::io::Errno::NOENT => Ok(()),
        Err(_) => Err(state_error(
            error_code,
            "local state destination inspection failed",
        )),
    }
}

fn read_from_root(
    root: &OwnedFd,
    components: &[OsString],
    maximum_bytes: u64,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
    observe_oversized: bool,
) -> Result<Option<ObservedFile>, KrxError> {
    let (parents, leaf) = components.split_at(components.len() - 1);
    let Some(parent) = open_relative_directories(root, parents, false, error_code)? else {
        return Ok(None);
    };
    read_from_parent(
        &parent,
        &leaf[0],
        maximum_bytes,
        sensitivity,
        error_code,
        observe_oversized,
    )
}

fn read_from_parent(
    parent: &OwnedFd,
    leaf: &OsStr,
    maximum_bytes: u64,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
    observe_oversized: bool,
) -> Result<Option<ObservedFile>, KrxError> {
    let descriptor = match rustix::fs::openat(
        parent,
        leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(descriptor) => descriptor,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => {
            return Err(state_error(error_code, "local state file open failed"));
        }
    };
    let stat = rustix::fs::fstat(&descriptor)
        .map_err(|_| state_error(error_code, "local state file inspection failed"))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(state_error(
            error_code,
            "local state path is not a regular file",
        ));
    }
    if u64::from(stat.st_uid) != u64::from(rustix::process::geteuid().as_raw()) {
        return Err(state_error(
            error_code,
            "local state file has a foreign owner",
        ));
    }
    let actual = Mode::from_raw_mode(stat.st_mode) & (Mode::RWXU | Mode::RWXG | Mode::RWXO);
    if sensitivity == ReadSensitivity::LegacySecret && actual != FILE_MODE {
        return Err(state_error(
            error_code,
            "legacy secret file permissions are unsafe",
        ));
    }
    if stat.st_size < 0 {
        return Err(state_error(
            error_code,
            "local state file exceeds its read bound",
        ));
    }

    let identity = file_identity(&stat);
    if stat.st_size as u128 > u128::from(maximum_bytes) {
        if observe_oversized {
            return Ok(Some(ObservedFile {
                bytes: Vec::new(),
                identity,
                complete: false,
            }));
        }
        return Err(state_error(
            error_code,
            "local state file exceeds its read bound",
        ));
    }
    let mut file = File::from(descriptor);
    let capacity = usize::try_from(stat.st_size)
        .map_err(|_| state_error(error_code, "local state file exceeds platform capacity"))?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "local state file read failed"))?;
    if bytes.len() as u128 > u128::from(maximum_bytes) {
        return Err(state_error(
            error_code,
            "local state file exceeds its read bound",
        ));
    }
    let after = rustix::fs::fstat(&file)
        .map_err(|_| state_error(error_code, "local state file reinspection failed"))?;
    if file_identity(&after) != identity {
        return Err(state_error(
            error_code,
            "local state file changed while it was read",
        ));
    }
    Ok(Some(ObservedFile {
        bytes,
        identity,
        complete: true,
    }))
}

fn path_matches_file(
    parent: &OwnedFd,
    leaf: &OsStr,
    expected: &FileIdentity,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    match rustix::fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(
            FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
                && u64::from(stat.st_uid) == u64::from(rustix::process::geteuid().as_raw())
                && file_identity(&stat) == *expected,
        ),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(false),
        Err(_) => Err(state_error(
            error_code,
            "local state file reinspection failed",
        )),
    }
}

fn file_identity(stat: &rustix::fs::Stat) -> FileIdentity {
    FileIdentity {
        device: stat.st_dev as u128,
        inode: stat.st_ino as u128,
        size: stat.st_size as i128,
        modified_seconds: stat.st_mtime as i128,
        modified_nanoseconds: stat.st_mtime_nsec as i128,
    }
}

fn same_object_identity(left: &FileIdentity, right: &FileIdentity) -> bool {
    left.device == right.device && left.inode == right.inode
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    struct TestRoot {
        parent: PathBuf,
        state: StateRoot,
    }

    impl TestRoot {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .expect("working directory")
                .join("target")
                .join("state-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&parent).expect("test parent");
            let state = StateRoot::new(parent.join(".krx-cli")).expect("state root");
            Self { parent, state }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.parent.join(".krx-cli").join(relative)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).expect("remove test state");
        }
    }

    #[test]
    fn atomically_writes_owner_only_files_and_repairs_owned_directories() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write(
                "cache/v2/20260102/entry.json",
                b"first",
                KrxErrorCode::CacheWriteFailed,
            )
            .expect("first write");
        fs::set_permissions(fixture.path("cache/v2"), fs::Permissions::from_mode(0o755))
            .expect("loosen mode");
        fixture
            .state
            .atomic_write(
                "cache/v2/20260102/entry.json",
                b"second",
                KrxErrorCode::CacheWriteFailed,
            )
            .expect("replace");
        assert_eq!(
            fs::read(fixture.path("cache/v2/20260102/entry.json")).unwrap(),
            b"second"
        );
        assert_eq!(
            fs::metadata(fixture.path("cache/v2"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(fixture.path("cache/v2/20260102/entry.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn post_commit_sync_failure_reports_committed_replacement() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write("config.json", b"before", KrxErrorCode::MigrationFailed)
            .unwrap();
        let failure = fixture
            .state
            .atomic_write_with_post_commit_failure(
                "config.json",
                b"after",
                KrxErrorCode::MigrationFailed,
            )
            .unwrap_err();
        assert!(failure.committed());
        assert_eq!(fs::read(fixture.path("config.json")).unwrap(), b"after");
    }

    #[test]
    fn pre_commit_failure_reports_uncommitted_and_preserves_destination() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write("config.json", b"before", KrxErrorCode::MigrationFailed)
            .unwrap();
        let failure = fixture
            .state
            .atomic_write_with_pre_commit_failure(
                "config.json",
                b"after",
                KrxErrorCode::MigrationFailed,
            )
            .unwrap_err();
        assert!(!failure.committed());
        assert_eq!(fs::read(fixture.path("config.json")).unwrap(), b"before");
    }

    #[test]
    fn conditional_file_changes_never_touch_a_replacement() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write(
                "cache/entry.json",
                b"observed",
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();
        let observed = fixture
            .state
            .read(
                "cache/entry.json",
                64,
                ReadSensitivity::NonSecret,
                KrxErrorCode::CacheReadFailed,
            )
            .unwrap()
            .unwrap();
        fixture
            .state
            .atomic_write(
                "cache/entry.json",
                b"replacement",
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();
        assert!(
            !fixture
                .state
                .remove_if_unchanged(
                    "cache/entry.json",
                    &observed,
                    KrxErrorCode::CacheWriteFailed,
                )
                .unwrap()
        );
        assert!(
            !fixture
                .state
                .rename_if_unchanged(
                    "cache/entry.json",
                    &observed,
                    "entry.json.corrupt",
                    KrxErrorCode::CacheWriteFailed,
                )
                .unwrap()
        );
        assert_eq!(
            fs::read(fixture.path("cache/entry.json")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn cache_lease_acquisition_is_exclusive_and_release_matches_owner() {
        let fixture = TestRoot::new();
        let relative = "cache/.leases/key.lock";
        let owner = br#"{"version":1,"pid":1,"nonce":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-01T00:00:00.000Z"}"#;
        let lease = fixture
            .state
            .try_acquire_cache_lease(relative, owner, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("first lease");
        assert!(
            fixture
                .state
                .try_acquire_cache_lease(relative, owner, KrxErrorCode::CacheWriteFailed)
                .unwrap()
                .is_none()
        );
        let observed = fixture
            .state
            .observe_cache_lease(relative, 1024, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("observed lease");
        assert_eq!(observed.owner_bytes(), Some(owner.as_slice()));
        drop(lease);
        assert!(
            fixture
                .state
                .observe_cache_lease(relative, 1024, KrxErrorCode::CacheWriteFailed)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn stale_cache_lease_tombstone_never_deletes_replacement() {
        let fixture = TestRoot::new();
        let relative = "cache/.leases/key.lock";
        let old_owner = b"old-owner";
        let old = fixture
            .state
            .try_acquire_cache_lease(relative, old_owner, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("old lease");
        let observed = fixture
            .state
            .observe_cache_lease(relative, 1024, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("observed lease");
        assert!(
            fixture
                .state
                .steal_cache_lease_if_unchanged(
                    relative,
                    &observed,
                    "key.lock.stale-test",
                    KrxErrorCode::CacheWriteFailed,
                )
                .unwrap()
        );
        let new_owner = b"new-owner";
        let replacement = fixture
            .state
            .try_acquire_cache_lease(relative, new_owner, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("replacement lease");
        assert!(
            !fixture
                .state
                .steal_cache_lease_if_unchanged(
                    relative,
                    &observed,
                    "key.lock.stale-paused",
                    KrxErrorCode::CacheWriteFailed,
                )
                .unwrap()
        );
        drop(old);
        assert_eq!(
            fs::read(fixture.path("cache/.leases/key.lock/owner.json")).unwrap(),
            new_owner
        );
        drop(replacement);
    }

    #[test]
    fn oversized_cache_lease_owner_is_observed_without_unbounded_read() {
        let fixture = TestRoot::new();
        let relative = "cache/.leases/key.lock";
        let lease = fixture
            .state
            .try_acquire_cache_lease(relative, b"owner", KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("lease");
        fs::write(
            fixture.path("cache/.leases/key.lock/owner.json"),
            vec![b'x'; 2048],
        )
        .unwrap();
        let observed = fixture
            .state
            .observe_cache_lease(relative, 1024, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .expect("observed lease");
        assert!(observed.owner_bytes().is_none());
        drop(lease);
        assert!(fixture.path("cache/.leases/key.lock").exists());
    }

    #[test]
    fn rejects_links_and_unsafe_legacy_secret_permissions() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write("config.json", b"secret", KrxErrorCode::MigrationFailed)
            .expect("config");
        fs::set_permissions(
            fixture.path("config.json"),
            fs::Permissions::from_mode(0o644),
        )
        .expect("unsafe mode");
        assert!(
            fixture
                .state
                .read(
                    "config.json",
                    1024,
                    ReadSensitivity::LegacySecret,
                    KrxErrorCode::LegacyStateInvalid,
                )
                .is_err()
        );

        let outside = fixture.parent.join("outside");
        fs::create_dir(&outside).expect("outside");
        symlink(&outside, fixture.path("cache")).expect("cache symlink");
        let error = fixture
            .state
            .atomic_write(
                "cache/entry.json",
                b"unsafe",
                KrxErrorCode::CacheWriteFailed,
            )
            .expect_err("link rejected");
        assert_eq!(error.code(), KrxErrorCode::CacheWriteFailed);
        assert!(!outside.join("entry.json").exists());
    }

    #[test]
    fn bounds_reads_without_exposing_partial_bytes() {
        let fixture = TestRoot::new();
        fixture
            .state
            .atomic_write(
                "cache/v2/entry.json",
                b"invalid",
                KrxErrorCode::CacheWriteFailed,
            )
            .expect("cache");
        assert!(
            fixture
                .state
                .read(
                    "cache/v2/entry.json",
                    3,
                    ReadSensitivity::NonSecret,
                    KrxErrorCode::CacheReadFailed,
                )
                .is_err()
        );
        let observed = fixture
            .state
            .read(
                "cache/v2/entry.json",
                1024,
                ReadSensitivity::NonSecret,
                KrxErrorCode::CacheReadFailed,
            )
            .expect("read")
            .expect("entry");
        assert_eq!(observed.bytes(), b"invalid");
    }

    #[test]
    fn plain_directory_locks_match_node_ownership_and_stale_steal_rules() {
        let fixture = TestRoot::new();
        let owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let lock = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                owner.clone(),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("acquire")
            .expect("new lock");
        assert_eq!(
            fs::read_to_string(fixture.path("rate-limit.json.lock/owner")).unwrap(),
            owner
        );
        assert!(
            fixture
                .state
                .try_acquire_plain_lock(
                    "rate-limit.json.lock",
                    format!("{}-{}", std::process::id(), Uuid::new_v4()),
                    KrxErrorCode::QuotaStateIoFailed,
                )
                .expect("contention")
                .is_none()
        );
        drop(lock);
        assert!(!fixture.path("rate-limit.json.lock").exists());

        let dead_owner = format!("2147483647-{}", Uuid::new_v4());
        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("abandoned acquire")
            .expect("abandoned lock");
        std::mem::forget(abandoned);
        assert!(
            fixture
                .state
                .steal_plain_lock_if_stale(
                    "rate-limit.json.lock",
                    Duration::from_secs(30),
                    SystemTime::now() + Duration::from_secs(31),
                    KrxErrorCode::QuotaStateIoFailed,
                )
                .expect("stale steal")
        );
        assert!(!fixture.path("rate-limit.json.lock").exists());
    }

    #[test]
    fn recovers_dead_published_claims_and_preserves_live_claimants() {
        let fixture = TestRoot::new();
        let dead_owner = format!("2147483647-{}", Uuid::new_v4());
        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner.clone(),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("abandoned acquire")
            .expect("abandoned lock");
        std::mem::forget(abandoned);
        fs::write(fixture.path("rate-limit.json.lock/steal"), &dead_owner)
            .expect("published dead claim");
        fs::set_permissions(
            fixture.path("rate-limit.json.lock/steal"),
            fs::Permissions::from_mode(0o600),
        )
        .expect("claim mode");
        assert!(
            fixture
                .state
                .steal_plain_lock_if_stale(
                    "rate-limit.json.lock",
                    Duration::from_secs(30),
                    SystemTime::now() + Duration::from_secs(31),
                    KrxErrorCode::QuotaStateIoFailed,
                )
                .expect("recover dead claim")
        );
        assert!(
            fixture
                .path(&format!("rate-limit.json.lock.stale-{dead_owner}"))
                .exists()
        );

        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("second abandoned acquire")
            .expect("second abandoned lock");
        std::mem::forget(abandoned);
        let live_claim = format!("{}-{}", std::process::id(), Uuid::new_v4());
        fs::write(fixture.path("rate-limit.json.lock/steal"), &live_claim)
            .expect("published live claim");
        fs::set_permissions(
            fixture.path("rate-limit.json.lock/steal"),
            fs::Permissions::from_mode(0o600),
        )
        .expect("claim mode");
        assert!(
            !fixture
                .state
                .steal_plain_lock_if_stale(
                    "rate-limit.json.lock",
                    Duration::from_secs(30),
                    SystemTime::now() + Duration::from_secs(31),
                    KrxErrorCode::QuotaStateIoFailed,
                )
                .expect("preserve live claim")
        );
        assert_eq!(
            fs::read_to_string(fixture.path("rate-limit.json.lock/steal")).unwrap(),
            live_claim
        );
    }

    #[test]
    fn retained_claim_tombstone_fences_a_paused_second_stealer() {
        let fixture = TestRoot::new();
        let dead_owner = format!("2147483647-{}", Uuid::new_v4());
        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner.clone(),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("abandoned acquire")
            .expect("abandoned lock");
        std::mem::forget(abandoned);
        fs::write(fixture.path("rate-limit.json.lock/steal"), &dead_owner)
            .expect("published dead claim");
        fs::set_permissions(
            fixture.path("rate-limit.json.lock/steal"),
            fs::Permissions::from_mode(0o600),
        )
        .expect("claim mode");
        let root = rustix::fs::open(
            fixture.path(""),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("open state root");
        let paused = inspect_plain_lock(
            &root,
            OsStr::new("rate-limit.json.lock"),
            KrxErrorCode::QuotaStateIoFailed,
        )
        .expect("inspect stale lock")
        .expect("stale observation");
        let paused_claim = read_steal_claim(&paused.directory, KrxErrorCode::QuotaStateIoFailed)
            .expect("read stale claim")
            .expect("stale claim");

        assert!(
            fixture
                .state
                .steal_plain_lock_if_stale(
                    "rate-limit.json.lock",
                    Duration::from_secs(30),
                    SystemTime::now() + Duration::from_secs(31),
                    KrxErrorCode::QuotaStateIoFailed,
                )
                .expect("first stealer wins")
        );
        let live_owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let live = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                live_owner.clone(),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("live acquire")
            .expect("live lock");

        assert!(
            !move_plain_lock_to_tombstone(
                &root,
                OsStr::new("rate-limit.json.lock"),
                &paused,
                &paused_claim,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("paused stealer is fenced")
        );
        assert_eq!(
            fs::read_to_string(fixture.path("rate-limit.json.lock/owner")).unwrap(),
            live_owner
        );
        drop(live);
    }

    #[test]
    fn stale_lock_tombstone_preserves_unexpected_entries_fail_closed() {
        let fixture = TestRoot::new();
        let dead_owner = format!("2147483647-{}", Uuid::new_v4());
        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("abandoned acquire")
            .expect("abandoned lock");
        std::mem::forget(abandoned);
        fs::write(
            fixture.path("rate-limit.json.lock/unexpected"),
            b"preserve-me",
        )
        .expect("unexpected entry");
        let error = fixture
            .state
            .steal_plain_lock_if_stale(
                "rate-limit.json.lock",
                Duration::from_secs(30),
                SystemTime::now() + Duration::from_secs(31),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect_err("unexpected entry fails closed");
        assert_eq!(error.code(), KrxErrorCode::QuotaStateIoFailed);
        let tombstone = fs::read_dir(fixture.path(""))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("rate-limit.json.lock.stale-")
            })
            .expect("retained tombstone");
        assert_eq!(
            fs::read(tombstone.join("unexpected")).unwrap(),
            b"preserve-me"
        );
    }

    #[test]
    fn prepared_claim_cannot_attach_to_a_replacement_lock() {
        let fixture = TestRoot::new();
        let old_owner = format!("2147483647-{}", Uuid::new_v4());
        let old = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                old_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("old acquire")
            .expect("old lock");
        std::mem::forget(old);
        let root = rustix::fs::open(
            fixture.path(""),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("open state root");
        let observed = inspect_plain_lock(
            &root,
            OsStr::new("rate-limit.json.lock"),
            KrxErrorCode::QuotaStateIoFailed,
        )
        .expect("inspect old lock")
        .expect("old observation");
        fs::rename(
            fixture.path("rate-limit.json.lock"),
            fixture.path("rate-limit.json.lock.old"),
        )
        .expect("move old lock");
        let fresh_owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let fresh = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                fresh_owner.clone(),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("fresh acquire")
            .expect("fresh lock");
        let claimant = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let claim = publish_steal_claim(
            &observed.directory,
            &claimant,
            KrxErrorCode::QuotaStateIoFailed,
        )
        .expect("publish against moved lock")
        .expect("claim stays attached to observed lock");
        assert_eq!(
            fs::read_to_string(fixture.path("rate-limit.json.lock/owner")).unwrap(),
            fresh_owner
        );
        assert!(!fixture.path("rate-limit.json.lock/steal").exists());
        assert_eq!(
            fs::read_to_string(fixture.path("rate-limit.json.lock.old/steal")).unwrap(),
            claimant
        );
        release_steal_claim(&observed.directory, &claim);
        drop(fresh);
    }

    #[test]
    fn failed_creator_cleanup_preserves_a_replacement_lock() {
        let fixture = TestRoot::new();
        let old_owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
        let old = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                old_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("old acquire")
            .expect("old lock");
        std::mem::forget(old);
        let root = rustix::fs::open(
            fixture.path(""),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("open state root");
        let observed = inspect_plain_lock(
            &root,
            OsStr::new("rate-limit.json.lock"),
            KrxErrorCode::QuotaStateIoFailed,
        )
        .expect("inspect old lock")
        .expect("old observation");
        fs::rename(
            fixture.path("rate-limit.json.lock"),
            fixture.path("rate-limit.json.lock.old"),
        )
        .expect("move old lock");
        fs::create_dir(fixture.path("rate-limit.json.lock")).expect("replacement lock");
        fs::set_permissions(
            fixture.path("rate-limit.json.lock"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("replacement mode");

        assert!(
            !path_matches_directory(
                &root,
                OsStr::new("rate-limit.json.lock"),
                &observed.identity,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("replacement identity")
        );
        abandon_new_lock(&observed.directory);
        assert!(fixture.path("rate-limit.json.lock").is_dir());
        assert!(
            fs::read_dir(fixture.path("rate-limit.json.lock"))
                .unwrap()
                .next()
                .is_none()
        );
        assert!(!fixture.path("rate-limit.json.lock.old/owner").exists());
    }

    #[test]
    fn treats_a_disappearing_open_lock_directory_as_lock_turnover() {
        assert!(
            classify_lock_directory_stat(
                Err(rustix::io::Errno::NOENT),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("classify disappeared lock")
            .is_none()
        );
    }

    #[test]
    fn rejects_noncanonical_plain_lock_owners() {
        let fixture = TestRoot::new();
        for owner in [
            "0-00000000-0000-4000-8000-000000000000",
            "1-00000000-0000-1000-8000-000000000000",
            "1-00000000-0000-4000-c000-000000000000",
            "1-00000000-0000-4000-8000-00000000000A",
        ] {
            assert!(
                fixture
                    .state
                    .try_acquire_plain_lock(
                        "rate-limit.json.lock",
                        owner.to_owned(),
                        KrxErrorCode::QuotaStateIoFailed,
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_oversized_existing_lock_owners_fail_closed() {
        let fixture = TestRoot::new();
        let dead_owner = format!("2147483647-{}", Uuid::new_v4());
        let abandoned = fixture
            .state
            .try_acquire_plain_lock(
                "rate-limit.json.lock",
                dead_owner,
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect("abandoned acquire")
            .expect("abandoned lock");
        std::mem::forget(abandoned);
        fs::write(fixture.path("rate-limit.json.lock/owner"), [b'x'; 129])
            .expect("oversized owner");

        let error = fixture
            .state
            .steal_plain_lock_if_stale(
                "rate-limit.json.lock",
                Duration::from_secs(30),
                SystemTime::now() + Duration::from_secs(31),
                KrxErrorCode::QuotaStateIoFailed,
            )
            .expect_err("oversized owner rejected");
        assert_eq!(error.code(), KrxErrorCode::QuotaStateIoFailed);
        assert_eq!(
            fs::read(fixture.path("rate-limit.json.lock/owner")).unwrap(),
            [b'x'; 129]
        );
        assert!(fixture.path("rate-limit.json.lock").exists());
    }
}
