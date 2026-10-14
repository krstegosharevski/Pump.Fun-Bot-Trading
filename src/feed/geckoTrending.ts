import { log } from "../log";

const TRENDING_URL = "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h";
const PAGES = [1, 2];
const MAX_BACKOFF_MS = 5 * 60_000;

/** One pool from GeckoTerminal's Solana trending list. */
export interface HotCoin {
  mint: string;
  pool: string;
  symbol: string;
  dex: string;
  quoteMint: string;
  fdvUsd: number;
  liquidityUsd: number;
  change5m: number;
  change1h: number;
  buys1h: number;
  sells1h: number;
  buyers1h: number;
  volume1h: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const idOf = (rel: unknown) => String((rel as { data?: { id?: string } })?.data?.id ?? "").replace(/^solana_/, "");

/** Turns a trending_pools response into HotCoins. Unknown shapes are skipped, never thrown. */
export function parseTrending(body: unknown): HotCoin[] {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: HotCoin[] = [];
  for (const p of data as Record<string, any>[]) {
    const a = p?.attributes;
    const r = p?.relationships;
    if (!a || !r) continue;
    const mint = idOf(r.base_token);
    if (!mint || typeof a.address !== "string") continue;
    out.push({
      mint,
      pool: a.address,
      symbol: String(a.name ?? "").split(" / ")[0].slice(0, 16),
      dex: idOf(r.dex),
      quoteMint: idOf(r.quote_token),
      fdvUsd: num(a.market_cap_usd ?? a.fdv_usd) || num(a.fdv_usd),
      liquidityUsd: num(a.reserve_in_usd),
      change5m: num(a.price_change_percentage?.m5),
      change1h: num(a.price_change_percentage?.h1),
      buys1h: num(a.transactions?.h1?.buys),
      sells1h: num(a.transactions?.h1?.sells),
      buyers1h: num(a.transactions?.h1?.buyers),
      volume1h: num(a.volume_usd?.h1),
    });
  }
  return out;
}

/** Polls GeckoTerminal's 1h trending list (free, keyless) and backs off when rate-limited. */
export class TrendingFeed {
  coins: HotCoin[] = [];
  lastUpdate = 0;
  private timer?: NodeJS.Timeout;
  private backoffMs = 0;
  private stopped = true;

  constructor(
    private refreshMs: number,
    private onUpdate: (coins: HotCoin[]) => void,
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
      const pages: HotCoin[] = [];
      for (const page of PAGES) {
        const res = await fetch(`${TRENDING_URL}&page=${page}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429) throw new Error("rate limited (429)");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        pages.push(...parseTrending(await res.json()));
      }
      const seen = new Set<string>();
      this.coins = pages.filter((c) => !seen.has(c.mint) && seen.add(c.mint));
      this.lastUpdate = Date.now();
      this.backoffMs = 0;
      this.onUpdate(this.coins);
      this.schedule(this.refreshMs);
    } catch (err) {
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(this.refreshMs, this.backoffMs * 2));
      log.warn(`Trending list unavailable (${(err as Error).message}); retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.schedule(this.backoffMs);
    }
  }
}
