use std::ffi::{OsStr, OsString, c_void};
use std::fs::OpenOptions as AmbientOpenOptions;
use std::io::{self, Read, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt as AmbientMetadataExt;
use std::os::windows::fs::OpenOptionsExt as AmbientOpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::null_mut;
use std::time::{Duration, SystemTime};

use cap_std::fs::OpenOptionsExt as CapOpenOptionsExt;
use cap_std::fs::{Dir, File, MetadataExt, OpenOptions};
use uuid::{Uuid, Variant};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_LINK_INFORMATION, FILE_NON_DIRECTORY_FILE,
    FILE_OPEN_REPARSE_POINT as NT_FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_SYNCHRONOUS_IO_NONALERT, FileLinkInformation, FileRenameInformation, NtCreateFile,
    NtOpenFile, NtSetInformationFile,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, GENERIC_ALL, GENERIC_READ,
    GENERIC_WRITE, GetLastError, HANDLE, LocalFree, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
    STATUS_DELETE_PENDING, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
    STATUS_OBJECT_PATH_NOT_FOUND, UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{
    BuildTrusteeWithSidW, GetEffectiveRightsFromAclW, GetSecurityInfo, SE_FILE_OBJECT, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL_REVISION, ACL_SIZE_INFORMATION, AclSizeInformation,
    AddAccessAllowedAce, CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
    GetAclInformation, GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor,
    IsValidSid, OWNER_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR,
    SECURITY_MAX_SID_SIZE, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
    SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser, WinAuthenticatedUserSid,
    WinBuiltinAdministratorsSid, WinLocalSystemSid, WinWorldSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, FileDispositionInfo,
    FlushFileBuffers, GetFileInformationByHandle, READ_CONTROL, SYNCHRONIZE,
    SetFileInformationByHandle, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE,
    ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE, ACCESS_ALLOWED_COMPOUND_ACE_TYPE,
    ACCESS_ALLOWED_OBJECT_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::{KrxError, KrxErrorCode};

const STEAL_CLAIM_FILE: &str = "steal";
const PROTOCOL_FILE_MAXIMUM_BYTES: u64 = 128;
const CACHE_LEASE_OWNER_MAXIMUM_BYTES: u64 = 1024;
const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadSensitivity {
    NonSecret,
    LegacySecret,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
    size: u64,
    modified: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ObservedFile {
    bytes: Vec<u8>,
    identity: FileIdentity,
    complete: bool,
}

/// A pathname found by the bounded cache walk.  The walk intentionally only
/// returns regular, non-reparse entries; callers still re-open each path
/// through the capability-checked state root before acting on it.
pub(crate) struct CachePath {
    pub(crate) relative: String,
}

pub(crate) struct CacheEnumeration {
    pub(crate) paths: Vec<CachePath>,
    pub(crate) leases: Vec<String>,
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

    pub(crate) fn modified(&self) -> SystemTime {
        const TICKS_PER_SECOND: u64 = 10_000_000;
        const WINDOWS_TO_UNIX_SECONDS: u64 = 11_644_473_600;
        let seconds = self.identity.modified / TICKS_PER_SECOND;
        let Some(seconds) = seconds.checked_sub(WINDOWS_TO_UNIX_SECONDS) else {
            return SystemTime::UNIX_EPOCH;
        };
        let nanoseconds = ((self.identity.modified % TICKS_PER_SECOND) * 100) as u32;
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::new(seconds, nanoseconds))
            .unwrap_or(SystemTime::UNIX_EPOCH)
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
    parent: Dir,
    directory: Option<Dir>,
    published_owner: ProtocolFileObservation,
}

/// A cache lease is represented by an owned directory and an exact owner.json
/// file inside it.  The handles are retained so release is never based on a
/// pathname that may have been replaced by another process.
#[derive(Debug)]
pub(crate) struct CacheDirectoryLease {
    parent: Dir,
    leaf: OsString,
    directory: Option<Dir>,
    directory_identity: FileIdentity,
    owner: CacheOwnerObservation,
}

#[derive(Clone, Debug)]
pub(crate) struct ObservedCacheDirectoryLease {
    directory_identity: FileIdentity,
    owner: Option<CacheOwnerObservation>,
    modified: SystemTime,
}

impl ObservedCacheDirectoryLease {
    pub(crate) fn owner_bytes(&self) -> Option<&[u8]> {
        self.owner
            .as_ref()
            .filter(|owner| owner.complete)
            .map(|owner| owner.bytes.as_slice())
    }

    pub(crate) fn modified(&self) -> SystemTime {
        self.modified
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CacheOwnerObservation {
    identity: FileIdentity,
    bytes: Vec<u8>,
    complete: bool,
}

fn same_cache_owner(left: &CacheOwnerObservation, right: &CacheOwnerObservation) -> bool {
    left.complete == right.complete
        && same_object_identity(&left.identity, &right.identity)
        && left.bytes == right.bytes
}

fn same_cache_owner_identity(owner: &CacheOwnerObservation, identity: &FileIdentity) -> bool {
    same_object_identity(&owner.identity, identity)
}

#[derive(Debug)]
struct PlainLockObservation {
    directory: Dir,
    identity: FileIdentity,
    modified: SystemTime,
    owner: Option<String>,
    owner_identity: Option<FileIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProtocolFileObservation {
    identity: FileIdentity,
    owner: String,
}

struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        // SAFETY: this guard exclusively owns the non-null handle returned by
        // a successful Win32 open call.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct LocalAllocation(*mut c_void);

struct OwnedUnicodeString {
    string: UNICODE_STRING,
    _wide: Vec<u16>,
}

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.0);
            }
        }
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

    pub(crate) fn enumerate_cache_paths(
        &self,
        maximum_files: u64,
        maximum_metadata_bytes: u64,
        error_code: KrxErrorCode,
    ) -> Result<CacheEnumeration, KrxError> {
        let Some(root) = open_absolute_root(
            &self.path,
            false,
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(CacheEnumeration {
                paths: Vec::new(),
                leases: Vec::new(),
            });
        };
        let Some(cache) = open_relative_directories(
            &root,
            &[OsString::from("cache")],
            false,
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(CacheEnumeration {
                paths: Vec::new(),
                leases: Vec::new(),
            });
        };
        let mut paths = Vec::new();
        let mut leases = Vec::new();
        let mut metadata_bytes = 0u64;
        let mut child_count = 0u64;
        enumerate_cache_directory(
            &cache,
            "cache",
            &mut paths,
            &mut leases,
            &mut child_count,
            &mut metadata_bytes,
            maximum_files,
            maximum_metadata_bytes,
            error_code,
            false,
        )?;
        Ok(CacheEnumeration { paths, leases })
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
        let Some(root) = open_absolute_root(&self.path, false, false, sensitivity, error_code)?
        else {
            return Ok(None);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(
            &root,
            parents,
            false,
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(None);
        };
        read_file(
            &parent,
            &leaf[0],
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

    pub(crate) fn remove_if_unchanged(
        &self,
        relative: &str,
        observed: &ObservedFile,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        self.change_observed_file(relative, observed, None, error_code)
    }

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
        let Some(root) = open_absolute_root(
            &self.path,
            false,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(
            &root,
            parents,
            false,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(false);
        };
        let Some(mut file) = open_secure_file(&parent, &leaf[0], false, false, true, error_code)?
        else {
            return Ok(false);
        };
        let before = file_metadata_identity(&file, error_code)?;
        if before != observed.identity || before.size != observed.bytes.len() as u64 {
            return Ok(false);
        }
        let mut bytes = Vec::with_capacity(observed.bytes.len());
        Read::by_ref(&mut file)
            .take(observed.bytes.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| state_error(error_code, "local state file read failed"))?;
        let after = file_metadata_identity(&file, error_code)?;
        if before != after || bytes != observed.bytes {
            return Ok(false);
        }
        match destination_leaf {
            Some(destination) => match rename_open_handle(&file, &parent, destination, false) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
                    ) =>
                {
                    return Ok(false);
                }
                Err(_) => return Err(state_error(error_code, "local state rename failed")),
            },
            None => delete_open_handle(file.as_raw_handle())
                .map_err(|_| state_error(error_code, "local state removal failed"))?,
        }
        drop(file);
        flush_directory(&parent, error_code, "local state parent sync failed")?;
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
        let root = open_absolute_root(
            &self.path,
            true,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )
        .map_err(before_commit)?
        .ok_or_else(|| state_error(error_code, "local state root could not be created"))
        .map_err(before_commit)?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(
            &root,
            parents,
            true,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )
        .map_err(before_commit)?
        .ok_or_else(|| state_error(error_code, "local state parent could not be created"))
        .map_err(before_commit)?;
        validate_destination(&parent, &leaf[0], error_code).map_err(before_commit)?;

        let temporary = temporary_name(&leaf[0]).map_err(before_commit)?;
        let mut file =
            create_secure_file(&parent, &temporary, error_code).map_err(before_commit)?;
        let mut renamed = false;
        let result = (|| {
            file.write_all(bytes)
                .map_err(|_| state_error(error_code, "local state write failed"))?;
            file.sync_all()
                .map_err(|_| state_error(error_code, "local state file sync failed"))?;
            if fail_before_commit {
                return Err(state_error(
                    error_code,
                    "injected local state pre-commit failure",
                ));
            }
            rename_open_handle(&file, &parent, &leaf[0], true)
                .map_err(|_| state_error(error_code, "local state atomic replace failed"))?;
            renamed = true;
            if fail_after_commit {
                return Err(state_error(
                    error_code,
                    "injected local state directory sync failure",
                ));
            }
            flush_directory(&parent, error_code, "local state directory sync failed")
        })();
        if result.is_err() && !renamed {
            let _ = delete_open_handle(file.as_raw_handle());
        }
        drop(file);
        result.map_err(|error| (error, renamed))
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

    pub(crate) fn try_acquire_cache_lease(
        &self,
        relative: &str,
        owner_json: &[u8],
        error_code: KrxErrorCode,
    ) -> Result<Option<CacheDirectoryLease>, KrxError> {
        if owner_json.is_empty() || owner_json.len() as u64 > CACHE_LEASE_OWNER_MAXIMUM_BYTES {
            return Err(state_error(error_code, "cache lease owner is unsafe"));
        }
        let components = relative_components(relative)?;
        let root = open_absolute_root(
            &self.path,
            true,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        .ok_or_else(|| state_error(error_code, "local state root could not be created"))?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(
            &root,
            parents,
            true,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        .ok_or_else(|| state_error(error_code, "cache lease parent could not be created"))?;
        let directory = match create_child_directory(
            &parent,
            &leaf[0],
            ReadSensitivity::NonSecret,
            error_code,
        )? {
            Some(directory) => directory,
            None => {
                // Validate an existing directory without repairing it.  This
                // keeps mkdir-as-the-lock atomic while rejecting reparse or
                // foreign-ACL paths before returning contention.
                let _ = open_child_directory(
                    &parent,
                    &leaf[0],
                    true,
                    ReadSensitivity::NonSecret,
                    error_code,
                )?;
                return Ok(None);
            }
        };
        let created_directory_identity = directory_identity(&directory, error_code)?;
        let owner = match publish_cache_owner(&directory, owner_json, error_code) {
            Ok(owner) => owner,
            Err(error) => {
                abandon_cache_lease(&parent, directory, None);
                return Err(error);
            }
        };
        if flush_directory(&parent, error_code, "cache lease parent sync failed").is_err() {
            abandon_cache_lease(&parent, directory, Some(&owner));
            return Err(state_error(error_code, "cache lease parent sync failed"));
        }
        if !path_matches_directory(&parent, &leaf[0], &created_directory_identity, error_code)? {
            abandon_cache_lease(&parent, directory, Some(&owner));
            return Ok(None);
        }
        Ok(Some(CacheDirectoryLease {
            parent,
            leaf: leaf[0].clone(),
            directory: Some(directory),
            directory_identity: created_directory_identity,
            owner,
        }))
    }

    pub(crate) fn observe_cache_lease(
        &self,
        relative: &str,
        maximum_owner_bytes: u64,
        error_code: KrxErrorCode,
    ) -> Result<Option<ObservedCacheDirectoryLease>, KrxError> {
        if maximum_owner_bytes > CACHE_LEASE_OWNER_MAXIMUM_BYTES {
            return Err(state_error(error_code, "cache lease owner bound is unsafe"));
        }
        let components = relative_components(relative)?;
        let Some(root) = open_absolute_root(
            &self.path,
            false,
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(None);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(
            &root,
            parents,
            false,
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(None);
        };
        let Some(directory) = open_child_directory(
            &parent,
            &leaf[0],
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(None);
        };
        let observed_directory_identity = directory_identity(&directory, error_code)?;
        let modified = directory
            .dir_metadata()
            .map_err(|_| state_error(error_code, "cache lease timestamp inspection failed"))?
            .modified()
            .map_err(|_| state_error(error_code, "cache lease timestamp is invalid"))?
            .into_std();
        let owner = read_cache_owner(&directory, maximum_owner_bytes, error_code)?;
        let Some(current_directory) = open_child_directory(
            &parent,
            &leaf[0],
            false,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(None);
        };
        if !same_object_identity(
            &observed_directory_identity,
            &directory_identity(&current_directory, error_code)?,
        ) {
            return Ok(None);
        }
        Ok(Some(ObservedCacheDirectoryLease {
            directory_identity: observed_directory_identity,
            owner,
            modified,
        }))
    }

    pub(crate) fn steal_cache_lease_if_unchanged(
        &self,
        relative: &str,
        observed: &ObservedCacheDirectoryLease,
        tombstone_leaf: &str,
        error_code: KrxErrorCode,
    ) -> Result<bool, KrxError> {
        let tombstone = relative_components(tombstone_leaf)?;
        if tombstone.len() != 1 {
            return Err(invalid_state_path(
                "cache lease tombstone must be one filename",
            ));
        }
        let components = relative_components(relative)?;
        let Some(root) = open_absolute_root(
            &self.path,
            false,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(
            &root,
            parents,
            false,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(false);
        };
        let Some(directory) = open_child_directory(
            &parent,
            &leaf[0],
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
            return Ok(false);
        };
        if !same_object_identity(
            &directory_identity(&directory, error_code)?,
            &observed.directory_identity,
        ) || !cache_lease_owner_matches(&directory, observed.owner.as_ref(), error_code)?
        {
            return Ok(false);
        }
        match rename_open_handle(&directory, &parent, &tombstone[0], false) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                return Ok(false);
            }
            Err(_) => return Err(state_error(error_code, "cache lease steal rename failed")),
        }
        flush_directory(&parent, error_code, "cache lease steal sync failed")?;
        if !cache_lease_owner_matches(&directory, observed.owner.as_ref(), error_code)? {
            // The tombstone is retained because its contents no longer match
            // the observation.  In particular, never remove a replacement
            // owner or a newly-created lock directory.
            return Ok(false);
        }
        if let Some(owner) = observed.owner.as_ref() {
            let Some((file, current)) =
                open_cache_owner(&directory, owner.bytes.len() as u64, error_code)?
            else {
                return Ok(false);
            };
            if !same_cache_owner(&current, owner)
                || delete_open_handle(file.as_raw_handle()).is_err()
            {
                return Ok(false);
            }
            drop(file);
        }
        if delete_open_directory(directory).is_err() {
            return Err(state_error(
                error_code,
                "cache lease tombstone removal failed",
            ));
        }
        flush_directory(&parent, error_code, "cache lease parent sync failed")?;
        Ok(true)
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
        let root = open_absolute_root(&self.path, true, true, sensitivity, error_code)?
            .ok_or_else(|| state_error(error_code, "local state root could not be created"))?;
        let (parents, leaf) = components.split_at(components.len() - 1);
        let parent = open_relative_directories(
            &root,
            parents,
            true,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        .ok_or_else(|| state_error(error_code, "local lock parent could not be created"))?;
        let directory = match create_child_directory(
            &parent,
            &leaf[0],
            ReadSensitivity::LegacySecret,
            error_code,
        )? {
            Some(directory) => directory,
            None => {
                validate_existing_lock_directory(&parent, &leaf[0], error_code)?;
                return Ok(None);
            }
        };
        let created_identity = directory_identity(&directory, error_code)?;
        let published_owner = match publish_protocol_file(
            &directory,
            "owner",
            &format!(".owner.{owner}.tmp"),
            &owner,
            error_code,
            "local lock owner",
        ) {
            Ok(Some(published)) => published,
            Ok(None) => {
                abandon_new_lock(&parent, directory, None);
                return Ok(None);
            }
            Err(error) => {
                abandon_new_lock(&parent, directory, None);
                return Err(error);
            }
        };
        if flush_directory(&parent, error_code, "local lock parent sync failed").is_err() {
            abandon_new_lock(&parent, directory, Some(&published_owner));
            return Err(state_error(error_code, "local lock parent sync failed"));
        }
        match read_protocol_file(
            &directory,
            STEAL_CLAIM_FILE,
            error_code,
            "local steal claim",
        ) {
            Ok(Some(_)) => {
                abandon_new_lock(&parent, directory, Some(&published_owner));
                return Ok(None);
            }
            Ok(None) => {}
            Err(error) => {
                abandon_new_lock(&parent, directory, Some(&published_owner));
                return Err(error);
            }
        }
        if !path_matches_directory(&parent, &leaf[0], &created_identity, error_code)? {
            abandon_new_lock(&parent, directory, Some(&published_owner));
            return Ok(None);
        }
        Ok(Some(PlainDirectoryLock {
            parent,
            directory: Some(directory),
            published_owner,
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
        let Some(root) = open_absolute_root(&self.path, false, true, sensitivity, error_code)?
        else {
            return Ok(false);
        };
        let (parents, leaf) = components.split_at(components.len() - 1);
        let Some(parent) = open_relative_directories(
            &root,
            parents,
            false,
            true,
            ReadSensitivity::NonSecret,
            error_code,
        )?
        else {
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
        let (claim, owns_claim) = match read_protocol_file(
            &observed.directory,
            STEAL_CLAIM_FILE,
            error_code,
            "local steal claim",
        )? {
            Some(claim) if plain_lock_owner_is_alive(Some(&claim.owner)) => return Ok(false),
            Some(claim) => (claim, false),
            None => {
                let Some(claim) = publish_protocol_file(
                    &observed.directory,
                    STEAL_CLAIM_FILE,
                    &format!(".steal.{claimant}.tmp"),
                    &claimant,
                    error_code,
                    "local steal claim",
                )?
                else {
                    return Ok(false);
                };
                (claim, true)
            }
        };

        let current_owner =
            read_protocol_file(&observed.directory, "owner", error_code, "local lock owner")?;
        let current_claim = read_protocol_file(
            &observed.directory,
            STEAL_CLAIM_FILE,
            error_code,
            "local steal claim",
        )?;
        let revalidated =
            path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)?
                && current_owner.as_ref().map(|entry| entry.owner.as_str())
                    == observed.owner.as_deref()
                && current_owner.as_ref().map(|entry| &entry.identity)
                    == observed.owner_identity.as_ref()
                && !plain_lock_owner_is_alive(observed.owner.as_deref())
                && current_claim
                    .as_ref()
                    .is_some_and(|current| current == &claim);
        if !revalidated {
            if owns_claim {
                release_protocol_file(
                    &observed.directory,
                    STEAL_CLAIM_FILE,
                    &claim,
                    error_code,
                    "local steal claim",
                );
            }
            return Ok(false);
        }

        let moved = move_plain_lock_to_tombstone(&parent, &leaf[0], &observed, &claim, error_code);
        match moved {
            Ok(true) => Ok(true),
            Ok(false) => {
                if owns_claim {
                    release_protocol_file(
                        &observed.directory,
                        STEAL_CLAIM_FILE,
                        &claim,
                        error_code,
                        "local steal claim",
                    );
                }
                Ok(false)
            }
            Err(error) => {
                if owns_claim
                    && path_matches_directory(&parent, &leaf[0], &observed.identity, error_code)
                        .unwrap_or(false)
                {
                    release_protocol_file(
                        &observed.directory,
                        STEAL_CLAIM_FILE,
                        &claim,
                        error_code,
                        "local steal claim",
                    );
                }
                Err(error)
            }
        }
    }
}

impl Drop for PlainDirectoryLock {
    fn drop(&mut self) {
        let Some(directory) = self.directory.take() else {
            return;
        };
        let removed = release_protocol_file(
            &directory,
            "owner",
            &self.published_owner,
            KrxErrorCode::InternalFailure,
            "local lock owner",
        );
        if removed && delete_open_directory(directory).is_ok() {
            let _ = flush_directory(
                &self.parent,
                KrxErrorCode::InternalFailure,
                "local lock parent sync failed",
            );
        }
    }
}

impl Drop for CacheDirectoryLease {
    fn drop(&mut self) {
        let Some(directory) = self.directory.take() else {
            return;
        };
        let Ok(Some(current_path)) = open_child_directory(
            &self.parent,
            &self.leaf,
            true,
            ReadSensitivity::NonSecret,
            KrxErrorCode::InternalFailure,
        ) else {
            return;
        };
        let Ok(current_identity) = directory_identity(&current_path, KrxErrorCode::InternalFailure)
        else {
            return;
        };
        if !same_object_identity(&current_identity, &self.directory_identity) {
            return;
        }
        let Ok(Some((owner_file, current_owner))) = open_cache_owner(
            &directory,
            self.owner.bytes.len() as u64,
            KrxErrorCode::InternalFailure,
        ) else {
            return;
        };
        if !same_cache_owner(&current_owner, &self.owner)
            || delete_open_handle(owner_file.as_raw_handle()).is_err()
        {
            return;
        }
        drop(owner_file);
        if delete_open_directory(directory).is_ok() {
            let _ = flush_directory(
                &self.parent,
                KrxErrorCode::InternalFailure,
                "cache lease parent sync failed",
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn enumerate_cache_directory(
    directory: &Dir,
    relative: &str,
    paths: &mut Vec<CachePath>,
    leases: &mut Vec<String>,
    child_count: &mut u64,
    metadata_bytes: &mut u64,
    maximum_files: u64,
    maximum_metadata_bytes: u64,
    error_code: KrxErrorCode,
    only_files: bool,
) -> Result<(), KrxError> {
    let entries = directory
        .entries()
        .map_err(|_| state_error(error_code, "cache directory enumeration failed"))?;
    let mut names = Vec::new();
    for entry in entries {
        *child_count = child_count.checked_add(1).ok_or_else(|| {
            KrxError::new(
                KrxErrorCode::CacheScanLimit,
                "cache scan exceeded its file bound",
            )
        })?;
        if *child_count > maximum_files {
            return Err(KrxError::new(
                KrxErrorCode::CacheScanLimit,
                "cache scan exceeded its file bound",
            ));
        }
        let entry =
            entry.map_err(|_| state_error(error_code, "cache directory enumeration failed"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| state_error(error_code, "cache filename is not valid UTF-8"))?;
        names.push(name);
    }
    names.sort();
    for name in names {
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(state_error(error_code, "cache entry inspection failed")),
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            continue;
        }
        let child_relative = format!("{relative}/{name}");
        if file_type.is_dir() {
            if relative == "cache/.leases" && is_cache_lease_directory(&name) {
                leases.push(child_relative);
                continue;
            }
            let is_v2_root = relative == "cache" && name == "v2";
            let is_leases_root = relative == "cache" && name == ".leases";
            if only_files || (!is_v2_root && !is_leases_root && !is_cache_date_directory(&name)) {
                continue;
            }
            let Some(child) = open_child_directory(
                directory,
                OsStr::new(&name),
                false,
                ReadSensitivity::NonSecret,
                error_code,
            )?
            else {
                continue;
            };
            enumerate_cache_directory(
                &child,
                &child_relative,
                paths,
                leases,
                child_count,
                metadata_bytes,
                maximum_files,
                maximum_metadata_bytes,
                error_code,
                !is_v2_root && !is_leases_root,
            )?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if paths.len() as u64 >= maximum_files {
            return Err(KrxError::new(
                KrxErrorCode::CacheScanLimit,
                "cache scan exceeded its file bound",
            ));
        }
        *metadata_bytes = metadata_bytes.checked_add(metadata.len()).ok_or_else(|| {
            KrxError::new(
                KrxErrorCode::CacheScanLimit,
                "cache scan exceeded its metadata bound",
            )
        })?;
        if *metadata_bytes > maximum_metadata_bytes {
            return Err(KrxError::new(
                KrxErrorCode::CacheScanLimit,
                "cache scan exceeded its metadata bound",
            ));
        }
        paths.push(CachePath {
            relative: child_relative,
        });
    }
    Ok(())
}

fn is_cache_lease_directory(value: &str) -> bool {
    let Some(stem) = value.strip_suffix(".lock") else {
        return false;
    };
    stem.len() == 64
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_cache_date_directory(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn state_error(code: KrxErrorCode, message: &'static str) -> KrxError {
    KrxError::new(code, message)
}

fn invalid_state_path(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::InternalFailure, message)
}

fn validate_absolute_root(path: &Path) -> Result<(), KrxError> {
    reject_dot_components(path.as_os_str())?;
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(invalid_state_path(
            "local state root must be an absolute path",
        ));
    }
    let mut components = path.components();
    let prefix = components
        .next()
        .and_then(|component| match component {
            Component::Prefix(prefix) => Some(prefix.kind()),
            _ => None,
        })
        .ok_or_else(|| invalid_state_path("local state root must have a drive prefix"))?;
    if !matches!(prefix, Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        || !matches!(components.next(), Some(Component::RootDir))
    {
        return Err(invalid_state_path(
            "local state root must be an absolute local-drive path",
        ));
    }
    for component in components {
        let Component::Normal(component) = component else {
            return Err(invalid_state_path(
                "local state root must be an absolute local-drive path",
            ));
        };
        validate_windows_component(component)?;
    }
    Ok(())
}

fn relative_components(relative: &str) -> Result<Vec<OsString>, KrxError> {
    let path = Path::new(relative);
    reject_dot_components(path.as_os_str())?;
    let components = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => {
                validate_windows_component(value)?;
                Ok(value.to_os_string())
            }
            _ => Err(invalid_state_path(
                "local state relative path contains an unsafe component",
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(invalid_state_path(
            "local state relative path must not be empty",
        ));
    }
    Ok(components)
}

fn reject_dot_components(path: &OsStr) -> Result<(), KrxError> {
    let wide = path.encode_wide().collect::<Vec<_>>();
    if wide
        .split(|unit| *unit == u16::from(b'/') || *unit == u16::from(b'\\'))
        .any(|component| component == [b'.' as u16] || component == [b'.' as u16, b'.' as u16])
    {
        return Err(invalid_state_path(
            "local state path contains an unsafe dot component",
        ));
    }
    Ok(())
}

fn absolute_parts(path: &Path) -> Result<(PathBuf, Vec<OsString>), KrxError> {
    let mut components = path.components();
    let prefix = match components.next() {
        Some(Component::Prefix(prefix)) => prefix.kind(),
        _ => return Err(invalid_state_path("local state root has no drive prefix")),
    };
    let drive = match prefix {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        _ => {
            return Err(invalid_state_path(
                "local state root is not on a local drive",
            ));
        }
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(invalid_state_path("local state root has no drive root"));
    }
    let normal = components
        .map(|component| match component {
            Component::Normal(value) => {
                validate_windows_component(value)?;
                Ok(value.to_os_string())
            }
            _ => Err(invalid_state_path("local state root is malformed")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((PathBuf::from(format!("{}:\\", char::from(drive))), normal))
}

fn temporary_name(leaf: &OsStr) -> Result<OsString, KrxError> {
    let leaf = leaf
        .to_str()
        .ok_or_else(|| invalid_state_path("local state filename must be UTF-8"))?;
    Ok(OsString::from(format!(".{leaf}.{}.tmp", Uuid::new_v4())))
}

fn validate_windows_component(component: &OsStr) -> Result<(), KrxError> {
    let wide = component.encode_wide().collect::<Vec<_>>();
    if wide.is_empty()
        || wide
            .iter()
            .any(|unit| *unit == 0 || *unit == u16::from(b':'))
        || wide
            .last()
            .is_some_and(|unit| *unit == u16::from(b'.') || *unit == u16::from(b' '))
    {
        return Err(invalid_state_path(
            "local state path contains an unsafe Windows component",
        ));
    }
    let base = wide
        .split(|unit| *unit == u16::from(b'.'))
        .next()
        .unwrap_or_default();
    let reserved_simple = [b"CON", b"PRN", b"AUX", b"NUL"]
        .iter()
        .any(|name| equals_ascii_case_insensitive(base, name.as_slice()));
    let reserved_port_suffix = base.get(3).is_some_and(|suffix| {
        (u16::from(b'1')..=u16::from(b'9')).contains(suffix)
            || matches!(*suffix, 0x00b9 | 0x00b2 | 0x00b3)
    });
    let reserved_port = base.len() == 4
        && (equals_ascii_case_insensitive(&base[..3], b"COM")
            || equals_ascii_case_insensitive(&base[..3], b"LPT"))
        && reserved_port_suffix;
    if reserved_simple || reserved_port {
        return Err(invalid_state_path(
            "local state path contains a reserved Windows component",
        ));
    }
    Ok(())
}

fn equals_ascii_case_insensitive(wide: &[u16], ascii: &[u8]) -> bool {
    wide.len() == ascii.len()
        && wide
            .iter()
            .zip(ascii)
            .all(|(left, right)| *left <= 0x7f && (*left as u8).eq_ignore_ascii_case(right))
}

fn unicode_string(component: &OsStr) -> Result<OwnedUnicodeString, KrxError> {
    validate_windows_component(component)?;
    let mut wide = component.encode_wide().collect::<Vec<_>>();
    let byte_length = wide
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| invalid_state_path("local state component is too long"))?;
    let string = UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: wide.as_mut_ptr(),
    };
    Ok(OwnedUnicodeString {
        string,
        _wide: wide,
    })
}

fn validate_plain_lock_owner(owner: &str) -> Result<(), KrxError> {
    let Some((pid, uuid)) = owner.split_once('-') else {
        return Err(invalid_state_path("local lock owner is malformed"));
    };
    if pid.is_empty()
        || pid.starts_with('0')
        || !pid.bytes().all(|byte| byte.is_ascii_digit())
        || pid.parse::<u32>().ok().filter(|pid| *pid > 0).is_none()
    {
        return Err(invalid_state_path("local lock owner is malformed"));
    }
    let valid_uuid_shape = uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        });
    if !valid_uuid_shape {
        return Err(invalid_state_path("local lock owner is malformed"));
    }
    let uuid =
        Uuid::parse_str(uuid).map_err(|_| invalid_state_path("local lock owner is malformed"))?;
    if uuid.get_version_num() != 4 || uuid.get_variant() != Variant::RFC4122 {
        return Err(invalid_state_path("local lock owner is malformed"));
    }
    Ok(())
}

fn open_absolute_root(
    path: &Path,
    create: bool,
    for_write: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<Option<Dir>, KrxError> {
    let (drive_root, normal) = absolute_parts(path)?;
    let ambient = AmbientOpenOptions::new()
        .read(true)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(drive_root)
        .map_err(|_| state_error(error_code, "local state root traversal failed"))?;
    let metadata = ambient
        .metadata()
        .map_err(|_| state_error(error_code, "local state root traversal failed"))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY == 0
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(state_error(
            error_code,
            "local state path contains an unsafe component",
        ));
    }
    let mut current = Dir::from_std_file(ambient);
    for (index, component) in normal.iter().enumerate() {
        let is_root = index + 1 == normal.len();
        // Windows profile ancestors such as C:\Users are normally OS-owned.
        // Traverse them by no-follow handles, then enforce the private ACL only
        // on the application state root and every descendant it contains.
        let opened = if is_root {
            open_child_directory(&current, component, for_write, sensitivity, error_code)?
        } else {
            open_traversal_directory(&current, component, error_code)?
        };
        match opened {
            Some(next) => current = next,
            None if is_root && !create => return Ok(None),
            None if is_root && create => {
                current =
                    match create_child_directory(&current, component, sensitivity, error_code)? {
                        Some(created) => created,
                        None => open_child_directory(
                            &current,
                            component,
                            for_write,
                            sensitivity,
                            error_code,
                        )?
                        .ok_or_else(|| state_error(error_code, "local state root open failed"))?,
                    };
            }
            None => {
                return Err(state_error(
                    error_code,
                    "local state path contains an unsafe component",
                ));
            }
        }
    }
    validate_directory_security(&current, sensitivity, error_code)?;
    Ok(Some(current))
}

fn open_relative_directories(
    root: &Dir,
    components: &[OsString],
    create: bool,
    for_write: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<Option<Dir>, KrxError> {
    let mut current = root
        .try_clone()
        .map_err(|_| state_error(error_code, "local state root duplication failed"))?;
    for component in components {
        match open_child_directory(&current, component, for_write, sensitivity, error_code)? {
            Some(next) => current = next,
            None if create => {
                current =
                    match create_child_directory(&current, component, sensitivity, error_code)? {
                        Some(created) => created,
                        None => open_child_directory(
                            &current,
                            component,
                            for_write,
                            sensitivity,
                            error_code,
                        )?
                        .ok_or_else(|| {
                            state_error(error_code, "local state directory open failed")
                        })?,
                    };
            }
            None => return Ok(None),
        }
    }
    Ok(Some(current))
}

fn create_child_directory(
    parent: &Dir,
    leaf: &OsStr,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<Option<Dir>, KrxError> {
    let Some(file) = create_state_object(parent, leaf, true, error_code)? else {
        return Ok(None);
    };
    let directory = Dir::from_std_file(file);
    validate_directory_security(&directory, sensitivity, error_code)?;
    Ok(Some(directory))
}

fn create_state_object(
    parent: &Dir,
    leaf: &OsStr,
    directory: bool,
    error_code: KrxErrorCode,
) -> Result<Option<std::fs::File>, KrxError> {
    let name = unicode_string(leaf)?;
    let mut token = null_mut();
    // SAFETY: token receives an owned process-token handle on success.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(state_error(
            error_code,
            "local state user identity inspection failed",
        ));
    }
    let _token_guard = HandleGuard(token);
    let mut owner = token_user_sid(token, error_code)?;
    let mut acl_storage = [0_usize; 64];
    let dacl = acl_storage.as_mut_ptr().cast();
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let descriptor_ptr = (&raw mut descriptor).cast();
    // Elevated tokens can default to Administrators as owner. Specify the user
    // and a protected private ACL at creation, before any bytes are written;
    // never repair or take ownership of an existing object.
    // SAFETY: the aligned ACL buffer fits one maximum-size SID. All descriptor
    // pointers reference live local storage through NtCreateFile below.
    let secured = unsafe {
        InitializeAcl(
            dacl,
            std::mem::size_of_val(&acl_storage) as u32,
            ACL_REVISION,
        ) != 0
            && AddAccessAllowedAce(
                dacl,
                ACL_REVISION,
                FILE_ALL_ACCESS,
                owner.as_mut_ptr().cast(),
            ) != 0
            && InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) != 0
            && SetSecurityDescriptorOwner(descriptor_ptr, owner.as_mut_ptr().cast(), 0) != 0
            && SetSecurityDescriptorDacl(descriptor_ptr, 1, dacl, 0) != 0
            && SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                != 0
    };
    if !secured {
        return Err(state_error(
            error_code,
            "local state private ACL creation failed",
        ));
    }
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle().cast(),
        ObjectName: &name.string,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: &descriptor,
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut handle = null_mut();
    // SAFETY: attributes retains a validated relative name, parent handle and
    // security descriptor. FILE_CREATE never opens an existing object.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | READ_CONTROL | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            std::ptr::null(),
            if directory {
                FILE_ATTRIBUTE_DIRECTORY
            } else {
                0
            },
            SHARE_ALL,
            FILE_CREATE,
            (if directory {
                FILE_DIRECTORY_FILE
            } else {
                FILE_NON_DIRECTORY_FILE
            }) | NT_FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if matches!(status, STATUS_OBJECT_NAME_COLLISION | STATUS_DELETE_PENDING) {
        return Ok(None);
    }
    if status < 0 || handle.is_null() {
        return Err(state_error(
            error_code,
            "local state object creation failed",
        ));
    }
    // SAFETY: NtCreateFile returned a new owned handle on success.
    Ok(Some(unsafe {
        std::fs::File::from_raw_handle(handle.cast())
    }))
}

fn open_child_directory(
    parent: &Dir,
    leaf: &OsStr,
    for_write: bool,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<Option<Dir>, KrxError> {
    let Some(file) = open_directory_file(parent, leaf, for_write, error_code)? else {
        return Ok(None);
    };
    let directory = Dir::from_std_file(file.into_std());
    validate_directory_security(&directory, sensitivity, error_code)?;
    Ok(Some(directory))
}

fn open_traversal_directory(
    parent: &Dir,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<Option<Dir>, KrxError> {
    let Some(file) = open_directory_file(parent, leaf, false, error_code)? else {
        return Ok(None);
    };
    Ok(Some(Dir::from_std_file(file.into_std())))
}

fn open_directory_file(
    parent: &Dir,
    leaf: &OsStr,
    for_write: bool,
    error_code: KrxErrorCode,
) -> Result<Option<File>, KrxError> {
    let name = unicode_string(leaf)?;
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle().cast(),
        ObjectName: &name.string,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle = null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    let access = FILE_GENERIC_READ
        | if for_write {
            FILE_GENERIC_WRITE | DELETE
        } else {
            0
        };
    // SAFETY: the validated single-component name and parent handle remain live.
    // Opening the reparse point itself prevents traversal through a replacement.
    let status = unsafe {
        NtOpenFile(
            &mut handle,
            access,
            &attributes,
            &mut status_block,
            SHARE_ALL,
            FILE_DIRECTORY_FILE | NT_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )
    };
    // Win32 folds DELETE_PENDING into ACCESS_DENIED. Retain the native status
    // so a disappearing lock is absence while a real access denial stays fatal.
    if matches!(
        status,
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND | STATUS_DELETE_PENDING
    ) {
        return Ok(None);
    }
    if status < 0 || handle.is_null() {
        return Err(state_error(
            error_code,
            "local state directory is missing or unsafe",
        ));
    }
    // SAFETY: NtOpenFile returned a new owned file handle.
    let file = File::from_std(unsafe { std::fs::File::from_raw_handle(handle.cast()) });
    let metadata = file
        .metadata()
        .map_err(|_| state_error(error_code, "local state directory inspection failed"))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY == 0
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(state_error(
            error_code,
            "local state component is not a safe directory",
        ));
    }
    Ok(Some(file))
}

fn validate_directory_security(
    directory: &Dir,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    let metadata = directory
        .dir_metadata()
        .map_err(|_| state_error(error_code, "local state directory inspection failed"))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY == 0
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(state_error(
            error_code,
            "local state component is not a safe directory",
        ));
    }
    validate_handle_security(directory.as_raw_handle(), sensitivity, error_code)
}

fn validate_destination(
    parent: &Dir,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    match open_secure_file(parent, leaf, false, false, false, error_code) {
        Ok(Some(_)) | Ok(None) => Ok(()),
        Err(error) => Err(error),
    }
}

fn create_secure_file(
    parent: &Dir,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<File, KrxError> {
    open_secure_file(parent, leaf, true, true, false, error_code)?
        .ok_or_else(|| state_error(error_code, "local state temporary file creation failed"))
}

fn open_secure_file(
    parent: &Dir,
    leaf: &OsStr,
    write: bool,
    create_new: bool,
    delete_access: bool,
    error_code: KrxErrorCode,
) -> Result<Option<File>, KrxError> {
    let file = if create_new {
        let file = create_state_object(parent, leaf, false, error_code)?
            .ok_or_else(|| state_error(error_code, "local state temporary file already exists"))?;
        File::from_std(file)
    } else {
        let mut options = OpenOptions::new();
        options
            .read(!write)
            .write(write)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if write {
            options.access_mode(
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | READ_CONTROL | SYNCHRONIZE,
            );
        } else if delete_access {
            options.access_mode(FILE_GENERIC_READ | DELETE | READ_CONTROL | SYNCHRONIZE);
        }
        match parent.open_with(leaf, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(state_error(error_code, "local state file open failed")),
        }
    };
    let metadata = file
        .metadata()
        .map_err(|_| state_error(error_code, "local state file inspection failed"))?;
    if metadata.file_attributes() & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(state_error(
            error_code,
            "local state file is not a safe regular file",
        ));
    }
    validate_handle_security(file.as_raw_handle(), ReadSensitivity::NonSecret, error_code)?;
    Ok(Some(file))
}

fn read_file(
    parent: &Dir,
    leaf: &OsStr,
    maximum_bytes: u64,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
    observe_oversized: bool,
) -> Result<Option<ObservedFile>, KrxError> {
    let Some(mut file) = open_secure_file(parent, leaf, false, false, false, error_code)? else {
        return Ok(None);
    };
    if sensitivity == ReadSensitivity::LegacySecret {
        validate_handle_security(file.as_raw_handle(), sensitivity, error_code)?;
    }
    let before = file_metadata_identity(&file, error_code)?;
    if before.size > maximum_bytes {
        if observe_oversized {
            return Ok(Some(ObservedFile {
                bytes: Vec::new(),
                identity: before,
                complete: false,
            }));
        }
        return Err(state_error(
            error_code,
            "local state file exceeds its read bound",
        ));
    }
    let capacity = usize::try_from(before.size)
        .map_err(|_| state_error(error_code, "local state file exceeds platform bounds"))?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "local state file read failed"))?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(state_error(
            error_code,
            "local state file exceeds its read bound",
        ));
    }
    let after = file_metadata_identity(&file, error_code)?;
    if before != after {
        return Err(state_error(
            error_code,
            "local state file changed during read",
        ));
    }
    Ok(Some(ObservedFile {
        bytes,
        identity: before,
        complete: true,
    }))
}

fn publish_protocol_file(
    directory: &Dir,
    destination: &str,
    candidate: &str,
    owner: &str,
    error_code: KrxErrorCode,
    label: &'static str,
) -> Result<Option<ProtocolFileObservation>, KrxError> {
    validate_plain_lock_owner(owner)?;
    let mut file = create_secure_file(directory, OsStr::new(candidate), error_code)?;
    let mut published = None;
    let result = (|| {
        file.write_all(owner.as_bytes())
            .map_err(|_| state_error(error_code, "local protocol candidate write failed"))?;
        file.sync_all()
            .map_err(|_| state_error(error_code, "local protocol candidate sync failed"))?;
        let candidate_identity = file_metadata_identity(&file, error_code)?;
        if !link_open_handle(&file, directory, OsStr::new(destination))
            .map_err(|_| state_error(error_code, "local protocol publication failed"))?
        {
            return Ok(None);
        }
        published = Some(ProtocolFileObservation {
            identity: candidate_identity.clone(),
            owner: owner.to_owned(),
        });
        flush_directory(
            directory,
            error_code,
            "local protocol publication sync failed",
        )?;
        let observation = read_protocol_file(directory, destination, error_code, label)?
            .ok_or_else(|| state_error(error_code, "local protocol publication disappeared"))?;
        if observation.owner != owner
            || !same_object_identity(&observation.identity, &candidate_identity)
        {
            return Err(state_error(
                error_code,
                "local protocol publication identity changed",
            ));
        }
        Ok(Some(observation))
    })();
    let mut cleanup_failed = false;
    let mut rolled_back = false;
    if result.is_err()
        && let Some(observation) = &published
    {
        rolled_back = true;
        if !release_protocol_file(directory, destination, observation, error_code, label) {
            cleanup_failed = true;
        }
    }
    let candidate_cleanup = delete_open_handle(file.as_raw_handle());
    drop(file);
    if candidate_cleanup.is_err() {
        cleanup_failed = true;
        if !rolled_back && let Some(observation) = &published {
            rolled_back = true;
            if !release_protocol_file(directory, destination, observation, error_code, label) {
                cleanup_failed = true;
            }
        }
    }
    let candidate_sync =
        flush_directory(directory, error_code, "local protocol cleanup sync failed");
    if candidate_sync.is_err() {
        cleanup_failed = true;
        if result.is_ok()
            && !rolled_back
            && let Some(observation) = &published
            && !release_protocol_file(directory, destination, observation, error_code, label)
        {
            cleanup_failed = true;
        }
    }
    if cleanup_failed {
        return Err(state_error(error_code, "local protocol cleanup failed"));
    }
    result
}

fn publish_cache_owner(
    directory: &Dir,
    bytes: &[u8],
    error_code: KrxErrorCode,
) -> Result<CacheOwnerObservation, KrxError> {
    let mut file = create_secure_file(directory, OsStr::new("owner.json"), error_code)?;
    file.write_all(bytes)
        .map_err(|_| state_error(error_code, "cache lease owner write failed"))?;
    file.sync_all()
        .map_err(|_| state_error(error_code, "cache lease owner sync failed"))?;
    let identity = file_metadata_identity(&file, error_code)?;
    flush_directory(
        directory,
        error_code,
        "cache lease owner directory sync failed",
    )?;
    drop(file);
    let Some((_, observed)) = open_cache_owner(directory, bytes.len() as u64, error_code)? else {
        return Err(state_error(
            error_code,
            "cache lease owner publication disappeared",
        ));
    };
    if !same_cache_owner_identity(&observed, &identity) || observed.bytes != bytes {
        return Err(state_error(
            error_code,
            "cache lease owner publication identity changed",
        ));
    }
    Ok(observed)
}

fn read_cache_owner(
    directory: &Dir,
    maximum_bytes: u64,
    error_code: KrxErrorCode,
) -> Result<Option<CacheOwnerObservation>, KrxError> {
    Ok(open_cache_owner(directory, maximum_bytes, error_code)?.map(|(_, owner)| owner))
}

fn open_cache_owner(
    directory: &Dir,
    maximum_bytes: u64,
    error_code: KrxErrorCode,
) -> Result<Option<(File, CacheOwnerObservation)>, KrxError> {
    let Some(mut file) = open_secure_file(
        directory,
        OsStr::new("owner.json"),
        false,
        false,
        true,
        error_code,
    )?
    else {
        return Ok(None);
    };
    let identity = file_metadata_identity(&file, error_code)?;
    if identity.size > maximum_bytes {
        // Keep the exact file identity without reading attacker-controlled
        // oversized contents.  Stale recovery may compare and remove only
        // this still-matching object, while callers treat its payload as
        // malformed rather than allocating an unbounded buffer.
        return Ok(Some((
            file,
            CacheOwnerObservation {
                identity,
                bytes: Vec::new(),
                complete: false,
            },
        )));
    }
    let mut bytes = Vec::with_capacity(identity.size as usize);
    Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "cache lease owner read failed"))?;
    let after = file_metadata_identity(&file, error_code)?;
    if identity != after || bytes.len() as u64 > maximum_bytes {
        return Err(state_error(
            error_code,
            "cache lease owner changed during read",
        ));
    }
    Ok(Some((
        file,
        CacheOwnerObservation {
            identity,
            bytes,
            complete: true,
        },
    )))
}

fn cache_lease_owner_matches(
    directory: &Dir,
    observed: Option<&CacheOwnerObservation>,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    match observed {
        Some(expected) => Ok(
            open_cache_owner(directory, expected.bytes.len() as u64, error_code)?
                .is_some_and(|(_, current)| same_cache_owner(&current, expected)),
        ),
        None => Ok(open_secure_file(
            directory,
            OsStr::new("owner.json"),
            false,
            false,
            false,
            error_code,
        )?
        .is_none()),
    }
}

fn abandon_cache_lease(parent: &Dir, directory: Dir, owner: Option<&CacheOwnerObservation>) {
    if let Some(owner) = owner
        && let Ok(Some((file, current))) = open_cache_owner(
            &directory,
            owner.bytes.len() as u64,
            KrxErrorCode::InternalFailure,
        )
        && same_cache_owner(&current, owner)
    {
        let _ = delete_open_handle(file.as_raw_handle());
        drop(file);
    }
    if delete_open_directory(directory).is_ok() {
        let _ = flush_directory(
            parent,
            KrxErrorCode::InternalFailure,
            "cache lease parent sync failed",
        );
    }
}

fn read_protocol_file(
    directory: &Dir,
    leaf: &str,
    error_code: KrxErrorCode,
    label: &'static str,
) -> Result<Option<ProtocolFileObservation>, KrxError> {
    let Some((_, observation)) = open_protocol_file(directory, leaf, false, error_code, label)?
    else {
        return Ok(None);
    };
    Ok(Some(observation))
}

fn open_protocol_file(
    directory: &Dir,
    leaf: &str,
    delete_access: bool,
    error_code: KrxErrorCode,
    label: &'static str,
) -> Result<Option<(File, ProtocolFileObservation)>, KrxError> {
    let Some(mut file) = open_secure_file(
        directory,
        OsStr::new(leaf),
        false,
        false,
        delete_access,
        error_code,
    )?
    else {
        return Ok(None);
    };
    let identity = file_metadata_identity(&file, error_code)?;
    if identity.size > PROTOCOL_FILE_MAXIMUM_BYTES {
        return Err(state_error(error_code, "local protocol file is unsafe"));
    }
    let mut bytes = Vec::with_capacity(identity.size as usize);
    Read::by_ref(&mut file)
        .take(PROTOCOL_FILE_MAXIMUM_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| state_error(error_code, "local protocol file read failed"))?;
    let after = file_metadata_identity(&file, error_code)?;
    if identity != after || bytes.len() as u64 > PROTOCOL_FILE_MAXIMUM_BYTES {
        return Err(state_error(
            error_code,
            "local protocol file changed during read",
        ));
    }
    let owner = String::from_utf8(bytes).map_err(|_| state_error(error_code, label))?;
    validate_plain_lock_owner(&owner).map_err(|_| state_error(error_code, label))?;
    Ok(Some((file, ProtocolFileObservation { identity, owner })))
}

fn release_protocol_file(
    directory: &Dir,
    leaf: &str,
    expected: &ProtocolFileObservation,
    error_code: KrxErrorCode,
    label: &'static str,
) -> bool {
    let Ok(Some((file, current))) = open_protocol_file(directory, leaf, true, error_code, label)
    else {
        return false;
    };
    if current != *expected || delete_open_handle(file.as_raw_handle()).is_err() {
        return false;
    }
    drop(file);
    flush_directory(
        directory,
        KrxErrorCode::InternalFailure,
        "local protocol removal sync failed",
    )
    .is_ok()
}

fn abandon_new_lock(
    parent: &Dir,
    directory: Dir,
    published_owner: Option<&ProtocolFileObservation>,
) {
    if let Some(owner) = published_owner
        && !release_protocol_file(
            &directory,
            "owner",
            owner,
            KrxErrorCode::InternalFailure,
            "local lock owner",
        )
    {
        return;
    }
    if delete_open_directory(directory).is_ok() {
        let _ = flush_directory(
            parent,
            KrxErrorCode::InternalFailure,
            "local lock parent sync failed",
        );
    }
}

fn validate_existing_lock_directory(
    parent: &Dir,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    match open_child_directory(
        parent,
        leaf,
        true,
        ReadSensitivity::LegacySecret,
        error_code,
    )? {
        Some(_) => Ok(()),
        None => Ok(()),
    }
}

fn inspect_plain_lock(
    parent: &Dir,
    leaf: &OsStr,
    error_code: KrxErrorCode,
) -> Result<Option<PlainLockObservation>, KrxError> {
    let Some(directory) = open_child_directory(
        parent,
        leaf,
        true,
        ReadSensitivity::LegacySecret,
        error_code,
    )?
    else {
        return Ok(None);
    };
    let metadata = directory
        .dir_metadata()
        .map_err(|_| state_error(error_code, "local lock inspection failed"))?;
    let modified = metadata
        .modified()
        .map_err(|_| state_error(error_code, "local lock timestamp is invalid"))?
        .into_std();
    let identity = handle_identity(directory.as_raw_handle(), error_code)?;
    let owner_observation = read_protocol_file(
        &directory,
        "owner",
        error_code,
        "local lock owner is malformed",
    )?;
    Ok(Some(PlainLockObservation {
        directory,
        identity,
        modified,
        owner: owner_observation
            .as_ref()
            .map(|observation| observation.owner.clone()),
        owner_identity: owner_observation.map(|observation| observation.identity),
    }))
}

fn path_matches_directory(
    parent: &Dir,
    leaf: &OsStr,
    expected: &FileIdentity,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let Some(directory) = open_child_directory(
        parent,
        leaf,
        false,
        ReadSensitivity::LegacySecret,
        error_code,
    )?
    else {
        return Ok(false);
    };
    Ok(same_object_identity(
        &directory_identity(&directory, error_code)?,
        expected,
    ))
}

fn plain_lock_owner_is_alive(owner: Option<&str>) -> bool {
    let Some(owner) = owner else {
        return false;
    };
    let Some((pid, _)) = owner.split_once('-') else {
        return false;
    };
    let Some(pid) = pid.parse::<u32>().ok().filter(|pid| *pid > 0) else {
        return false;
    };
    process_is_alive(pid)
}

pub(crate) fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: OpenProcess is called with a PID parsed from the validated owner
    // grammar. A returned handle is closed by the guard.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if !handle.is_null() {
        drop(HandleGuard(handle));
        return true;
    }
    // Access denied means the process exists but cannot be inspected.
    unsafe { GetLastError() == ERROR_ACCESS_DENIED }
}

fn move_plain_lock_to_tombstone(
    parent: &Dir,
    leaf: &OsStr,
    observed: &PlainLockObservation,
    claim: &ProtocolFileObservation,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let leaf_text = leaf
        .to_str()
        .ok_or_else(|| invalid_state_path("lock filename must be UTF-8"))?;
    let tombstone = OsString::from(format!("{leaf_text}.stale-{}", claim.owner));
    match rename_open_handle(&observed.directory, parent, &tombstone, false) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            if path_matches_directory(parent, leaf, &observed.identity, error_code)? {
                return Err(state_error(
                    error_code,
                    "stale local lock tombstone conflicts with observed lock",
                ));
            }
            return Ok(false);
        }
        Err(_) => return Err(state_error(error_code, "stale local lock rename failed")),
    }
    flush_directory(parent, error_code, "stale local lock sync failed")?;
    let moved = open_child_directory(
        parent,
        &tombstone,
        false,
        ReadSensitivity::LegacySecret,
        error_code,
    )?
    .ok_or_else(|| state_error(error_code, "stale local lock tombstone disappeared"))?;
    if !same_object_identity(&directory_identity(&moved, error_code)?, &observed.identity) {
        return Err(state_error(
            error_code,
            "stale local lock tombstone identity changed",
        ));
    }
    validate_retained_plain_lock(&observed.directory, error_code)?;
    Ok(true)
}

fn validate_retained_plain_lock(directory: &Dir, error_code: KrxErrorCode) -> Result<(), KrxError> {
    validate_directory_security(directory, ReadSensitivity::LegacySecret, error_code)?;
    let mut saw_claim = false;
    for entry in directory
        .entries()
        .map_err(|_| state_error(error_code, "stale local lock listing failed"))?
    {
        let entry =
            entry.map_err(|_| state_error(error_code, "stale local lock listing failed"))?;
        match entry.file_name().to_str() {
            Some("owner") => {}
            Some(STEAL_CLAIM_FILE) => saw_claim = true,
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

fn validate_handle_security(
    raw: RawHandle,
    sensitivity: ReadSensitivity,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    let handle = raw.cast::<c_void>();
    let mut token = null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle; token receives a new
    // owned handle on success.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(state_error(
            error_code,
            "local state user identity inspection failed",
        ));
    }
    let _token_guard = HandleGuard(token);
    let mut user_sid = token_user_sid(token, error_code)?;

    let mut owner: PSID = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: all out-pointers are valid for the duration of the call. The
    // returned descriptor is released by LocalAllocation.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    let _descriptor_guard = LocalAllocation(descriptor);
    if status != 0 || owner.is_null() || dacl.is_null() {
        return Err(state_error(error_code, "local state ACL inspection failed"));
    }
    // SAFETY: owner and user_sid point to valid SIDs backed by live buffers.
    if unsafe { EqualSid(owner, user_sid.as_mut_ptr().cast()) } == 0 {
        return Err(state_error(error_code, "local state has a foreign owner"));
    }
    let forbidden = writable_rights()
        | if sensitivity == ReadSensitivity::LegacySecret {
            GENERIC_READ | FILE_READ_DATA
        } else {
            0
        };
    validate_acl_access(dacl, user_sid.as_mut_ptr().cast(), forbidden, error_code)?;
    for sid_type in [WinWorldSid, WinAuthenticatedUserSid] {
        if effective_forbidden_rights(dacl, sid_type, forbidden, error_code)? {
            return Err(state_error(
                error_code,
                "local state ACL permits forbidden shared access",
            ));
        }
    }
    Ok(())
}

fn validate_acl_access(
    dacl: *mut windows_sys::Win32::Security::ACL,
    owner: PSID,
    forbidden: u32,
    error_code: KrxErrorCode,
) -> Result<(), KrxError> {
    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl was returned by GetSecurityInfo and information is a valid
    // fixed-size output buffer.
    if unsafe {
        GetAclInformation(
            dacl,
            (&raw mut information).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(state_error(error_code, "local state ACL inspection failed"));
    }
    let mut system_sid = well_known_sid(WinLocalSystemSid, error_code)?;
    let mut administrators_sid = well_known_sid(WinBuiltinAdministratorsSid, error_code)?;
    for index in 0..information.AceCount {
        let mut raw_ace = std::ptr::null_mut();
        // SAFETY: index is bounded by the ACL's reported ACE count and raw_ace
        // receives a pointer backed by the live security descriptor.
        if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(state_error(error_code, "local state ACL inspection failed"));
        }
        let allowed = raw_ace.cast::<ACCESS_ALLOWED_ACE>();
        // Every access-allowed ACE variant begins with ACE_HEADER and Mask.
        let ace_type = unsafe { (*allowed).Header.AceType };
        if !matches!(
            u32::from(ace_type),
            ACCESS_ALLOWED_ACE_TYPE
                | ACCESS_ALLOWED_CALLBACK_ACE_TYPE
                | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE
                | ACCESS_ALLOWED_COMPOUND_ACE_TYPE
                | ACCESS_ALLOWED_OBJECT_ACE_TYPE
        ) || unsafe { (*allowed).Mask } & forbidden == 0
        {
            continue;
        }
        // Object/callback/compound layouts place the SID at variant-dependent
        // offsets. Writable nonstandard allow ACEs are rejected fail-closed.
        if u32::from(ace_type) != ACCESS_ALLOWED_ACE_TYPE {
            return Err(state_error(
                error_code,
                "local state ACL permits nonstandard access",
            ));
        }
        // SAFETY: for ACCESS_ALLOWED_ACE_TYPE SidStart is the first word of a
        // SID stored inside this ACE and remains live with the descriptor.
        let sid = unsafe { (&raw mut (*allowed).SidStart).cast() };
        if unsafe { IsValidSid(sid) } == 0 {
            return Err(state_error(error_code, "local state ACL inspection failed"));
        }
        let approved = unsafe {
            EqualSid(sid, owner) != 0
                || EqualSid(sid, system_sid.as_mut_ptr().cast()) != 0
                || EqualSid(sid, administrators_sid.as_mut_ptr().cast()) != 0
        };
        if !approved {
            return Err(state_error(
                error_code,
                "local state ACL permits forbidden foreign access",
            ));
        }
    }
    Ok(())
}

fn token_user_sid(token: HANDLE, error_code: KrxErrorCode) -> Result<Vec<u8>, KrxError> {
    let mut length = 0;
    // SAFETY: the null-buffer probe is the documented way to obtain the size.
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length);
    }
    if length == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(state_error(
            error_code,
            "local state user identity inspection failed",
        ));
    }
    let mut bytes = vec![0_u8; length as usize];
    // SAFETY: bytes has exactly the probed size and remains live through the
    // subsequent SID copy.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            bytes.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(state_error(
            error_code,
            "local state user identity inspection failed",
        ));
    }
    let token_user = bytes.as_ptr().cast::<TOKEN_USER>();
    // Copy the SID into an independently owned buffer so its pointer remains
    // valid after this function returns.
    let sid = unsafe { (*token_user).User.Sid };
    // GetLengthSid is avoided here because SECURITY_MAX_SID_SIZE is the
    // documented upper bound and EqualSid ignores trailing bytes.
    let mut owned = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
    // SAFETY: CopySid validates the source SID and bounds the destination.
    if unsafe {
        windows_sys::Win32::Security::CopySid(SECURITY_MAX_SID_SIZE, owned.as_mut_ptr().cast(), sid)
    } == 0
    {
        return Err(state_error(
            error_code,
            "local state user identity inspection failed",
        ));
    }
    Ok(owned)
}

