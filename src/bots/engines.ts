import type { Config } from "../config";
import type { NewTokenEvent, PumpPortalFeed } from "../feed/pumpPortal";
import type { TrackedCoin, Tracker } from "../market/tracker";
import type { Trader } from "../bot";
import { shouldEnter } from "../strategy/momentum";
import { shouldSnipe } from "../strategy/launch";
import { botConfig, type BotId } from "./registry";
import { log } from "../log";

export interface EngineDeps {
  cfg: Config;
  tracker: Tracker;
  feed: PumpPortalFeed;
  trader: Trader;
}

/**
 * Starts a bot's buying logic and returns a function that stops it.
 * Selling is always done by the Trader, by the rules of the bot that bought.
 */
export function startEngine(id: BotId, deps: EngineDeps): () => void {
  return id === "tabak" ? startTabak(deps) : startPrimal(deps);
}

/** Risk checks, then buy. Returns false when the risk guard said no. */
function tryBuy(
  deps: EngineDeps,
  bot: BotId,
  coin: TrackedCoin,
  reason: string,
  expectedPriceSol: number,
  now: number,
  quiet = false,
): boolean {
  const { trader } = deps;
  const sizeSol = trader.sizeFor(botConfig(deps.cfg, bot));
  const ok = trader.risk.canOpen(now, {
    openPositions: trader.pf.positions.size + trader.pendingBuys(),
    cashSol: trader.pf.cashSol,
    tradeSizeSol: sizeSol,
  });
  if (!ok.ok) {
    (quiet ? log.debug : log.info)(`Signal on ${coin.symbol} skipped: ${ok.reason}`);
    return false;
  }
  void trader.enter(coin, { bot, reason, sizeSol, expectedPriceSol });
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
      tryBuy(deps, "tabak", coin, d.reason, expectedPriceSol, now, true);
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
