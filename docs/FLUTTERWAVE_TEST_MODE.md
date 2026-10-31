# FlowPay Flutterwave sandbox deposits

This integration belongs to **FlowPay**. It is not a PWFB integration. PWFB Flutterwave material was used only as a technical reference for sandbox behavior.

## Safety boundary

- The API accepts only `FLUTTERWAVE_MODE=test` and a secret key beginning `FLWSECK_TEST-`.
- The webhook secret hash must be configured independently in FlowPay.
- The checkout redirect URL must be HTTPS and owned by the FlowPay test application.
- Do not add live credentials, production webhook settings, or production activation.
- Do not copy PWFB customer data, wallet balances, credentials, or environment settings.
- Do not apply migrations to a production database. Use the isolated FlowPay development/test database only.

## API

Authenticated customer endpoint:

`POST /v1/payments/flutterwave/deposits`

Headers:
- `Authorization: Bearer <FlowPay customer access token>`
- `Idempotency-Key: <unique value at least 8 characters>`
- `Content-Type: application/json`

Body:
```json
{
  "accountId": "<FlowPay customer's NGN account UUID>",
  "amountMinor": "250000"
}
```

Amounts are integer kobo strings. The current sandbox bounds are ₦100.00 to ₦1,000,000.00. The account must belong to the authenticated FlowPay customer and be active NGN. The API returns a Flutterwave hosted checkout URL and a pending FlowPay transaction; it does not credit the wallet at checkout initialization.

Webhook endpoint:

`POST /webhooks/flutterwave`

Configure this exact URL in the FlowPay Flutterwave test dashboard. The handler validates the `verif-hash` header, fetches the transaction from Flutterwave's verification API, checks successful status, NGN currency, transaction ID, FlowPay reference and exact amount, then posts the balanced ledger transaction once. Repeated webhook deliveries are idempotent.

## Required FlowPay API environment

```dotenv
FLUTTERWAVE_MODE=test
FLW_SECRET_KEY=FLWSECK_TEST-<FlowPay-test-secret>
FLW_WEBHOOK_SECRET_HASH=<FlowPay-test-webhook-secret-hash>
FLOWPAY_FLUTTERWAVE_REDIRECT_URL=https://<FlowPay-test-frontend>/payments/flutterwave/return
```

Keep all credentials in the FlowPay API service environment, never in the frontend, source control, PWFB, or client application. Do not use a live key; live mode is intentionally rejected by the integration.

## Database

Migration `007_flutterwave_test_deposits.sql` creates FlowPay provider-reference metadata. Migration `008_flutterwave_ngn_clearing_account.sql` provisions one dedicated NGN system clearing account with a zero opening balance and a stable role marker. It does not create customers, customer wallet balances, or provider-issued bank accounts. The clearing account is an internal balancing account, not proof of funds held by Flutterwave. Review and apply migrations 007 and 008 only to the isolated FlowPay development/test database using the existing migration procedure.

## Verification checklist

1. Confirm API environment contains test-only credentials and an HTTPS FlowPay redirect.
2. Apply migrations 007 and 008 to the isolated FlowPay test database.
3. Confirm a customer can initialize a sandbox checkout for their own active NGN account.
4. Confirm missing auth, foreign account IDs, invalid amounts, and missing test configuration fail closed.
5. Complete a Flutterwave test payment and verify the provider's transaction status.
6. Replay the webhook; confirm the wallet ledger is credited exactly once.
7. Test invalid webhook hashes, wrong currency, amount mismatch, unknown references, and provider verification outages.
8. Confirm production credentials and live mode are absent.

**Status:** The dedicated clearing-account migration and exact-role lookup are now included on the feature branch. A successful end-to-end sandbox transaction has not yet been demonstrated; do not describe the integration as production-ready or live.
