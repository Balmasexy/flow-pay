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
  [process.env.WEB_ORIGIN, "http://localhost:5173"].filter(
    (origin): origin is string => Boolean(origin)
  )
);

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({ service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready"] }));
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
