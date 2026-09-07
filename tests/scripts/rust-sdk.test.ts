import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const workspaceDependencyLines = [
  'cap-std = "=4.0.3"',
  'clap = { version = "=4.6.6", features = ["derive"] }',
  'futures-util = "=0.3.34"',
  'jiff = { version = "=0.2.35", default-features = false, features = ["serde", "std"] }',
  'keyring = "=4.1.6"',
  'napi = { version = "=3.12.2", default-features = false, features = ["async", "napi8", "tokio_rt"] }',
  'napi-build = "=2.4.1"',
  'napi-derive = "=3.6.3"',
  'num-bigint = "=0.5.1"',
  'reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls", "stream"] }',
  'rustix = { version = "=1.1.4", default-features = false, features = ["fs", "process", "std"] }',
  'serde = { version = "=1.0.229", features = ["derive"] }',
  'serde_json = "=1.0.151"',
  'serde-saphyr = { version = "=1.1.0", default-features = false, features = ["deserialize"] }',
  'sha2 = "=0.11.0"',
  'thiserror = "=2.0.20"',
  'tokio = { version = "=1.53.1", features = ["fs", "io-util", "macros", "net", "rt-multi-thread", "signal", "sync", "time"] }',
  'tokio-util = "=0.7.19"',
  'url = "=2.5.8"',
  'uuid = { version = "=1.25.0", features = ["serde", "v4"] }',
  'zeroize = { version = "=1.9.0", features = ["derive"] }',
  'windows-sys = { version = "=0.61.2", features = ["Wdk_Foundation", "Wdk_Storage_FileSystem", "Win32_Foundation", "Win32_Security", "Win32_Security_Authorization", "Win32_Storage_FileSystem", "Win32_System_IO", "Win32_System_SystemServices", "Win32_System_Threading"] }',
] as const;

function assertWorkspaceDependencyPins(source: string): void {
  for (const line of workspaceDependencyLines) {
    if (!source.includes(line)) {
      throw new Error(`workspace dependency contract is missing ${line}`);
    }
  }
}

function assertDomainPolicySources(sources: {
  readonly adjustment: string;
  readonly build: string;
  readonly request: string;
  readonly result: string;
}): void {
  const transitionStart = sources.adjustment.indexOf("fn transition_string(");
  const transitionEnd = sources.adjustment.indexOf(
    "pub(crate) fn adjust_stock_rows(",
    transitionStart,
  );
  const transitionFormatter = sources.adjustment.slice(
    transitionStart,
    transitionEnd,
  );
  const exactTransitionFormat =
    '{{\\"date\\":\\"{}\\",\\"previousClose\\":\\"{}\\",\\"previousDate\\":\\"{}\\",\\"ratio\\":{{\\"denominator\\":\\"{}\\",\\"numerator\\":\\"{}\\"}},\\"referencePrice\\":\\"{}\\"}}';
  const required = [
    [sources.build, 'deserialize_with = "ordered_string_map"'],
    [sources.build, "!retryable_statuses.is_empty()"],
    [sources.request, "pub const MAX_DAYS: usize = 10_000;"],
    [sources.result, "krx-adjustment-transition/v1"],
    [sources.adjustment, "krx-adjustment-transition/v1"],
    [transitionFormatter, exactTransitionFormat],
  ] as const;
  for (const [source, marker] of required) {
    if (!source.includes(marker)) {
      throw new Error(`Rust SDK domain policy is missing ${marker}`);
    }
  }
}

function assertPublicSdkSurfaceSources(sources: {
  readonly cache: string;
  readonly client: string;
  readonly integration: string;
  readonly lib: string;
  readonly result: string;
  readonly state: string;
  readonly stateWindows: string;
  readonly watchlist: string;
}): void {
  const publicClientStart = sources.client.indexOf("impl Client {");
  const publicClientEnd = sources.client.indexOf(
    "#[derive(Clone)]\npub struct CredentialHandle",
    publicClientStart,
  );
  const publicClient = sources.client.slice(publicClientStart, publicClientEnd);
  const rangeStart = sources.client.indexOf(
    "pub(crate) async fn range(",
    publicClientEnd,
  );
  const rangeEnd = sources.client.indexOf(
    "async fn offline_query(",
    rangeStart,
  );
  const range = sources.client.slice(rangeStart, rangeEnd);
  const unixEnumeration = sources.state.slice(
    sources.state.indexOf("fn enumerate_cache_directory("),
    sources.state.indexOf("fn is_cache_lease_directory("),
  );
  const windowsEnumeration = sources.stateWindows.slice(
    sources.stateWindows.indexOf("fn enumerate_cache_directory("),
    sources.stateWindows.indexOf("fn is_cache_lease_directory("),
  );
  const required = [
    [
      sources.integration,
      '#[path = "../../../contracts/product/v1/rust-sdk-consumer.rs"]',
    ],
    [sources.lib, "ClientBuilder, CredentialHandle, WatchlistHandle"],
    [sources.lib, "pub use watchlist::WatchlistEntry;"],
    [sources.result, "pub contract_id: &'static str"],
    [sources.client, "pub struct Client"],
    [sources.client, "pub struct ClientBuilder"],
    [publicClient, "pub async fn query("],
    [publicClient, "pub async fn range("],
    [publicClient, "pub async fn search_stocks("],
    [publicClient, "StockSearchRequest::new(&query, options)?"],
    [publicClient, "pub async fn market_summary("],
    [publicClient, "pub async fn watchlist_prices("],
    [
      publicClient,
      "WatchlistPricesRequest::new(date, security_codes, options)?",
    ],
    [publicClient, "STOCK_SEARCH_COMPONENTS"],
    [publicClient, "MARKET_SUMMARY_COMPONENTS"],
    [publicClient, "WATCHLIST_PRICE_COMPONENTS"],
    [publicClient, '"KONEX" => WatchlistMarket::Konex'],
    [sources.client, "APPROVAL_PROBES"],
    [sources.client, "pub async fn inspect("],
    [sources.client, "pub async fn prune("],
    [sources.client, "pub async fn clear("],
    [sources.client, "pub async fn list("],
    [sources.client, "pub async fn add("],
    [sources.client, "pub async fn remove("],
    [range, ".buffered(RANGE_CONCURRENCY)"],
    [range, "query_until(direct, deadline)"],
    [sources.watchlist, "let _lock = acquire_lock(state)?;"],
    [sources.watchlist, "watchlist contains duplicate ISINs"],
    [sources.cache, "CACHE_INSPECT_DEFAULT_ENTRIES"],
    [sources.cache, "CACHE_PRUNE_SCAN_MAXIMUM_FILES"],
    [sources.cache, "maximum > CACHE_PRUNE_DELETE_BATCH_MAXIMUM as usize"],
    [sources.cache, "is_v2_cache_path(&entries[*right].relative)"],
    [
      sources.cache,
      "is_stale_cache_temporary(&path.relative, observed.modified(), now)",
    ],
    [unixEnumeration, "Dir::read_from(directory)"],
    [windowsEnumeration, ".entries()"],
  ] as const;
  if (
    publicClientStart < 0 ||
    publicClientEnd < 0 ||
    rangeStart < 0 ||
    rangeEnd < 0 ||
    required.some(([source, marker]) => !source.includes(marker)) ||
    publicClient.includes(".query(direct)") ||
    range.includes("self.query(direct)")
  ) {
    throw new Error(
      "Rust public SDK surface, shared orchestration, or state handles are incomplete",
    );
  }
}

