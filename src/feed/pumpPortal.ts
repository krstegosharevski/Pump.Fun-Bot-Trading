import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../log";

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  /** Tokens (whole units) the creator bought in the launch transaction. */
  initialBuyTokens: number;
  marketCapSol: number;
  pool?: string;
  isMayhem: boolean;
  receivedAt: number;
}

interface FeedEvents {
  newToken: [NewTokenEvent];
  migration: [string];
}

/**
 * PumpPortal websocket: new coin launches and migrations (both free streams).
 * Keeps one connection and reconnects with exponential backoff.
 */
export class PumpPortalFeed extends EventEmitter<FeedEvents> {
  private ws?: WebSocket;
  private retry = 0;
  private stopped = false;
  private watchdog?: NodeJS.Timeout;
  private loggedSample = false;
  connected = false;
  lastMessageAt = 0;
  tokensSeen = 0;

  constructor(
    private url: string,
    private apiKey?: string,
  ) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
    // pump.fun launches coins every few seconds; silence for 60s means a dead socket.
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastMessageAt > 60_000) {
        log.warn("PumpPortal: no messages for 60s, reconnecting");
        this.ws?.terminate();
      }
    }, 15_000);
    this.watchdog.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.close();
  }

  private connect() {
    const url = this.apiKey ? `${this.url}?api-key=${encodeURIComponent(this.apiKey)}` : this.url;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.retry = 0;
      this.connected = true;
      this.lastMessageAt = Date.now();
      log.info("PumpPortal feed connected");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    ws.on("message", (raw) => this.handle(raw.toString()));
    ws.on("error", (err) => log.warn(`PumpPortal socket error: ${err.message}`));
    ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      log.warn(`PumpPortal feed closed, reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private handle(text: string) {
    this.lastMessageAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.message === "string") {
      log.info(`PumpPortal: ${msg.message}`);
      return;
    }
    if (typeof msg.errors === "string" || typeof msg.error === "string") {
      log.warn(`PumpPortal error: ${String(msg.errors ?? msg.error)}`);
      return;
    }
    if (msg.txType === "create" && typeof msg.mint === "string") {
      if (!this.loggedSample) {
        this.loggedSample = true;
        log.debug(`PumpPortal sample create message: ${text}`);
      }
      this.tokensSeen++;
      this.emit("newToken", {
        mint: msg.mint,
        name: String(msg.name ?? "").slice(0, 40),
        symbol: String(msg.symbol ?? "").slice(0, 16),
        creator: String(msg.traderPublicKey ?? ""),
        initialBuyTokens: Number(msg.initialBuy ?? 0),
        marketCapSol: Number(msg.marketCapSol ?? 0),
        pool: typeof msg.pool === "string" ? msg.pool : undefined,
        isMayhem: msg.is_mayhem_mode === true,
        receivedAt: Date.now(),
      });
      return;
    }
    if (msg.txType === "migrate" && typeof msg.mint === "string") {
      this.emit("migration", msg.mint);
    }
  }
}