fn effective_forbidden_rights(
    dacl: *mut windows_sys::Win32::Security::ACL,
    sid_type: i32,
    forbidden: u32,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let mut sid = well_known_sid(sid_type, error_code)?;
    let mut trustee = TRUSTEE_W::default();
    // SAFETY: the SID buffer remains live through GetEffectiveRightsFromAclW.
    unsafe {
        BuildTrusteeWithSidW(&mut trustee, sid.as_mut_ptr().cast());
    }
    let mut rights = 0_u32;
    // SAFETY: dacl was returned by GetSecurityInfo and trustee is initialized.
    if unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) } != 0 {
        return Err(state_error(error_code, "local state ACL inspection failed"));
    }
    Ok(rights & forbidden != 0)
}

fn well_known_sid(sid_type: i32, error_code: KrxErrorCode) -> Result<Vec<u8>, KrxError> {
    let mut sid = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
    let mut sid_length = SECURITY_MAX_SID_SIZE;
    // SAFETY: sid is a writable buffer of the advertised size.
    if unsafe {
        CreateWellKnownSid(
            sid_type,
            null_mut(),
            sid.as_mut_ptr().cast(),
            &mut sid_length,
        )
    } == 0
    {
        return Err(state_error(error_code, "local state ACL inspection failed"));
    }
    Ok(sid)
}

