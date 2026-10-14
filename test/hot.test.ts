import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { defaultConfig } from "../src/config";
import {
  applyBuyAmm,
  decodePool,
  poolPriceSol,
  quoteBuyAmm,
  quoteSellAmm,
  WSOL_MINT,
  type PoolState,
} from "../src/chain/pumpswap";
import { AmmPaperExecutor } from "../src/exec/paperAmm";
import { parseTrending, type HotCoin } from "../src/feed/geckoTrending";
import { isHotMeme, shouldBuyHot } from "../src/strategy/hot";
import { botConfig } from "../src/bots/registry";

const cfg = defaultConfig({ SIM_FAIL_RATE: 0, SIM_LATENCY_MS: 0 });
const noWait = async () => {};
// A pool like the ones on the trending list: ~450 SOL effective, ~200M tokens.
const pool: PoolState = { baseReserve: 200_000_000_000_000n, quoteReserve: 450_000_000_000n, realQuote: 433_000_000_000n };

describe("PumpSwap pool decoding", () => {
  it("reads mints, vaults and signed virtual quote reserves at their offsets", () => {
    const keys = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
    const buf = Buffer.alloc(301);
    keys[0].toBuffer().copy(buf, 43);
    keys[1].toBuffer().copy(buf, 75);
    keys[2].toBuffer().copy(buf, 139);
    keys[3].toBuffer().copy(buf, 171);
    buf.writeBigUInt64LE(17_560_471_364n, 245);
    const info = decodePool(buf)!;
    expect(info.baseMint).toBe(keys[0].toBase58());
    expect(info.quoteMint).toBe(keys[1].toBase58());
    expect(info.baseVault.equals(keys[2])).toBe(true);
    expect(info.quoteVault.equals(keys[3])).toBe(true);
    expect(info.virtualQuoteReserves).toBe(17_560_471_364n);
    // -1 as i128 = all ones
    buf.fill(0xff, 245, 261);
    expect(decodePool(buf)!.virtualQuoteReserves).toBe(-1n);
  });
});

describe("PumpSwap pool math", () => {
  it("prices a pool and never creates SOL on a buy-then-sell", () => {
    expect(poolPriceSol(pool)).toBeCloseTo(450 / 200_000_000, 15);
    const solIn = 200_000_000n;
    const tokens = quoteBuyAmm(pool, solIn);
    const back = quoteSellAmm(applyBuyAmm(pool, solIn), tokens);
    expect(back).toBeLessThanOrEqual(solIn);
    expect(Number(solIn - back)).toBeLessThan(10);
  });

  it("can't pay out more than the real SOL in the vault", () => {
    const drained = { ...pool, realQuote: 1_000_000n };
    expect(quoteSellAmm(drained, 10_000_000_000_000n)).toBe(1_000_000n);
  });
});

describe("pool paper executor", () => {
  it("a round trip at a flat price loses about the modeled fees", async () => {
    const exec = new AmmPaperExecutor(cfg, async () => pool, () => 0.99, noWait);
    const price = poolPriceSol(pool);
    const buy = await exec.buy({ mint: "m", solAmount: 0.2, expectedPriceSol: price });
    expect(buy.ok).toBe(true);
    const solInCurve = buy.priceSol * (Number(buy.tokensRaw) / 1e6);
    const sell = await exec.sell({ mint: "m", tokensRaw: buy.tokensRaw, expectedPriceSol: price, solInCurve });
    expect(sell.ok).toBe(true);
    const pnl = buy.solDelta + sell.solDelta;
    const modeled = 0.2 * 2 * ((cfg.BLAZE_POOL_FEE_PCT + cfg.PUMPPORTAL_FEE_PCT) / 100) + 2 * (cfg.BASE_FEE_SOL + cfg.PRIORITY_FEE_SOL);
    expect(-pnl).toBeGreaterThan(modeled * 0.95);
    expect(-pnl).toBeLessThan(modeled * 1.05);
  });
});

