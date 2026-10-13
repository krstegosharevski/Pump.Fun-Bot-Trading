import type { Config } from "../config";

export interface PricePoint {
  t: number;
  priceSol: number;
  mcapSol: number;
  realSol: number;
  progressPct: number;
}

export interface CoinView {
  createdAt: number;
  firstMcapSol: number;
  devBuyPct: number;
  complete: boolean;
  history: PricePoint[];
}

export interface EntryDecision {
  enter: boolean;
  reason: string;
  /** True when this coin can never qualify again (stop watching it). */
  final?: boolean;
}

/** Latest point at or before time `t`. */
export function pointAtOrBefore(history: PricePoint[], t: number): PricePoint | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].t <= t) return history[i];
  return undefined;
}

export function shouldEnter(coin: CoinView, now: number, cfg: Config): EntryDecision {
  if (coin.complete) return { enter: false, reason: "curve complete", final: true };
  if ((now - coin.createdAt) / 1000 > cfg.WATCH_WINDOW_SEC)
    return { enter: false, reason: "watch window over", final: true };
  if (coin.devBuyPct > cfg.MAX_DEV_BUY_PCT)
    return { enter: false, reason: `dev bought ${coin.devBuyPct.toFixed(1)}%`, final: true };

  const last = coin.history.at(-1);
  if (!last || coin.firstMcapSol <= 0) return { enter: false, reason: "no price yet" };

  const gainPct = (last.mcapSol / coin.firstMcapSol - 1) * 100;
  if (gainPct < cfg.MIN_MCAP_GAIN_PCT) return { enter: false, reason: `mcap +${gainPct.toFixed(0)}%` };
  if (last.realSol < cfg.MIN_REAL_SOL)
    return { enter: false, reason: `only ${last.realSol.toFixed(2)} SOL in curve` };
  if (last.progressPct > cfg.MAX_CURVE_PROGRESS_PCT)
    return { enter: false, reason: `curve ${last.progressPct.toFixed(0)}% done` };

  const ref = pointAtOrBefore(coin.history, now - cfg.RISING_LOOKBACK_SEC * 1000);
  if (!ref) return { enter: false, reason: "not enough history" };
  if (last.priceSol <= ref.priceSol) return { enter: false, reason: "not rising" };

  return {
    enter: true,
    reason: `mcap +${gainPct.toFixed(0)}%, ${last.realSol.toFixed(2)} SOL in curve, rising`,
  };
}

export interface PositionView {
  openedAt: number;
  entryPriceSol: number;
  peakPriceSol: number;
}

export type ExitReason = "graduated" | "stop_loss" | "take_profit" | "trailing_stop" | "max_hold";

export function shouldExit(
  pos: PositionView,
  priceSol: number,
  complete: boolean,
  now: number,
  cfg: Config,
): ExitReason | null {
  if (complete) return "graduated";
  const pnlPct = (priceSol / pos.entryPriceSol - 1) * 100;
  if (pnlPct <= -cfg.STOP_LOSS_PCT) return "stop_loss";
  if (pnlPct >= cfg.TAKE_PROFIT_PCT) return "take_profit";
  const peakGainPct = (pos.peakPriceSol / pos.entryPriceSol - 1) * 100;
  const dropFromPeakPct = (1 - priceSol / pos.peakPriceSol) * 100;
  if (peakGainPct >= cfg.TRAIL_ACTIVATE_PCT && dropFromPeakPct >= cfg.TRAIL_DROP_PCT)
    return "trailing_stop";
  if ((now - pos.openedAt) / 1000 >= cfg.MAX_HOLD_SEC) return "max_hold";
  return null;
}
