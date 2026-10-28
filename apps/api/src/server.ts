import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createServer } from "node:http";
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

type JwtClaims = {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };
type JwksDocument = { keys?: Jwk[] };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

class InvalidTokenError extends Error {}
class AuthUnavailableError extends Error {}

function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

async function getSigningKey(kid: string): Promise<Jwk> {
  const jwksUrl = process.env.AUTH_JWKS_URL?.trim();
  if (!jwksUrl || !process.env.AUTH_ISSUER?.trim() || !process.env.AUTH_AUDIENCE?.trim()) {
    throw new AuthUnavailableError("Authentication is not configured");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(jwksUrl);
  } catch {
    throw new AuthUnavailableError("Authentication key URL is invalid");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new AuthUnavailableError("Authentication key URL must use HTTPS");
  }

  if (!jwksCache || Date.now() - jwksCache.fetchedAt > 5 * 60 * 1000) {
    try {
      const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
      const document = await response.json() as JwksDocument;
      if (!Array.isArray(document.keys)) throw new Error("Invalid JWKS document");
      jwksCache = { keys: document.keys, fetchedAt: Date.now() };
    } catch {
      throw new AuthUnavailableError("Authentication signing keys are unavailable");
    }
  }

  let key = jwksCache.keys.find((candidate) =>
    candidate.kid === kid && candidate.kty === "RSA" && (!candidate.use || candidate.use === "sig") &&
    (!candidate.alg || candidate.alg === "RS256")
  );
  if (!key) {
    jwksCache = null;
    try {
      const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("JWKS refresh failed");
      const document = await response.json() as JwksDocument;
      if (!Array.isArray(document.keys)) throw new Error("Invalid JWKS document");
      jwksCache = { keys: document.keys, fetchedAt: Date.now() };
      key = document.keys.find((candidate) =>
        candidate.kid === kid && candidate.kty === "RSA" && (!candidate.use || candidate.use === "sig") &&
        (!candidate.alg || candidate.alg === "RS256")
      );
    } catch {
      throw new AuthUnavailableError("Authentication signing keys are unavailable");
    }
  }
  if (!key) throw new InvalidTokenError("Unknown signing key");
  return key;
}

