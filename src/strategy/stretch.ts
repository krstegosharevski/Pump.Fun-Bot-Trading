import type { Config } from "../config";
import type { EntryDecision, PricePoint } from "./momentum";

// ErenTinx 3: the "Final Stretch" style of trading-terminal tools like Axiom Pulse.
// Buy pump.fun coins that are close to graduating, still pulling in SOL, and whose
// supply isn't concentrated in a few wallets. Then sell in steps.

export interface StretchListing {
  progressPct: number;
  complete: boolean;
  lastTradeAt: number;
  hasSocials: boolean;
}

/** Is this coin in the final stretch toward graduation, and still alive? */
export function isFinalStretch(c: StretchListing, now: number, cfg: Config): { ok: boolean; reason: string } {
  if (c.complete) return { ok: false, reason: "already graduated" };
  if (c.progressPct < cfg.ERENTINX_MIN_PROGRESS_PCT) return { ok: false, reason: `curve ${c.progressPct.toFixed(0)}%, not yet` };
  if (c.progressPct > cfg.ERENTINX_MAX_PROGRESS_PCT) return { ok: false, reason: `curve ${c.progressPct.toFixed(0)}%, too late` };
  if ((now - c.lastTradeAt) / 1000 > cfg.ERENTINX_MAX_IDLE_SEC) return { ok: false, reason: "no recent trades" };
  if (cfg.ERENTINX_REQUIRE_SOCIALS && !c.hasSocials) return { ok: false, reason: "no socials" };
  return { ok: true, reason: "final stretch" };
}

export interface HolderSafety {
  /** % of total supply held by the 10 largest wallets, excluding the bonding curve. null = unchecked. */
  top10Pct: number | null;
  top1Pct: number | null;
  /** % held by the coin's creator. */
  devPct: number;
}

/** The safety checks trading terminals show for every coin. */
export function isSafe(s: HolderSafety, cfg: Config): { ok: boolean; reason: string } {
  if (s.devPct > cfg.ERENTINX_MAX_DEV_PCT) return { ok: false, reason: `creator holds ${s.devPct.toFixed(1)}%` };
  if (s.top10Pct === null || s.top1Pct === null) {
    return cfg.ERENTINX_REQUIRE_TOP_HOLDERS
      ? { ok: false, reason: "top holders unchecked (needs a private RPC)" }
      : { ok: true, reason: "creator ok, top holders unchecked" };
  }
  if (s.top1Pct > cfg.ERENTINX_MAX_TOP1_PCT) return { ok: false, reason: `one wallet holds ${s.top1Pct.toFixed(1)}%` };
  if (s.top10Pct > cfg.ERENTINX_MAX_TOP10_PCT) return { ok: false, reason: `top 10 hold ${s.top10Pct.toFixed(0)}%` };
  return { ok: true, reason: "safe" };
}

/** Momentum check on the on-chain price history: real SOL flowing in, price going up. */
export function shouldBuyStretch(history: PricePoint[], now: number, cfg: Config): EntryDecision {
  const last = history.at(-1);
  if (!last) return { enter: false, reason: "no price yet" };
  const cutoff = now - cfg.ERENTINX_LOOKBACK_SEC * 1000;
  let ref: PricePoint | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= cutoff) {
      ref = history[i];
      break;
    }
  }
  if (!ref) return { enter: false, reason: "watching" };
  const inflow = last.realSol - ref.realSol;
  if (inflow < cfg.ERENTINX_MIN_INFLOW_SOL) {
    return { enter: false, reason: `${inflow >= 0 ? "+" : ""}${inflow.toFixed(1)} SOL in ${cfg.ERENTINX_LOOKBACK_SEC}s, too slow` };
  }
  if (last.priceSol <= ref.priceSol) return { enter: false, reason: "price not rising" };
  return {
    enter: true,
    reason: `final stretch ${last.progressPct.toFixed(0)}%, +${inflow.toFixed(1)} SOL in ${cfg.ERENTINX_LOOKBACK_SEC}s`,
  };
}

export type StretchExit = { kind: "part"; fraction: number; reason: string } | { kind: "all"; reason: string } | null;

/**
 * Sells in steps. Before step 1: stop loss, or sell part at +TP1. After step 1 the rest
 * goes at +TP2, on a trailing stop, or if price falls back to the entry (never let a
 * winner turn into a loss).
 */
export function shouldExitStretch(
  pos: { openedAt: number; entryPriceSol: number; peakPriceSol: number; stage?: number },
  priceSol: number,
  complete: boolean,
  now: number,
  cfg: Config,
): StretchExit {
  if (complete && cfg.ERENTINX_SELL_ON_GRADUATION) return { kind: "all", reason: "graduated" };
  const pnlPct = (priceSol / pos.entryPriceSol - 1) * 100;
  const stage = pos.stage ?? 0;
  if (stage === 0) {
    if (pnlPct <= -cfg.ERENTINX_STOP_LOSS_PCT) return { kind: "all", reason: "stop_loss" };
    if (pnlPct >= cfg.ERENTINX_TP1_PCT) {
      return { kind: "part", fraction: cfg.ERENTINX_TP1_SELL_PCT / 100, reason: "take_profit_1" };
    }
  } else {
    if (pnlPct >= cfg.ERENTINX_TP2_PCT) return { kind: "all", reason: "take_profit_2" };
    if (priceSol <= pos.entryPriceSol) return { kind: "all", reason: "breakeven_stop" };
    if ((1 - priceSol / pos.peakPriceSol) * 100 >= cfg.ERENTINX_TRAIL_DROP_PCT) return { kind: "all", reason: "trailing_stop" };
  }
  if ((now - pos.openedAt) / 60_000 >= cfg.ERENTINX_MAX_HOLD_MIN) return { kind: "all", reason: "max_hold" };
  return null;
}
