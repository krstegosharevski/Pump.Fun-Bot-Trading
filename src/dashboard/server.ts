import fs from "node:fs";
import http from "node:http";
import { log } from "../log";

export interface DashboardActions {
  pause(): void;
  resume(): void;
  closeAll(): void;
}

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Local-only dashboard: http://127.0.0.1:<port> */
export function startDashboard(port: number, getState: () => unknown, actions: DashboardActions): http.Server {
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // Reject other Host headers (DNS-rebinding protection).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = http.createServer((req, res) => {
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
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(json(getState()));
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/")) {
      // A custom header can't be sent cross-site without a CORS preflight, which we never allow.
      if (req.headers["x-bot-action"] !== "1") {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const action = { "/api/pause": actions.pause, "/api/resume": actions.resume, "/api/close-all": actions.closeAll }[url];
      if (action) {
        action();
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
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
