# Authenticated customer account read API

## Endpoint

`GET /v1/me/accounts`

Requires a verified `Authorization: Bearer <access-token>` header. Returns only customer accounts belonging to the authenticated identity, with balances calculated from ledger entries belonging to transactions whose status is `posted`.

Example response:

```json
{
  "accounts": [
    {
      "id": "account-uuid",
      "currency": "NGN",
      "status": "active",
      "ledger_balance_minor": "125000"
    }
  ]
}
```

`ledger_balance_minor` is a decimal string to avoid integer precision loss in JavaScript. It is the signed ledger total in the currency's minor unit; it is not a guarantee that the amount is spendable. Account status must be considered separately. The API does not convert currencies or create accounts.

## Required API environment

Configure these values on the API service using the exact values from the Neon Auth project; do not guess them:

- `NEON_AUTH_JWKS_URL`: HTTPS URL serving the provider's JSON Web Key Set.
- `NEON_AUTH_ISSUER`: exact expected `iss` claim.
- `NEON_AUTH_AUDIENCE`: expected `aud` claim.

The current verifier accepts RS256 access tokens only and validates the signature, key ID, issuer, audience, expiration, and optional not-before claim. Missing auth configuration fails closed with `503 AUTH_NOT_CONFIGURED`; missing/invalid tokens return `401`. Do not disable these checks to make the endpoint work.

## Database rollout and identity linking

1. Review and apply `003_auth_subject.sql` to the isolated FlowPay Development database using the project's approved migration process. This migration only adds a nullable column and a partial unique index; it does not update or delete existing customer or ledger rows.
2. Link an authenticated subject to an existing `fp_users` row only after independently verifying that the identity belongs to that customer. The unique index prevents one subject from being linked to multiple profiles.
3. Do not automatically create a new customer when the endpoint returns `404 CUSTOMER_PROFILE_NOT_FOUND`; review identity mapping first to avoid duplicate profiles or linking the wrong customer.
4. Confirm the customer account is already present in `fp_accounts` and ledger entries are posted through the server-side ledger workflow.

## Not yet enabled

- The web/mobile client does not yet have a verified Neon Auth sign-in/session flow wired to this endpoint.
- Customer identity-to-profile mapping is not automatic.
- No account creation, transfer, payment, or ledger-writing route is added.
- The endpoint is read-only and does not change financial records.
