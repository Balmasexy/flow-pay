import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true
}) : null;

pool?.on("error", (error) => console.error("FlowPay database pool error:", error.message));
const allowedOrigins = new Set(
  [process.env.WEB_ORIGIN, "http://localhost:5173", "https://localhost"].filter(
    (origin): origin is string => Boolean(origin)
  )
);

type Jwk = { kid?: string; kty?: string; use?: string; alg?: string; [key: string]: unknown };
type JwtClaims = { sub?: string; iss?: string; aud?: string | string[]; exp?: number; nbf?: number };
type AuthResult = { subject: string } | { error: "missing" | "invalid" | "not_configured" };
type Customer = { id: string; email: string | null; status: string; created_at: Date };
let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function authConfig() {
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim();
  const issuer = process.env.NEON_AUTH_ISSUER?.trim();
  const audience = process.env.NEON_AUTH_AUDIENCE?.trim();
  if (!jwksUrl || !issuer || !audience) return null;
  try { if (new URL(jwksUrl).protocol !== "https:") return null; }
  catch { return null; }
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
  if (typeof body !== "object" || body === null || !("keys" in body) || !Array.isArray(body.keys)) {
    throw new Error("Invalid JWKS response");
  }
  const keys = body.keys.filter((key): key is Jwk =>
    typeof key === "object" && key !== null &&
    "kid" in key && typeof key.kid === "string" &&
    "kty" in key && key.kty === "RSA" &&
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
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || typeof header.kid !== "string") return { error: "invalid" };
    const keys = await getJwks(config.jwksUrl);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) { jwksCache = null; return { error: "invalid" }; }
    const publicKey = createPublicKey({ key: JSON.parse(JSON.stringify(jwk)), format: "jwk" });
    if (!verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2], "base64url"))) {
      return { error: "invalid" };
    }
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    const audienceMatches = Array.isArray(claims.aud) ? claims.aud.includes(config.audience) : claims.aud === config.audience;
    if (typeof claims.sub !== "string" || !claims.sub.trim() ||
      claims.iss !== config.issuer || !audienceMatches ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now))) {
      return { error: "invalid" };
    }
    return { subject: claims.sub };
  } catch {
    return { error: "invalid" };
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function getCustomer(subject: string): Promise<Customer | null> {
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  const result = await pool.query<Customer>(
    "SELECT id, email, status, created_at FROM fp_users WHERE auth_subject = $1 LIMIT 1",
    [subject]
  );
  const customer = result.rows[0];
  if (!customer) return null;
  if (customer.status !== "active") throw new Error("CUSTOMER_PROFILE_INACTIVE");
  return customer;
}

function authError(res: ServerResponse, error: AuthResult extends infer _T ? string : never) {
  if (error === "not_configured") sendJson(res, 503, { error: "AUTH_NOT_CONFIGURED" });
  else if (error === "missing") sendJson(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  else sendJson(res, 401, { error: "INVALID_ACCESS_TOKEN" });
}

async function handleProtected(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
  const auth = await authenticate(req);
  if ("error" in auth) { authError(res, auth.error); return; }
  if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }

  let customer: Customer | null;
  try {
    customer = await getCustomer(auth.subject);
  } catch (error) {
    if (error instanceof Error && error.message === "CUSTOMER_PROFILE_INACTIVE") {
      sendJson(res, 403, { error: "CUSTOMER_PROFILE_INACTIVE" });
    } else {
      sendJson(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE" });
    }
    return;
  }
  if (!customer) { sendJson(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" }); return; }

  try {
    if (req.method !== "GET") { sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" }); return; }

    if (pathname === "/v1/me/profile") {
      sendJson(res, 200, { profile: {
        id: customer.id, email: customer.email, status: customer.status, created_at: customer.created_at
      }});
      return;
    }

    if (pathname === "/v1/me/accounts") {
      const result = await pool.query(
        `SELECT a.id, a.currency, a.status,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS ledger_balance_minor
         FROM fp_accounts a
         LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
         LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
         WHERE a.user_id = $1 AND a.account_type = 'customer'
         GROUP BY a.id, a.currency, a.status, a.created_at
         ORDER BY a.created_at ASC, a.id ASC`,
        [customer.id]
      );
      sendJson(res, 200, { accounts: result.rows.map((row) => ({
        ...row, currency: String(row.currency).trim(), ledger_balance_minor: String(row.ledger_balance_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/summary") {
      const result = await pool.query(
        `SELECT a.currency,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS net_balance_minor,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted' AND e.amount_minor > 0), 0)::text AS money_received_minor,
          COALESCE(-SUM(e.amount_minor) FILTER (WHERE t.status = 'posted' AND e.amount_minor < 0), 0)::text AS money_sent_minor
         FROM fp_accounts a
         LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
         LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
         WHERE a.user_id = $1 AND a.account_type = 'customer'
         GROUP BY a.currency ORDER BY a.currency`,
        [customer.id]
      );
      sendJson(res, 200, { totals: result.rows.map((row) => ({
        currency: String(row.currency).trim(),
        net_balance_minor: String(row.net_balance_minor),
        money_received_minor: String(row.money_received_minor),
        money_sent_minor: String(row.money_sent_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/transactions") {
      const requested = url.searchParams.get("type") ?? "all";
      if (!["all", "received", "sent", "transfers"].includes(requested)) {
        sendJson(res, 400, { error: "INVALID_TRANSACTION_FILTER" }); return;
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
      const filter = requested === "received" ? "AND t.status = 'posted' AND e.amount_minor > 0"
        : requested === "sent" ? "AND t.status = 'posted' AND e.amount_minor < 0"
        : requested === "transfers" ? "AND t.transaction_type ILIKE '%transfer%'" : "";
      const result = await pool.query(
        `SELECT t.id, t.transaction_type, t.status, t.description, t.created_at,
          e.currency, SUM(e.amount_minor)::text AS amount_minor
         FROM fp_ledger_transactions t
         JOIN fp_ledger_entries e ON e.transaction_id = t.id
         JOIN fp_accounts a ON a.id = e.account_id
         WHERE a.user_id = $1 AND a.account_type = 'customer' ${filter}
         GROUP BY t.id, t.transaction_type, t.status, t.description, t.created_at, e.currency
         ORDER BY t.created_at DESC, t.id DESC LIMIT $2`,
        [customer.id, limit]
      );
      sendJson(res, 200, { transactions: result.rows.map((row) => ({
        ...row, currency: String(row.currency).trim(), amount_minor: String(row.amount_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/cards") {
      const result = await pool.query(
        `SELECT id, card_type, status, last4, expiry_month, expiry_year, created_at, updated_at
         FROM fp_cards WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
        [customer.id]
      );
      sendJson(res, 200, { cards: result.rows });
      return;
    }

    if (pathname === "/v1/me/card-events") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
      const result = await pool.query(
        `SELECT e.id, e.card_id, e.event_type, e.outcome, e.created_at
         FROM fp_card_events e
         JOIN fp_cards c ON c.id = e.card_id
         WHERE c.user_id = $1
         ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
        [customer.id, limit]
      );
      sendJson(res, 200, { events: result.rows });
      return;
    }

    const cardEventMatch = /^\/v1\/me\/cards\/([0-9a-f-]{36})\/events$/.exec(pathname);
    if (cardEventMatch) {
      const result = await pool.query(
        `SELECT e.id, e.event_type, e.outcome, e.created_at
         FROM fp_card_events e
         JOIN fp_cards c ON c.id = e.card_id
         WHERE c.id = $1 AND c.user_id = $2
         ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
        [cardEventMatch[1], customer.id]
      );
      sendJson(res, 200, { events: result.rows });
      return;
    }

    sendJson(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    console.error("FlowPay customer read API failed:", error instanceof Error ? error.message : "unknown error");
    sendJson(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE", detail: "Required read-only data is unavailable. Verify database migrations and schema." });
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && pathname === "/") {
    sendJson(res, 200, { service: "flowpay-api", status: "ok", endpoints: [
      "/health", "/ready", "/v1/me/profile", "/v1/me/accounts", "/v1/me/summary",
      "/v1/me/transactions", "/v1/me/cards", "/v1/me/card-events"
    ]});
    return;
  }
  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { service: "flowpay-api", status: "ok", environment: process.env.NODE_ENV ?? "development" });
    return;
  }
  if (req.method === "GET" && pathname === "/ready") {
    if (!pool) { sendJson(res, 503, { service: "flowpay-api", status: "not_ready", database: "not_configured", payments: "disabled" }); return; }
    try {
      const result = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
      sendJson(res, 200, { service: "flowpay-api", status: "ready", database: "connected", database_name: result.rows[0]?.database_name, payments: "disabled" });
    } catch (error) {
      console.error("FlowPay readiness database check failed:", error instanceof Error ? error.message : "unknown database error");
      sendJson(res, 503, { service: "flowpay-api", status: "not_ready", database: "unavailable", payments: "disabled" });
    }
    return;
  }
  if (pathname.startsWith("/v1/me/")) {
    if (!["GET", "OPTIONS"].includes(req.method ?? "")) { sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", financial_actions: "disabled" }); return; }
    await handleProtected(req, res, pathname, url);
    return;
  }
  sendJson(res, 404, { error: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => console.log(`FlowPay API listening on port ${port}`));
async function shutdown() { server.close(); if (pool) await pool.end(); }
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