function hotCoin(over: Partial<HotCoin> = {}): HotCoin {
  return {
    mint: "Mint111",
    pool: "Pool111",
    symbol: "SEALS",
    dex: "pumpswap",
    quoteMint: WSOL_MINT,
    fdvUsd: 900_000,
    liquidityUsd: 90_000,
    change5m: 6,
    change1h: 80,
    buys1h: 7580,
    sells1h: 6475,
    buyers1h: 2649,
    volume1h: 1_600_000,
    ...over,
  };
}

describe("Blazebit 1-1 rules", () => {
  it("keeps only hot pump.fun memes", () => {
    expect(isHotMeme(hotCoin(), cfg).ok).toBe(true);
    expect(isHotMeme(hotCoin({ dex: "raydium" }), cfg).ok).toBe(false);
    expect(isHotMeme(hotCoin({ quoteMint: "USDC" }), cfg).ok).toBe(false);
    expect(isHotMeme(hotCoin({ fdvUsd: 4_000_000_000 }), cfg).reason).toMatch(/too big/);
    expect(isHotMeme(hotCoin({ fdvUsd: 50_000 }), cfg).reason).toMatch(/too small/);
    expect(isHotMeme(hotCoin({ change1h: 5 }), cfg).reason).toMatch(/not hot/);
    expect(isHotMeme(hotCoin({ buyers1h: 20 }), cfg).ok).toBe(false);
  });

  const T0 = 1_700_000_000_000;
  const rising = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 1500, priceSol: 1e-6 * (1 + i * 0.002) }));
  const now = rising.at(-1)!.t;

  it("buys while the coin is still climbing", () => {
    expect(shouldBuyHot(hotCoin(), rising, now, cfg).enter).toBe(true);
  });

  it("skips cooling, vertical or sold-off coins", () => {
    expect(shouldBuyHot(hotCoin({ change5m: 1 }), rising, now, cfg).enter).toBe(false);
    expect(shouldBuyHot(hotCoin({ change5m: 90 }), rising, now, cfg).reason).toMatch(/vertical/);
    expect(shouldBuyHot(hotCoin({ buys1h: 100, sells1h: 300 }), rising, now, cfg).enter).toBe(false);
    const falling = rising.map((p, i) => ({ ...p, priceSol: 1e-6 * (1 - i * 0.002) }));
    expect(shouldBuyHot(hotCoin(), falling, now, cfg).reason).toMatch(/not rising/);
    expect(shouldBuyHot(hotCoin(), rising.slice(-5), now, cfg).reason).toMatch(/watching/);
  });

  it("trades with Blazebit's own exits and limits", () => {
    const b = botConfig(cfg, "blazebit");
    expect(b).toMatchObject({
      TAKE_PROFIT_PCT: cfg.BLAZE_TAKE_PROFIT_PCT,
      STOP_LOSS_PCT: cfg.BLAZE_STOP_LOSS_PCT,
      MAX_HOLD_SEC: cfg.BLAZE_MAX_HOLD_MIN * 60,
      MAX_OPEN_POSITIONS: cfg.BLAZE_MAX_OPEN_POSITIONS,
    });
  });
});

describe("GeckoTerminal trending parser", () => {
  it("reads the fields Blazebit needs and skips junk", () => {
    const body = {
      data: [
        {
          id: "solana_Pool111",
          type: "pool",
          attributes: {
            address: "Pool111",
            name: "SEALS / SOL",
            fdv_usd: "887802.04",
            market_cap_usd: null,
            reserve_in_usd: "90434.39",
            price_change_percentage: { m5: "6.764", h1: "11.334" },
            transactions: { h1: { buys: 7580, sells: 6475, buyers: 2649, sellers: 2438 } },
            volume_usd: { h1: "1676559.96" },
          },
          relationships: {
            base_token: { data: { id: "solana_Mint111" } },
            quote_token: { data: { id: `solana_${WSOL_MINT}` } },
            dex: { data: { id: "pumpswap" } },
          },
        },
        { id: "broken" },
      ],
    };
    const [c, ...rest] = parseTrending(body);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ mint: "Mint111", pool: "Pool111", symbol: "SEALS", dex: "pumpswap", buyers1h: 2649 });
    expect(c.fdvUsd).toBeCloseTo(887802.04, 2);
    expect(c.change1h).toBeCloseTo(11.334, 3);
    expect(parseTrending({ error: "x" })).toEqual([]);
  });
});
