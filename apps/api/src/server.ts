import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

const allowedOrigins = new Set(
  [
    process.env.WEB_ORIGIN,
    "http://localhost:5173"
  ].filter((origin): origin is string => Boolean(origin))
);

const server = createServer((req, res) => {
  const origin = req.headers.origin;

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

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      service: "flowpay-api",
      status: "ok",
      environment: process.env.NODE_ENV ?? "development"
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/ready") {
    res.writeHead(200);
    res.end(JSON.stringify({
      service: "flowpay-api",
      status: "ready",
      database: "not_configured",
      payments: "disabled"
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "NOT_FOUND" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`FlowPay API listening on port ${port}`);
});
