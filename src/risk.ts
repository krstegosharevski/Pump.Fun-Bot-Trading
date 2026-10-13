import type { Config } from "./config";

export interface RiskState {
  dayKey: string;
  dayStartEquitySol: number;
  haltedForDay: boolean;
  consecutiveLosses: number;
  cooldownUntil: number;
  tradeTimes: number[];
}

/** SOL to put into the next trade: a % of equity (capped) or the fixed size. */
export function tradeSizeSol(cfg: Config, equitySol: number): number {
  if (cfg.TRADE_SIZE_PCT > 0) {
    return Math.min(cfg.MAX_TRADE_SOL, (equitySol * cfg.TRADE_SIZE_PCT) / 100);
  }
  return cfg.TRADE_SIZE_SOL;
}

const localDayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** Hard limits that sit between the strategy and the executor. */
export class RiskGuard {
  paused = false;
  private s: RiskState;

  constructor(
    private cfg: Config,
    equitySol: number,
    now: number,
    saved?: unknown,
  ) {
    const restored = saved as Partial<RiskState> | undefined;
    this.s = {
      dayKey: localDayKey(now),
      dayStartEquitySol: equitySol,
      haltedForDay: false,
      consecutiveLosses: 0,
      cooldownUntil: 0,
      tradeTimes: [],
      ...(restored && restored.dayKey === localDayKey(now) ? restored : {}),
    };
  }

  toJSON(): RiskState {
    return this.s;
  }

  /** Switch to another bot's limits; the shared state (cooldown, daily loss, trade times) is kept. */
  setConfig(cfg: Config) {
    this.cfg = cfg;
  }

  canOpen(
    now: number,
    st: { openPositions: number; cashSol: number; tradeSizeSol?: number },
  ): { ok: true } | { ok: false; reason: string } {
    const cfg = this.cfg;
    if (this.paused) return { ok: false, reason: "paused" };
    if (this.s.haltedForDay) return { ok: false, reason: "daily loss limit hit" };
    if (now < this.s.cooldownUntil) return { ok: false, reason: "cooling down after losses" };
    if (st.openPositions >= cfg.MAX_OPEN_POSITIONS) return { ok: false, reason: "max open positions" };
    const size = st.tradeSizeSol ?? cfg.TRADE_SIZE_SOL;
    const worstCaseCost =
      size * (1 + cfg.BUY_SLIPPAGE_PCT / 100) * (1 + cfg.PUMPPORTAL_FEE_PCT / 100) +
      cfg.PRIORITY_FEE_SOL +
      cfg.BASE_FEE_SOL +
      cfg.ATA_RENT_SOL;
    if (st.cashSol - worstCaseCost < cfg.MIN_SOL_RESERVE) return { ok: false, reason: "balance too low" };
    this.s.tradeTimes = this.s.tradeTimes.filter((t) => now - t < 3_600_000);
    if (this.s.tradeTimes.length >= cfg.MAX_TRADES_PER_HOUR) return { ok: false, reason: "hourly trade limit" };
    return { ok: true };
  }

  recordBuy(now: number) {
    this.s.tradeTimes.push(now);
  }

  recordClose(pnlSol: number, now: number) {
    if (pnlSol > 0) {
      this.s.consecutiveLosses = 0;
      return;
    }
    this.s.consecutiveLosses++;
    if (this.s.consecutiveLosses >= this.cfg.MAX_CONSEC_LOSSES) {
      this.s.cooldownUntil = now + this.cfg.COOLDOWN_MIN * 60_000;
      this.s.consecutiveLosses = 0;
    }
  }

  /** Call regularly with current equity; handles day rollover and the daily loss stop. */
  updateEquity(equitySol: number, now: number): boolean {
    const key = localDayKey(now);
    if (key !== this.s.dayKey) {
      this.s.dayKey = key;
      this.s.dayStartEquitySol = equitySol;
      this.s.haltedForDay = false;
    }
    const lossPct = (1 - equitySol / this.s.dayStartEquitySol) * 100;
    if (!this.s.haltedForDay && lossPct >= this.cfg.DAILY_LOSS_LIMIT_PCT) {
      this.s.haltedForDay = true;
      return true;
    }
    return false;
  }

  /** Forget the trades counted toward MAX_TRADES_PER_HOUR, so buying can resume now. */
  resetHourlyLimit() {
    this.s.tradeTimes = [];
  }

  snapshot(now: number) {
    return {
      paused: this.paused,
      haltedForDay: this.s.haltedForDay,
      cooldownSec: Math.max(0, Math.round((this.s.cooldownUntil - now) / 1000)),
      consecutiveLosses: this.s.consecutiveLosses,
      tradesLastHour: this.s.tradeTimes.filter((t) => now - t < 3_600_000).length,
      maxTradesPerHour: this.cfg.MAX_TRADES_PER_HOUR,
      dayStartEquitySol: this.s.dayStartEquitySol,
    };
  }
}