fn writable_rights() -> u32 {
    // FILE_GENERIC_WRITE also contains READ_CONTROL and SYNCHRONIZE, which
    // ordinary readers receive. Only mutation rights identify foreign writers.
    GENERIC_ALL
        | GENERIC_WRITE
        | FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | FILE_DELETE_CHILD
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER
}

fn aligned_information_buffer(byte_length: usize) -> Result<(Vec<usize>, u32), io::Error> {
    let byte_length = u32::try_from(byte_length).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
    })?;
    let words = (byte_length as usize).div_ceil(size_of::<usize>());
    Ok((vec![0_usize; words], byte_length))
}

fn rename_open_handle(
    source: &impl AsRawHandle,
    parent: &Dir,
    destination: &OsStr,
    replace: bool,
) -> io::Result<()> {
    validate_windows_component(destination)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "unsafe Windows file name"))?;
    let wide = destination.encode_wide().collect::<Vec<_>>();
    let name_bytes = wide.len().checked_mul(size_of::<u16>()).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
    })?;
    let information_length = offset_of!(FILE_RENAME_INFORMATION, FileName)
        .checked_add(name_bytes)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
        })?;
    let (mut buffer, information_length) = aligned_information_buffer(information_length)?;
    let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status_block = IO_STATUS_BLOCK::default();
    // Use the native relative-name contract, matching hard-link publication.
    // The Win32 rename wrapper rejects this retained-directory form (error 87).
    // SAFETY: buffer is usize-aligned and large enough for the fixed header and
    // exact UTF-16 name. Both source and parent handles remain live in the call.
    let status = unsafe {
        (*information).Anonymous.ReplaceIfExists = replace;
        (*information).RootDirectory = parent.as_raw_handle().cast();
        (*information).FileNameLength = u32::try_from(name_bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
        })?;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            (*information).FileName.as_mut_ptr(),
            wide.len(),
        );
        NtSetInformationFile(
            source.as_raw_handle().cast(),
            &mut status_block,
            information.cast(),
            information_length,
            FileRenameInformation,
        )
    };
    if status < 0 {
        // SAFETY: conversion accepts the returned NTSTATUS and preserves OS
        // collision classifications used by lock recovery.
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    } else {
        Ok(())
    }
}

