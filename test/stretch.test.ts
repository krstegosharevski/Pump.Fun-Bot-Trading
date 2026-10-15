import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { applyBuy, initialCurve, spotPriceSol } from "../src/chain/curve";
import { PaperExecutor } from "../src/exec/paper";
import { parseCoinList } from "../src/feed/pumpfunList";
import { Portfolio } from "../src/portfolio";
import { botConfig } from "../src/bots/registry";
import { isFinalStretch, isSafe, shouldBuyStretch, shouldExitStretch } from "../src/strategy/stretch";
import type { PricePoint } from "../src/strategy/momentum";

const cfg = defaultConfig();
const T0 = 1_700_000_000_000;

describe("ErenTinx 3: final stretch", () => {
  const coin = { progressPct: 75, complete: false, lastTradeAt: T0, hasSocials: true };

  it("keeps live coins 60–95% of the way to graduating", () => {
    expect(isFinalStretch(coin, T0 + 5_000, cfg).ok).toBe(true);
    expect(isFinalStretch({ ...coin, progressPct: 40 }, T0, cfg).reason).toMatch(/not yet/);
    expect(isFinalStretch({ ...coin, progressPct: 98 }, T0, cfg).reason).toMatch(/too late/);
    expect(isFinalStretch({ ...coin, complete: true }, T0, cfg).ok).toBe(false);
    expect(isFinalStretch(coin, T0 + 120_000, cfg).reason).toMatch(/no recent trades/);
    expect(isFinalStretch({ ...coin, hasSocials: false }, T0, { ...cfg, ERENTINX_REQUIRE_SOCIALS: true }).ok).toBe(false);
  });

  it("applies the holder safety checks", () => {
    expect(isSafe({ top10Pct: 20, top1Pct: 5, devPct: 1 }, cfg).ok).toBe(true);
    expect(isSafe({ top10Pct: 20, top1Pct: 5, devPct: 9 }, cfg).reason).toMatch(/creator/);
    expect(isSafe({ top10Pct: 45, top1Pct: 5, devPct: 1 }, cfg).reason).toMatch(/top 10/);
    expect(isSafe({ top10Pct: 25, top1Pct: 15, devPct: 1 }, cfg).reason).toMatch(/one wallet/);
  });

  it("treats an unchecked top-holder list according to the setting", () => {
    const unchecked = { top10Pct: null, top1Pct: null, devPct: 1 };
    expect(isSafe(unchecked, cfg)).toMatchObject({ ok: true, reason: expect.stringMatching(/unchecked/) });
    expect(isSafe(unchecked, { ...cfg, ERENTINX_REQUIRE_TOP_HOLDERS: true }).ok).toBe(false);
  });

  const series = (sols: number[]): PricePoint[] =>
    sols.map((s, i) => ({ t: T0 + i * 10_000, priceSol: s / 1e9, mcapSol: s, realSol: s, progressPct: 75 }));

  it("buys only while SOL keeps flowing in and the price rises", () => {
    const h = series([50, 51, 52, 53, 54, 55, 56, 57]);
    expect(shouldBuyStretch(h, h.at(-1)!.t, cfg).enter).toBe(true);
    const slow = series([50, 50.2, 50.4, 50.5, 50.6, 50.7, 50.8, 50.9]);
    expect(shouldBuyStretch(slow, slow.at(-1)!.t, cfg).reason).toMatch(/too slow/);
    expect(shouldBuyStretch(h.slice(-3), h.at(-1)!.t, cfg).reason).toMatch(/watching/);
  });
});

