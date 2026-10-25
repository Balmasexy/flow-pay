# Implementation plan

## Phase 0 — isolation and repository setup

- Confirm repository access and keep this repo separate from all existing projects.
- Add the scaffold, CI checks, and secret scanning.
- Set up local development configuration without committing secrets.
- Verify the isolated FlowPay Development database before creating any schema.

## Phase 1 — API foundation

- Add request validation, consistent errors, structured logging with redaction, and health/readiness checks.
- Add authentication, session handling, authorization, and audit events.
- Add database migrations and integration tests.

## Phase 2 — ledger first

- Design chart of accounts and double-entry journal schema.
- Implement balanced posting, idempotency, concurrency safety, reversals, and reconciliation.
- Test insufficient funds, duplicate requests, concurrency, failed transactions, and auditability.
- Do not integrate a payment provider until ledger invariants are tested.

## Phase 3 — client applications

- Build the customer web app and Android app against documented API contracts.
- Build a separately protected admin console with MFA and role-based access.
- Show pending/failed/succeeded states clearly; never fabricate balances or transaction history.

## Phase 4 — sandbox integration

- Add provider adapter behind feature flags with sandbox credentials only.
- Verify webhook signatures, event deduplication, reconciliation, and failure paths.
- Test provider callbacks and ledger postings end-to-end.

## Phase 5 — independent live-launch gate

Requires explicit approval, legal/compliance review, security review, operational monitoring, incident response, verified provider onboarding, and separate production secrets. This phase is not authorized by the current scaffold task.