function assertQuotaStateProtocolSource(source: string): void {
  const atomicStart = source.indexOf("fn atomic_write_observed_inner(");
  const atomicEnd = source.indexOf(
    "pub(crate) fn try_acquire_plain_lock(",
    atomicStart,
  );
  const atomicWrite = source.slice(atomicStart, atomicEnd);
  const atomicRename = atomicWrite.indexOf("rustix::fs::renameat(");
  const commitMarker = atomicWrite.indexOf("committed = true;");
  const directorySync = atomicWrite.indexOf("rustix::fs::fsync(&parent)");
  const ownerStart = source.indexOf("fn write_lock_owner(");
  const ownerEnd = source.indexOf("fn abandon_new_lock(", ownerStart);
  const ownerPublication = source.slice(ownerStart, ownerEnd);
  const ownerSync = ownerPublication.indexOf("file.sync_all()");
  const ownerLink = ownerPublication.indexOf("rustix::fs::linkat(");
  const publicationStart = source.indexOf("fn publish_steal_claim(");
  const publicationEnd = source.indexOf(
    "fn read_steal_claim(",
    publicationStart,
  );
  const publication = source.slice(publicationStart, publicationEnd);
  const mismatchStart = publication.indexOf("if claim.owner != claimant");
  const mismatchEnd = publication.indexOf("Ok(Some(claim))", mismatchStart);
  const mismatch = publication.slice(mismatchStart, mismatchEnd);
  const ownerGrammarStart = source.indexOf("fn validate_plain_lock_owner(");
  const ownerGrammarEnd = source.indexOf(
    "fn write_lock_owner(",
    ownerGrammarStart,
  );
  const ownerGrammar = source.slice(ownerGrammarStart, ownerGrammarEnd);
  if (
    atomicStart < 0 ||
    atomicEnd < 0 ||
    atomicRename < 0 ||
    commitMarker <= atomicRename ||
    directorySync <= commitMarker ||
    !atomicWrite.includes("let mut committed = false;") ||
    !atomicWrite.includes("result.map_err(|error| (error, committed))") ||
    ownerStart < 0 ||
    ownerEnd < 0 ||
    ownerSync < 0 ||
    ownerLink <= ownerSync ||
    !ownerPublication.includes(
      'let candidate = OsString::from(format!(".owner.{owner}.tmp"));',
    ) ||
    !ownerPublication.includes(
      '&candidate,\n            lock_directory,\n            "owner",',
    ) ||
    publicationStart < 0 ||
    publicationEnd < 0 ||
    mismatchStart < 0 ||
    mismatchEnd < 0 ||
    ownerGrammarStart < 0 ||
    ownerGrammarEnd < 0 ||
    !ownerGrammar.includes("nonce.len() == 36") ||
    !ownerGrammar.includes("matches!(index, 8 | 13 | 18 | 23)") ||
    !publication.includes("let mut published = None;") ||
    !publication.includes("let Some(claim) = &published") ||
    !publication.includes("release_steal_claim(lock_directory, claim);") ||
    mismatch.includes("release_steal_claim")
  ) {
    throw new Error(
      "Rust quota owner/claim publication protocol is incomplete",
    );
  }
}

