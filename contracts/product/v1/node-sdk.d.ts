import type {
  AdjustedDailyStockOperation,
  ApprovalCategory,
  OperationDescription,
  OperationId,
  RowFor,
} from "../../generated/node-operations.js";
import type {
  KrxErrorCode,
  KrxErrorKind,
} from "../../generated/error-types.js";

export type {
  AdjustedDailyStockOperation,
  ApprovalCategory,
  OperationDescription,
  OperationId,
  OperationRows,
  RowFor,
} from "../../generated/node-operations.js";
export type {
  KrxErrorCode,
  KrxErrorKind,
} from "../../generated/error-types.js";

export type CachePolicy =
  | { readonly mode: "prefer"; readonly maxAgeHours?: number }
  | { readonly mode: "refresh" }
  | { readonly mode: "bypass" }
  | { readonly mode: "offline" };

export type RetryCount = 0 | 1 | 2 | 3;

export interface QueryRequest<O extends OperationId> {
  readonly operation: O;
  readonly date: string;
  readonly cache?: CachePolicy;
  readonly retries?: RetryCount;
  readonly signal?: AbortSignal;
}

interface RangeRequestBase<O extends OperationId> extends Omit<
  QueryRequest<O>,
  "date"
> {
  readonly from: string;
  readonly to: string;
}

export type RangeRequest<O extends OperationId> = RangeRequestBase<O> &
  (O extends AdjustedDailyStockOperation
    ?
        | { readonly adjusted: true; readonly securityCode: string }
        | { readonly adjusted?: false; readonly securityCode?: string }
    : { readonly adjusted?: false; readonly securityCode?: never });

export interface Provenance {
  readonly source: "network" | "cache";
  readonly fetchedAt: string;
  readonly freshness: "fresh" | "stale";
  readonly contractId: string;
}

export interface QueryResult<R> {
  readonly data: readonly Readonly<R>[];
  readonly provenance: Provenance;
}

interface KrxFailureCommon {
  readonly name: "KrxError";
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly operationId?: OperationId;
}

export type KrxFailure = {
  readonly [K in KrxErrorKind]: KrxFailureCommon & {
    readonly kind: K;
    readonly code: KrxErrorCode<K>;
  };
}[KrxErrorKind];

export class KrxError<K extends KrxErrorKind = KrxErrorKind> implements Error {
  private constructor();
  readonly name: "KrxError";
  readonly message: string;
  readonly stack?: string;
  readonly kind: K;
  readonly code: KrxErrorCode<K>;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly operationId?: OperationId;
}

export type CompletenessState = "complete" | "partial" | "empty" | "failed";

export interface CompositeFailure<Id extends string> {
  readonly id: Id;
  readonly error: KrxFailure;
}

export interface Completeness<Id extends string> {
  readonly state: CompletenessState;
  readonly requested: readonly Id[];
  readonly succeeded: readonly Id[];
  readonly failed: readonly CompositeFailure<Id>[];
  readonly skipped: readonly Id[];
}

export interface CompositeResult<Data, Id extends string> {
  readonly success: boolean;
  readonly data: Data;
  readonly completeness: Completeness<Id>;
  readonly provenance: Readonly<Partial<Record<Id, Provenance>>>;
  readonly error?: KrxFailure;
}

export interface CalendarSelection {
  readonly version: string;
  readonly source: string;
  readonly retrievedAt: string;
  readonly coverage: "official" | "fallback";
  readonly unverifiedDates: readonly string[];
}

export interface AdjustmentMetadata {
  readonly method: string;
  readonly version: number;
  readonly asOf: string;
  readonly rounding: string;
  readonly rawFields: readonly string[];
  readonly adjustedFields: readonly string[];
  readonly factorField: "ADJ_FACTOR";
  readonly basisTransitions: readonly string[];
  readonly cashDividends: "excluded";
}

export interface RangeResult<O extends OperationId> extends CompositeResult<
  readonly Readonly<RowFor<O>>[],
  string
> {
  readonly fetchedDays: number;
  readonly failedDays: number;
  readonly calendar: CalendarSelection;
  readonly adjustment?: AdjustmentMetadata;
}

export type SearchMarket = "KOSPI" | "KOSDAQ";

export interface StockSearchRequest {
  readonly query: string;
  readonly signal?: AbortSignal;
  readonly cache?: CachePolicy;
}

export interface StockSearchMatch {
  readonly ISU_CD: string;
  readonly ISU_SRT_CD: string;
  readonly ISU_NM: string;
  readonly market: SearchMarket;
}

