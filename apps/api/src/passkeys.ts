import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture
} from "@simplewebauthn/server";

type Customer = { id: string; email: string | null };
type PasskeyRow = {
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[] | null;
  device_type: string | null;
  backed_up: boolean;
};
type Ceremony = "registration" | "authentication";

const RP_NAME = process.env.PASSKEY_RP_NAME?.trim() || "FlowPay";
const RP_ID = process.env.PASSKEY_RP_ID?.trim();
const EXPECTED_ORIGIN = process.env.PASSKEY_ORIGIN?.trim();
const CHALLENGE_TTL_MINUTES = 5;

function send(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) return null;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function configReady(): boolean {
  if (!RP_ID || !EXPECTED_ORIGIN) return false;
  try {
    const origin = new URL(EXPECTED_ORIGIN);
    return origin.protocol === "https:" && origin.hostname === RP_ID;
  } catch { return false; }
}

async function createCeremony(pool: Pool, customerId: string, purpose: Ceremony, challenge: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO fp_passkey_challenges (id, user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 minute'))`,
    [id, customerId, purpose, challenge, CHALLENGE_TTL_MINUTES]
  );
  return id;
}

async function consumeCeremony(pool: Pool, customerId: string, purpose: Ceremony, id: unknown) {
  if (typeof id !== "string" || id.length > 64) return null;
  const result = await pool.query<{ challenge: string }>(
    `UPDATE fp_passkey_challenges SET consumed_at = NOW()
      WHERE id = $1 AND user_id = $2 AND purpose = $3
        AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING challenge`,
    [id, customerId, purpose]
  );
  return result.rows[0]?.challenge ?? null;
}

