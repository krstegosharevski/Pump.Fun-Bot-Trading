import type { Config } from "../config";
import type { NewTokenEvent, PumpPortalFeed } from "../feed/pumpPortal";
import type { TrackedCoin, Tracker } from "../market/tracker";
import type { PoolTracker } from "../market/poolTracker";
import type { CoinRef, Trader } from "../bot";
import type { Venue } from "../portfolio";
import { TrendingFeed, type HotCoin } from "../feed/geckoTrending";
import { shouldEnter } from "../strategy/momentum";
import { shouldSnipe } from "../strategy/launch";
import { isHotMeme, shouldBuyHot } from "../strategy/hot";
import { botConfig, type BotId } from "./registry";
import { log } from "../log";

export interface EngineDeps {
  cfg: Config;
  tracker: Tracker;
  pools: PoolTracker;
  feed: PumpPortalFeed;
  trader: Trader;
}

/** One row of Blazebit's hot list on the dashboard. */
export interface HotRow {
  mint: string;
  symbol: string;
  fdvUsd: number;
  liquidityUsd: number;
  change5m: number;
  change1h: number;
  hot: boolean;
  status: string;
}

export interface EngineHandle {
  stop(): void;
  /** Blazebit only: the trending list and what the bot thinks of each coin. */
  hotList?(): HotRow[];
}

/**
 * Starts a bot's buying logic. Selling is always done by the Trader,
 * by the rules of the bot that bought.
 */
export function startEngine(id: BotId, deps: EngineDeps): EngineHandle {
  if (id === "tabak") return { stop: startTabak(deps) };
  if (id === "blazebit") return startBlazebit(deps);
  return { stop: startPrimal(deps) };
}

/** Risk checks, then buy. Returns false when the risk guard said no. */
function tryBuy(
  deps: EngineDeps,
  bot: BotId,
  coin: CoinRef,
  reason: string,
  expectedPriceSol: number,
  now: number,
  opts: { quiet?: boolean; venue?: Venue; pool?: string } = {},
): boolean {
  const { trader } = deps;
  const sizeSol = trader.sizeFor(botConfig(deps.cfg, bot));
  const ok = trader.risk.canOpen(now, {
    openPositions: trader.pf.positions.size + trader.pendingBuys(),
    cashSol: trader.pf.cashSol,
    tradeSizeSol: sizeSol,
  });
  if (!ok.ok) {
    (opts.quiet ? log.debug : log.info)(`Signal on ${coin.symbol} skipped: ${ok.reason}`);
    return false;
  }
  void trader.enter(coin, { bot, reason, sizeSol, expectedPriceSol, venue: opts.venue, pool: opts.pool });
  return true;
}

/** Primal 1-1: momentum. Checks every watched coin on each price poll. */
function startPrimal(deps: EngineDeps): () => void {
  const { tracker, trader } = deps;
  const cfg = botConfig(deps.cfg, "primal");
  return tracker.onTick((coins, now) => {
    for (const coin of coins) {
      if (coin.held || coin.done || trader.isInFlight(coin.mint) || trader.pf.positions.has(coin.mint)) continue;
      const d = shouldEnter(coin, now, cfg);
      coin.lastDecision = d.reason;
      if (d.final) {
        tracker.markDone(coin.mint);
        continue;
      }
      if (!d.enter) continue;
      const price = coin.history.at(-1)!.priceSol;
      if (!tryBuy(deps, "primal", coin, d.reason, price, now)) tracker.markDone(coin.mint);
    }
  });
}

/**
 * Tabak 1-1: launch sniper. In extreme fast mode it decides the moment PumpPortal
 * announces a coin; otherwise it waits on the price polls until the coin is old enough.
 */
