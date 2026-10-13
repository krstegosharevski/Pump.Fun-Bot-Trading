import { Connection } from "@solana/web3.js";
import { log } from "../log";

export function makeConnection(rpcUrl: string): Connection {
  // We handle rate limits ourselves (skip a poll) instead of web3.js retry spam.
  return new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
}

/** Hide API keys when printing an RPC URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "***");
    return u.toString();
  } catch {
    return "(invalid url)";
  }
}

/** SOL/USD price from CoinGecko, refreshed in the background. Display only. */
export class SolPrice {
  usd: number | null = null;
  private timer?: NodeJS.Timeout;

  async refresh(): Promise<number | null> {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { solana?: { usd?: number } };
      if (typeof body.solana?.usd === "number" && body.solana.usd > 0) this.usd = body.solana.usd;
    } catch (err) {
      log.warn(`Could not fetch SOL price: ${(err as Error).message}`);
    }
    return this.usd;
  }

  startAutoRefresh(everyMs = 5 * 60_000) {
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
  }
}
