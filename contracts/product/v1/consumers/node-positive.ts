import {
  KrxClient,
  KrxError,
  type KrxFailure,
  type OperationDescription,
} from "../node-sdk.js";

const client = new KrxClient();
const signal = new AbortController().signal;

const stock = await client.query({
  operation: "stock_stk_bydd_trd",
  date: "20260102",
  retries: 3,
  signal,
});
void stock.data[0]?.TDD_CLSPRC;
// @ts-expect-error stock rows cannot expose index-only fields
void stock.data[0]?.IDX_NM;

const index = await client.query({
  operation: "index_kospi_dd_trd",
  date: "20260102",
  cache: { mode: "offline" },
});
void index.data[0]?.IDX_NM;
// @ts-expect-error index rows cannot expose stock-only fields
void index.data[0]?.ISU_CD;

await client.range({
  operation: "stock_stk_bydd_trd",
  from: "20260102",
  to: "20260130",
  adjusted: true,
  securityCode: "005930",
  cache: { mode: "bypass" },
});

const search = await client.searchStocks({ query: "삼성", signal });
void search.data[0]?.ISU_SRT_CD;

const watchlistPrices = await client.watchlistPrices({
  date: "20260102",
  securityCodes: ["005930"],
  cache: { mode: "offline" },
});
void watchlistPrices.data.stocks[0]?.ISU_CD;

// @ts-expect-error adjusted ranges require one exact security code
void client.range({
  operation: "stock_stk_bydd_trd",
  from: "20260102",
  to: "20260130",
  adjusted: true,
});

void client.range({
  operation: "index_kospi_dd_trd",
  from: "20260102",
  to: "20260130",
  // @ts-expect-error adjustment is limited to the generated stock operation set
  adjusted: true,
});

const capabilities: readonly OperationDescription[] = client.capabilities();
void capabilities;

await client.credentials.status();
await client.credentials.approvalStatus("stock");
await client.credentials.checkApproval("stock", { signal });
await client.credentials.set("fixture-key");
await client.credentials.remove();
await client.credentials.migrateLegacy();

await client.cache.inspect({
  operation: "stock_stk_bydd_trd",
  date: "20260102",
  limit: 100,
});
await client.cache.prune({
  olderThan: "2026-01-02T00:00:00.000Z",
  maxEntries: 100,
});
await client.cache.clear();

// @ts-expect-error error codes are paired with their owning kind
const invalidFailure: KrxFailure = {
  name: "KrxError",
  kind: "offline",
  code: "invalid_date",
  message: "fixture",
  retryable: false,
};
void invalidFailure;

const projectError = null as unknown as KrxError;
// @ts-expect-error causal objects are not part of the public error boundary
void projectError.cause;
// @ts-expect-error project errors are constructed only by the SDK
new KrxError();

try {
  await client.marketSummary({ date: "20260102", signal });
} catch (error) {
  if (error instanceof KrxError) {
    void error.kind;
    void error.code;
    void error.retryable;
  }
}

// @ts-expect-error arbitrary operations are not public
void client.query({ operation: "arbitrary_endpoint", date: "20260102" });
void client.query({
  operation: "stock_stk_bydd_trd",
  date: "20260102",
  // @ts-expect-error cache policy is a closed discriminated union
  cache: { mode: "network" },
});
void client.query({
  operation: "stock_stk_bydd_trd",
  date: "20260102",
  // @ts-expect-error retries are bounded to zero through three
  retries: 4,
});
