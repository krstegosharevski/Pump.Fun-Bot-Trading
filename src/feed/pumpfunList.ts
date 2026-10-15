import { INITIAL_REAL_TOKEN_RESERVES, INITIAL_VIRTUAL_SOL_RESERVES } from "../chain/curve";
import { log } from "../log";

// pump.fun's own website feed (unofficial, free, rate limit 60 calls/min).
const LIST_URL =
  "https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=false";
const PAGES = [0, 50];
const MAX_BACKOFF_MS = 5 * 60_000;

/** A recently traded coin still on the bonding curve, as listed by pump.fun. */
export interface ListedCoin {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  lastTradeAt: number;
  progressPct: number;
  realSol: number;
  usdMarketCap: number;
  complete: boolean;
  hasSocials: boolean;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parses pump.fun's coin list. Keeps only standard SOL-paired curves (virtual SOL = 30 SOL
 * + real SOL); Mayhem coins and coins paired with other tokens are left out.
 */
export function parseCoinList(body: unknown): ListedCoin[] {
  if (!Array.isArray(body)) return [];
  const out: ListedCoin[] = [];
  for (const c of body as Record<string, any>[]) {
    if (typeof c?.mint !== "string") continue;
    const vSol = num(c.virtual_sol_reserves);
    const rSol = num(c.real_sol_reserves);
    if (vSol - rSol !== Number(INITIAL_VIRTUAL_SOL_RESERVES)) continue;
    const realTokens = num(c.real_token_reserves);
    out.push({
      mint: c.mint,
      name: String(c.name ?? "").slice(0, 40),
      symbol: String(c.symbol ?? "").slice(0, 16),
      creator: String(c.creator ?? ""),
      createdAt: num(c.created_timestamp),
      lastTradeAt: num(c.last_trade_timestamp),
      progressPct: Math.max(0, Math.min(100, (1 - realTokens / Number(INITIAL_REAL_TOKEN_RESERVES)) * 100)),
      realSol: rSol / 1e9,
      usdMarketCap: num(c.usd_market_cap),
      complete: c.complete === true,
      hasSocials: Boolean(c.twitter || c.telegram || c.website),
    });
  }
  return out;
}

/** Polls pump.fun's recently-traded list and backs off when it's slow or rate-limited. */
export class PumpfunListFeed {
  coins: ListedCoin[] = [];
  lastError = "";
  private timer?: NodeJS.Timeout;
  private backoffMs = 0;
  private stopped = true;

  constructor(
    private refreshMs: number,
    private onUpdate: (coins: ListedCoin[]) => void,
  ) {}

  start() {
    this.stopped = false;
    void this.refresh();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (!this.stopped) this.timer = setTimeout(() => void this.refresh(), ms);
  }

  private async refresh() {
    try {
      const all: ListedCoin[] = [];
      for (const offset of PAGES) {
        const res = await fetch(`${LIST_URL}&offset=${offset}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) throw new Error("rate limited (429)");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        all.push(...parseCoinList(await res.json()));
      }
      const seen = new Set<string>();
      this.coins = all.filter((c) => !seen.has(c.mint) && seen.add(c.mint));
      this.lastError = "";
      this.backoffMs = 0;
      this.onUpdate(this.coins);
      this.schedule(this.refreshMs);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(this.refreshMs, this.backoffMs * 2));
      log.warn(`pump.fun coin list unavailable (${this.lastError}); retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.schedule(this.backoffMs);
    }
  }
}