function assertWindowsStateProtocolSource(source: string): void {
  const atomicStart = source.indexOf("pub(crate) fn atomic_write(");
  const atomicEnd = source.indexOf(
    "pub(crate) fn try_acquire_plain_lock(",
    atomicStart,
  );
  const atomicWrite = source.slice(atomicStart, atomicEnd);
  const fileSync = atomicWrite.indexOf("file.sync_all()");
  const atomicRename = atomicWrite.indexOf("rename_open_handle(", fileSync);
  const renameCommitted = atomicWrite.indexOf("renamed = true;", atomicRename);
  const parentFlush = atomicWrite.indexOf("flush_directory(", renameCommitted);
  const conditionalStart = source.indexOf("fn change_observed_file(");
  const conditionalEnd = source.indexOf(
    "pub(crate) fn atomic_write_observed(",
    conditionalStart,
  );
  const conditionalMutation = source.slice(conditionalStart, conditionalEnd);
  const rootStart = source.indexOf("fn open_absolute_root(");
  const rootEnd = source.indexOf("fn open_relative_directories(", rootStart);
  const rootTraversal = source.slice(rootStart, rootEnd);
  const createStart = source.indexOf("fn create_child_directory(");
  const directoryStart = source.indexOf("fn open_child_directory(");
  const directoryCreate = source.slice(createStart, directoryStart);
  const directoryEnd = source.indexOf(
    "fn validate_directory_security(",
    directoryStart,
  );
  const directoryOpen = source.slice(directoryStart, directoryEnd);
  const fileStart = source.indexOf("fn open_secure_file(");
  const fileEnd = source.indexOf("fn read_file(", fileStart);
  const fileOpen = source.slice(fileStart, fileEnd);
  const readStart = source.indexOf("fn read_file(");
  const readEnd = source.indexOf("fn publish_protocol_file(", readStart);
  const boundedRead = source.slice(readStart, readEnd);
  const publicationStart = source.indexOf("fn publish_protocol_file(");
  const publicationEnd = source.indexOf(
    "fn read_protocol_file(",
    publicationStart,
  );
  const publication = source.slice(publicationStart, publicationEnd);
  const candidateSync = publication.indexOf("file.sync_all()");
  const publicationLink = publication.indexOf(
    "link_open_handle(&file, directory, OsStr::new(destination))",
  );
  const cleanupFlush = publication.indexOf("let candidate_sync =");
  const cleanupDecision = publication.indexOf("if candidate_sync.is_err()");
  const resultPropagation = publication.lastIndexOf("\n    result\n");
  const rollbackCalls =
    publication.match(/release_protocol_file\(/gu)?.length ?? 0;
  const guardedRollbackCalls =
    publication.match(/!release_protocol_file\(/gu)?.length ?? 0;
  const protocolOpenStart = source.indexOf("fn open_protocol_file(");
  const protocolOpenEnd = source.indexOf(
    "fn release_protocol_file(",
    protocolOpenStart,
  );
  const protocolOpen = source.slice(protocolOpenStart, protocolOpenEnd);
  const releaseStart = protocolOpenEnd;
  const releaseEnd = source.indexOf("fn abandon_new_lock(", releaseStart);
  const release = source.slice(releaseStart, releaseEnd);
  const abandonEnd = source.indexOf(
    "fn validate_existing_lock_directory(",
    releaseEnd,
  );
  const abandon = source.slice(releaseEnd, abandonEnd);
  const tombstoneStart = source.indexOf("fn move_plain_lock_to_tombstone(");
  const tombstoneEnd = source.indexOf(
    "fn validate_retained_plain_lock(",
    tombstoneStart,
  );
  const tombstone = source.slice(tombstoneStart, tombstoneEnd);
  const securityStart = source.indexOf("fn validate_handle_security(");
  const aclStart = source.indexOf("fn validate_acl_access(", securityStart);
  const securityEnd = aclStart;
  const security = source.slice(securityStart, securityEnd);
  const aclEnd = source.indexOf("fn token_user_sid(", aclStart);
  const acl = source.slice(aclStart, aclEnd);
  const rightsStart = source.indexOf("fn effective_forbidden_rights(");
  const rightsEnd = source.indexOf("fn well_known_sid(", rightsStart);
  const rights = source.slice(rightsStart, rightsEnd);
  const writableStart = source.indexOf("fn writable_rights()");
  const writableEnd = source.indexOf(
    "fn aligned_information_buffer(",
    writableStart,
  );
  const writable = source.slice(writableStart, writableEnd);
  const renameStart = source.indexOf("fn rename_open_handle(");
  const renameEnd = source.indexOf("fn link_open_handle(", renameStart);
  const rename = source.slice(renameStart, renameEnd);
  const linkStart = renameEnd;
  const linkEnd = source.indexOf("fn delete_open_handle(", linkStart);
  const link = source.slice(linkStart, linkEnd);
  const deleteStart = linkEnd;
  const deleteEnd = source.indexOf("fn flush_directory(", deleteStart);
  const deletion = source.slice(deleteStart, deleteEnd);
  const flushStart = deleteEnd;
  const flushEnd = source.indexOf("fn directory_identity(", flushStart);
  const flush = source.slice(flushStart, flushEnd);
  const identityStart = source.indexOf("fn handle_identity(");
  const identityEnd = source.indexOf("#[cfg(test)]", identityStart);
  const identity = source.slice(identityStart, identityEnd);
  const ownerGrammarStart = source.indexOf("fn validate_plain_lock_owner(");
  const ownerGrammarEnd = source.indexOf(
    "fn open_absolute_root(",
    ownerGrammarStart,
  );
  const ownerGrammar = source.slice(ownerGrammarStart, ownerGrammarEnd);
  const forbiddenPathMutations = [
    ".create_dir(",
    ".rename(",
    ".hard_link(",
    ".remove_file(",
    ".remove_open_dir(",
    "std::fs::rename(",
    "std::fs::remove_dir(",
  ];

  if (
    atomicStart < 0 ||
    atomicEnd < 0 ||
    fileSync < 0 ||
    atomicRename <= fileSync ||
    renameCommitted <= atomicRename ||
    parentFlush <= renameCommitted ||
    conditionalStart < 0 ||
    conditionalEnd < 0 ||
    (conditionalMutation.match(/false,\n {12}true,/gu)?.length ?? 0) !== 2 ||
    !conditionalMutation.includes("flush_directory(&parent") ||
    !atomicWrite.includes("if result.is_err() && !renamed") ||
    !atomicWrite.includes("let mut renamed = false;") ||
    !atomicWrite.includes("delete_open_handle(file.as_raw_handle())") ||
    !atomicWrite.includes("result.map_err(|error| (error, renamed))") ||
    rootStart < 0 ||
    rootEnd < 0 ||
    !rootTraversal.includes("Dir::from_std_file(ambient)") ||
    !rootTraversal.includes("FILE_FLAG_OPEN_REPARSE_POINT") ||
    !rootTraversal.includes("let opened = if is_root") ||
    !rootTraversal.includes("open_traversal_directory(") ||
    createStart < 0 ||
    !directoryCreate.includes("NtCreateFile(") ||
    !directoryCreate.includes("RootDirectory: parent.as_raw_handle().cast()") ||
    !directoryCreate.includes("FILE_DIRECTORY_FILE") ||
    directoryStart < 0 ||
    directoryEnd < 0 ||
    !directoryOpen.includes("parent.open_with(leaf, &options)") ||
    !directoryOpen.includes("FILE_FLAG_OPEN_REPARSE_POINT") ||
    !directoryOpen.includes("validate_directory_security(&directory") ||
    fileStart < 0 ||
    fileEnd < 0 ||
    !fileOpen.includes("parent.open_with(leaf, &options)") ||
    !fileOpen.includes("FILE_FLAG_OPEN_REPARSE_POINT") ||
    !fileOpen.includes(
      "validate_handle_security(file.as_raw_handle(), ReadSensitivity::NonSecret, error_code)",
    ) ||
    readStart < 0 ||
    readEnd < 0 ||
    boundedRead.indexOf("let before = file_metadata_identity") < 0 ||
    boundedRead.indexOf("if before.size > maximum_bytes") < 0 ||
    boundedRead.indexOf(".read_to_end(&mut bytes)") < 0 ||
    boundedRead.indexOf("let after = file_metadata_identity") < 0 ||
    boundedRead.indexOf("if before != after") < 0 ||
    boundedRead.indexOf("if before.size > maximum_bytes") <=
      boundedRead.indexOf("let before = file_metadata_identity") ||
    boundedRead.indexOf(".read_to_end(&mut bytes)") <=
      boundedRead.indexOf("if before.size > maximum_bytes") ||
    boundedRead.indexOf("let after = file_metadata_identity") <=
      boundedRead.indexOf(".read_to_end(&mut bytes)") ||
    boundedRead.indexOf("if before != after") <=
      boundedRead.indexOf("let after = file_metadata_identity") ||
    publicationStart < 0 ||
    publicationEnd < 0 ||
    candidateSync < 0 ||
    publicationLink <= candidateSync ||
    !publication.includes("let mut published = None;") ||
    !publication.includes("release_protocol_file(") ||
    !publication.includes("let mut cleanup_failed = false;") ||
    !publication.includes(
      "if result.is_err()\n        && let Some(observation) = &published\n    {",
    ) ||
    !publication.includes("if cleanup_failed {") ||
    !publication.includes("if !release_protocol_file(") ||
    !publication.includes(
      "if candidate_sync.is_err() {\n        cleanup_failed = true;",
    ) ||
    cleanupFlush < 0 ||
    cleanupDecision <= cleanupFlush ||
    resultPropagation <= cleanupDecision ||
    publication.slice(0, cleanupFlush).includes("result?") ||
    rollbackCalls === 0 ||
    rollbackCalls !== guardedRollbackCalls ||
    protocolOpenStart < 0 ||
    protocolOpenEnd < 0 ||
    !protocolOpen.includes("let identity = file_metadata_identity") ||
    !protocolOpen.includes("let after = file_metadata_identity") ||
    !protocolOpen.includes("if identity != after") ||
    releaseStart < 0 ||
    releaseEnd < 0 ||
    !release.includes(
      "open_protocol_file(directory, leaf, true, error_code, label)",
    ) ||
    !release.includes("delete_open_handle(file.as_raw_handle())") ||
    !release.includes("local protocol removal sync failed") ||
    !release.includes(".is_ok()") ||
    !abandon.includes("delete_open_directory(directory).is_ok()") ||
    !abandon.includes("local lock parent sync failed") ||
    tombstoneStart < 0 ||
    tombstoneEnd < 0 ||
    !tombstone.includes("rename_open_handle(&observed.directory") ||
    securityStart < 0 ||
    securityEnd < 0 ||
    !security.includes("GetSecurityInfo(") ||
    !security.includes("EqualSid(owner, user_sid.as_mut_ptr().cast())") ||
    !security.includes(
      "if unsafe { EqualSid(owner, user_sid.as_mut_ptr().cast()) } == 0",
    ) ||
    !security.includes("validate_acl_access(") ||
    !security.includes(
      "for sid_type in [WinWorldSid, WinAuthenticatedUserSid]",
    ) ||
    !security.includes(
      "effective_forbidden_rights(dacl, sid_type, forbidden, error_code)",
    ) ||
    aclStart < 0 ||
    aclEnd < 0 ||
    !acl.includes("GetAclInformation(") ||
    !acl.includes("GetAce(") ||
    !acl.includes("WinLocalSystemSid") ||
    !acl.includes("WinBuiltinAdministratorsSid") ||
    !acl.includes("for index in 0..information.AceCount") ||
    !acl.includes(
      ") || unsafe { (*allowed).Mask } & forbidden == 0\n        {\n            continue;\n        }",
    ) ||
    !acl.includes("if u32::from(ace_type) != ACCESS_ALLOWED_ACE_TYPE") ||
    !acl.includes("EqualSid(sid, owner) != 0") ||
    !acl.includes("EqualSid(sid, system_sid.as_mut_ptr().cast()) != 0") ||
    !acl.includes(
      "EqualSid(sid, administrators_sid.as_mut_ptr().cast()) != 0",
    ) ||
    !acl.includes(
      'if !approved {\n            return Err(state_error(\n                error_code,\n                "local state ACL permits forbidden foreign access",\n            ));\n        }',
    ) ||
    !acl.includes("local state ACL permits forbidden foreign access") ||
    rightsStart < 0 ||
    rightsEnd < 0 ||
    !rights.includes(
      'if unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) } != 0 {\n        return Err(state_error(error_code, "local state ACL inspection failed"));\n    }',
    ) ||
    !rights.includes("Ok(rights & forbidden != 0)") ||
    writableStart < 0 ||
    writableEnd < 0 ||
    !writable.includes("GENERIC_ALL") ||
    !writable.includes("GENERIC_WRITE") ||
    !writable.includes("FILE_WRITE_DATA") ||
    !writable.includes("FILE_APPEND_DATA") ||
    !writable.includes("FILE_WRITE_EA") ||
    !writable.includes("FILE_WRITE_ATTRIBUTES") ||
    !writable.includes("FILE_DELETE_CHILD") ||
    !writable.includes("DELETE") ||
    !writable.includes("WRITE_DAC") ||
    !writable.includes("WRITE_OWNER") ||
    !writable.includes(
      "GENERIC_ALL\n        | GENERIC_WRITE\n        | FILE_WRITE_DATA\n        | FILE_APPEND_DATA\n        | FILE_WRITE_EA\n        | FILE_WRITE_ATTRIBUTES\n        | FILE_DELETE_CHILD\n        | DELETE\n        | WRITE_DAC\n        | WRITE_OWNER",
    ) ||
    renameStart < 0 ||
    renameEnd < 0 ||
    !rename.includes("SetFileInformationByHandle(") ||
    !rename.includes("FileRenameInfo") ||
    linkStart < 0 ||
    linkEnd < 0 ||
    !link.includes("NtSetInformationFile(") ||
    !link.includes("FileLinkInformation") ||
    !link.includes("(*information).Anonymous.ReplaceIfExists = false") ||
    deleteStart < 0 ||
    deleteEnd < 0 ||
    !deletion.includes("FileDispositionInfo") ||
    !deletion.includes("DeleteFile: true") ||
    !deletion.includes("fn delete_open_directory(directory: Dir)") ||
    flushStart < 0 ||
    flushEnd < 0 ||
    !flush.includes("FlushFileBuffers(directory.as_raw_handle().cast())") ||
    !flush.includes("== 0") ||
    !source.includes("delete_open_directory(directory).is_ok()") ||
    ownerGrammarStart < 0 ||
    ownerGrammarEnd < 0 ||
    !ownerGrammar.includes("uuid.len() == 36") ||
    !ownerGrammar.includes("matches!(index, 8 | 13 | 18 | 23)") ||
    !source.includes("matches!(*suffix, 0x00b9 | 0x00b2 | 0x00b3)") ||
    identityStart < 0 ||
    identityEnd < 0 ||
    !identity.includes("GetFileInformationByHandle(") ||
    !identity.includes(
      "left.volume_serial == right.volume_serial && left.file_index == right.file_index",
    ) ||
    forbiddenPathMutations.some((mutation) => source.includes(mutation))
  ) {
    throw new Error(
      "Windows quota state must preserve handle-relative no-follow security and atomic publication",
    );
  }
}

function assertWindowsCacheLeaseProtocolSource(source: string): void {
  const acquisitionStart = source.indexOf(
    "pub(crate) fn try_acquire_cache_lease(",
  );
  const observationStart = source.indexOf(
    "pub(crate) fn observe_cache_lease(",
    acquisitionStart,
  );
  const stealStart = source.indexOf(
    "pub(crate) fn steal_cache_lease_if_unchanged(",
    observationStart,
  );
  const stealEnd = source.indexOf(
    "pub(crate) fn try_acquire_plain_lock(",
    stealStart,
  );
  const acquisition = source.slice(acquisitionStart, observationStart);
  const observation = source.slice(observationStart, stealStart);
  const steal = source.slice(stealStart, stealEnd);
  const ownerStart = source.indexOf("fn open_cache_owner(");
  const ownerEnd = source.indexOf("fn cache_lease_owner_matches(", ownerStart);
  const boundedOwner = source.slice(ownerStart, ownerEnd);
  const releaseStart = source.indexOf("impl Drop for CacheDirectoryLease {");
  const releaseEnd = source.indexOf("fn state_error(", releaseStart);
  const release = source.slice(releaseStart, releaseEnd);
  const livenessStart = source.indexOf("pub(crate) fn process_is_alive(");
  const livenessEnd = source.indexOf(
    "fn move_plain_lock_to_tombstone(",
    livenessStart,
  );
  const liveness = source.slice(livenessStart, livenessEnd);
  const stealRevalidations =
    steal.match(/cache_lease_owner_matches\(/gu)?.length ?? 0;

  if (
    acquisitionStart < 0 ||
    observationStart < 0 ||
    stealStart < 0 ||
    stealEnd < 0 ||
    !source.includes("struct CacheDirectoryLease") ||
    !source.includes("struct ObservedCacheDirectoryLease") ||
    !source.includes("const CACHE_LEASE_OWNER_MAXIMUM_BYTES: u64 = 1024;") ||
    !acquisition.includes("create_child_directory(") ||
    !acquisition.includes("publish_cache_owner(") ||
    !acquisition.includes("path_matches_directory(") ||
    !observation.includes("open_child_directory(") ||
    !observation.includes("read_cache_owner(") ||
    !observation.includes("same_object_identity(") ||
    ownerStart < 0 ||
    ownerEnd < 0 ||
    boundedOwner.indexOf("if identity.size > maximum_bytes") < 0 ||
    boundedOwner.indexOf("complete: false") < 0 ||
    boundedOwner.indexOf(".read_to_end(&mut bytes)") < 0 ||
    boundedOwner.indexOf("let after = file_metadata_identity") < 0 ||
    boundedOwner.indexOf("if identity != after") < 0 ||
    boundedOwner.indexOf("complete: false") <=
      boundedOwner.indexOf("if identity.size > maximum_bytes") ||
    boundedOwner.indexOf(".read_to_end(&mut bytes)") <=
      boundedOwner.indexOf("complete: false") ||
    !steal.includes("rename_open_handle(&directory, &parent") ||
    stealRevalidations < 2 ||
    !steal.includes("delete_open_handle(file.as_raw_handle())") ||
    !steal.includes("delete_open_directory(directory)") ||
    releaseStart < 0 ||
    releaseEnd < 0 ||
    !release.includes("same_object_identity(") ||
    !release.includes("same_cache_owner(") ||
    !release.includes("delete_open_handle(owner_file.as_raw_handle())") ||
    !release.includes("delete_open_directory(directory)") ||
    livenessStart < 0 ||
    livenessEnd < 0 ||
    !liveness.includes("OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION") ||
    !liveness.includes("GetLastError() == ERROR_ACCESS_DENIED")
  ) {
    throw new Error(
      "Windows cache leases must preserve bounded exact-handle acquisition, recovery, and release",
    );
  }
}

function assertCacheCoordinationProtocolSources(sources: {
  readonly cache: string;
  readonly client: string;
  readonly state: string;
}): void {
  const acquisitionStart = sources.state.indexOf(
    "pub(crate) fn try_acquire_cache_lease(",
  );
  const observationStart = sources.state.indexOf(
    "pub(crate) fn observe_cache_lease(",
    acquisitionStart,
  );
  const acquisition = sources.state.slice(acquisitionStart, observationStart);
  const stealStart = sources.state.indexOf(
    "pub(crate) fn steal_cache_lease_if_unchanged(",
    observationStart,
  );
  const stealEnd = sources.state.indexOf(
    "pub(crate) fn try_acquire_legacy_secret_plain_lock(",
    stealStart,
  );
  const steal = sources.state.slice(stealStart, stealEnd);
  const required = [
    [sources.cache, "struct CacheFlightKey"],
    [sources.cache, "state_root: self.state.flight_namespace().to_path_buf()"],
    [sources.cache, "network_result: Mutex<Option<QueryResult>>"],
    [sources.cache, "pub(crate) fn shared_network_result(&self)"],
    [
      sources.cache,
      "canonical_cache_timestamp(self.result.provenance.fetched_at)",
    ],
    [sources.client, "if let Some(result) = flight.shared_network_result()"],
    [sources.client, "flight.publish_network_result(result.clone())"],
    [sources.client, "!hit.same_refresh_generation(baseline)"],
    [acquisition, "if read_steal_claim(&directory, error_code)?.is_some()"],
    [steal, "plain_lock_owner_is_alive(Some(&existing.owner))"],
    [steal, "release_steal_claim(&observed.directory, &existing)"],
    [steal, "publish_steal_claim(&observed.directory, &claimant, error_code)"],
    [steal, "current.owner == claim.owner"],
    [steal, "same_object_identity(&current.identity, &claim.identity)"],
  ] as const;
  if (
    acquisitionStart < 0 ||
    observationStart < 0 ||
    stealStart < 0 ||
    stealEnd < 0 ||
    required.some(([source, marker]) => !source.includes(marker))
  ) {
    throw new Error(
      "Rust cache coordination must preserve scoped result sharing, refresh generations, and claimant-fenced leases",
    );
  }
}

function assertCredentialApprovalProtocolSources(sources: {
  readonly approval: string;
  readonly build: string;
  readonly credential: string;
}): void {
  const migrationStart = sources.credential.indexOf(
    "fn migrate_legacy_blocking(",
  );
  const migrationEnd = sources.credential.indexOf(
    "fn verify_backend(",
    migrationStart,
  );
  const migration = sources.credential.slice(migrationStart, migrationEnd);
  const setStart = sources.credential.indexOf("fn set_blocking(");
  const setEnd = sources.credential.indexOf(
    "fn migrate_legacy_blocking(",
    setStart,
  );
  const setMutation = sources.credential.slice(setStart, setEnd);
  const setLock = setMutation.indexOf(
    "let _lock = acquire_config_lock(state)?;",
  );
  const clearApprovals = setMutation.indexOf(
    "clear_for_rotation_locked(state)?;",
    setLock,
  );
  const setCredential = setMutation.indexOf(
    "let write_error = backend.set(secret).err();",
    clearApprovals,
  );
  const verifyCredential = setMutation.indexOf(
    "verify_backend(backend, secret)",
    setCredential,
  );
  const publicRemoveStart = sources.credential.indexOf(
    "pub(crate) async fn remove(&self)",
  );
  const publicRemoveEnd = sources.credential.indexOf(
    "pub(crate) async fn migrate_legacy(&self)",
    publicRemoveStart,
  );
  const publicRemove = sources.credential.slice(
    publicRemoveStart,
    publicRemoveEnd,
  );
  const validateSource = migration.indexOf("migrate_approval_root(");
  const validateLegacySecret = migration.indexOf(
    "validate_persisted_api_key(&secret)",
  );
  const migrationLock = migration.indexOf(
    "acquire_legacy_migration_lock(state)?",
  );
  const inspectKeychain = migration.indexOf("let existing = backend.get()?");
  const verifyKeychain = migration.indexOf("verify_backend(backend, &secret)");
  const writeConfig = migration.indexOf("write(state, &root)", verifyKeychain);
  const commitAwareRollback = migration.indexOf(
    "if created && !committed && !rollback_created_backend(backend, &secret)",
    writeConfig,
  );
  const recordStart = sources.approval.indexOf("fn record_blocking(");
  const recordEnd = sources.approval.indexOf(
    "pub(crate) fn clear_for_rotation_blocking(",
    recordStart,
  );
  const record = sources.approval.slice(recordStart, recordEnd);
  const lock = record.indexOf("let _lock = acquire_config_lock(state)?;");
  const reread = record.indexOf("read_config_for_write(", lock);
  const legacyStart = sources.approval.indexOf("fn is_legacy_observation(");
  const legacyEnd = sources.approval.indexOf(
    "fn validate_observation(",
    legacyStart,
  );
  const legacyClassifier = sources.approval.slice(legacyStart, legacyEnd);
  const configLockStart = sources.approval.indexOf(
    "fn acquire_config_lock_with_error(",
  );
  const configLockEnd = sources.approval.indexOf(
    "fn canonical_timestamp(",
    configLockStart,
  );
  const configLock = sources.approval.slice(configLockStart, configLockEnd);
  const required = [
    [sources.build, 'join("contracts/product/v1/migrations.yaml")'],
    [sources.build, "pub(crate) const KEYRING_SERVICE"],
    [sources.build, "pub(crate) const APPROVAL_TTL_SECONDS"],
    [
      sources.credential,
      "keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)",
    ],
    [sources.credential, "tokio::task::spawn_blocking"],
    [sources.credential, "rollback_created_backend(backend, &secret)"],
    [sources.credential, "match backend.get()"],
    [sources.approval, "if persisted.credential_id != fingerprint"],
    [sources.approval, "ReadSensitivity::LegacySecret"],
    [sources.approval, "try_acquire_legacy_secret_plain_lock"],
    [sources.approval, 'message.replace(exact_secret, "[REDACTED]")'],
    [
      sources.approval,
      "checked_at.checked_add(Duration::from_secs(APPROVAL_TTL_SECONDS))",
    ],
  ] as const;
  if (
    required.some(([source, marker]) => !source.includes(marker)) ||
    migrationStart < 0 ||
    migrationEnd < 0 ||
    validateSource < 0 ||
    validateLegacySecret < 0 ||
    migrationLock < 0 ||
    validateSource <= migrationLock ||
    validateLegacySecret <= migrationLock ||
    inspectKeychain <= validateLegacySecret ||
    inspectKeychain <= validateSource ||
    verifyKeychain <= inspectKeychain ||
    writeConfig <= verifyKeychain ||
    commitAwareRollback <= writeConfig ||
    setStart < 0 ||
    setEnd < 0 ||
    publicRemoveStart < 0 ||
    publicRemoveEnd < 0 ||
    setLock < 0 ||
    clearApprovals <= setLock ||
    setCredential <= clearApprovals ||
    verifyCredential <= setCredential ||
    setMutation.includes("restore_backend") ||
    !publicRemove.includes("spawn_blocking(move || backend.remove())") ||
    publicRemove.includes("StateRoot") ||
    publicRemove.includes("acquire_config_lock") ||
    recordStart < 0 ||
    recordEnd < 0 ||
    lock < 0 ||
    reread <= lock ||
    legacyStart < 0 ||
    legacyEnd < 0 ||
    configLockStart < 0 ||
    configLockEnd < 0 ||
    !configLock.includes(
      'error_code,\n                "timed out waiting for the configuration lock"',
    ) ||
    !["state", "validUntil", "credentialId", "failureType", "error"].every(
      (field) => legacyClassifier.includes(`"${field}"`),
    )
  ) {
    throw new Error(
      "Rust credential and approval protocol is incomplete or reordered",
    );
  }
}

describe("production Rust SDK gate", () => {
  it("owns a pinned workspace while keeping adapter dependencies out of the SDK", () => {
    const workspace = read("Cargo.toml");
    const sdk = read("crates/krx-sdk/Cargo.toml");
    const lock = read("Cargo.lock");

    expect(workspace).toContain(
      'members = ["crates/krx-sdk", "crates/krx-cli", "crates/krx-node"]',
    );
    expect(workspace).toContain('rust-version = "1.92"');
    expect(sdk).not.toMatch(/probes|clap|napi/u);
    assertWorkspaceDependencyPins(workspace);
    for (const [name, version] of [
      ["cap-std", "4.0.3"],
      ["serde", "1.0.229"],
      ["serde_json", "1.0.151"],
      ["serde-saphyr", "1.1.0"],
      ["jiff", "0.2.35"],
      ["keyring", "4.1.6"],
      ["num-bigint", "0.5.1"],
      ["rustix", "1.1.4"],
      ["tokio-util", "0.7.19"],
      ["zeroize", "1.9.0"],
      ["windows-sys", "0.61.2"],
    ]) {
      expect(lock).toMatch(
        new RegExp(
          `name = "${name}"\\nversion = "${version.replaceAll(".", "\\.")}"`,
          "u",
        ),
      );
    }

    expect(() =>
      assertWorkspaceDependencyPins(
        workspace.replace('sha2 = "=0.11.0"', 'sha2 = "0.11"'),
      ),
    ).toThrow(/workspace dependency contract is missing sha2/u);
    expect(sdk).toContain(
      "[target.'cfg(unix)'.dependencies]\nrustix.workspace = true",
    );
    expect(sdk).toContain("keyring.workspace = true");
    for (const forbidden of ["db-keystore", "turso", "libsql"]) {
      expect(lock).not.toMatch(new RegExp(`name = "${forbidden}"`, "u"));
    }
    expect(sdk).toContain(
      "[target.'cfg(windows)'.dependencies]\ncap-std.workspace = true\nwindows-sys.workspace = true",
    );
  });

  it("freezes credential, keychain, approval, and migration ordering", () => {
    const sources = {
      approval: read("crates/krx-sdk/src/approval.rs"),
      build: read("crates/krx-sdk/build.rs"),
      credential: read("crates/krx-sdk/src/credential.rs"),
    };
    expect(() =>
      assertCredentialApprovalProtocolSources(sources),
    ).not.toThrow();
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        credential: sources.credential.replace(
          "let existing = backend.get()?",
          "let existing = None",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        credential: sources.credential.replace(
          "spawn_blocking(move || backend.remove())",
          "spawn_blocking(move || remove_blocking(backend.as_ref(), &state))",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        credential: sources.credential.replace(
          "let write_error = backend.set(secret).err();",
          "let write_error = None;",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        credential: sources.credential.replace(
          "clear_for_rotation_locked(state)?;",
          "let _ = state;",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        approval: sources.approval.replace(
          "if persisted.credential_id != fingerprint",
          "if false",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        approval: sources.approval.replace(
          'message.replace(exact_secret, "[REDACTED]")',
          "message.to_owned()",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        credential: sources.credential.replace(
          "if created && !committed && !rollback_created_backend(backend, &secret)",
          "if created && !rollback_created_backend(backend, &secret)",
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        approval: sources.approval.replace(
          '        "credentialId",\n        "failureType",',
          '        "other",\n        "failureType",',
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
    expect(() =>
      assertCredentialApprovalProtocolSources({
        ...sources,
        approval: sources.approval.replace(
          'error_code,\n                "timed out waiting for the configuration lock"',
          'KrxErrorCode::MigrationFailed,\n                "timed out waiting for the configuration lock"',
        ),
      }),
    ).toThrow(/credential and approval protocol/u);
  });

  it("derives production wire tables into Cargo output from canonical artifacts", () => {
    const build = read("crates/krx-sdk/build.rs");
    const source = read("crates/krx-sdk/src/operation.rs");

    expect(build).toContain('join("contracts/krx/openapi.yaml")');
    expect(build).toContain('join("contracts/generated/product-v1.json")');
    expect(build).toContain('env::var_os("OUT_DIR")');
    expect(build).toContain("product.operations.len()");
    expect(source).toContain(
      'concat!(env!("OUT_DIR"), "/operation_contract.rs")',
    );
    expect(source).not.toContain("probes/");
  });

  it("freezes ordered composites, bounded ranges, and transition grammar", () => {
    const sources = {
      adjustment: read("crates/krx-sdk/src/adjustment.rs"),
      build: read("crates/krx-sdk/build.rs"),
      request: read("crates/krx-sdk/src/request.rs"),
      result: read("crates/krx-sdk/src/result.rs"),
    };
    expect(() => assertDomainPolicySources(sources)).not.toThrow();
    expect(() =>
      assertDomainPolicySources({
        ...sources,
        adjustment: sources.adjustment.replace(
          "krx-adjustment-transition/v1",
          "krx-adjustment-transition/v2",
        ),
      }),
    ).toThrow(/domain policy is missing krx-adjustment-transition\/v1/u);
    expect(() =>
      assertDomainPolicySources({
        ...sources,
        adjustment: sources.adjustment.replace(
          '\\"denominator\\":\\"{}\\",\\"numerator\\":\\"{}\\"',
          '\\"numerator\\":\\"{}\\",\\"denominator\\":\\"{}\\"',
        ),
      }),
    ).toThrow(/Rust SDK domain policy is missing/u);
  });

  it("compiles and mutation-gates the complete public SDK façade", () => {
    const sources = {
      cache: read("crates/krx-sdk/src/cache.rs"),
      client: read("crates/krx-sdk/src/client.rs"),
      integration: read("crates/krx-sdk/tests/public_contract.rs"),
      lib: read("crates/krx-sdk/src/lib.rs"),
      result: read("crates/krx-sdk/src/result.rs"),
      state: read("crates/krx-sdk/src/state.rs"),
      stateWindows: read("crates/krx-sdk/src/state_windows.rs"),
      watchlist: read("crates/krx-sdk/src/watchlist.rs"),
    };
    expect(() => assertPublicSdkSurfaceSources(sources)).not.toThrow();
    for (const [index, mutant] of [
      {
        ...sources,
        integration: sources.integration.replace(
          "rust-sdk-consumer.rs",
          "missing-consumer.rs",
        ),
      },
      {
        ...sources,
        result: sources.result.replace("&'static str", "String"),
      },
      {
        ...sources,
        client: sources.client.replace(
          ".buffered(RANGE_CONCURRENCY)",
          ".buffered(1)",
        ),
      },
      {
        ...sources,
        client: sources.client.replace(
          "query_until(direct, deadline)",
          "query(direct)",
        ),
      },
      {
        ...sources,
        client: sources.client.replace(
          '"KONEX" => WatchlistMarket::Konex',
          '"KONEX" => WatchlistMarket::Kosdaq',
        ),
      },
      {
        ...sources,
        watchlist: sources.watchlist.replaceAll(
          "let _lock = acquire_lock(state)?;",
          "let _lock = ();",
        ),
      },
      {
        ...sources,
        cache: sources.cache.replaceAll(
          "CACHE_INSPECT_DEFAULT_ENTRIES",
          "REMOVED_INSPECT_DEFAULT_ENTRIES",
        ),
      },
      {
        ...sources,
        cache: sources.cache.replace("observed.modified()", "path.modified"),
      },
      {
        ...sources,
        cache: sources.cache.replace(
          "maximum > CACHE_PRUNE_DELETE_BATCH_MAXIMUM as usize",
          "false",
        ),
      },
      {
        ...sources,
        cache: sources.cache.replace(
          "is_v2_cache_path(&entries[*right].relative)",
          "false",
        ),
      },
      {
        ...sources,
        state: sources.state.replace(
          "Dir::read_from(directory)",
          "fs::read_dir(directory)",
        ),
      },
      {
        ...sources,
        stateWindows: sources.stateWindows.replace(
          ".entries()",
          ".read_dir(directory)",
        ),
      },
    ].entries()) {
      expect(
        () => assertPublicSdkSurfaceSources(mutant),
        `public SDK mutant ${index}`,
      ).toThrow(/Rust public SDK surface/u);
    }
  });

  it("runs locked strict validation on both Blacksmith Linux architectures", () => {
    const workflow = YAML.parse(
      read(".github/workflows/rust-vertical-slice.yml"),
    );
    const paths = workflow.on.pull_request.paths as string[];
    const job = workflow.jobs.build;

    expect(workflow.on.push).toBeUndefined();
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(paths).toEqual([
      ".gitattributes",
      ".github/workflows/rust-vertical-slice.yml",
      "Cargo.lock",
      "Cargo.toml",
      "contracts/**",
      "crates/krx-cli/**",
      "crates/krx-node/**",
      "crates/krx-sdk/**",
      "deny.toml",
      "package.json",
      "packages/node/**",
      "pnpm-lock.yaml",
      "rust-toolchain.toml",
      "scripts/native-package/**",
      "scripts/compat-certify.mjs",
      "scripts/compat-judge.mjs",
      "scripts/package-smoke-command.mjs",
      "scripts/rust-vertical-slice.mjs",
      "skills/krx-cli/**",
      "src/calendar/krx-closures.json",
      "tests/compat/**",
      "tests/fixtures/adjusted-stock-prices/oracles.json",
      "tests/scripts/release-policy.test.ts",
      "tests/scripts/rust-vertical-slice.test.ts",
    ]);
    expect(
      job.strategy.matrix.include.map(
        ({ id, runner }: { id: string; runner: string }) => ({ id, runner }),
      ),
    ).toEqual([
      { id: "linux-x64-gnu", runner: "blacksmith-2vcpu-ubuntu-2404" },
      {
        id: "linux-arm64-gnu",
        runner: "blacksmith-2vcpu-ubuntu-2404-arm",
      },
    ]);
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: "cargo fmt --all --check" }),
        expect.objectContaining({
          run: "cargo check --locked --workspace --all-targets --all-features",
        }),
        expect.objectContaining({
          run: "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
        }),
        expect.objectContaining({
          run: "cargo test --locked --workspace --all-features",
        }),
      ]),
    );
    expect(JSON.parse(read("package.json")).scripts["rust:sdk"]).toBe(
      "cargo fmt --all --check && cargo check --locked --workspace --all-targets --all-features && cargo clippy --locked --workspace --all-targets --all-features -- -D warnings && cargo test --locked --workspace --all-features",
    );
  });

  it("freezes the crash-recoverable shared quota lock protocol", () => {
    const migrations = YAML.parse(
      read("contracts/product/v1/migrations.yaml"),
    ) as {
      transitions: Array<{ id: string; lockProtocol?: unknown }>;
    };
    const quota = migrations.transitions.find(
      (migration) => migration.id === "quota-root-v0-to-v1",
    );
    expect(quota?.lockProtocol).toEqual({
      acquisition: "mkdir",
      directoryMode: "0700",
      directoryOwnership: "current-user",
      ownerFile: "owner",
      ownerMode: "0600",
      ownerOwnership: "current-user",
      ownerMaximumBytes: 128,
      ownerGrammar:
        "^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      ownerCandidate: "rate-limit.json.lock/.owner.<owner>.tmp",
      ownerPublication:
        "in-created-directory-prepared-file-hard-link-no-replace",
      creatorReturnRevalidation: "same-created-directory-identity",
      failedAcquisitionCleanup:
        "descriptor-relative-owner-removal-no-pathname-directory-delete",
      pollMs: 25,
      timeoutMs: 5000,
      staleAfterMs: 30000,
      stealRequiresOwnerDead: true,
      stealClaimFile: "steal",
      stealClaimMode: "0600",
      stealClaimOwnership: "current-user",
      stealClaimMaximumBytes: 128,
      stealClaimOwnerGrammar:
        "^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      stealClaimCandidate: "rate-limit.json.lock/.steal.<owner>.tmp",
      stealClaimPublication:
        "in-observed-directory-prepared-file-hard-link-no-replace",
      stealClaimRecovery:
        "dead-published-claim-races-one-deterministic-retained-tombstone",
      stealTombstone: "rate-limit.json.lock.stale-<steal-owner>",
      stealTombstoneRetention: "permanent-nonempty-fence",
      ownerPublicationRevalidation: "no-steal-claim-after-owner-durable",
      stealRevalidation: [
        "same-lock-directory-identity",
        "same-regular-owner-only-owner-identity-and-bytes",
        "unchanged-dead-lock-owner",
        "same-regular-owner-only-claim-identity-and-bytes",
      ],
      steal: "rename-to-claim-derived-nonempty-tombstone-and-retain",
      symlinkPolicy: "reject",
    });
    const rustState = read("crates/krx-sdk/src/state.rs");
    expect(rustState).toContain(
      "match read_steal_claim(&lock_directory, error_code)",
    );
    expect(rustState).toContain(
      "rustix::fs::openat(\n        lock_directory,\n        &candidate,",
    );
    expect(rustState).toContain(
      'let candidate = OsString::from(format!(".owner.{owner}.tmp"));',
    );
    expect(rustState).toContain(
      "path_matches_directory(&parent, &leaf[0], &created_identity, error_code)",
    );
    expect(rustState).toContain(
      "fn abandon_new_lock(lock_directory: &OwnedFd)",
    );
    expect(() => assertQuotaStateProtocolSource(rustState)).not.toThrow();
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace("rustix::fs::linkat(", "rustix::fs::renameat("),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace("committed = true;", "committed = false;"),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace("nonce.len() == 36", "nonce.len() > 0"),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace(
          "let mut committed = false;",
          "let mut committed = true;",
        ),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace(
          'return Err(state_error(\n                error_code,\n                "local steal claim identity changed",\n            ));',
          'release_steal_claim(lock_directory, &claim);\n            return Err(state_error(\n                error_code,\n                "local steal claim identity changed",\n            ));',
        ),
      ),
    ).toThrow(/owner\/claim publication protocol/u);

    const rustCache = read("crates/krx-sdk/src/cache.rs");
    const rustClient = read("crates/krx-sdk/src/client.rs");
    const cacheCoordination = {
      cache: rustCache,
      client: rustClient,
      state: rustState,
    };
    expect(() =>
      assertCacheCoordinationProtocolSources(cacheCoordination),
    ).not.toThrow();
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        cache: rustCache.replace(
          "state_root: self.state.flight_namespace().to_path_buf()",
          'state_root: PathBuf::from("global")',
        ),
      }),
    ).toThrow(/Rust cache coordination/u);
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        cache: rustCache.replace(
          "canonical_cache_timestamp(self.result.provenance.fetched_at)",
          "Some(jiff::Timestamp::MAX)",
        ),
      }),
    ).toThrow(/Rust cache coordination/u);
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        client: rustClient.replace(
          "flight.publish_network_result(result.clone())",
          "drop(result.clone())",
        ),
      }),
    ).toThrow(/Rust cache coordination/u);
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        client: rustClient.replace(
          "!hit.same_refresh_generation(baseline)",
          "true",
        ),
      }),
    ).toThrow(/Rust cache coordination/u);
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        state: rustState.replace(
          "if read_steal_claim(&directory, error_code)?.is_some()",
          "if false",
        ),
      }),
    ).toThrow(/Rust cache coordination/u);
    expect(() =>
      assertCacheCoordinationProtocolSources({
        ...cacheCoordination,
        state: rustState.replace(
          "current.owner == claim.owner",
          "current.owner != claim.owner",
        ),
      }),
    ).toThrow(/Rust cache coordination/u);

    const windowsState = read("crates/krx-sdk/src/state_windows.rs");
    const sdkRoot = read("crates/krx-sdk/src/lib.rs");
    expect(sdkRoot).toContain("#[cfg(any(unix, windows))]\nmod quota;");
    expect(sdkRoot).toContain(
      '#[cfg(windows)]\n#[path = "state_windows.rs"]\nmod state;',
    );
    expect(() => assertWindowsStateProtocolSource(windowsState)).not.toThrow();
    expect(() =>
      assertWindowsCacheLeaseProtocolSource(windowsState),
    ).not.toThrow();
    expect(() =>
      assertWindowsCacheLeaseProtocolSource(
        windowsState.replace(
          "bytes: Vec::new(),\n                complete: false,",
          "bytes: Vec::new(),\n                complete: true,",
        ),
      ),
    ).toThrow(/Windows cache leases/u);
    expect(() =>
      assertWindowsCacheLeaseProtocolSource(
        windowsState.replace(
          "rename_open_handle(&directory, &parent, &tombstone[0], false)",
          "parent.rename(&leaf[0], &parent, &tombstone[0])",
        ),
      ),
    ).toThrow(/Windows cache leases/u);
    expect(() =>
      assertWindowsCacheLeaseProtocolSource(
        windowsState.replace(
          "delete_open_handle(owner_file.as_raw_handle())",
          "Ok(())",
        ),
      ),
    ).toThrow(/Windows cache leases/u);
    expect(() =>
      assertWindowsCacheLeaseProtocolSource(
        windowsState.replace(
          "OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)",
          "OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid)",
        ),
      ),
    ).toThrow(/Windows cache leases/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "&self.path,\n            false,\n            true,\n            ReadSensitivity::NonSecret,",
          "&self.path,\n            false,\n            false,\n            ReadSensitivity::NonSecret,",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          ".custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);",
          ".custom_flags(FILE_FLAG_BACKUP_SEMANTICS);",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "let mut renamed = false;",
          "let mut renamed = true;",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "result.map_err(|error| (error, renamed))",
          "result.map_err(|error| (error, false))",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("let candidate_sync =", "let _candidate_sync ="),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "    let candidate_sync =\n",
          "    let published_result = result?;\n    let candidate_sync =\n",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("if result.is_err()", "if false"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if result.is_err()\n        && let Some(observation) = &published",
          "if result.is_err()\n        && false\n        && let Some(observation) = &published",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("if cleanup_failed {", "if false {"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "open_traversal_directory(&current, component, error_code)?",
          "open_child_directory(\n                &current,\n                component,\n                false,\n                sensitivity,\n                error_code,\n            )?",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if unsafe { EqualSid(owner, user_sid.as_mut_ptr().cast()) } == 0",
          "if false",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "link_open_handle(&file, directory, OsStr::new(destination))",
          "directory.hard_link(candidate, directory, destination)",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "(*allowed).Mask } & forbidden == 0",
          "(*allowed).Mask } & forbidden != 0",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "(*allowed).Mask } & forbidden == 0",
          "(*allowed).Mask } & forbidden == 0 || true",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("if !approved", "if false"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("if !approved {", "if !approved && false {"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          /fn writable_rights\(\) -> u32 \{[\s\S]*?\n\}\n\nfn aligned_information_buffer/u,
          "fn writable_rights() -> u32 {\n    0\n}\n\nfn aligned_information_buffer",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          /fn writable_rights\(\) -> u32 \{[\s\S]*?\n\}\n\nfn aligned_information_buffer/u,
          (block) => block.replaceAll("|", "&"),
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          / {8}let approved = unsafe \{[\s\S]*?\n {8}\};/u,
          "        let approved = true;",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "for sid_type in [WinWorldSid, WinAuthenticatedUserSid]",
          "for sid_type in []",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("Ok(rights & forbidden != 0)", "Ok(false)"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) } != 0",
          "if false",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) } != 0 {",
          "if unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) } != 0 && false {",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "(*information).Anonymous.ReplaceIfExists = false;",
          "(*information).Anonymous.ReplaceIfExists = true;",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "matches!(*suffix, 0x00b9 | 0x00b2 | 0x00b3)",
          "false",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "        GetSecurityInfo(\n            handle,",
          "        GetNamedSecurityInfoW(\n            handle,",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "unsafe { GetAce(dacl, index, &mut raw_ace) }",
          "unsafe { GetAceRemoved(dacl, index, &mut raw_ace) }",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("uuid.len() == 36", "uuid.len() > 0"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "            FileDispositionInfo,\n            (&raw const information).cast(),",
          "            FileBasicInfo,\n            (&raw const information).cast(),",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace("DeleteFile: true", "DeleteFile: false"),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if unsafe { FlushFileBuffers(directory.as_raw_handle().cast()) } == 0",
          "if false",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "if candidate_sync.is_err() {",
          "if candidate_sync.is_err() && false {",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "left.volume_serial == right.volume_serial",
          "true",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "left.volume_serial == right.volume_serial && left.file_index == right.file_index",
          "left.volume_serial == right.volume_serial || left.file_index == right.file_index",
        ),
      ),
    ).toThrow(/Windows quota state/u);
    expect(() =>
      assertWindowsStateProtocolSource(
        windowsState.replace(
          "validate_handle_security(file.as_raw_handle(), ReadSensitivity::NonSecret, error_code)?;",
          "let _ = file.as_raw_handle();",
        ),
      ),
    ).toThrow(/Windows quota state/u);
  });
});
