import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { shouldEnter, shouldExit, type CoinView, type PricePoint } from "../src/strategy/momentum";
import { RiskGuard } from "../src/risk";

const cfg = defaultConfig();
const T0 = 1_700_000_000_000;

function series(mcaps: number[], realSol: number, stepMs = 1000): PricePoint[] {
  return mcaps.map((m, i) => ({ t: T0 + i * stepMs, priceSol: m / 1e9, mcapSol: m, realSol, progressPct: 10 }));
}

function coin(history: PricePoint[], extra: Partial<CoinView> = {}): CoinView {
  return { createdAt: T0, firstMcapSol: 28, devBuyPct: 2, complete: false, history, ...extra };
}

describe("momentum entry", () => {
  const rising = series([28, 29, 31, 33, 35, 37, 38, 40], 5);
  const now = rising.at(-1)!.t;

  it("enters a coin with strong, still-rising momentum", () => {
    expect(shouldEnter(coin(rising), now, cfg).enter).toBe(true);
  });

  it("skips when market cap has not grown enough", () => {
    expect(shouldEnter(coin(series([28, 28, 29, 29, 30, 30, 31, 32], 5)), now, cfg).enter).toBe(false);
  });

  it("skips when there is too little SOL in the curve", () => {
    expect(shouldEnter(coin(series([28, 29, 31, 33, 35, 37, 38, 40], 1)), now, cfg).enter).toBe(false);
  });

  it("skips when price is falling over the lookback", () => {
    expect(shouldEnter(coin(series([28, 45, 44, 43, 42, 41, 40, 39], 5)), now, cfg).enter).toBe(false);
  });

  it("permanently skips big dev buys and expired watch windows", () => {
    const dev = shouldEnter(coin(rising, { devBuyPct: 25 }), now, cfg);
    expect(dev).toMatchObject({ enter: false, final: true });
    const late = shouldEnter(coin(rising), T0 + (cfg.WATCH_WINDOW_SEC + 1) * 1000, cfg);
    expect(late).toMatchObject({ enter: false, final: true });
  });
});

describe("exits", () => {
  const pos = { openedAt: T0, entryPriceSol: 1, peakPriceSol: 1 };

  it("stop loss", () => expect(shouldExit(pos, 0.79, false, T0 + 1000, cfg)).toBe("stop_loss"));
  it("take profit", () => expect(shouldExit(pos, 1.41, false, T0 + 1000, cfg)).toBe("take_profit"));
  it("trailing stop after the activation level", () => {
    expect(shouldExit({ ...pos, peakPriceSol: 1.3 }, 1.1, false, T0 + 1000, cfg)).toBe("trailing_stop");
    expect(shouldExit({ ...pos, peakPriceSol: 1.1 }, 0.95, false, T0 + 1000, cfg)).toBeNull();
  });
  it("max hold time", () =>
    expect(shouldExit(pos, 1.05, false, T0 + cfg.MAX_HOLD_SEC * 1000, cfg)).toBe("max_hold"));
  it("graduation", () => expect(shouldExit(pos, 1.05, true, T0 + 1000, cfg)).toBe("graduated"));
  it("holds otherwise", () => expect(shouldExit(pos, 1.05, false, T0 + 1000, cfg)).toBeNull());
});

describe("risk guard", () => {
  it("cools down after consecutive losses", () => {
    const risk = new RiskGuard(cfg, 0.2, T0);
    const st = { openPositions: 0, cashSol: 0.2 };
    for (let i = 0; i < cfg.MAX_CONSEC_LOSSES; i++) risk.recordClose(-0.001, T0);
    expect(risk.canOpen(T0 + 1000, st)).toMatchObject({ ok: false, reason: "cooling down after losses" });
    expect(risk.canOpen(T0 + cfg.COOLDOWN_MIN * 60_000 + 1, st).ok).toBe(true);
  });

  it("halts for the day at the daily loss limit", () => {
    const risk = new RiskGuard(cfg, 0.2, T0);
    expect(risk.updateEquity(0.2 * (1 - cfg.DAILY_LOSS_LIMIT_PCT / 100) - 0.0001, T0 + 1000)).toBe(true);
    expect(risk.canOpen(T0 + 2000, { openPositions: 0, cashSol: 0.2 }).ok).toBe(false);
  });

  it("enforces max positions and the SOL reserve", () => {
    const risk = new RiskGuard(cfg, 0.2, T0);
    expect(risk.canOpen(T0, { openPositions: cfg.MAX_OPEN_POSITIONS, cashSol: 1 }).ok).toBe(false);
    expect(risk.canOpen(T0, { openPositions: 0, cashSol: cfg.MIN_SOL_RESERVE + 0.01 }).ok).toBe(false);
    expect(risk.canOpen(T0, { openPositions: 0, cashSol: 0.2 }).ok).toBe(true);
  });
});
