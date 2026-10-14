import fs from "node:fs";
import http from "node:http";
import { isBotId, type BotId } from "../bots/registry";
import { log } from "../log";

export interface DashboardActions {
  /** Returns an error message, or null when the bot is starting. */
  start(bot: BotId): string | null;
  stop(): void;
  pause(): void;
  resume(): void;
  closeAll(): void;
  resetHourlyLimit(): void;
  /** Sell one open position now. Returns an error message, or null when the sale started. */
  sell(mint: string): string | null;
}

const MAX_BODY_BYTES = 1024;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Local-only dashboard: http://127.0.0.1:<port> */
export function startDashboard(port: number, getState: () => unknown, actions: DashboardActions): http.Server {
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // Reject other Host headers (DNS-rebinding protection).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(json(body));
    };
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url === "/api/state") {
      send(200, getState());
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/")) {
      // A custom header can't be sent cross-site without a CORS preflight, which we never allow.
      if (req.headers["x-bot-action"] !== "1") {
        res.writeHead(403).end("Forbidden");
        return;
      }
      if (url === "/api/start") {
        let bot: unknown;
        try {
          bot = JSON.parse(await readBody(req)).bot;
        } catch {
          send(400, { ok: false, error: "bad request" });
          return;
        }
        if (!isBotId(bot)) {
          send(400, { ok: false, error: "unknown bot" });
          return;
        }
        const error = actions.start(bot);
        send(error ? 409 : 200, { ok: !error, error });
        return;
      }
      if (url === "/api/sell") {
        let mint: unknown;
        try {
          mint = JSON.parse(await readBody(req)).mint;
        } catch {
          send(400, { ok: false, error: "bad request" });
          return;
        }
        if (typeof mint !== "string" || !BASE58_ADDRESS.test(mint)) {
          send(400, { ok: false, error: "bad coin address" });
          return;
        }
        const error = actions.sell(mint);
        send(error ? 409 : 200, { ok: !error, error });
        return;
      }
      const action = {
        "/api/stop": actions.stop,
        "/api/pause": actions.pause,
        "/api/resume": actions.resume,
        "/api/close-all": actions.closeAll,
        "/api/reset-hourly": actions.resetHourlyLimit,
      }[url];
      if (action) {
        action();
        send(200, { ok: true });
        return;
      }
    }
    res.writeHead(404).end("Not found");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Two bots would overwrite each other's saved state, so refuse to run a second copy.
      log.error(
        `Port ${port} is busy — another copy of the bot is probably already running. Stop it first (Ctrl+C in its terminal).`,
      );
      process.exit(1);
    } else {
      log.error(`Dashboard error: ${err.message}`);
    }
  });
  server.listen(port, "127.0.0.1", () => log.info(`Dashboard: http://127.0.0.1:${port}`));
  return server;
}