fn link_open_handle(source: &File, parent: &Dir, destination: &OsStr) -> io::Result<bool> {
    validate_windows_component(destination)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "unsafe Windows file name"))?;
    let wide = destination.encode_wide().collect::<Vec<_>>();
    let name_bytes = wide.len().checked_mul(size_of::<u16>()).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
    })?;
    let information_length = offset_of!(FILE_LINK_INFORMATION, FileName)
        .checked_add(name_bytes)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
        })?;
    let (mut buffer, information_length) = aligned_information_buffer(information_length)?;
    let information = buffer.as_mut_ptr().cast::<FILE_LINK_INFORMATION>();
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: buffer is usize-aligned and large enough for the fixed header and
    // exact UTF-16 name. Both source and parent handles remain live in the call.
    let status = unsafe {
        (*information).Anonymous.ReplaceIfExists = false;
        (*information).RootDirectory = parent.as_raw_handle().cast();
        (*information).FileNameLength = u32::try_from(name_bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Windows file name is too long")
        })?;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            (*information).FileName.as_mut_ptr(),
            wide.len(),
        );
        NtSetInformationFile(
            source.as_raw_handle().cast(),
            &mut status_block,
            information.cast(),
            information_length,
            FileLinkInformation,
        )
    };
    if matches!(status, STATUS_OBJECT_NAME_COLLISION | STATUS_DELETE_PENDING) {
        Ok(false)
    } else if status < 0 {
        Err(io::Error::other("handle-relative Windows hard-link failed"))
    } else {
        Ok(true)
    }
}

