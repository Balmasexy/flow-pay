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
