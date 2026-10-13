import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  applyBuy,
  curveProgressPct,
  decodeCurve,
  initialCurve,
  INITIAL_REAL_TOKEN_RESERVES,
  isSolPaired,
  marketCapSol,
  quoteBuy,
  quoteSell,
  spotPriceSol,
} from "../src/chain/curve";

describe("bonding curve math", () => {
  it("prices a brand-new coin at 30 SOL / 1.073B tokens", () => {
    const c = initialCurve();
    expect(spotPriceSol(c)).toBeCloseTo(30 / 1.073e9, 15);
    expect(marketCapSol(c)).toBeCloseTo(27.96, 2);
    expect(curveProgressPct(c)).toBe(0);
  });

  it("matches PumpPortal's marketCapSol for a real launch", () => {
    // From a captured PumpPortal create message: vSol 30.0977..., vTokens 1069514290.47..., marketCapSol 28.1415...
    const c = {
      ...initialCurve(),
      virtualSolReserves: 30_097_774_557n,
      virtualTokenReserves: 1_069_514_290_475_798n,
    };
    expect(marketCapSol(c)).toBeCloseTo(28.14153567, 5);
  });

  it("never creates value on a fee-less buy→sell round trip", () => {
    const start = applyBuy(initialCurve(), 5_000_000_000n);
    const solIn = 20_000_000n;
    const tokens = quoteBuy(start, solIn);
    expect(tokens).toBeGreaterThan(0n);
    const after = applyBuy(start, solIn);
    const back = quoteSell(after, tokens);
    expect(back).toBeLessThanOrEqual(solIn);
    expect(Number(solIn - back)).toBeLessThan(10); // only rounding dust
  });

  it("keeps the constant product from decreasing on a buy", () => {
    const c = applyBuy(initialCurve(), 3_000_000_000n);
    const next = applyBuy(c, 1_000_000_000n);
    expect(next.virtualSolReserves * next.virtualTokenReserves).toBeGreaterThanOrEqual(
      c.virtualSolReserves * c.virtualTokenReserves,
    );
  });

  it("reports progress toward graduation", () => {
    const c = { ...initialCurve(), realTokenReserves: INITIAL_REAL_TOKEN_RESERVES / 2n };
    expect(curveProgressPct(c)).toBeCloseTo(50, 5);
    expect(curveProgressPct({ ...c, realTokenReserves: 0n })).toBe(100);
  });

  it("decodes the on-chain account layout", () => {
    const buf = Buffer.alloc(166);
    buf.writeBigUInt64LE(1_000n, 8);
    buf.writeBigUInt64LE(2_000n, 16);
    buf.writeBigUInt64LE(3_000n, 24);
    buf.writeBigUInt64LE(4_000n, 32);
    buf.writeBigUInt64LE(5_000n, 40);
    buf[48] = 1;
    const creator = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    creator.toBuffer().copy(buf, 49);
    buf[81] = 1;
    const c = decodeCurve(buf)!;
    expect(c.virtualTokenReserves).toBe(1_000n);
    expect(c.virtualSolReserves).toBe(2_000n);
    expect(c.realTokenReserves).toBe(3_000n);
    expect(c.realSolReserves).toBe(4_000n);
    expect(c.tokenTotalSupply).toBe(5_000n);
    expect(c.complete).toBe(true);
    expect(c.creator).toBe(creator.toBase58());
    expect(c.isMayhem).toBe(true);
    expect(isSolPaired(c)).toBe(true); // zeroed quote_mint = SOL
    creator.toBuffer().copy(buf, 83);
    expect(isSolPaired(decodeCurve(buf)!)).toBe(false);
  });
});
