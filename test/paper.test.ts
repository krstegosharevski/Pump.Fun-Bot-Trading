import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { defaultConfig } from "../src/config";
import { applyBuy, initialCurve, spotPriceSol } from "../src/chain/curve";
import { PaperExecutor } from "../src/exec/paper";
import { BASE_ALLOWED_PROGRAMS, inspectTransaction } from "../src/exec/live";
import { Portfolio } from "../src/portfolio";

const noWait = async () => {};
const curve = applyBuy(initialCurve(), 5_000_000_000n); // a coin with 5 SOL in it

describe("paper executor", () => {
  const cfg = defaultConfig({ SIM_FAIL_RATE: 0, SIM_LATENCY_MS: 0 });
  const exec = new PaperExecutor(cfg, async () => curve, () => 0.99, noWait);
  const price = spotPriceSol(curve);

  it("a round trip at a flat price loses about the modeled fees", async () => {
    const buy = await exec.buy({ mint: "x", solAmount: 0.02, expectedPriceSol: price });
    expect(buy.ok).toBe(true);
    const sell = await exec.sell({ mint: "x", tokensRaw: buy.tokensRaw, expectedPriceSol: price });
    expect(sell.ok).toBe(true);

    const pnl = buy.solDelta + sell.solDelta;
    const txFees = 2 * (cfg.BASE_FEE_SOL + cfg.PRIORITY_FEE_SOL);
    const pctFees = 0.02 * 2 * ((cfg.PUMP_FEE_PCT + cfg.PUMPPORTAL_FEE_PCT) / 100);
    expect(pnl).toBeLessThan(0);
    // Loss = % fees + tx fees + a little price impact (we sell into the pre-buy curve).
    expect(-pnl).toBeGreaterThan((pctFees + txFees) * 0.95);
    expect(-pnl).toBeLessThan((pctFees + txFees) * 1.15);
    expect(buy.rentSol).toBe(cfg.ATA_RENT_SOL);
    expect(sell.rentSol).toBe(cfg.ATA_RENT_SOL);
  });

  it("failed transactions still cost the network fee", async () => {
    const failing = new PaperExecutor({ ...cfg, SIM_FAIL_RATE: 1 }, async () => curve, () => 0, noWait);
    const fill = await failing.buy({ mint: "x", solAmount: 0.02, expectedPriceSol: price });
    expect(fill.ok).toBe(false);
    expect(fill.solDelta).toBeCloseTo(-(cfg.BASE_FEE_SOL + cfg.PRIORITY_FEE_SOL), 9);
  });

  it("can still sell after everyone else has left the curve (our own SOL counts)", async () => {
    const buy = await exec.buy({ mint: "x", solAmount: 0.2, expectedPriceSol: price });
    const solInCurve = buy.priceSol * (Number(buy.tokensRaw) / 1e6);
    // Every other holder sold: the on-chain curve is back to its empty starting state.
    const empty = initialCurve();
    const emptyExec = new PaperExecutor(cfg, async () => empty, () => 0.99, noWait);
    const spot = spotPriceSol(empty);
    const stuck = await emptyExec.sell({ mint: "x", tokensRaw: buy.tokensRaw, expectedPriceSol: spot });
    expect(stuck.ok).toBe(false); // the old behaviour: "price moved -100%"
    const fixed = await emptyExec.sell({ mint: "x", tokensRaw: buy.tokensRaw, expectedPriceSol: spot, solInCurve });
    expect(fixed.ok).toBe(true);
    expect(fixed.solDelta).toBeGreaterThan(0.1);
    expect(fixed.priceSol / spot).toBeGreaterThan(0.9);
  });

  it("sells at any price when the slippage limit is raised", async () => {
    const buy = await exec.buy({ mint: "x", solAmount: 0.02, expectedPriceSol: price });
    const solInCurve = buy.priceSol * (Number(buy.tokensRaw) / 1e6);
    const crashed = new PaperExecutor(cfg, async () => initialCurve(), () => 0.99, noWait);
    const req = { mint: "x", tokensRaw: buy.tokensRaw, expectedPriceSol: price * 3, solInCurve };
    expect((await crashed.sell(req)).ok).toBe(false);
    expect((await crashed.sell({ ...req, slippagePct: 95 })).ok).toBe(true);
  });

  it("rejects a buy when price ran past the slippage limit", async () => {
    const fill = await exec.buy({ mint: "x", solAmount: 0.02, expectedPriceSol: price / 2 });
    expect(fill.ok).toBe(false);
    expect(fill.error).toMatch(/slippage/);
  });
});

describe("portfolio accounting", () => {
  it("P&L equals SOL out minus SOL in, rent included on both sides", async () => {
    const cfg = defaultConfig({ SIM_FAIL_RATE: 0, SIM_LATENCY_MS: 0 });
    const price = spotPriceSol(curve);
    const exec = new PaperExecutor(cfg, async () => curve, () => 0.99, noWait);
    const pf = new Portfolio("paper", 0.2, 0.2, Date.now(), "test-data-unused");
    const buy = await exec.buy({ mint: "m", solAmount: 0.02, expectedPriceSol: price });
    pf.open({ mint: "m", symbol: "TST", name: "Test", entryReason: "test", bot: "primal" }, buy, 0);
    const sell = await exec.sell({ mint: "m", tokensRaw: buy.tokensRaw, expectedPriceSol: price });
    // Close without touching disk.
    const p = pf.positions.get("m")!;
    pf.positions.delete("m");
    pf.cashSol += sell.solDelta;
    expect(pf.cashSol - 0.2).toBeCloseTo(sell.solDelta - p.costSol, 12);
  });
});

describe("live transaction inspection", () => {
  const me = Keypair.generate().publicKey;
  const allowed = new Set(BASE_ALLOWED_PROGRAMS);
  const build = (ixs: TransactionInstruction[], payer = me) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: ixs,
      }).compileToV0Message(),
    );

  it("accepts a plain SOL transfer (like the PumpPortal fee)", () => {
    const tx = build([SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 1 })]);
    expect(inspectTransaction(tx, me, allowed)).toBeNull();
  });

  it("refuses an Assign that would hand over the wallet", () => {
    const tx = build([SystemProgram.assign({ accountPubkey: me, programId: Keypair.generate().publicKey })]);
    expect(inspectTransaction(tx, me, allowed)).toMatch(/System instruction/);
  });

  it("refuses unknown programs and foreign fee payers", () => {
    const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
    expect(inspectTransaction(build([evil]), me, allowed)).toMatch(/unexpected program/);
    const other = Keypair.generate().publicKey;
    const tx = build([SystemProgram.transfer({ fromPubkey: other, toPubkey: me, lamports: 1 })], other);
    expect(inspectTransaction(tx, me, allowed)).toMatch(/fee payer/);
  });
});
