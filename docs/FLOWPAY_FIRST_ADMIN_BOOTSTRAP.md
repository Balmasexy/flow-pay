# FlowPay first-admin bootstrap (review required)

This change adds a one-time API bootstrap for the first administrator. It does
not apply migrations, configure Render, deploy code, or enable financial actions.

## Preconditions

1. Deploy only after reviewing and merging this change and applying migration
   `005_admin_bootstrap` to the intended FlowPay database with explicit approval.
2. Configure `FLOWPAY_ADMIN_BOOTSTRAP_TOKEN` as a high-entropy secret of at least
   32 characters in the API service's secret environment. Never put it in the
   frontend, repository, URL, logs, or chat.
3. The signed-in person's Neon Auth subject must already be linked to an active
   `fp_users.auth_subject` row. This endpoint deliberately does not link accounts
   by email or create a customer profile.
4. Keep the bootstrap token configured only for the short bootstrap window.
   Remove it from the API environment after the first administrator is created.

## One-time operation

Send an authenticated `POST` request to `/v1/admin/bootstrap` with the current
Neon Auth bearer access token and header `X-FlowPay-Bootstrap-Token` containing
the server-configured bootstrap token. There is no request body.

The API verifies the Neon Auth JWT, checks the bootstrap secret in constant-time,
serializes concurrent attempts with a PostgreSQL advisory transaction lock, and
only promotes the authenticated subject's already-linked active profile if no
administrator exists. A successful attempt is recorded in
`fp_admin_audit_events`. The route does not expose the token or customer data.

Expected outcomes:
- `200 admin_bootstrapped`: first administrator created.
- `403 ADMIN_BOOTSTRAP_FORBIDDEN`: missing or incorrect bootstrap token.
- `404 ACTIVE_LINKED_CUSTOMER_PROFILE_REQUIRED`: no active profile linked to
  the authenticated Neon Auth subject; resolve identity linking through a
  separately reviewed, verified process.
- `409 ADMIN_ALREADY_BOOTSTRAPPED`: bootstrap has already been used.
- `503`: configuration, database, or schema is not ready.

## Important limitations

This bootstrap endpoint is not an admin dashboard and does not yet implement
admin-only business-management routes. Every future admin route must enforce
the database role server-side. Hiding UI elements or trusting client-side role
flags is not authorization. Financial actions remain disabled.
