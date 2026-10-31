import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

type Customer = { id: string; email: string | null };
type AuthResult = { subject: string } | { error: "missing" | "invalid" | "not_configured" };

function json(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage, maxBytes = 16_384): Promise<string | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > maxBytes) return null;
  }
  return body;
}
function testConfig() {
  const secretKey = process.env.FLW_SECRET_KEY?.trim() ?? "";
  const webhookHash = process.env.FLW_WEBHOOK_SECRET_HASH?.trim() ?? "";
  if (process.env.FLUTTERWAVE_MODE !== "test" || !secretKey.startsWith("FLWSECK_TEST-") || webhookHash.length < 16) return null;
  return { secretKey, webhookHash };
}
function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function handleFlutterwaveDeposit(
  req: IncomingMessage, res: ServerResponse, pool: Pool | null,
  authenticate: (req: IncomingMessage) => Promise<AuthResult>,
  getCustomer: (subject: string) => Promise<Customer | null>
) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); json(res, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
  const config = testConfig();
  if (!config) { json(res, 503, { error: "FLUTTERWAVE_TEST_MODE_NOT_CONFIGURED" }); return; }
  if (!pool) { json(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
  const auth = await authenticate(req);
  if ("error" in auth) {
    json(res, auth.error === "not_configured" ? 503 : 401, { error: auth.error === "not_configured" ? "AUTH_NOT_CONFIGURED" : auth.error === "missing" ? "AUTHENTICATION_REQUIRED" : "INVALID_ACCESS_TOKEN" });
    return;
  }
  let customer: Customer | null;
  try { customer = await getCustomer(auth.subject); }
  catch { json(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE" }); return; }
  if (!customer) { json(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" }); return; }
  if (!customer.email) { json(res, 400, { error: "CUSTOMER_EMAIL_REQUIRED" }); return; }

  const idempotencyKey = req.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 180) {
    json(res, 400, { error: "INVALID_IDEMPOTENCY_KEY" }); return;
  }
  const raw = await readBody(req);
  if (raw === null) { json(res, 413, { error: "REQUEST_TOO_LARGE" }); return; }
  let input: unknown;
  try { input = JSON.parse(raw); } catch { json(res, 400, { error: "INVALID_JSON" }); return; }
  if (typeof input !== "object" || input === null) { json(res, 400, { error: "INVALID_REQUEST_BODY" }); return; }
  const body = input as { accountId?: unknown; amountMinor?: unknown };
  if (typeof body.accountId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.accountId) ||
      typeof body.amountMinor !== "string" || !/^[1-9][0-9]{0,9}$/.test(body.amountMinor)) {
    json(res, 400, { error: "INVALID_DEPOSIT_FIELDS" }); return;
  }
  const amountMinor = BigInt(body.amountMinor);
  if (amountMinor < 10000n || amountMinor > 100000000n) {
    json(res, 400, { error: "DEPOSIT_AMOUNT_OUT_OF_RANGE", minimumMinor: "10000", maximumMinor: "100000000" }); return;
  }
  const client = await pool.connect().catch(() => null);
  if (!client) { json(res, 503, { error: "DATABASE_UNAVAILABLE" }); return; }
  try {
    await client.query("BEGIN");
    const accountResult = await client.query<{ id: string; status: string; currency: string }>(
      "SELECT id, status, currency FROM fp_accounts WHERE id = $1 AND user_id = $2 AND account_type = 'customer' FOR UPDATE",
      [body.accountId, customer.id]
    );
    const account = accountResult.rows[0];
    if (!account || account.status !== "active" || account.currency.trim() !== "NGN") {
      await client.query("ROLLBACK"); json(res, 403, { error: "ACTIVE_OWNED_NGN_ACCOUNT_REQUIRED" }); return;
    }
    const replay = await client.query<{ transaction_id: string; checkout_url: string; amount_minor: string }>(
      `SELECT d.transaction_id, d.checkout_url, d.amount_minor::text
       FROM fp_flutterwave_deposits d JOIN fp_ledger_transactions t ON t.id = d.transaction_id
       WHERE t.idempotency_key = $1 AND d.user_id = $2`, [idempotencyKey, customer.id]
    );
    if (replay.rows[0]) {
      const previous = replay.rows[0];
      if (previous.amount_minor !== amountMinor.toString()) {
        await client.query("ROLLBACK"); json(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" }); return;
      }
      await client.query("COMMIT");
      json(res, 200, { provider: "flutterwave", mode: "test", transactionId: previous.transaction_id, amountMinor: previous.amount_minor, currency: "NGN", checkoutUrl: previous.checkout_url, replayed: true });
      return;
    }
    const clearingResult = await client.query<{ id: string }>(
      "SELECT id FROM fp_accounts WHERE account_type = 'system' AND currency = 'NGN' AND status = 'active' ORDER BY created_at, id LIMIT 1 FOR UPDATE"
    );
    const clearing = clearingResult.rows[0];
    if (!clearing) { await client.query("ROLLBACK"); json(res, 503, { error: "NGN_CLEARING_ACCOUNT_NOT_CONFIGURED" }); return; }
    await client.query("COMMIT");

    const txRef = `flowpay_test_${randomUUID()}`;
    const amountNgn = Number(amountMinor) / 100;
    const providerResponse = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.secretKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        tx_ref: txRef, amount: amountNgn.toFixed(2), currency: "NGN",
        redirect_url: process.env.FLOWPAY_FLUTTERWAVE_REDIRECT_URL,
        customer: { email: customer.email },
        meta: { flowpay: true, mode: "test" },
        customizations: { title: "FlowPay", description: "FlowPay sandbox deposit" }
      }),
      signal: AbortSignal.timeout(12_000)
    });
    const providerBody: unknown = await providerResponse.json().catch(() => null);
    const response = providerBody as { status?: string; message?: string; data?: { link?: string } } | null;
    if (!providerResponse.ok || response?.status !== "success" || typeof response.data?.link !== "string") {
      json(res, 502, { error: "FLUTTERWAVE_CHECKOUT_INITIALIZATION_FAILED" }); return;
    }

    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>("SELECT id FROM fp_ledger_transactions WHERE idempotency_key = $1", [idempotencyKey]);
    if (existing.rows.length) { await client.query("ROLLBACK"); json(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" }); return; }
    const tx = await client.query<{ id: string }>(
      "INSERT INTO fp_ledger_transactions (idempotency_key, transaction_type, status, description) VALUES ($1, 'flutterwave_deposit', 'pending', 'FlowPay Flutterwave test-mode deposit') RETURNING id",
      [idempotencyKey]
    );
    const transactionId = tx.rows[0].id;
    await client.query(
      "INSERT INTO fp_ledger_entries (transaction_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')",
      [transactionId, account.id, amountMinor.toString(), clearing.id, (-amountMinor).toString()]
    );
    await client.query(
      "INSERT INTO fp_flutterwave_deposits (transaction_id, user_id, account_id, provider_tx_ref, amount_minor, currency, checkout_url) VALUES ($1, $2, $3, $4, $5, 'NGN', $6)",
      [transactionId, customer.id, account.id, txRef, amountMinor.toString(), response.data.link]
    );
    await client.query("COMMIT");
    json(res, 201, { provider: "flutterwave", mode: "test", transactionId, providerReference: txRef, amountMinor: amountMinor.toString(), currency: "NGN", status: "pending", checkoutUrl: response.data.link, replayed: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("FlowPay Flutterwave deposit initialization failed:", error instanceof Error ? error.message : "unknown error");
    json(res, 503, { error: "DEPOSIT_INITIALIZATION_UNAVAILABLE" });
  } finally { client.release(); }
}

export async function handleFlutterwaveWebhook(req: IncomingMessage, res: ServerResponse, pool: Pool | null) {
  const config = testConfig();
  if (!config) { json(res, 503, { error: "FLUTTERWAVE_TEST_MODE_NOT_CONFIGURED" }); return; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); json(res, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
  const signature = req.headers["verif-hash"];
  if (typeof signature !== "string" || !safeEqual(signature, config.webhookHash)) { json(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" }); return; }
  if (!pool) { json(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
  const raw = await readBody(req);
  if (raw === null) { json(res, 413, { error: "REQUEST_TOO_LARGE" }); return; }
  let event: unknown;
  try { event = JSON.parse(raw); } catch { json(res, 400, { error: "INVALID_JSON" }); return; }
  if (typeof event !== "object" || event === null) { json(res, 400, { error: "INVALID_WEBHOOK" }); return; }
  const payload = event as { event?: unknown; data?: { id?: unknown; tx_ref?: unknown } };
  if (typeof payload.data?.id !== "number" && typeof payload.data?.id !== "string") { json(res, 400, { error: "INVALID_PROVIDER_TRANSACTION_ID" }); return; }
  const providerId = String(payload.data.id);
  const verifiedResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(providerId)}/verify`, {
    headers: { Authorization: `Bearer ${config.secretKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(12_000)
  }).catch(() => null);
  if (!verifiedResponse?.ok) { json(res, 502, { error: "PROVIDER_VERIFICATION_UNAVAILABLE" }); return; }
  const verifiedBody = await verifiedResponse.json().catch(() => null) as {
    status?: string; data?: { id?: number; tx_ref?: string; status?: string; currency?: string; amount?: number; charged_amount?: number }
  } | null;
  const data = verifiedBody?.data;
  if (verifiedBody?.status !== "success" || data?.status !== "successful" || typeof data.tx_ref !== "string" ||
      data.currency !== "NGN" || typeof data.id !== "number" || !Number.isFinite(data.amount)) {
    json(res, 200, { received: true, credited: false, reason: "PAYMENT_NOT_VERIFIED_AS_SUCCESSFUL" }); return;
  }
  const client = await pool.connect().catch(() => null);
  if (!client) { json(res, 503, { error: "DATABASE_UNAVAILABLE" }); return; }
  try {
    await client.query("BEGIN");
    const depositResult = await client.query<{
      transaction_id: string; account_id: string; amount_minor: string; provider_transaction_id: string | null; status: string
    }>(
      "SELECT transaction_id, account_id, amount_minor::text, provider_transaction_id, status FROM fp_flutterwave_deposits WHERE provider_tx_ref = $1 FOR UPDATE",
      [data.tx_ref]
    );
    const deposit = depositResult.rows[0];
    if (!deposit) { await client.query("ROLLBACK"); json(res, 200, { received: true, credited: false, reason: "UNKNOWN_FLOWPAY_REFERENCE" }); return; }
    const verifiedMinor = BigInt(Math.round(data.amount * 100));
    if (verifiedMinor !== BigInt(deposit.amount_minor) || (deposit.provider_transaction_id && deposit.provider_transaction_id !== String(data.id))) {
      await client.query("ROLLBACK"); json(res, 200, { received: true, credited: false, reason: "VERIFIED_PAYMENT_MISMATCH" }); return;
    }
    if (deposit.status === "posted") { await client.query("COMMIT"); json(res, 200, { received: true, credited: true, duplicate: true }); return; }
    if (deposit.status !== "pending") { await client.query("ROLLBACK"); json(res, 200, { received: true, credited: false, reason: "DEPOSIT_NOT_PENDING" }); return; }
    await client.query("UPDATE fp_flutterwave_deposits SET provider_transaction_id = $2, status = 'posted', verified_at = now() WHERE transaction_id = $1", [deposit.transaction_id, String(data.id)]);
    await client.query("UPDATE fp_ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1 AND status = 'pending'", [deposit.transaction_id]);
    await client.query("COMMIT");
    json(res, 200, { received: true, credited: true, duplicate: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("FlowPay Flutterwave webhook processing failed:", error instanceof Error ? error.message : "unknown error");
    json(res, 503, { error: "WEBHOOK_PROCESSING_UNAVAILABLE" });
  } finally { client.release(); }
}