describe("ErenTinx 3: selling in steps", () => {
  const pos = { openedAt: T0, entryPriceSol: 1, peakPriceSol: 1, stage: 0 };

  it("stops out, or sells part at the first target", () => {
    expect(shouldExitStretch(pos, 0.84, false, T0 + 1000, cfg)).toEqual({ kind: "all", reason: "stop_loss" });
    expect(shouldExitStretch(pos, 1.26, false, T0 + 1000, cfg)).toEqual({ kind: "part", fraction: 0.5, reason: "take_profit_1" });
    expect(shouldExitStretch(pos, 1.1, false, T0 + 1000, cfg)).toBeNull();
  });

  it("after step 1 the rest never turns into a loss", () => {
    const after = { ...pos, stage: 1, peakPriceSol: 1.5 };
    expect(shouldExitStretch(after, 1.81, false, T0 + 1000, cfg)?.reason).toBe("take_profit_2");
    expect(shouldExitStretch(after, 1.3, false, T0 + 1000, cfg)?.reason).toBe("trailing_stop");
    expect(shouldExitStretch({ ...after, peakPriceSol: 1.1 }, 1.0, false, T0 + 1000, cfg)?.reason).toBe("breakeven_stop");
    expect(shouldExitStretch({ ...after, peakPriceSol: 1.4 }, 1.35, false, T0 + 1000, cfg)).toBeNull();
  });

  it("sells everything on graduation or the time limit", () => {
    expect(shouldExitStretch(pos, 1.1, true, T0 + 1000, cfg)?.reason).toBe("graduated");
    expect(shouldExitStretch(pos, 1.1, false, T0 + cfg.ERENTINX_MAX_HOLD_MIN * 60_000, cfg)?.reason).toBe("max_hold");
  });

  it("books one trade whose P&L covers every step", () => {
    const pf = new Portfolio("paper", 1, 1, 0, null);
    const buy = { ok: true, solDelta: -0.2, tokensRaw: 1_000_000n, priceSol: 1e-7, feesSol: 0.004, rentSol: 0.002 };
    pf.open({ mint: "m", symbol: "AAA", name: "A", entryReason: "x", bot: "erentinx" }, buy, 0);
    pf.sellPart("m", { ok: true, solDelta: 0.12, tokensRaw: 500_000n, priceSol: 1.25e-7, feesSol: 0.002, rentSol: 0 });
    expect(pf.positions.get("m")).toMatchObject({ tokensRaw: 500_000n, stage: 1, soldSol: 0.12 });
    const t = pf.close("m", { ok: true, solDelta: 0.11, tokensRaw: 500_000n, priceSol: 1.1e-7, feesSol: 0.002, rentSol: 0.002 }, "trailing_stop", 60_000)!;
    expect(t.proceedsSol).toBeCloseTo(0.23, 10);
    expect(t.pnlSol).toBeCloseTo(0.03, 10);
    expect(t.reason).toBe("tp1>trailing_stop");
    expect(pf.wins).toBe(1);
    expect(pf.cashSol).toBeCloseTo(1.03, 10);
  });

  it("a partial paper sale keeps the token account (no rent back)", async () => {
    const curve = applyBuy(initialCurve(), 60_000_000_000n);
    const exec = new PaperExecutor({ ...cfg, SIM_FAIL_RATE: 0, SIM_LATENCY_MS: 0 }, async () => curve, () => 0.99, async () => {});
    const buy = await exec.buy({ mint: "m", solAmount: 0.2, expectedPriceSol: spotPriceSol(curve) });
    const half = buy.tokensRaw / 2n;
    const part = await exec.sell({ mint: "m", tokensRaw: half, expectedPriceSol: spotPriceSol(curve), fraction: 0.5 });
    expect(part.ok).toBe(true);
    expect(part.rentSol).toBe(0);
  });
});

describe("pump.fun list parser", () => {
  it("keeps standard SOL curves and computes progress", () => {
    const coins = parseCoinList([
      {
        mint: "Std111",
        name: "Standard",
        symbol: "STD",
        creator: "Dev111",
        created_timestamp: 1,
        last_trade_timestamp: 2,
        virtual_sol_reserves: 94_680_410_741,
        real_sol_reserves: 64_680_410_741,
        real_token_reserves: 198_275_000_000_000, // 75% of 793.1M sold
        usd_market_cap: 29_330,
        complete: false,
        twitter: "https://x.com/std",
      },
      { mint: "Mayhem111", virtual_sol_reserves: 18_700_000_000, real_sol_reserves: 0, real_token_reserves: 1 },
      { not: "a coin" },
    ]);
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({ mint: "Std111", symbol: "STD", creator: "Dev111", hasSocials: true });
    expect(coins[0].progressPct).toBeCloseTo(75, 1);
    expect(coins[0].realSol).toBeCloseTo(64.68, 2);
    expect(parseCoinList({ error: "x" })).toEqual([]);
  });

  it("ErenTinx uses its own position and trade limits", () => {
    expect(botConfig(cfg, "erentinx")).toMatchObject({
      MAX_OPEN_POSITIONS: cfg.ERENTINX_MAX_OPEN_POSITIONS,
      MAX_TRADES_PER_HOUR: cfg.ERENTINX_MAX_TRADES_PER_HOUR,
    });
  });
});
