import type { Config } from "./config";
import { log } from "./log";
import type { PumpPortalFeed } from "./feed/pumpPortal";
import type { Tracker } from "./market/tracker";
import { shouldEnter } from "./strategy/momentum";

/** No trading: print new coins, live prices and which coins the strategy would buy. */
export function runWatchMode(cfg: Config, feed: PumpPortalFeed, tracker: Tracker) {
  let launches = 0;
  feed.on("newToken", (e) => {
    launches++;
    log.info(
      `NEW  ${e.symbol.padEnd(10)} mcap ${e.marketCapSol.toFixed(1)} SOL  dev buy ${((e.initialBuyTokens / 1e9) * 100).toFixed(1)}%  ${e.mint}`,
    );
  });
  feed.on("migration", (mint) => log.info(`GRADUATED ${mint}`));

  const flagged = new Set<string>();
  let lastSummary = Date.now();
  tracker.onTick((coins, now) => {
    for (const coin of coins) {
      if (coin.done || flagged.has(coin.mint)) continue;
      const d = shouldEnter(coin, now, cfg);
      if (d.enter) {
        flagged.add(coin.mint);
        log.trade(`WOULD BUY ${coin.symbol} — ${d.reason}`);
      } else if (d.final) tracker.markDone(coin.mint);
    }
    if (now - lastSummary < 10_000) return;
    lastSummary = now;
    const movers = coins
      .filter((c) => c.history.length > 0 && c.firstMcapSol > 0)
      .map((c) => ({ c, gain: (c.history.at(-1)!.mcapSol / c.firstMcapSol - 1) * 100 }))
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 3)
      .map(({ c, gain }) => `${c.symbol} ${gain >= 0 ? "+" : ""}${gain.toFixed(0)}% (${c.history.at(-1)!.realSol.toFixed(2)} SOL)`);
    const s = tracker.stats();
    log.info(
      `watching ${s.watching} | launches ${launches} | poll ${s.lastPollMs}ms | rpc errors ${s.rpcErrors} | top: ${movers.join(", ") || "-"}`,
    );
  });
}
