# Apply for KRX endpoint service access

Read this workflow only after the user explicitly asks to submit service-access
applications for all currently discoverable endpoints or a named subset. The
workflow changes external account state; a status question or approval error is
not authorization.

## Required capability and authority

1. Record the user's requested scope: all currently discoverable endpoints or
   an explicit subset.
2. Use a browser-control capability attached to the user's shared,
   already-authenticated KRX Open API tab.
3. Confirm that the tab is on the expected KRX Open API origin and still exposes
   the authenticated service pages. Do not inspect cookies or credential fields.
4. Stop and ask the user to restore the same shared tab when it is detached,
   stale, logged out, or requires authentication. Never switch to an unrelated
   profile or session.
5. If CAPTCHA, password, OTP, or another human-verification step appears, pause
   before it and ask the user to complete it.

## Discover a stable endpoint snapshot

1. Open the portal's `서비스 이용` area.
2. Traverse every category and every pagination or lazy-loading control visible
   in the current portal. Do not rely on a hard-coded endpoint count or list.
3. Record each endpoint's category, display name, detail URL, and any stable
   endpoint code or DOM identifier exposed by the page.
4. Identify endpoints by the strongest stable compound key available:
   `category + endpoint code`, then `category + canonical detail URL`, and only
   as a last resort `category + normalized display name`.
5. Mark colliding or ambiguous identities as `unknown`. Do not submit an
   application for an endpoint that cannot be mapped uniquely.
6. Preserve this discovery snapshot for the final comparison. Include its
   collection time in the work record.

## Build the existing-access set

1. Open `마이페이지 → API 이용현황`.
2. Traverse all result pages and collect the endpoint identity, status, and
   displayed use period for every row.
3. Map these rows to the discovery snapshot with the same compound-key rules.
4. Classify matched rows before applying:
   - `existing-approved`: already approved and currently valid; record its
     displayed period and preserve it without renewal, regardless of its term.
   - `submitted-pending`: already submitted but not approved; do not resubmit.
   - `unknown`: the row, identity, or current validity cannot be reconciled
     safely, including expired access; do not submit or renew it in this workflow.
5. The candidate set is the requested scope intersected with discovered
   endpoints, excluding every existing-approved, submitted-pending, and unknown
   endpoint.

## Submit each unambiguous candidate

For each candidate:

1. Open its detail page and verify that its identity matches the recorded
   category and stable key.
2. Open `API 이용신청`.
3. Select period `12M` and purpose `개인 연구`.
4. Re-read both selected values from the rendered form before submission.
5. Submit with `확인`.
6. Confirm the `이용신청이 완료되었습니다` notification and record the
   endpoint as submitted. Treat the notification as submission evidence, not
   final approval evidence.
7. Return through a known portal navigation path before processing the next
   candidate.

Continue after an isolated endpoint rejection or validation error when portal
state remains trustworthy; record that endpoint as `failed`. Stop the batch
immediately on any systemic or ambiguous condition, including login expiry,
tab detachment, CAPTCHA, unexpected credential prompts, DOM or navigation drift,
loss of the discovery mapping, an unknown confirmation result, or uncertainty
about whether a submission occurred. Preserve completed records and ask the user
to resolve the blocking condition before resuming.

## Reconcile and report

1. Revisit `서비스 이용` and collect all categories and pages again. Report any
   endpoint introduced after the initial snapshot as `unknown`; do not silently
   expand the authorized batch during reconciliation.
2. Revisit every page of `마이페이지 → API 이용현황` and rebuild the access map.
3. Reconcile every endpoint in the requested scope into exactly one state:
   - `existing-approved`: approved before this run and still currently valid.
   - `newly-approved`: submitted in this run and now shown as approved.
   - `submitted-pending`: submitted but not yet approved.
   - `failed`: an isolated application attempt was rejected or failed with a
     known result.
   - `unknown`: identity, submission result, status, period, or portal state
     cannot be verified.
4. For `newly-approved` endpoints, confirm the displayed period matches the
   requested `12M` term or the portal's corresponding 365-day representation.
   Record the portal's literal value rather than assuming equivalence.
   For `existing-approved` endpoints, report their displayed period and confirm
   access is still valid; a different term does not prevent complete success.
   If existing access has expired or its validity cannot be verified, classify
   it as `unknown` and report the next action without renewing it.
5. Report counts and endpoint identities under all five states. Include any
   unprocessed candidates after a stopped batch.

Report complete success only when every endpoint in the requested discovery
scope is `existing-approved` or `newly-approved`, every existing approval remains
valid, every new approval shows the requested term, and no endpoint is pending,
failed, unknown, or unprocessed.
Otherwise report partial completion and the exact next safe action.
