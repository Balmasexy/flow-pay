# FlowPay — isolated fintech starter

FlowPay is a new, independent fintech product inspired by common digital-wallet conveniences. It is not affiliated with OPay and must not use OPay branding, proprietary assets, or copied interface code.

## Scope

This is a **planning and starter scaffold only**. It contains no live payment integration, production credentials, customer data, or deploy configuration. It does not modify any other project.

## Planned applications

- `apps/android/`: native Android customer app (Kotlin + Jetpack Compose; setup pending).
- `apps/web/`: customer web app (React + TypeScript; setup pending).
- `apps/admin/`: separately protected operations dashboard (React + TypeScript; setup pending).
- `apps/api/`: Node.js + TypeScript API starter.
- Neon PostgreSQL: isolated project `FlowPay Development`, region `aws-eu-west-2`. No credentials are included in this repository.

## First milestones

1. Review `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/IMPLEMENTATION_PLAN.md`.
2. Set up a local development environment and CI.
3. Implement authentication and a double-entry ledger with automated tests before any payment-provider sandbox integration.
4. Integrate sandbox-only payment flows; keep live credentials and live processing out of scope until explicitly approved.

## Safety rules

- Never reuse credentials, databases, auth projects, deployment services, or environment variables from PWFB Microfinance, World Wallet AI, MagCharge, or BALMZ.
- Never commit `.env` files, database URLs, signing keys, payment secrets, or private keys.
- No real money, no fake spendable balances, and no live payment calls in this scaffold.
- All financial state must be derived from server-side ledger entries; clients cannot write balances.
- Production deployment is intentionally not configured.


## Customer finance API (read-only milestone)

The current implementation adds customer-scoped read endpoints. It does not enable money movement or card mutations.

- `GET /v1/me/profile` — authenticated customer profile.
- `GET /v1/me/accounts` — customer account statuses and ledger-derived balances.
- `GET /v1/me/summary` — posted-ledger net balance, money received, and money sent by currency.
- `GET /v1/me/transactions?type=all|received|sent|transfers&limit=50` — customer-scoped ledger history.
- `GET /v1/me/cards` — card metadata only.
- `GET /v1/me/card-events` and `GET /v1/me/cards/:id/events` — read-only card audit history.

### Required environment and rollout

Configure the web build with `VITE_NEON_AUTH_URL`. Configure the API with `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE`, `DATABASE_URL`, and the allowed web origin in `WEB_ORIGIN`.

Migration `apps/api/migrations/003_customer_profile_cards.sql` is additive but **has not been applied automatically**. Review and back up the database before applying it. It creates a verified-auth-subject mapping column and stores non-sensitive card metadata; it does not automatically link any existing identity. Map a customer's verified Neon Auth subject to the correct existing FlowPay customer profile only after confirming identity.

No PAN, CVV/CVC, PIN, passwords, or session tokens may be stored in card metadata or exposed by API responses. Virtual-card issuance, physical-card orders, freeze/unfreeze, PIN changes, spending-limit updates, transfers, and payments remain disabled until a provider-backed, authenticated, audited implementation is reviewed and approved.


## Flutterwave sandbox deposits

FlowPay includes a guarded Flutterwave test-mode deposit route. See [docs/FLUTTERWAVE_TEST_MODE.md](docs/FLUTTERWAVE_TEST_MODE.md) for test-only environment variables, API contract, migration 006, webhook verification, and validation checklist. The integration rejects live-mode configuration and does not use PWFB customer data or credentials. End-to-end sandbox verification is still required before considering this milestone complete.
