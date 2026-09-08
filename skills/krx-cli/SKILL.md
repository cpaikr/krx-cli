---
name: krx-cli
description: Query and analyze Korea Exchange (KRX) market data through the native krx CLI, inspect authentication or service status, or handle an express request to submit KRX Open API service-access applications through a user-authorized authenticated browser tab, including requests for all current or unapproved endpoints and requests whose subset must be clarified before submission. Use for Korean stock prices, KOSPI/KOSDAQ indices, ETF/ETN/ELW, bonds, derivatives, commodities, ESG data, command usage, and endpoint service-access applications. Route status-only questions exclusively to the CLI branch. Do not use this skill for account registration, credential entry, CAPTCHA bypass, or API-key deletion, renewal, or reissue.
---

# KRX CLI

Route KRX work through either the read-oriented CLI branch or the external
service-access application branch. Keep market-data reads separate from portal
changes.

## Universal rules

- Never inspect, expose, log, or copy credential values. Let the CLI resolve
  configured credentials internally; leave credential entry to the user.
- Preserve existing approvals and unrelated account state.
- Do not claim completion when a required query component or requested endpoint
  remains partial, pending, failed, or unknown.
- If an approval check fails, explain the observed status. Do not open or submit
  a portal application unless the user explicitly requested that change.

## Route the request

### Query or operate the CLI

For market-data queries, analysis, command selection, CLI setup, authentication
status, cache operations, schema lookup, or local-state administration, read
[references/cli-usage.md](references/cli-usage.md) before acting. Follow its
output-completeness, date, field, and exit-status contracts.

Complete this branch only after reporting the relevant data date and any
partial, empty, failed, or approval-limited result that affects the answer.

### Apply for endpoint service access

Use this branch only when the user explicitly asks to submit KRX endpoint access
applications. Read
[workflows/apply-service-access.md](workflows/apply-service-access.md) completely
before opening or controlling the portal.

This branch requires browser control over the user's shared, authenticated KRX
Open API tab without extracting credentials. If that capability or tab is
unavailable, stop at that boundary and state what the user must provide. Do not
substitute a different browser profile or session.

### Status-only and adjacent requests

- For “what is approved?” or similar status-only requests, use `krx auth status`
  through the CLI branch; never submit applications.
- Registration, credential or OTP entry, CAPTCHA solving or bypass, and global
  API-key deletion, renewal, or reissue remain outside this skill.