export async function handlePasskeyRoute(
  req: IncomingMessage, res: ServerResponse, pool: Pool, customer: Customer, pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/v1/me/passkeys")) return false;
  if (!configReady()) {
    send(res, 503, { error: "PASSKEYS_NOT_CONFIGURED", message: "Passkey relying-party settings are not configured safely." });
    return true;
  }

  try {
    if (req.method === "GET" && pathname === "/v1/me/passkeys") {
      const result = await pool.query(
        `SELECT id, name, device_type, backed_up, created_at, last_used_at
           FROM fp_passkeys WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [customer.id]
      );
      send(res, 200, { passkeys: result.rows });
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/me/passkeys/register/options") {
      const existing = await pool.query<{ credential_id: string }>(
        "SELECT credential_id FROM fp_passkeys WHERE user_id = $1 AND revoked_at IS NULL",
        [customer.id]
      );
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID!,
        userID: new TextEncoder().encode(customer.id),
        userName: customer.email || customer.id,
        userDisplayName: customer.email || "FlowPay customer",
        attestationType: "none",
        excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: CHALLENGE_TTL_MINUTES * 60_000
      });
      const ceremonyId = await createCeremony(pool, customer.id, "registration", options.challenge);
      send(res, 200, { ceremonyId, options });
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/me/passkeys/register/verify") {
      const body = await readJson(req);
      if (!body || typeof body.ceremonyId !== "string" || typeof body.name !== "string" ||
          !body.response || typeof body.response !== "object") {
        send(res, 400, { error: "INVALID_REQUEST" }); return true;
      }
      const challenge = await consumeCeremony(pool, customer.id, "registration", body.ceremonyId);
      if (!challenge) { send(res, 400, { error: "CHALLENGE_EXPIRED_OR_USED" }); return true; }
      const verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: EXPECTED_ORIGIN!,
        expectedRPID: RP_ID!,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        send(res, 400, { error: "PASSKEY_REGISTRATION_FAILED" }); return true;
      }
      const info = verification.registrationInfo;
      const credential = info.credential;
      await pool.query(
        `INSERT INTO fp_passkeys
          (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          customer.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
          (body.transports as string[] | undefined) ?? [],
          info.credentialDeviceType, info.credentialBackedUp,
          body.name.trim().slice(0, 80) || "Passkey"
        ]
      );
      await pool.query(
        "INSERT INTO fp_security_audit_events (user_id, event_type, outcome, details) VALUES ($1, 'passkey_registered', 'succeeded', $2::jsonb)",
        [customer.id, JSON.stringify({ deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp })]
      );
      send(res, 201, { verified: true, message: "Passkey registered for this signed-in FlowPay account." });
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/me/passkeys/auth/options") {
      const rows = await pool.query<{ credential_id: string; transports: string[] | null }>(
        "SELECT credential_id, transports FROM fp_passkeys WHERE user_id = $1 AND revoked_at IS NULL",
        [customer.id]
      );
      if (rows.rowCount === 0) { send(res, 404, { error: "NO_ACTIVE_PASSKEYS" }); return true; }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID!,
        allowCredentials: rows.rows.map((row) => ({
          id: row.credential_id,
          transports: (row.transports ?? []) as AuthenticatorTransportFuture[]
        })),
        userVerification: "required",
        timeout: CHALLENGE_TTL_MINUTES * 60_000
      });
      const ceremonyId = await createCeremony(pool, customer.id, "authentication", options.challenge);
      send(res, 200, { ceremonyId, options });
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/me/passkeys/auth/verify") {
      const body = await readJson(req);
      if (!body || typeof body.ceremonyId !== "string" || !body.response ||
          typeof body.response !== "object" || typeof (body.response as Record<string, unknown>).id !== "string") {
        send(res, 400, { error: "INVALID_REQUEST" }); return true;
      }
      const challenge = await consumeCeremony(pool, customer.id, "authentication", body.ceremonyId);
      if (!challenge) { send(res, 400, { error: "CHALLENGE_EXPIRED_OR_USED" }); return true; }
      const response = body.response as AuthenticationResponseJSON;
      const result = await pool.query<PasskeyRow>(
        `SELECT credential_id, public_key, counter, transports, device_type, backed_up
           FROM fp_passkeys
          WHERE user_id = $1 AND credential_id = $2 AND revoked_at IS NULL LIMIT 1`,
        [customer.id, response.id]
      );
      const row = result.rows[0];
      if (!row) { send(res, 401, { error: "PASSKEY_NOT_REGISTERED_TO_ACCOUNT" }); return true; }
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: EXPECTED_ORIGIN!,
        expectedRPID: RP_ID!,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: (row.transports ?? []) as AuthenticatorTransportFuture[]
        },
        requireUserVerification: true
      });
      if (!verification.verified) {
        await pool.query(
          "INSERT INTO fp_security_audit_events (user_id, event_type, outcome) VALUES ($1, 'passkey_step_up', 'failed')",
          [customer.id]
        );
        send(res, 401, { error: "PASSKEY_VERIFICATION_FAILED" }); return true;
      }
      await pool.query(
        "UPDATE fp_passkeys SET counter = $1, last_used_at = NOW() WHERE user_id = $2 AND credential_id = $3 AND revoked_at IS NULL",
        [verification.authenticationInfo.newCounter, customer.id, row.credential_id]
      );
      await pool.query(
        "INSERT INTO fp_security_audit_events (user_id, event_type, outcome) VALUES ($1, 'passkey_step_up', 'succeeded')",
        [customer.id]
      );
      send(res, 200, { verified: true, purpose: "step_up_only", message: "Passkey verified. This does not enable payments or transfers." });
      return true;
    }

    const revokeMatch = pathname.match(/^\/v1\/me\/passkeys\/([0-9a-f-]{36})$/i);
    if (req.method === "DELETE" && revokeMatch) {
      const result = await pool.query(
        "UPDATE fp_passkeys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [revokeMatch[1], customer.id]
      );
      if (!result.rowCount) { send(res, 404, { error: "PASSKEY_NOT_FOUND" }); return true; }
      await pool.query(
        "INSERT INTO fp_security_audit_events (user_id, event_type, outcome) VALUES ($1, 'passkey_revoked', 'succeeded')",
        [customer.id]
      );
      send(res, 200, { revoked: true });
      return true;
    }

    send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  } catch (error) {
    console.error("FlowPay passkey operation failed:", error instanceof Error ? error.message : "unknown error");
    send(res, 500, { error: "PASSKEY_OPERATION_FAILED" });
    return true;
  }
}
