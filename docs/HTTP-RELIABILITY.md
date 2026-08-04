# KRX request reliability

Each uncached KRX request is bounded by a 15-second attempt timeout and a
45-second overall deadline. The deadline includes local quota admission,
outbound fetches, response-body reads, and retry delays. Caller cancellation
aborts quota-lock waits, requests, body reads, and backoff sleeps. MCP request
cancellation is forwarded from the SDK to the client.

The client makes at most four attempts by default (the first attempt plus three
retries). It retries network failures, attempt timeouts, and HTTP 408, 429, 500,
502, 503, and 504. Other 4xx responses are permanent. Backoff is exponential
with bounded jitter; a valid `Retry-After` value takes precedence only when it
fits inside the overall deadline.

Before every actual HTTP attempt, the client atomically reserves one unit in
`~/.krx-cli/rate-limit.json`. Counters use the KST calendar day and a SHA-256
credential identity, so one API key cannot inherit another key's count. A
cross-process owner lock and atomic rename prevent lost increments or malformed
writes. Corrupt state fails closed instead of silently resetting. The local
10,000-call counter is advisory: KRX remains the source of truth. A crash after
reservation but before dispatch can conservatively overcount, but retries and
failed attempts are not systematically undercounted.

`krx auth status` and `krx auth check` always bypass the market-data cache and
probe only the official endpoint registered for that category. Persisted
results are bound to a non-reversible credential identity and expire after 15
minutes. The public `krx://service-status` resource reports `fresh`, timestamps,
state, and safe failure information, never the credential identity. Probe
states are `approved`, `rejected`, or `inconclusive`; timeout, cancellation,
network failure, invalid response, and an empty successful response are
inconclusive. KRX's `401 Unauthorized API Call` does not reliably distinguish
an invalid key from missing category approval, so it is reported as
inconclusive rather than guessed.