export type StockSearchResult = CompositeResult<
  readonly Readonly<StockSearchMatch>[],
  SearchMarket
>;

export type MarketComponent =
  | "kospiIndex"
  | "kosdaqIndex"
  | "kospiStocks"
  | "kosdaqStocks";

export interface MarketSummaryRequest {
  readonly date: string;
  readonly signal?: AbortSignal;
  readonly cache?: CachePolicy;
}

export interface StockStats {
  readonly advancing: number;
  readonly declining: number;
  readonly unchanged: number;
  readonly totalVolume: number;
  readonly totalValue: number;
}

export interface MarketSummary {
  readonly date: string;
  readonly kospiIndex: readonly Readonly<RowFor<"index_kospi_dd_trd">>[] | null;
  readonly kosdaqIndex:
    | readonly Readonly<RowFor<"index_kosdaq_dd_trd">>[]
    | null;
  readonly stockStats: StockStats | null;
  readonly topGainers:
    | readonly Readonly<
        RowFor<"stock_stk_bydd_trd"> | RowFor<"stock_ksq_bydd_trd">
      >[]
    | null;
  readonly topLosers:
    | readonly Readonly<
        RowFor<"stock_stk_bydd_trd"> | RowFor<"stock_ksq_bydd_trd">
      >[]
    | null;
}

export type MarketSummaryResult = CompositeResult<
  MarketSummary,
  MarketComponent
>;

export interface WatchlistPricesRequest {
  readonly date: string;
  readonly securityCodes: readonly string[];
  readonly signal?: AbortSignal;
  readonly cache?: CachePolicy;
}

export interface WatchlistPrices {
  readonly date: string;
  readonly stocks: readonly Readonly<
    RowFor<"stock_stk_bydd_trd"> | RowFor<"stock_ksq_bydd_trd">
  >[];
}

export type WatchlistPricesResult = CompositeResult<
  WatchlistPrices,
  SearchMarket
>;

export interface ApprovalObservation {
  readonly category: ApprovalCategory;
  readonly state: "approved" | "rejected" | "inconclusive";
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly fresh: boolean;
  readonly error?: KrxFailure;
}

export interface CredentialStatus {
  readonly source: "explicit" | "environment" | "keychain" | "missing";
  readonly persisted: boolean;
}

export interface CredentialMigrationResult {
  readonly migrated: boolean;
  readonly legacySecretRemoved: boolean;
  readonly approvalsMigrated: number;
}

export interface CredentialStore {
  status(): Promise<CredentialStatus>;
  set(apiKey: string): Promise<void>;
  remove(): Promise<boolean>;
  migrateLegacy(): Promise<CredentialMigrationResult>;
  approvalStatus(
    category: ApprovalCategory,
  ): Promise<ApprovalObservation | null>;
  checkApproval(
    category: ApprovalCategory,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ApprovalObservation>;
}

export interface CacheEntryDescription {
  readonly operation: OperationId;
  readonly date: string;
  readonly fetchedAt: string;
  readonly freshness: "fresh" | "stale";
  readonly sizeBytes: number;
  readonly contractId: string;
}

export interface CacheInspection {
  readonly entries: readonly CacheEntryDescription[];
  readonly totalEntries: number;
  readonly totalSizeBytes: number;
  readonly truncated: boolean;
}

export interface CachePruneResult {
  readonly removedEntries: number;
  readonly removedBytes: number;
}

export interface CacheStore {
  inspect(options?: {
    readonly operation?: OperationId;
    readonly date?: string;
    readonly limit?: number;
  }): Promise<CacheInspection>;
  prune(options?: {
    readonly olderThan?: string;
    readonly maxEntries?: number;
  }): Promise<CachePruneResult>;
  clear(): Promise<CachePruneResult>;
}

export interface KrxClientOptions {
  readonly apiKey?: string;
  readonly cacheMaxAgeHours?: number;
}

export class KrxClient {
  constructor(options?: KrxClientOptions);
  query<O extends OperationId>(
    request: QueryRequest<O>,
  ): Promise<QueryResult<RowFor<O>>>;
  range<O extends OperationId>(
    request: RangeRequest<O>,
  ): Promise<RangeResult<O>>;
  searchStocks(request: StockSearchRequest): Promise<StockSearchResult>;
  marketSummary(request: MarketSummaryRequest): Promise<MarketSummaryResult>;
  watchlistPrices(
    request: WatchlistPricesRequest,
  ): Promise<WatchlistPricesResult>;
  capabilities(): readonly OperationDescription[];
  readonly credentials: CredentialStore;
  readonly cache: CacheStore;
}
