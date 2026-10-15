import type { Connection } from "@solana/web3.js";
import type { Config } from "../config";
import type { NewTokenEvent, PumpPortalFeed } from "../feed/pumpPortal";
import type { TrackedCoin, Tracker } from "../market/tracker";
import type { PoolTracker } from "../market/poolTracker";
import type { CoinRef, Trader } from "../bot";
import type { Venue } from "../portfolio";
import { TrendingFeed, type HotCoin } from "../feed/geckoTrending";
import { PumpfunListFeed, type ListedCoin } from "../feed/pumpfunList";
import { checkHolders } from "../chain/holders";
import { shouldEnter } from "../strategy/momentum";
import { shouldSnipe } from "../strategy/launch";
import { isHotMeme, shouldBuyHot } from "../strategy/hot";
import { isFinalStretch, isSafe, shouldBuyStretch, type HolderSafety } from "../strategy/stretch";
import { botConfig, type BotId } from "./registry";
import { log, sleep } from "../log";

export interface EngineDeps {
  cfg: Config;
  conn: Connection;
  tracker: Tracker;
  pools: PoolTracker;
  feed: PumpPortalFeed;
  trader: Trader;
}

/** A bot's own list on the dashboard (Blazebit's hot list, ErenTinx's final stretch). */
export interface WatchList {
  title: string;
  columns: string[];
  rows: {
    mint: string;
    symbol: string;
    tag?: string;
    cells: { text: string; tone?: "pos" | "neg" }[];
    status: string;
    muted: boolean;
  }[];
}

export interface EngineHandle {
  stop(): void;
  /** The coins the bot is looking at and what it thinks of each. */
  watchList?(): WatchList;
}

/**
 * Starts a bot's buying logic. Selling is always done by the Trader,
 * by the rules of the bot that bought.
 */
export function startEngine(id: BotId, deps: EngineDeps): EngineHandle {
  if (id === "tabak") return { stop: startTabak(deps) };
  if (id === "blazebit") return startBlazebit(deps);
  if (id === "erentinx") return startErentinx(deps);
  return { stop: startPrimal(deps) };
}

/** Risk checks, then buy. Returns null when buying, or the risk guard's reason for saying no. */
function tryBuy(
  deps: EngineDeps,
  bot: BotId,
  coin: CoinRef,
  reason: string,
  expectedPriceSol: number,
  now: number,
  opts: { quiet?: boolean; venue?: Venue; pool?: string } = {},
): string | null {
  const { trader } = deps;
  const sizeSol = trader.sizeFor(botConfig(deps.cfg, bot));
  const ok = trader.risk.canOpen(now, {
    openPositions: trader.pf.positions.size + trader.pendingBuys(),
    cashSol: trader.pf.cashSol,
    tradeSizeSol: sizeSol,
  });
  if (!ok.ok) {
    (opts.quiet ? log.debug : log.info)(`Signal on ${coin.symbol} skipped: ${ok.reason}`);
    return ok.reason;
  }
  void trader.enter(coin, { bot, reason, sizeSol, expectedPriceSol, venue: opts.venue, pool: opts.pool });
  return null;
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
      if (tryBuy(deps, "primal", coin, d.reason, price, now) !== null) tracker.markDone(coin.mint);
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
      const refused = tryBuy(deps, "blazebit", coin, d.reason, price, now, { quiet: true, venue: "pumpswap", pool: c.pool });
      if (refused === null) lastBought.set(p.mint, now);
      else p.lastDecision = `ready, but ${refused}`;
    }
  });

  return {
    stop: () => {
      trending.stop();
      unsubscribe();
      for (const mint of hot.keys()) pools.unwatch(mint);
    },
    watchList: () => ({
      title: "Hot list · 1h trending",
      columns: ["Market cap", "1h", "5m", "Liquidity"],
      rows: trending.coins.slice(0, 25).map((c) => {
        const verdict = isHotMeme(c, cfg);
        const status = trader.pf.positions.has(c.mint)
          ? "Holding"
          : !verdict.ok
            ? `Skipped: ${verdict.reason}`
            : (pools.get(c.mint)?.lastDecision ?? "Watching");
        return {
          mint: c.mint,
          symbol: c.symbol,
          tag: verdict.ok ? "HOT" : undefined,
          cells: [{ text: usd(c.fdvUsd) }, pctCell(c.change1h), pctCell(c.change5m), { text: usd(c.liquidityUsd) }],
          status,
          muted: !verdict.ok,
        };
      }),
    }),
  };
}