function startTabak(deps: EngineDeps): () => void {
  const { tracker, feed, trader } = deps;
  const cfg = botConfig(deps.cfg, "tabak");
  // Coins already decided on. Kept local so the tracker keeps recording them for the backtester.
  const decided = new Set<string>();
  const remember = (mint: string) => {
    decided.add(mint);
    if (decided.size > 5000) decided.delete(decided.values().next().value!);
  };

  const consider = (coin: TrackedCoin, now: number, expectedPriceSol: number) => {
    if (decided.has(coin.mint) || coin.held || trader.isInFlight(coin.mint) || !(expectedPriceSol > 0)) return;
    const d = shouldSnipe(coin, now, cfg, { busy: !trader.isIdle(), lastDoneAt: trader.lastDoneAt });
    coin.lastDecision = d.reason;
    if (d.enter) {
      remember(coin.mint);
      tryBuy(deps, "tabak", coin, d.reason, expectedPriceSol, now, { quiet: true });
    } else if (d.final || cfg.TABAK_EXTREME_FAST) {
      remember(coin.mint);
    }
  };

  if (cfg.TABAK_EXTREME_FAST) {
    const onNewToken = (evt: NewTokenEvent) => {
      const coin = tracker.get(evt.mint);
      if (coin) consider(coin, Date.now(), evt.marketCapSol / 1e9);
    };
    feed.on("newToken", onNewToken);
    return () => feed.off("newToken", onNewToken);
  }

  return tracker.onTick((coins, now) => {
    for (const coin of coins) {
      const price = coin.history.at(-1)?.priceSol;
      if (price) consider(coin, now, price);
    }
  });
}

/**
 * Blazebit 1-1: hot meme coins. Refreshes the 1h trending list, watches the hot ones'
 * PumpSwap pools on-chain, and buys while a coin is still climbing.
 */
function startBlazebit(deps: EngineDeps): EngineHandle {
  const { pools, trader } = deps;
  const cfg = botConfig(deps.cfg, "blazebit");
  let hot = new Map<string, HotCoin>();
  const lastBought = new Map<string, number>();

  const trending = new TrendingFeed(cfg.BLAZE_REFRESH_SEC * 1000, (coins) => {
    const next = new Map<string, HotCoin>();
    for (const c of coins) if (isHotMeme(c, cfg).ok) next.set(c.mint, c);
    for (const mint of hot.keys()) if (!next.has(mint)) pools.unwatch(mint);
    for (const c of next.values()) pools.watch(c.mint, c.pool, c.symbol);
    hot = next;
    log.info(`Hot list updated: ${next.size} of ${coins.length} trending coins qualify`);
  });
  trending.start();

  const unsubscribe = pools.onTick((list, now) => {
    for (const p of list) {
      const c = hot.get(p.mint);
      if (!c || p.held || trader.isInFlight(p.mint) || trader.pf.positions.has(p.mint)) continue;
      const waitMs = (lastBought.get(p.mint) ?? -Infinity) + cfg.BLAZE_COIN_COOLDOWN_MIN * 60_000 - now;
      if (waitMs > 0) {
        p.lastDecision = `bought recently, again in ${Math.ceil(waitMs / 60_000)} min`;
        continue;
      }
      const d = shouldBuyHot(c, p.history, now, cfg);
      p.lastDecision = d.reason;
      if (!d.enter) continue;
      const price = p.history.at(-1)!.priceSol;
      const coin = { mint: p.mint, symbol: c.symbol, name: c.symbol };
      if (tryBuy(deps, "blazebit", coin, d.reason, price, now, { venue: "pumpswap", pool: c.pool })) {
        lastBought.set(p.mint, now);
      }
    }
  });

  return {
    stop: () => {
      trending.stop();
      unsubscribe();
      for (const mint of hot.keys()) pools.unwatch(mint);
    },
    hotList: () =>
      trending.coins.slice(0, 25).map((c) => {
        const verdict = isHotMeme(c, cfg);
        const status = trader.pf.positions.has(c.mint)
          ? "Holding"
          : !verdict.ok
            ? `Skipped: ${verdict.reason}`
            : (pools.get(c.mint)?.lastDecision ?? "Watching");
        return {
          mint: c.mint,
          symbol: c.symbol,
          fdvUsd: c.fdvUsd,
          liquidityUsd: c.liquidityUsd,
          change5m: c.change5m,
          change1h: c.change1h,
          hot: verdict.ok,
          status,
        };
      }),
  };
}
