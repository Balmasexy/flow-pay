import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Pool } from "pg";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      allowExitOnIdle: true
    })
  : null;

pool?.on("error", (error) => {
  console.error("FlowPay database pool error:", error.message);
});

const allowedOrigins = new Set(
  [process.env.WEB_ORIGIN, "http://localhost:5173", "https://localhost"].filter(
    (origin): origin is string => Boolean(origin)
  )
);

type Jwk = {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
};
type JwtClaims = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
};
type AuthResult =
  | { subject: string }
  | { error: "missing" | "invalid" | "not_configured" };

let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function authConfig() {
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim();
  const issuer = process.env.NEON_AUTH_ISSUER?.trim();
  const audience = process.env.NEON_AUTH_AUDIENCE?.trim();
  if (!jwksUrl || !issuer || !audience) return null;

  try {
    if (new URL(jwksUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { jwksUrl, issuer, audience };
}

async function getJwks(jwksUrl: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;

  const response = await fetch(jwksUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("JWKS endpoint unavailable");

  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("keys" in body) ||
    !Array.isArray(body.keys)
  ) {
    throw new Error("Invalid JWKS response");
  }

  const keys = body.keys.filter(
    (key): key is Jwk =>
      typeof key === "object" &&
      key !== null &&
      "kid" in key &&
      typeof key.kid === "string" &&
      "kty" in key &&
      key.kty === "RSA" &&
      (!("use" in key) || key.use === "sig") &&
      (!("alg" in key) || key.alg === "RS256")
  );
  if (keys.length === 0) throw new Error("No supported signing keys found");

  jwksCache = { keys, expiresAt: Date.now() + 5 * 60_000 };
  return keys;
}

async function authenticate(req: IncomingMessage): Promise<AuthResult> {
  const authorization = req.headers.authorization;
  if (!authorization) return { error: "missing" };

  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (!match || match[1].length > 16_384) return { error: "invalid" };

  const config = authConfig();
  if (!config) return { error: "not_configured" };

  try {
    const parts = match[1].split(".");
    if (parts.length !== 3) return { error: "invalid" };

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: string;
      kid?: string;
      typ?: string;
    };
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return { error: "invalid" };
    }

    const keys = await getJwks(config.jwksUrl);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      jwksCache = null;
      return { error: "invalid" };
    }

    const publicKey = createPublicKey({ key: JSON.parse(JSON.stringify(jwk)), format: "jwk" });
    const validSignature = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url")
    );
    if (!validSignature) return { error: "invalid" };

    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    const audienceMatches = Array.isArray(claims.aud)
      ? claims.aud.includes(config.audience)
      : claims.aud === config.audience;

    if (
      typeof claims.sub !== "string" ||
      claims.sub.trim().length === 0 ||
      claims.iss !== config.issuer ||
      !audienceMatches ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      (typeof claims.nbf === "number" && claims.nbf > now)
    ) {
      return { error: "invalid" };
    }

    return { subject: claims.sub };
  } catch {
    return { error: "invalid" };
  }
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: Record<string, unknown>
) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function getCustomerAccounts(subject: string) {
  if (!pool) return { kind: "database_unavailable" as const };

  const profile = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM fp_users WHERE auth_subject = $1 LIMIT 1",
    [subject]
  );
  if (profile.rowCount === 0) return { kind: "profile_not_found" as const };
  if (profile.rows[0].status !== "active") return { kind: "profile_inactive" as const };

  const accounts = await pool.query<{
    id: string;
    currency: string;
    status: string;
    ledger_balance_minor: string;
  }>(
    `SELECT
       a.id,
       a.currency,
       a.status,
       COALESCE(
         SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'),
         0
       )::text AS ledger_balance_minor
     FROM fp_accounts a
     LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
     LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1
       AND a.account_type = 'customer'
     GROUP BY a.id, a.currency, a.status, a.created_at
     ORDER BY a.created_at ASC, a.id ASC`,
    [profile.rows[0].id]
  );

  return {
    kind: "ok" as const,
    accounts: accounts.rows.map((account) => ({
      id: account.id,
      currency: account.currency.trim(),
      status: account.status,
      ledger_balance_minor: account.ledger_balance_minor
    }))
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    sendJson(res, 200, {
      service: "flowpay-api",
      status: "ok",
      endpoints: ["/health", "/ready", "/v1/me/accounts"]
    });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      service: "flowpay-api",
      status: "ok",
      environment: process.env.NODE_ENV ?? "development"
    });
    return;
  }

  if (req.method === "GET" && pathname === "/ready") {
    if (!pool) {
      sendJson(res, 503, {
        service: "flowpay-api",
        status: "not_ready",
        database: "not_configured",
        payments: "disabled"
      });
      return;
    }
    try {
      const result = await pool.query<{ database_name: string }>(
        "SELECT current_database() AS database_name"
      );
      sendJson(res, 200, {
        service: "flowpay-api",
        status: "ready",
        database: "connected",
        database_name: result.rows[0]?.database_name,
        payments: "disabled"
      });
    } catch (error) {
      console.error(
        "FlowPay readiness database check failed:",
        error instanceof Error ? error.message : "unknown database error"
      );
      sendJson(res, 503, {
        service: "flowpay-api",
        status: "not_ready",
        database: "unavailable",
        payments: "disabled"
      });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/v1/me/accounts") {
    const auth = await authenticate(req);
    if ("error" in auth) {
      if (auth.error === "not_configured") {
        sendJson(res, 503, { error: "AUTH_NOT_CONFIGURED" });
      } else if (auth.error === "missing") {
        sendJson(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      } else {
        sendJson(res, 401, { error: "INVALID_ACCESS_TOKEN" });
      }
      return;
    }

    try {
      const result = await getCustomerAccounts(auth.subject);
      if (result.kind === "database_unavailable") {
        sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" });
      } else if (result.kind === "profile_not_found") {
        sendJson(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" });
      } else if (result.kind === "profile_inactive") {
        sendJson(res, 403, { error: "CUSTOMER_PROFILE_INACTIVE" });
      } else {
        sendJson(res, 200, { accounts: result.accounts });
      }
    } catch (error) {
      console.error(
        "FlowPay customer accounts query failed:",
        error instanceof Error ? error.message : "unknown database error"
      );
      sendJson(res, 503, { error: "ACCOUNT_DATA_UNAVAILABLE" });
    }
    return;
  }

  sendJson(res, 404, { error: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => console.log(`FlowPay API listening on port ${port}`));

async function shutdown() {
  server.close();
  if (pool) await pool.end();
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
