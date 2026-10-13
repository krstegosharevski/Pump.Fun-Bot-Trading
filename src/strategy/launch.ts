import type { Config } from "../config";
import type { EntryDecision } from "./momentum";

// Tabak 1-1: launch sniper. The rules mirror chainstacklabs/pumpfun-bonkfun-bot:
// buy right at creation ("extreme fast") or a fixed wait after it, one coin at a
// time with a pause between coins, then sell on a timer or on take-profit/stop-loss.

export interface LaunchCoinView {
  createdAt: number;
  name: string;
  symbol: string;
  creator: string;
}

export interface LaunchState {
  /** A position is open or a buy is in flight. */
  busy: boolean;
  /** When the previous coin was finished with (sold, or its buy failed). */
  lastDoneAt: number;
}

export function shouldSnipe(coin: LaunchCoinView, now: number, cfg: Config, st: LaunchState): EntryDecision {
  const match = cfg.TABAK_MATCH_STRING.trim().toLowerCase();
  if (match && !`${coin.name} ${coin.symbol}`.toLowerCase().includes(match)) {
    return { enter: false, reason: "name doesn't match", final: true };
  }
  if (cfg.TABAK_CREATOR && coin.creator !== cfg.TABAK_CREATOR) {
    return { enter: false, reason: "different creator", final: true };
  }

  const ageSec = (now - coin.createdAt) / 1000;
  const opensAt = cfg.TABAK_EXTREME_FAST ? 0 : cfg.TABAK_WAIT_AFTER_CREATION_SEC;
  const closesAt = opensAt + cfg.TABAK_MAX_TOKEN_AGE_SEC + (cfg.TABAK_EXTREME_FAST ? 0 : 1);
  if (ageSec < opensAt) return { enter: false, reason: `waiting ${Math.ceil(opensAt - ageSec)}s after launch` };
  if (ageSec > closesAt) return { enter: false, reason: "too old", final: true };

  if (st.busy) return { enter: false, reason: "one coin at a time" };
  const pauseLeft = cfg.TABAK_WAIT_BEFORE_NEW_TOKEN_SEC - (now - st.lastDoneAt) / 1000;
  if (pauseLeft > 0) return { enter: false, reason: `pausing ${Math.ceil(pauseLeft)}s between coins` };

  return {
    enter: true,
    reason: cfg.TABAK_EXTREME_FAST ? `launch snipe, ${ageSec.toFixed(1)}s old` : `${ageSec.toFixed(0)}s after launch`,
  };
}

export type LaunchExitReason = "graduated" | "take_profit" | "stop_loss" | "max_hold" | "time_exit";

export function shouldExitLaunch(
  pos: { openedAt: number; entryPriceSol: number },
  priceSol: number,
  complete: boolean,
  now: number,
  cfg: Config,
): LaunchExitReason | null {
  if (complete) return "graduated";
  const heldSec = (now - pos.openedAt) / 1000;
  if (cfg.TABAK_EXIT_STRATEGY === "time_based") {
    return heldSec >= cfg.TABAK_WAIT_AFTER_BUY_SEC ? "time_exit" : null;
  }
  // tp_sl, checked in the same order as the original: take profit, stop loss, time.
  const pnlPct = (priceSol / pos.entryPriceSol - 1) * 100;
  if (pnlPct >= cfg.TABAK_TAKE_PROFIT_PCT) return "take_profit";
  if (pnlPct <= -cfg.TABAK_STOP_LOSS_PCT) return "stop_loss";
  if (heldSec >= cfg.TABAK_MAX_HOLD_SEC) return "max_hold";
  return null;
}