fn delete_open_handle(raw: RawHandle) -> io::Result<()> {
    let information = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: raw is a live handle opened with DELETE access and information is
    // a valid fixed-size input buffer. Deletion applies to that exact handle.
    if unsafe {
        SetFileInformationByHandle(
            raw.cast(),
            FileDispositionInfo,
            (&raw const information).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn delete_open_directory(directory: Dir) -> io::Result<()> {
    let result = delete_open_handle(directory.as_raw_handle());
    drop(directory);
    result
}

fn flush_directory(
    directory: &Dir,
    error_code: KrxErrorCode,
    message: &'static str,
) -> Result<(), KrxError> {
    // SAFETY: directory owns a live filesystem handle opened for writes where
    // durability is required.
    if unsafe { FlushFileBuffers(directory.as_raw_handle().cast()) } == 0 {
        return Err(state_error(error_code, message));
    }
    Ok(())
}

fn directory_identity(directory: &Dir, error_code: KrxErrorCode) -> Result<FileIdentity, KrxError> {
    handle_identity(directory.as_raw_handle(), error_code)
}

fn file_metadata_identity(file: &File, error_code: KrxErrorCode) -> Result<FileIdentity, KrxError> {
    handle_identity(file.as_raw_handle(), error_code)
}

fn handle_identity(raw: RawHandle, error_code: KrxErrorCode) -> Result<FileIdentity, KrxError> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: raw belongs to a live File or Dir and information is a valid
    // writable output buffer for the duration of the call.
    if unsafe { GetFileInformationByHandle(raw.cast(), &mut information) } == 0 {
        return Err(state_error(
            error_code,
            "local state handle identity inspection failed",
        ));
    }
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        size: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        modified: (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(information.ftLastWriteTime.dwLowDateTime),
    })
}

fn same_object_identity(left: &FileIdentity, right: &FileIdentity) -> bool {
    left.volume_serial == right.volume_serial && left.file_index == right.file_index
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    const VALID_OWNER: &str = "42-4c691fc0-09c4-4c83-904d-d10b1681ff73";

    #[test]
    fn delete_pending_lock_is_unavailable_until_the_last_handle_closes() {
        let parent_path = std::env::temp_dir().join(format!("krx-pending-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent_path).unwrap();
        let code = KrxErrorCode::InternalFailure;
        let root = open_absolute_root(
            &parent_path.join(".krx-cli"),
            true,
            true,
            ReadSensitivity::NonSecret,
            code,
        )
        .unwrap()
        .unwrap();
        let leaf = OsStr::new("quota.lock");
        let directory = create_child_directory(&root, leaf, ReadSensitivity::NonSecret, code)
            .unwrap()
            .unwrap();
        delete_open_handle(directory.as_raw_handle()).unwrap();
        assert!(
            open_child_directory(&root, leaf, true, ReadSensitivity::NonSecret, code)
                .unwrap()
                .is_none()
        );
        assert!(
            create_child_directory(&root, leaf, ReadSensitivity::NonSecret, code)
                .unwrap()
                .is_none()
        );
        drop(directory);
        let replacement = create_child_directory(&root, leaf, ReadSensitivity::NonSecret, code)
            .unwrap()
            .expect("name reusable after deletion");
        drop(replacement);
        drop(root);
        fs::remove_dir_all(parent_path).unwrap();
    }

    #[test]
    fn legacy_lock_flushes_an_existing_root_and_releases() {
        let parent = std::env::temp_dir().join(format!("krx-legacy-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let state = StateRoot::new(parent.join(".krx-cli")).unwrap();
        let code = KrxErrorCode::InternalFailure;
        state.atomic_write("config.json", b"{}", code).unwrap();
        for _ in 0..2 {
            let lock = state
                .try_acquire_legacy_secret_plain_lock("config.lock", VALID_OWNER.to_owned(), code)
                .unwrap()
                .expect("lock acquired");
            drop(lock);
        }
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn plain_lock_contention_preserves_mutual_exclusion() {
        let parent = std::env::temp_dir().join(format!("krx-lock-contention-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join(".krx-cli");
        let inside = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..8 {
                let path = &path;
                let inside = &inside;
                workers.push(scope.spawn(move || {
                    let state = StateRoot::new(path.clone()).unwrap();
                    for _ in 0..20 {
                        let deadline = std::time::Instant::now() + Duration::from_secs(20);
                        loop {
                            if let Some(lock) = state.try_acquire_plain_lock(
                                "rate-limit/quota.lock",
                                format!("{}-{}", std::process::id(), Uuid::new_v4()),
                                KrxErrorCode::InternalFailure,
                            )? {
                                assert_eq!(
                                    inside.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                                    0
                                );
                                std::thread::yield_now();
                                assert_eq!(
                                    inside.fetch_sub(1, std::sync::atomic::Ordering::SeqCst),
                                    1
                                );
                                drop(lock);
                                break;
                            }
                            assert!(
                                std::time::Instant::now() < deadline,
                                "lock contention timed out"
                            );
                            std::thread::yield_now();
                        }
                    }
                    Ok::<_, KrxError>(())
                }));
            }
            let results = workers
                .into_iter()
                .map(|worker| worker.join())
                .collect::<Vec<_>>();
            for result in results {
                result.unwrap().unwrap();
            }
        });
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn handle_relative_rename_preserves_collision_and_replacement_semantics() {
        let parent_path = std::env::temp_dir().join(format!("krx-rename-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent_path).unwrap();
        let code = KrxErrorCode::CacheWriteFailed;
        let root = open_absolute_root(
            &parent_path.join(".krx-cli"),
            true,
            true,
            ReadSensitivity::NonSecret,
            code,
        )
        .unwrap()
        .unwrap();
        let mut source = create_secure_file(&root, OsStr::new("source"), code).unwrap();
        source.write_all(b"new").unwrap();
        rename_open_handle(&source, &root, OsStr::new("destination"), false).unwrap();
        drop(source);
        let mut replacement = create_secure_file(&root, OsStr::new("replacement"), code).unwrap();
        replacement.write_all(b"replacement").unwrap();
        assert!(rename_open_handle(&replacement, &root, OsStr::new("destination"), false).is_err());
        rename_open_handle(&replacement, &root, OsStr::new("destination"), true).unwrap();
        assert_eq!(
            fs::read(parent_path.join(".krx-cli/destination")).unwrap(),
            b"replacement"
        );
        drop(replacement);
        drop(root);
        fs::remove_dir_all(parent_path).unwrap();
    }

    #[test]
    fn acl_accepts_foreign_readers_but_rejects_foreign_mutation_rights() {
        use windows_sys::Win32::Security::{ACL_REVISION, AddAccessAllowedAce, InitializeAcl};
        use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_EXECUTE;

        let code = KrxErrorCode::CacheWriteFailed;
        let mut owner = well_known_sid(WinBuiltinAdministratorsSid, code).unwrap();
        let mut world = well_known_sid(WinWorldSid, code).unwrap();
        for (rights, writable) in [
            (FILE_GENERIC_READ, false),
            (FILE_GENERIC_EXECUTE, false),
            (FILE_GENERIC_WRITE, true),
            (FILE_WRITE_DATA, true),
            (FILE_APPEND_DATA, true),
            (FILE_WRITE_EA, true),
            (FILE_WRITE_ATTRIBUTES, true),
            (FILE_DELETE_CHILD, true),
            (DELETE, true),
            (WRITE_DAC, true),
            (WRITE_OWNER, true),
        ] {
            let mut storage = [0_usize; 64];
            let dacl = storage.as_mut_ptr().cast();
            // SAFETY: the aligned buffer has room for the ACL and one maximum
            // sized SID; the ACL and SID storage remain live through validation.
            unsafe {
                assert_ne!(
                    InitializeAcl(dacl, std::mem::size_of_val(&storage) as u32, ACL_REVISION),
                    0
                );
                assert_ne!(
                    AddAccessAllowedAce(dacl, ACL_REVISION, rights, world.as_mut_ptr().cast()),
                    0
                );
            }
            assert_eq!(
                validate_acl_access(dacl, owner.as_mut_ptr().cast(), writable_rights(), code)
                    .is_err(),
                writable,
                "unexpected ACL writer classification for {rights:#x}"
            );
            assert_eq!(
                effective_forbidden_rights(dacl, WinWorldSid, writable_rights(), code).unwrap(),
                writable,
                "unexpected effective writer classification for {rights:#x}"
            );
        }
    }

    #[test]
    fn legacy_secret_rejects_foreign_readable_files_and_directories() {
        use windows_sys::Win32::Security::Authorization::SetSecurityInfo;
        use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;

        let code = KrxErrorCode::MigrationFailed;
        for expose_directory in [false, true] {
            let parent = std::env::temp_dir().join(format!("krx-state-{}", Uuid::new_v4()));
            fs::create_dir_all(&parent).unwrap();
            let root_path = parent.join(".krx-cli");
            let state = StateRoot::new(root_path.clone()).unwrap();
            state.atomic_write("config.json", b"secret", code).unwrap();
            assert_eq!(
                state
                    .read("config.json", 64, ReadSensitivity::LegacySecret, code)
                    .unwrap()
                    .unwrap()
                    .bytes(),
                b"secret"
            );
            let exposed = if expose_directory {
                root_path.clone()
            } else {
                root_path.join("config.json")
            };
            let handle = AmbientOpenOptions::new()
                .access_mode(WRITE_DAC | READ_CONTROL)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(exposed)
                .unwrap();
            let mut token = null_mut();
            // SAFETY: token receives an owned handle and all ACL/SID buffers
            // remain live through the security update of this test-owned path.
            unsafe {
                assert_ne!(
                    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                    0
                );
            }
            let _guard = HandleGuard(token);
            let mut owner = token_user_sid(token, code).unwrap();
            let mut world = well_known_sid(WinWorldSid, code).unwrap();
            let mut storage = [0_usize; 64];
            let dacl = storage.as_mut_ptr().cast();
            unsafe {
                assert_ne!(
                    InitializeAcl(dacl, std::mem::size_of_val(&storage) as u32, ACL_REVISION),
                    0
                );
                assert_ne!(
                    AddAccessAllowedAce(
                        dacl,
                        ACL_REVISION,
                        FILE_ALL_ACCESS,
                        owner.as_mut_ptr().cast()
                    ),
                    0
                );
                assert_ne!(
                    AddAccessAllowedAce(
                        dacl,
                        ACL_REVISION,
                        FILE_GENERIC_READ,
                        world.as_mut_ptr().cast()
                    ),
                    0
                );
                assert_eq!(
                    SetSecurityInfo(
                        handle.as_raw_handle().cast(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        dacl,
                        null_mut()
                    ),
                    0
                );
            }
            assert_eq!(
                state
                    .read("config.json", 64, ReadSensitivity::NonSecret, code)
                    .unwrap()
                    .unwrap()
                    .bytes(),
                b"secret"
            );
            assert!(
                state
                    .read("config.json", 64, ReadSensitivity::LegacySecret, code)
                    .is_err()
            );
            assert_eq!(fs::read(root_path.join("config.json")).unwrap(), b"secret");
            drop(handle);
            fs::remove_dir_all(parent).unwrap();
        }
    }

    #[test]
    fn post_commit_sync_failure_reports_committed_replacement() {
        let parent = std::env::temp_dir().join(format!("krx-state-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root_path = parent.join(".krx-cli");
        let state = StateRoot::new(root_path.clone()).unwrap();
        state
            .atomic_write("config.json", b"before", KrxErrorCode::MigrationFailed)
            .unwrap();
        let failure = state
            .atomic_write_with_post_commit_failure(
                "config.json",
                b"after",
                KrxErrorCode::MigrationFailed,
            )
            .unwrap_err();
        assert!(failure.committed());
        assert_eq!(fs::read(root_path.join("config.json")).unwrap(), b"after");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn pre_commit_failure_reports_uncommitted_and_preserves_destination() {
        let parent = std::env::temp_dir().join(format!("krx-state-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root_path = parent.join(".krx-cli");
        let state = StateRoot::new(root_path.clone()).unwrap();
        state
            .atomic_write("config.json", b"before", KrxErrorCode::MigrationFailed)
            .unwrap();
        let failure = state
            .atomic_write_with_pre_commit_failure(
                "config.json",
                b"after",
                KrxErrorCode::MigrationFailed,
            )
            .unwrap_err();
        assert!(!failure.committed());
        assert_eq!(fs::read(root_path.join("config.json")).unwrap(), b"before");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn conditional_file_changes_never_touch_a_replacement() {
        let parent = std::env::temp_dir().join(format!("krx-state-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root_path = parent.join(".krx-cli");
        let state = StateRoot::new(root_path.clone()).unwrap();
        state
            .atomic_write(
                "cache/entry.json",
                b"observed",
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();
        let observed = state
            .read(
                "cache/entry.json",
                64,
                ReadSensitivity::NonSecret,
                KrxErrorCode::CacheReadFailed,
            )
            .unwrap()
            .unwrap();
        state
            .atomic_write(
                "cache/entry.json",
                b"replacement",
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();
        assert!(
            !state
                .remove_if_unchanged(
                    "cache/entry.json",
                    &observed,
                    KrxErrorCode::CacheWriteFailed
                )
                .unwrap()
        );
        assert!(
            !state
                .rename_if_unchanged(
                    "cache/entry.json",
                    &observed,
                    "entry.json.corrupt",
                    KrxErrorCode::CacheWriteFailed
                )
                .unwrap()
        );
        assert_eq!(
            fs::read(root_path.join("cache/entry.json")).unwrap(),
            b"replacement"
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn absolute_roots_require_safe_local_drive_components() {
        assert!(validate_absolute_root(Path::new(r"C:\Users\name\.krx-cli")).is_ok());

        for unsafe_root in [
            r"\\server\share\.krx-cli",
            r"C:\",
            r"C:\Users\.\state",
            r"C:\Users\..\state",
            r"C:\Users\state:stream",
            r"C:\Users\state.",
            r"C:\Users\state ",
            r"C:\Users\CON",
            r"C:\Users\LPT9.txt",
            r"C:\Users\COM¹",
            r"C:\Users\LPT³.txt",
        ] {
            assert!(
                validate_absolute_root(Path::new(unsafe_root)).is_err(),
                "accepted unsafe root {unsafe_root:?}"
            );
        }
    }

    #[test]
    fn relative_paths_reject_escaping_and_windows_aliases() {
        assert!(relative_components(r"rate-limit\quota.json").is_ok());

        for unsafe_relative in [
            r"C:\quota.json",
            r"..\quota.json",
            r"rate-limit\.\quota.json",
            r"rate-limit\..\quota.json",
            r"rate-limit\quota.json:stream",
            r"rate-limit\quota.json.",
            r"rate-limit\AUX.json",
        ] {
            assert!(
                relative_components(unsafe_relative).is_err(),
                "accepted unsafe relative path {unsafe_relative:?}"
            );
        }
    }

    #[test]
    fn owner_grammar_matches_the_frozen_cross_runtime_protocol() {
        assert!(validate_plain_lock_owner(VALID_OWNER).is_ok());

        for invalid_owner in [
            "042-4c691fc0-09c4-4c83-904d-d10b1681ff73",
            "42-4C691FC0-09C4-4C83-904D-D10B1681FF73",
            "42-00000000-0000-0000-0000-000000000000",
            "42-6ba7b810-9dad-11d1-80b4-00c04fd430c8",
            "42-4c691fc009c44c83904dd10b1681ff73",
            "42-{4c691fc0-09c4-4c83-904d-d10b1681ff73}",
            "42-urn:uuid:4c691fc0-09c4-4c83-904d-d10b1681ff73",
        ] {
            assert!(
                validate_plain_lock_owner(invalid_owner).is_err(),
                "accepted invalid owner {invalid_owner:?}"
            );
        }
    }
}