async function verifyAccessToken(authorization: string | undefined): Promise<string> {
  if (!authorization || !authorization.startsWith("Bearer ") || authorization.length > 8192) {
    throw new InvalidTokenError("Bearer access token required");
  }

  const token = authorization.slice(7).trim();
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new InvalidTokenError("Malformed access token");
  }

  let header: { alg?: unknown; kid?: unknown };
  let claims: JwtClaims;
  try {
    header = decodeJsonSegment(segments[0]);
    claims = decodeJsonSegment(segments[1]);
  } catch {
    throw new InvalidTokenError("Malformed access token");
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new InvalidTokenError("Unsupported access token");
  }

  const key = await getSigningKey(header.kid);
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({ key, format: "jwk" } as unknown as Parameters<typeof createPublicKey>[0]);
    signatureValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`),
      publicKey,
      Buffer.from(segments[2], "base64url")
    );
  } catch {
    throw new InvalidTokenError("Invalid access token signature");
  }
  if (!signatureValid) throw new InvalidTokenError("Invalid access token signature");

  const now = Math.floor(Date.now() / 1000);
  const issuer = process.env.AUTH_ISSUER?.trim();
  const audience = process.env.AUTH_AUDIENCE?.trim();
  if (!issuer || !audience) throw new AuthUnavailableError("Authentication is not configured");
  const tokenAudience = claims.aud;
  const audienceMatches = typeof tokenAudience === "string"
    ? tokenAudience === audience
    : Array.isArray(tokenAudience) && tokenAudience.includes(audience);

  if (
    typeof claims.sub !== "string" || !claims.sub.trim() ||
    claims.iss !== issuer || !audienceMatches ||
    typeof claims.exp !== "number" || claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 30)
  ) {
    throw new InvalidTokenError("Access token claims are invalid or expired");
  }

  return claims.sub;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Origin");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({ service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready", "/v1/me/summary"] }));
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ service: "flowpay-api", status: "ok", environment: process.env.NODE_ENV ?? "development" }));
    return;
  }

  if (req.method === "GET" && pathname === "/ready") {
    if (!pool) {
      res.writeHead(503);
      res.end(JSON.stringify({ service: "flowpay-api", status: "not_ready", database: "not_configured", payments: "disabled" }));
      return;
    }
    try {
      const result = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
      res.writeHead(200);
      res.end(JSON.stringify({ service: "flowpay-api", status: "ready", database: "connected", database_name: result.rows[0]?.database_name, payments: "disabled" }));
    } catch (error) {
      console.error("FlowPay readiness database check failed:", error instanceof Error ? error.message : "unknown database error");
      res.writeHead(503);
      res.end(JSON.stringify({ service: "flowpay-api", status: "not_ready", database: "unavailable", payments: "disabled" }));
    }
    return;
  }

  if (req.method === "GET" && pathname === "/v1/me/summary") {
    if (!pool) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "DATABASE_NOT_CONFIGURED" }));
      return;
    }
    if (!process.env.AUTH_JWKS_URL?.trim() || !process.env.AUTH_ISSUER?.trim() || !process.env.AUTH_AUDIENCE?.trim()) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "AUTH_NOT_CONFIGURED" }));
      return;
    }

    let subject: string;
    try {
      subject = await verifyAccessToken(req.headers.authorization);
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "AUTH_UNAVAILABLE" }));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "UNAUTHENTICATED" }));
      }
      return;
    }

    try {
      const result = await pool.query<{
        account_id: string;
        currency: string;
        account_status: string;
        balance_minor: string;
      }>(
        `SELECT a.id AS account_id,
                a.currency,
                a.status AS account_status,
                COALESCE(
                  SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'),
                  0
                )::text AS balance_minor
           FROM fp_users u
           JOIN fp_accounts a ON a.user_id = u.id AND a.account_type = 'customer'
           LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
           LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
          WHERE u.auth_subject = $1
            AND u.status = 'active'
          GROUP BY a.id, a.currency, a.status, a.created_at
          ORDER BY a.created_at, a.id`,
        [subject]
      );

      if (result.rows.length === 0) {
        const mapping = await pool.query(
          "SELECT 1 FROM fp_users WHERE auth_subject = $1 AND status = 'active' LIMIT 1",
          [subject]
        );
        res.writeHead(mapping.rows.length ? 200 : 404);
        res.end(JSON.stringify(mapping.rows.length
          ? { accounts: [], totals: [], account_status: "no_customer_accounts" }
          : { error: "CUSTOMER_ACCOUNT_NOT_LINKED" }));
        return;
      }

      const totals = new Map<string, bigint>();
      for (const account of result.rows) {
        totals.set(account.currency, (totals.get(account.currency) ?? 0n) + BigInt(account.balance_minor));
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        accounts: result.rows.map((account) => ({
          id: account.account_id,
          currency: account.currency.trim(),
          status: account.account_status,
          balance_minor: account.balance_minor
        })),
        totals: [...totals.entries()].map(([currency, balance]) => ({
          currency,
          balance_minor: balance.toString()
        })),
        source: "posted_ledger_entries"
      }));
    } catch (error) {
      console.error("FlowPay account summary query failed:", error instanceof Error ? error.message : "unknown database error");
      res.writeHead(500);
      res.end(JSON.stringify({ error: "ACCOUNT_SUMMARY_UNAVAILABLE" }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "NOT_FOUND" }));
});

server.listen(port, "0.0.0.0", () => console.log(`FlowPay API listening on port ${port}`));

async function shutdown() {
  server.close();
  if (pool) await pool.end();
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
