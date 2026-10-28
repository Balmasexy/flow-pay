# FlowPay passkeys and face-liveness security

## Scope and safety status

This work is additive. It does not change the existing Neon Auth email/password provider, customer identity mapping, accounts, balances, ledger rows, or payment configuration. Payments and transfers remain disabled.

The API passkey routes in this branch are a **step-up verification feature for an already authenticated Neon Auth customer**. They do not replace Neon Auth sessions and do not independently mint login tokens. This is deliberate: a passkey must not be reported as passwordless sign-in until the identity provider supports a reviewed session-exchange flow.

## Passkey API

Requires the additive migration `004_passkeys_security` and server environment:
- `PASSKEY_RP_NAME=FlowPay`
- `PASSKEY_RP_ID=flowpay-web-jx7i.onrender.com` (set to the exact production/staging hostname chosen for the deployment)
- `PASSKEY_ORIGIN=https://flowpay-web-jx7i.onrender.com` (must be an exact HTTPS origin whose hostname equals the RP ID)

Do not configure these values until the canonical web hostname and Android app association are confirmed. Never use a wildcard origin.

Routes require a valid existing Neon Auth bearer token and a correctly mapped active FlowPay customer:
- `GET /v1/me/passkeys`
- `POST /v1/me/passkeys/register/options`
- `POST /v1/me/passkeys/register/verify` with `{ ceremonyId, response, name, transports? }`
- `POST /v1/me/passkeys/auth/options`
- `POST /v1/me/passkeys/auth/verify` with `{ ceremonyId, response }`
- `DELETE /v1/me/passkeys/:id`

Ceremonies are single-use and expire after five minutes. Verification requires user verification and checks the expected challenge, origin and RP ID through SimpleWebAuthn. Passkeys are scoped to the current customer. Credential public keys and metadata are stored; biometric samples and private keys are not.

## Face-liveness provider integration — intentionally not activated

No provider credentials or account configuration were found in the inspected repository. The integration must not pretend to verify a face without a provider-backed server-side result.

Evaluate Veriff Biometric Authentication first, with Persona as an alternative. Before activation, confirm Nigerian availability for the specific product, commercial terms, Android/web SDKs, biometric template retention/deletion, data residency, webhook signing, face-match behavior across devices, and whether requested active gestures are supported. Presence/liveness alone is not face matching. A shared or universal “master face” is prohibited.

Provider integration should:
1. create a short-lived session tied to the already authenticated FlowPay customer and explicit purpose;
2. verify provider callbacks/signatures server-to-server;
3. verify both liveness and match to that customer's enrollment;
4. fail closed on mismatch, timeout, expired session, replay, invalid webhook, or provider outage;
5. store only provider references, status, timestamps and minimal audit metadata; avoid storing raw selfie video/images in FlowPay;
6. implement consent, deletion/retention rules, a privacy impact assessment and Nigerian data-protection review before production use.

## Android

The inspected branch's README describes `apps/android/` as planned, but the expected Gradle and AndroidManifest files were not found. Do not claim APK support until the real native project is located or created. Use Android Credential Manager for passkeys and the platform biometric prompt only for local user verification; the backend must still validate the passkey assertion.

## Deployment and release gates

1. Review and test the new migration against a disposable database.
2. Run API typecheck, registration/authentication success and rejection tests, expired/replayed challenge tests, cross-customer tests and revoked-credential tests.
3. Apply the migration only to the explicitly selected FlowPay database after backup and approval.
4. Configure exact RP ID/origin and verify the Android association separately.
5. Add UI and provider-backed liveness only after SDK/provider setup and privacy review.
6. Keep transfers and payments disabled and verify the readiness response.
7. Deploy only after CI passes and deployment is explicitly authorized.

This branch must not be considered production-ready merely because the code is committed.
