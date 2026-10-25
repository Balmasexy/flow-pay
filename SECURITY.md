# Security checklist

## Repository and environment

- Keep this project independent of PWFB Microfinance, World Wallet AI, MagCharge, and BALMZ.
- Keep `.env` files and credentials out of Git; rotate any secret accidentally committed.
- Use separate development, sandbox, and production credentials and databases.
- Do not include real customer data or real payment credentials in test fixtures.

## Identity and access

- Use secure, expiring sessions/tokens and server-side authorization on every protected endpoint.
- Enforce least privilege and deny access by default.
- Require MFA for administrators and audit privileged actions.
- Rate-limit login, recovery, sensitive actions, and public API endpoints.

## Ledger and payments

- Only server-side services can post ledger entries.
- Validate amount, currency, ownership, and transaction state on the server.
- Use idempotency and database transactions to prevent duplicate or partial postings.
- Verify provider webhook signatures using the raw request body and reject invalid signatures.
- Deduplicate provider events and verify transaction status with the provider before crediting.
- Never trust client callbacks, screenshots, or client-submitted balances as proof of payment.

## Operations

- Redact credentials and sensitive data from logs.
- Add security tests, dependency scanning, backups, restore drills, monitoring, and incident response before launch.
- Do not deploy to production or enable live payments as part of this scaffold.
