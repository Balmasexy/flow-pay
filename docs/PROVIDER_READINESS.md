# FlowPay Provider and Customer Account Readiness

## Current status

This document is a preparation checklist, not proof that a provider account is approved. FlowPay's current API scaffold has no verified live payment-provider integration. The development-only simulated OPay transfer route is not a real transfer. Keep live collection and payout processing disabled.

## Customer account-number requirement

FlowPay must not generate random ten-digit numbers and represent them as bank account numbers. For real NGN deposits, integrate a provider or sponsor bank that is approved to issue virtual accounts for this merchant and customer use case.

Required lifecycle:

1. Authenticate the customer and resolve their existing FlowPay profile using the verified auth subject.
2. Check required identity/KYC status and eligibility before requesting an account.
3. Create an idempotent provider-side virtual-account request using a stable internal customer reference.
4. Verify the provider response and persist the provider, provider customer/account reference, account number, bank name, currency, status, and timestamps. Enforce uniqueness on provider + account number and on the provider reference. Do not store API secrets in customer records.
5. Return the account number only to its authenticated owner. Never reveal another customer's account details.
6. For existing customers, reconcile the provider account against the verified identity before linking it. Do not silently overwrite an existing account or assign the same account number to multiple customers.
7. If provider account creation times out, query/reconcile by the idempotency reference before retrying; do not create duplicate virtual accounts.
8. Provide clear states such as pending, active, failed, and suspended. Only show an account as deposit-ready after the provider confirms it is active.

## Deposit processing requirements

- Accept provider webhooks only after validating the provider's documented signature over the exact raw request body and rejecting stale/invalid events where the provider supports timestamps.
- Persist provider event IDs with a unique constraint and make processing idempotent.
- Verify payment status, currency, amount, destination virtual account, and provider transaction reference with the provider where supported.
- Credit only a verified successful settlement/collection event using an atomic, balanced ledger transaction. Never trust a client redirect or client-supplied success flag.
- Handle duplicate, delayed, out-of-order, reversed, and failed events; keep an audit trail and reconciliation process.
- Do not expose provider secrets to the browser, Android app, logs, or Git history.

## Bank payout requirements

- Use an explicitly approved provider payout/disbursement API; a business mobile app login is not evidence of API access.
- Verify destination bank/account details with the provider before initiating a payout.
- Check the customer's posted, available ledger balance and any applicable limits, KYC requirements, fees, and fraud controls.
- Reserve funds atomically before submitting the payout; enforce a unique idempotency key and stable transfer reference.
- Track pending, successful, failed, and reversed statuses. A timeout or pending response is not a successful transfer; reconcile provider status before retrying or releasing funds.
- Reconcile ledger liabilities against actual provider/settlement balances. Never fund customer balances with simulated credits or treat customer funds as operating capital.

## Funding and operating capital

The owner does not necessarily need to pre-fund each customer transaction personally if the approved provider supports collection-first settlement and the relevant payout is funded from cleared, available settlement proceeds. This is provider- and contract-dependent, not guaranteed. Some providers require a prefunded payout balance, reserves, fees, or settlement delays. Do not promise instant payout from a newly initiated deposit until the provider's settlement and risk rules permit it.

## Approval gate before live traffic

Do not enable live traffic until all are documented and tested:

- Provider has approved the FlowPay legal entity, product, use case, and relevant collection plus payout endpoints.
- Provider account numbers/virtual accounts have been issued and verified in sandbox and production as applicable.
- API credentials are stored only in the deployment secret manager and are scoped appropriately.
- Webhook signature verification, idempotency, duplicate events, delayed events, reversals, insufficient funds, provider timeouts, and reconciliation tests pass.
- KYC/AML, customer disclosures, privacy, complaint handling, refund/reversal handling, limits, fees, safeguarding and applicable Nigerian regulatory/legal obligations are reviewed.
- A production readiness review is approved explicitly. Live payment flags remain off until that approval.

## Current no-change guarantees

This preparation document does not create a clearing/system account, apply database migrations, modify customer profiles or balances, submit transfers, or enable live payments. The existing simulated-transfer migration is separate from real-provider account issuance.