const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : `$${Math.round(x / 1e3)}K`);
const pctCell = (x: number) => ({ text: `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`, tone: x > 0 ? ("pos" as const) : x < 0 ? ("neg" as const) : undefined });

/** Time of the last price change in a coin's history (≈ its last trade). */
function lastTradeAt(history: { t: number; priceSol: number }[]): number {
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].priceSol !== history[i - 1].priceSol) return history[i].t;
  }
  return history[0]?.t ?? 0;
}

/**
 * ErenTinx 3: Final Stretch. Finds coins 60–95% of the way to graduating in two ways: on-chain
 * (every launch PumpPortal reports is followed for longer once it pulls in real SOL) and, when
 * reachable, pump.fun's own list. Checks who holds them and buys while SOL keeps flowing in.
 * Selling in steps is done by the Trader (src/strategy/stretch.ts).
 */
function startErentinx(deps: EngineDeps): EngineHandle {
  const { tracker, trader } = deps;
  const cfg = botConfig(deps.cfg, "erentinx");
  const SAFETY_TTL_MS = 2 * 60_000;
  const KEEP_TRACKING_MS = 3 * 60_000;
  const MAX_DISCOVERED = 80;
  let listed: ListedCoin[] = [];
  // Final-stretch candidates from pump.fun's list and from our own on-chain tracking.
  let fromList = new Map<string, ListedCoin>();
  const discovered = new Map<string, ListedCoin>();
  const candidateOf = (mint: string) => fromList.get(mint) ?? discovered.get(mint);
  const following = new Set<string>();
  const needsCheck = (mint: string, now: number) => {
    const s = safety.get(mint);
    if ((!s || now - s.at > SAFETY_TTL_MS) && !queue.includes(mint)) queue.push(mint);
  };
  const safety = new Map<string, { at: number; result?: HolderSafety; verdict: { ok: boolean; reason: string } }>();
  const lastBought = new Map<string, number>();
  const queue: string[] = [];
  let checking = false;
  let stopped = false;

  // Holder checks one at a time, gently, so the RPC isn't flooded.
  const runChecks = async () => {
    if (checking) return;
    checking = true;
    try {
      while (queue.length && !stopped) {
        const mint = queue.shift()!;
        const c = candidateOf(mint);
        if (!c) continue;
        try {
          const result = await checkHolders(deps.conn, mint, c.creator);
          safety.set(mint, { at: Date.now(), result, verdict: isSafe(result, cfg) });
        } catch {
          // Usually a busy RPC: try this coin again in ~30s rather than waiting the full TTL.
          safety.set(mint, { at: Date.now() - SAFETY_TTL_MS + 30_000, verdict: { ok: false, reason: "safety check failed, retrying" } });
        }
        await sleep(1500);
      }
    } finally {
      checking = false;
    }
  };

  const list = new PumpfunListFeed(cfg.ERENTINX_REFRESH_SEC * 1000, (coins) => {
    const now = Date.now();
    listed = coins;
    const next = new Map<string, ListedCoin>();
    for (const c of coins) if (isFinalStretch(c, now, cfg).ok) next.set(c.mint, c);
    fromList = next;
    for (const c of next.values()) {
      tracker.track(c.mint, c.name, c.symbol, c.createdAt, now + KEEP_TRACKING_MS);
      needsCheck(c.mint, now);
    }
    void runChecks();
  });
  list.start();

  /** On-chain discovery: keep following coins that pull in real SOL until they go quiet. */
  const discover = (coins: TrackedCoin[], now: number) => {
    const keepMs = cfg.ERENTINX_DISCOVER_KEEP_MIN * 60_000;
    for (const coin of coins) {
      const last = coin.history.at(-1);
      if (!last) continue;
      const tradedAt = lastTradeAt(coin.history);
      const active = now - tradedAt < keepMs;
      if (!coin.complete && active && last.realSol >= cfg.ERENTINX_DISCOVER_MIN_SOL) {
        if (following.has(coin.mint) || following.size < MAX_DISCOVERED) {
          following.add(coin.mint);
          tracker.track(coin.mint, coin.name, coin.symbol, coin.createdAt, tradedAt + keepMs);
        }
      } else if (!active || coin.complete) {
        following.delete(coin.mint);
      }
      const listing: ListedCoin = {
        mint: coin.mint,
        name: coin.name,
        symbol: coin.symbol,
        creator: coin.creator,
        createdAt: coin.createdAt,
        lastTradeAt: tradedAt,
        progressPct: last.progressPct,
        realSol: last.realSol,
        usdMarketCap: 0,
        complete: coin.complete,
        hasSocials: false,
      };
      if (following.has(coin.mint) && isFinalStretch(listing, now, cfg).ok) {
        discovered.set(coin.mint, listing);
        needsCheck(coin.mint, now);
      } else {
        discovered.delete(coin.mint);
      }
    }
    void runChecks();
  };

  const unsubscribe = tracker.onTick((coins, now) => {
    discover(coins, now);
    for (const coin of coins) {
      const c = candidateOf(coin.mint);
      if (!c || coin.held || trader.isInFlight(coin.mint) || trader.pf.positions.has(coin.mint)) continue;
      const waitMs = (lastBought.get(coin.mint) ?? -Infinity) + cfg.ERENTINX_COIN_COOLDOWN_MIN * 60_000 - now;
      if (waitMs > 0) {
        coin.lastDecision = `bought recently, again in ${Math.ceil(waitMs / 60_000)} min`;
        continue;
      }
      const last = coin.history.at(-1);
      if (!last) continue;
      // The list can be a few seconds old: confirm the final stretch on-chain.
      const live = isFinalStretch({ ...c, progressPct: last.progressPct, complete: coin.complete }, now, cfg);
      if (!live.ok) {
        coin.lastDecision = live.reason;
        continue;
      }
      const s = safety.get(coin.mint);
      if (!s) {
        coin.lastDecision = "checking holders…";
        continue;
      }
      if (!s.verdict.ok) {
        coin.lastDecision = `Skipped: ${s.verdict.reason}`;
        continue;
      }
      const d = shouldBuyStretch(coin.history, now, cfg);
      coin.lastDecision = d.reason;
      if (!d.enter) continue;
      const refused = tryBuy(deps, "erentinx", coin, `${d.reason}; ${s.verdict.reason}`, last.priceSol, now, { quiet: true });
      if (refused === null) lastBought.set(coin.mint, now);
      else coin.lastDecision = `ready, but ${refused}`;
    }
  });

  return {
    stop: () => {
      stopped = true;
      list.stop();
      unsubscribe();
    },
    watchList: () => {
      const now = Date.now();
      // Also show the coins being followed on their way up, so it's clear the bot is working.
      const climbing: ListedCoin[] = [];
      for (const mint of following) {
        const coin = tracker.get(mint);
        const last = coin?.history.at(-1);
        if (!coin || !last || discovered.has(mint)) continue;
        climbing.push({
          mint,
          name: coin.name,
          symbol: coin.symbol,
          creator: coin.creator,
          createdAt: coin.createdAt,
          lastTradeAt: lastTradeAt(coin.history),
          progressPct: last.progressPct,
          realSol: last.realSol,
          usdMarketCap: 0,
          complete: coin.complete,
          hasSocials: false,
        });
      }
      const seen = new Set<string>();
      const rows = [...discovered.values(), ...listed, ...climbing]
        .filter((c) => !seen.has(c.mint) && seen.add(c.mint))
        .map((c) => ({ c, stretch: isFinalStretch(c, now, cfg) }))
        .sort((a, b) => Number(b.stretch.ok) - Number(a.stretch.ok) || b.c.progressPct - a.c.progressPct)
        .slice(0, 25)
        .map(({ c, stretch }) => {
          const s = safety.get(c.mint);
          const pos = trader.pf.positions.get(c.mint);
          const status = pos
            ? pos.stage
              ? `Holding · ${cfg.ERENTINX_TP1_SELL_PCT}% sold`
              : "Holding"
            : !stretch.ok
              ? `Skipped: ${stretch.reason}`
              : (tracker.get(c.mint)?.lastDecision ?? "Watching");
          const top10 = s?.result ? (s.result.top10Pct === null ? "unchecked" : `${s.result.top10Pct.toFixed(0)}%`) : "…";
          return {
            mint: c.mint,
            symbol: c.symbol,
            // SAFE only when every check ran; OK when the top holders couldn't be checked.
            tag: stretch.ok && s?.verdict.ok ? (s.result?.top10Pct === null ? "OK" : "SAFE") : undefined,
            cells: [
              { text: `${c.progressPct.toFixed(0)}%` },
              { text: `${c.realSol.toFixed(1)} SOL` },
              { text: s?.result ? `${s.result.devPct.toFixed(1)}%` : "…" },
              { text: top10 },
            ],
            status,
            muted: !stretch.ok,
          };
        });
      return { title: "Final stretch", columns: ["Curve", "SOL in", "Creator", "Top 10"], rows };
    },
  };
}
