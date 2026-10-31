import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

type AuthResult = { subject: string } | { error: "missing" | "invalid" | "not_configured" };
type TierKey = "tier_1" | "tier_2" | "tier_3";

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
    if (size > 16_384) return null;
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function validLimit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^(0|[1-9][0-9]{0,17})$/.test(value));
}

export async function handleAdminConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool | null,
  authenticate: (req: IncomingMessage) => Promise<AuthResult>,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/v1/admin/tiers") &&
      !pathname.startsWith("/v1/admin/roles") &&
      pathname !== "/v1/admin/users" &&
      !/^\/v1\/admin\/users\/[0-9a-f-]{36}\/role$/i.test(pathname)) return false;

  if (!pool) { send(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return true; }
  const auth = await authenticate(req);
  if ("error" in auth) {
    send(res, auth.error === "not_configured" ? 503 : 401, {
      error: auth.error === "not_configured" ? "AUTH_NOT_CONFIGURED"
        : auth.error === "missing" ? "AUTHENTICATION_REQUIRED" : "INVALID_ACCESS_TOKEN"
    });
    return true;
  }

  const adminResult = await pool.query<{ id: string }>(
    "SELECT id FROM fp_users WHERE auth_subject = $1 AND status = 'active' AND role = 'admin' LIMIT 1",
    [auth.subject]
  ).catch(() => null);
  const actor = adminResult?.rows[0];
  if (!actor) { send(res, 403, { error: "SUPER_ADMIN_REQUIRED" }); return true; }

  try {
    if (req.method === "GET" && pathname === "/v1/admin/tiers") {
      const result = await pool.query(
        `SELECT tier_key, display_name, max_balance_minor::text,
                daily_transaction_limit_minor::text, per_transaction_limit_minor::text,
                requires_bvn, requires_nin, requires_proof_of_address, automatic_upgrade, updated_at
           FROM fp_customer_tier_config ORDER BY tier_key`
      );
      send(res, 200, { tiers: result.rows, amounts_unit: "NGN minor units (kobo); null means unlimited or not configured" });
      return true;
    }

    const tierMatch = /^\/v1\/admin\/tiers\/(tier_[123])$/.exec(pathname);
    if (req.method === "PUT" && tierMatch) {
      const body = await readJson(req);
      if (!body || typeof body.displayName !== "string" || body.displayName.trim().length < 2 ||
          body.displayName.trim().length > 60 ||
          !validLimit(body.maxBalanceMinor) || !validLimit(body.dailyTransactionLimitMinor) ||
          !validLimit(body.perTransactionLimitMinor) ||
          typeof body.requiresBvn !== "boolean" || typeof body.requiresNin !== "boolean" ||
          typeof body.requiresProofOfAddress !== "boolean" || typeof body.automaticUpgrade !== "boolean") {
        send(res, 400, { error: "INVALID_TIER_CONFIGURATION" });
        return true;
      }
      if (!body.requiresBvn) {
        send(res, 400, { error: "BVN_REQUIREMENT_CANNOT_BE_DISABLED", message: "FlowPay requires BVN verification for these customer tiers." });
        return true;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = await client.query(
          "SELECT * FROM fp_customer_tier_config WHERE tier_key = $1 FOR UPDATE", [tierMatch[1]]
        );
        if (!before.rows[0]) {
          await client.query("ROLLBACK");
          send(res, 404, { error: "TIER_NOT_FOUND" });
          return true;
        }
        const updated = await client.query(
          `UPDATE fp_customer_tier_config
              SET display_name = $2, max_balance_minor = $3, daily_transaction_limit_minor = $4,
                  per_transaction_limit_minor = $5, requires_bvn = $6, requires_nin = $7,
                  requires_proof_of_address = $8, automatic_upgrade = $9,
                  updated_by = $10, updated_at = NOW()
            WHERE tier_key = $1
            RETURNING tier_key, display_name, max_balance_minor::text,
                      daily_transaction_limit_minor::text, per_transaction_limit_minor::text,
                      requires_bvn, requires_nin, requires_proof_of_address, automatic_upgrade, updated_at`,
          [tierMatch[1], body.displayName.trim(), body.maxBalanceMinor, body.dailyTransactionLimitMinor,
            body.perTransactionLimitMinor, body.requiresBvn, body.requiresNin,
            body.requiresProofOfAddress, body.automaticUpgrade, actor.id]
        );
        await client.query(
          `INSERT INTO fp_admin_config_audit_events
            (actor_user_id, action, entity_key, before_state, after_state)
           VALUES ($1, 'tier_config_updated', $2, $3::jsonb, $4::jsonb)`,
          [actor.id, tierMatch[1], JSON.stringify(before.rows[0]), JSON.stringify(updated.rows[0])]
        );
        await client.query("COMMIT");
        send(res, 200, { updated: true, tier: updated.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/admin/users") {
      const limitRaw = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("limit") ?? "100");
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 100;
      const result = await pool.query(
        `SELECT u.id, u.email, u.status, u.role AS legacy_role, u.created_at,
                a.role_code AS assigned_role_code, d.display_name AS assigned_role_name
           FROM fp_users u
           LEFT JOIN fp_user_role_assignments a ON a.user_id = u.id
           LEFT JOIN fp_role_definitions d ON d.role_code = a.role_code
          ORDER BY u.created_at DESC, u.id
          LIMIT $1`,
        [limit]
      );
      send(res, 200, { users: result.rows, limit, note: "Customer and staff directory; sensitive identity data is excluded." });
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/admin/roles") {
      const result = await pool.query(
        `SELECT d.role_code, d.display_name, d.description, d.is_assignable,
                COUNT(a.user_id)::int AS assigned_users
           FROM fp_role_definitions d
           LEFT JOIN fp_user_role_assignments a ON a.role_code = d.role_code
          GROUP BY d.role_code ORDER BY d.display_name`
      );
      send(res, 200, { roles: result.rows, super_admin_role: "admin (protected legacy bootstrap role)" });
      return true;
    }

    const assignmentMatch = /^\/v1\/admin\/users\/([0-9a-f-]{36})\/role$/i.exec(pathname);
    if (assignmentMatch && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.roleCode !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(body.roleCode)) {
        send(res, 400, { error: "INVALID_ROLE_ASSIGNMENT" });
        return true;
      }
      if (assignmentMatch[1] === actor.id) {
        send(res, 409, { error: "SELF_ROLE_ASSIGNMENT_NOT_ALLOWED" });
        return true;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query<{ id: string; role: string }>(
          "SELECT id, role FROM fp_users WHERE id = $1 AND status = 'active' FOR UPDATE", [assignmentMatch[1]]
        );
        const role = await client.query<{ role_code: string }>(
          "SELECT role_code FROM fp_role_definitions WHERE role_code = $1 AND is_assignable = TRUE", [body.roleCode]
        );
        if (!target.rows[0] || !role.rows[0]) {
          await client.query("ROLLBACK");
          send(res, 404, { error: !target.rows[0] ? "ACTIVE_USER_NOT_FOUND" : "ASSIGNABLE_ROLE_NOT_FOUND" });
          return true;
        }
        if (target.rows[0].role === "admin") {
          await client.query("ROLLBACK");
          send(res, 409, { error: "SUPER_ADMIN_ASSIGNMENT_PROTECTED" });
          return true;
        }
        if (body.roleCode === "customer") {
          await client.query("ROLLBACK");
          send(res, 400, { error: "CUSTOMER_ROLE_IS_NOT_A_STAFF_ASSIGNMENT" });
          return true;
        }
        const previous = await client.query(
          "SELECT role_code, assigned_by, assigned_at FROM fp_user_role_assignments WHERE user_id = $1 FOR UPDATE",
          [assignmentMatch[1]]
        );
        const result = await client.query(
          `INSERT INTO fp_user_role_assignments (user_id, role_code, assigned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET role_code = EXCLUDED.role_code,
             assigned_by = EXCLUDED.assigned_by, assigned_at = NOW(), updated_at = NOW()
           RETURNING user_id, role_code, assigned_by, assigned_at`,
          [assignmentMatch[1], body.roleCode, actor.id]
        );
        await client.query(
          `INSERT INTO fp_admin_config_audit_events
            (actor_user_id, target_user_id, action, entity_key, before_state, after_state)
           VALUES ($1, $2, 'staff_role_assigned', $3, $4::jsonb, $5::jsonb)`,
          [actor.id, assignmentMatch[1], body.roleCode, JSON.stringify(previous.rows[0] ?? {}),
            JSON.stringify(result.rows[0])]
        );
        await client.query("COMMIT");
        send(res, 200, { assigned: true, assignment: result.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      return true;
    }

    if (assignmentMatch && req.method === "DELETE") {
      if (assignmentMatch[1] === actor.id) {
        send(res, 409, { error: "SELF_ROLE_REMOVAL_NOT_ALLOWED" });
        return true;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query<{ id: string; role: string; status: string }>(
          "SELECT id, role, status FROM fp_users WHERE id = $1 FOR UPDATE", [assignmentMatch[1]]
        );
        if (!target.rows[0] || target.rows[0].status !== "active") {
          await client.query("ROLLBACK");
          send(res, 404, { error: "ACTIVE_USER_NOT_FOUND" });
          return true;
        }
        if (target.rows[0].role === "admin") {
          await client.query("ROLLBACK");
          send(res, 409, { error: "SUPER_ADMIN_ASSIGNMENT_PROTECTED" });
          return true;
        }
        const previous = await client.query(
          "DELETE FROM fp_user_role_assignments WHERE user_id = $1 RETURNING role_code",
          [assignmentMatch[1]]
        );
        if (!previous.rowCount) {
          await client.query("ROLLBACK");
          send(res, 404, { error: "ROLE_ASSIGNMENT_NOT_FOUND" });
          return true;
        }
        await client.query(
          `INSERT INTO fp_admin_config_audit_events
            (actor_user_id, target_user_id, action, entity_key, before_state, after_state)
           VALUES ($1, $2, 'staff_role_removed', $3, $4::jsonb, '{}'::jsonb)`,
          [actor.id, assignmentMatch[1], previous.rows[0].role_code, JSON.stringify(previous.rows[0])]
        );
        await client.query("COMMIT");
        send(res, 200, { removed: true });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      return true;
    }

    send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  } catch (error) {
    console.error("FlowPay admin configuration failed:", error instanceof Error ? error.message : "unknown error");
    send(res, 503, { error: "ADMIN_CONFIGURATION_UNAVAILABLE" });
    return true;
  }
}
