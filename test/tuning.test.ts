import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import {
  INITIAL_REAL_TOKEN_RESERVES,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  TOKEN_TOTAL_SUPPLY,
  type CurveState,
} from "../src/chain/curve";
import { tradeSizeSol } from "../src/risk";
import { parseLine, tickLine, TickRecorder } from "../src/market/recorder";
import { buildSeries, buildTimeline, runBacktest } from "../src/backtest/engine";

const K = INITIAL_VIRTUAL_SOL_RESERVES * INITIAL_VIRTUAL_TOKEN_RESERVES;

/** A pump.fun curve holding `vSol` SOL of virtual reserves (30 = brand new). */
function curveAt(vSol: number): CurveState {
  const vs = BigInt(Math.round(vSol * 1e9));
  const vt = K / vs;
  return {
    virtualSolReserves: vs,
    virtualTokenReserves: vt,
    realSolReserves: vs - INITIAL_VIRTUAL_SOL_RESERVES,
    realTokenReserves: INITIAL_REAL_TOKEN_RESERVES - (INITIAL_VIRTUAL_TOKEN_RESERVES - vt),
    tokenTotalSupply: TOKEN_TOTAL_SUPPLY,
    complete: false,
  };
}

/** Recorder lines for one coin whose virtual SOL follows `path`, one tick per second. */
function recordedCoin(mint: string, t0: number, path: number[]): string[] {
  const meta = { k: "c", m: mint, sym: mint.toUpperCase(), t0, dev: 1, mc0: 27.96 };
  return [JSON.stringify(meta), ...path.map((v, i) => JSON.stringify(tickLine(mint, t0 + i * 1000, curveAt(v))))];
}

const RISE = [30.5, 31, 31.5, 32, 32.5, 33, 33.5, 34, 34.5, 35];
const PUMP = [...RISE, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];
const DUMP = [...RISE, 33, 31, 30.5, 30.2, 30.2, 30.2, 30.2, 30.2, 30.2, 30.2];

describe("trade sizing", () => {
  it("uses a % of equity, capped by MAX_TRADE_SOL", () => {
    const cfg = defaultConfig({ TRADE_SIZE_PCT: 2, MAX_TRADE_SOL: 0.5 });
    expect(tradeSizeSol(cfg, 9)).toBeCloseTo(0.18, 10);
    expect(tradeSizeSol(cfg, 100)).toBe(0.5);
  });

  it("falls back to the fixed size", () => {
    expect(tradeSizeSol(defaultConfig({ TRADE_SIZE_PCT: 0, TRADE_SIZE_SOL: 0.02 }), 9)).toBe(0.02);
  });
});

describe("recorder", () => {
  it("round-trips a tick line", () => {
    const c = curveAt(34);
    const back = parseLine(JSON.stringify(tickLine("abc", 123, c)));
    expect(back).toMatchObject({ k: "t", m: "abc", t: 123, vs: Number(c.virtualSolReserves), c: 0 });
    expect(parseLine("{broken")).toBeNull();
  });

  it("starts a coin only once it has real SOL, then writes meta + ticks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticks-"));
    const rec = new TickRecorder(dir, 0.5);
    const meta = { mint: "m1", symbol: "M1", createdAt: 1, devBuyPct: 2, firstMcapSol: 28 };
    rec.record(meta, curveAt(30.1), Date.UTC(2026, 9, 13)); // 0.1 SOL real: skipped
    rec.record(meta, curveAt(31), Date.UTC(2026, 9, 13, 0, 0, 1));
    rec.record(meta, curveAt(32), Date.UTC(2026, 9, 13, 0, 0, 2));
    expect(rec.linesWritten).toBe(3);
    rec.close();
  });
});

describe("backtest engine", () => {
  const cfg = defaultConfig({ SIM_FAIL_RATE: 0, TRADE_SIZE_PCT: 2 });
  const T0 = Date.UTC(2026, 9, 13, 12);

  it("buys a pump, takes profit and keeps it after fees", async () => {
    const tl = buildTimeline(buildSeries(recordedCoin("pump", T0, PUMP)));
    const r = await runBacktest(tl, cfg, { startSol: 10 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].reason).toBe("take_profit");
    expect(r.netPnlSol).toBeGreaterThan(0);
  });

  it("buys a dump, stops out and records the loss", async () => {
    const tl = buildTimeline(buildSeries(recordedCoin("dump", T0, DUMP)));
    const r = await runBacktest(tl, cfg, { startSol: 10 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].reason).toBe("stop_loss");
    expect(r.netPnlSol).toBeLessThan(0);
  });

  it("only trades coins created inside the requested period", async () => {
    const lines = [...recordedCoin("early", T0, PUMP), ...recordedCoin("late", T0 + 600_000, PUMP)];
    const tl = buildTimeline(buildSeries(lines));
    const r = await runBacktest(tl, cfg, { startSol: 10, from: T0 + 300_000 });
    expect(r.trades.map((t) => t.mint)).toEqual(["late"]);
  });
});
