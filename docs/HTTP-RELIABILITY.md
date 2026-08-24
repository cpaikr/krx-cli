# HTTP reliability

`crates/krx-sdk/src/transport.rs` is the only KRX HTTP implementation. It uses
one reusable Rustls client, refuses redirects, disables implicit retries,
bounds response bodies, and sanitizes provider failures.

Each call has a 45-second overall deadline covering quota/lease waits, connect,
headers, body streaming, and retry sleep. Individual attempts have a 15-second
deadline. Cancellation dominates and reaches every wait and I/O phase.

Only network/attempt timeout failures and HTTP 408, 429, 500, 502, 503, and 504
are retryable. Callers select zero through three retries. Before each actual
attempt, the SDK atomically reserves exactly one unit in the shared 10,000-call
KST-day advisory quota. A rejected reservation sends no request; a crash may
overcount but must never undercount.
