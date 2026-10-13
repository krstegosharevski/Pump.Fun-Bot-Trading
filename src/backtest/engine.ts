import type { Config } from "../config";
import {
  curveProgressPct,
  marketCapSol,
  realSol,
  spotPriceSol,
  TOKEN_TOTAL_SUPPLY,
  type CurveState,
} from "../chain/curve";
import { PaperExecutor } from "../exec/paper";
import type { Fill } from "../exec/types";
import { parseLine, type CoinMeta } from "../market/recorder";
import { Portfolio, type ClosedTrade } from "../portfolio";
import { RiskGuard, tradeSizeSol } from "../risk";
import { shouldEnter, shouldExit, type PricePoint } from "../strategy/momentum";

const SELL_RETRY_MS = 3000;
/** A fill needs a recorded price within this long after the target time. */
const MAX_FILL_GAP_MS = 5000;

export interface CoinSeries {
  meta: CoinMeta;
  t: number[];
  /** [virtualSol, virtualTokens, realSol, realTokens, complete] per tick (raw units). */
  raw: number[][];
  points: PricePoint[];
}

export function curveAt(s: CoinSeries, i: number): CurveState {
  const [vs, vt, rs, rt, c] = s.raw[i];
  return {
    virtualSolReserves: BigInt(vs),
    virtualTokenReserves: BigInt(vt),
    realSolReserves: BigInt(rs),
    realTokenReserves: BigInt(rt),
    tokenTotalSupply: TOKEN_TOTAL_SUPPLY,
    complete: c === 1,
  };
}

/** Groups recorder lines (any order, any number of files) into per-coin price series. */
export function buildSeries(lines: Iterable<string>): CoinSeries[] {
  const metas = new Map<string, CoinMeta>();
  const ticks = new Map<string, { t: number; raw: number[] }[]>();
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.k === "c") {
      metas.set(r.m, { mint: r.m, symbol: r.sym, createdAt: r.t0, devBuyPct: r.dev, firstMcapSol: r.mc0 });
    } else {
      let arr = ticks.get(r.m);
      if (!arr) ticks.set(r.m, (arr = []));
      arr.push({ t: r.t, raw: [r.vs, r.vt, r.rs, r.rt, r.c] });
    }
  }
  const out: CoinSeries[] = [];
  for (const [mint, arr] of ticks) {
    const meta = metas.get(mint);
    if (!meta || arr.length < 2) continue;
    arr.sort((a, b) => a.t - b.t);
    const dedup = arr.filter((x, i) => i === 0 || x.t !== arr[i - 1].t);
    const s: CoinSeries = { meta, t: dedup.map((x) => x.t), raw: dedup.map((x) => x.raw), points: [] };
    s.points = s.t.map((t, i) => {
      const c = curveAt(s, i);
      return { t, priceSol: spotPriceSol(c), mcapSol: marketCapSol(c), realSol: realSol(c), progressPct: curveProgressPct(c) };
    });
    out.push(s);
  }
  return out;
}

/** Every tick of every coin, in time order. Built once, reused by every backtest run. */
export interface Timeline {
  coins: CoinSeries[];
  coinIdx: Int32Array;
  tickIdx: Int32Array;
  times: Float64Array;
  start: number;
  end: number;
}

export function buildTimeline(coins: CoinSeries[]): Timeline {
  let n = 0;
  for (const s of coins) n += s.t.length;
  const ci = new Int32Array(n);
  const ti = new Int32Array(n);
  const tt = new Float64Array(n);
  let k = 0;
  coins.forEach((s, c) => {
    for (let i = 0; i < s.t.length; i++, k++) {
      ci[k] = c;
      ti[k] = i;
      tt[k] = s.t[i];
    }
  });
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => tt[a] - tt[b]);
  const tl: Timeline = {
    coins,
    coinIdx: new Int32Array(n),
    tickIdx: new Int32Array(n),
    times: new Float64Array(n),
    start: n ? tt[order[0]] : 0,
    end: n ? tt[order[n - 1]] : 0,
  };
  order.forEach((src, dst) => {
    tl.coinIdx[dst] = ci[src];
    tl.tickIdx[dst] = ti[src];
    tl.times[dst] = tt[src];
  });
  return tl;
}

export interface BacktestOptions {
  startSol: number;
  /** Only coins created in [from, to) are traded. */
  from?: number;
  to?: number;
  seed?: number;
}

export interface BacktestResult {
  trades: ClosedTrade[];
  startSol: number;
  endSol: number;
  netPnlSol: number;
  netPnlPct: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  feesSol: number;
}

/** Deterministic random numbers so every run of the grid sees the same simulated failures. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function firstIndexAtOrAfter(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Replays recorded price paths through the real strategy, risk guard and paper
 * executor (same fees, latency and failure model as `npm run dev`).
 */
export async function runBacktest(tl: Timeline, cfg: Config, opts: BacktestOptions): Promise<BacktestResult> {
  const { coins } = tl;
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const exitFeePct = cfg.PUMP_FEE_PCT + cfg.PUMPPORTAL_FEE_PCT;
  const pf = new Portfolio("paper", opts.startSol, opts.startSol, 0, null);

  // The executor reads "the curve SIM_LATENCY_MS after the decision" from the recording.
  let fillCoin: CoinSeries | null = null;
  let fillAt = 0;
  const exec = new PaperExecutor(
    cfg,
    async () => {
      if (!fillCoin) return null;
      const i = firstIndexAtOrAfter(fillCoin.t, fillAt);
      if (i < fillCoin.t.length && fillCoin.t[i] - fillAt <= MAX_FILL_GAP_MS) return curveAt(fillCoin, i);
      return null;
    },
    mulberry32(opts.seed ?? 1),
    async () => {},
  );

  const trades: ClosedTrade[] = [];
  const hist: (PricePoint[] | null)[] = new Array(coins.length).fill(null);
  const done = new Uint8Array(coins.length);
  const coinOf = new Map<string, number>();
  const lastSellAttempt = new Map<string, number>();
  let risk: RiskGuard | null = null;
  let peak = opts.startSol;
  let maxDd = 0;

  const afterTrade = (t: number) => {
    const eq = pf.equitySol(exitFeePct);
    risk!.updateEquity(eq, t);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (1 - eq / peak) * 100);
  };

  for (let k = 0; k < tl.times.length; k++) {
    const t = tl.times[k];
    if (t < from) continue;
    if (t >= to && pf.positions.size === 0) break;
    const ci = tl.coinIdx[k];
    const s = coins[ci];
    const ti = tl.tickIdx[k];
    const p = s.points[ti];
    const mint = s.meta.mint;
    const complete = s.raw[ti][4] === 1;
    risk ??= new RiskGuard(cfg, opts.startSol, t);

    const pos = pf.positions.get(mint);
    if (pos) {
      pf.markPrice(mint, p.priceSol);
      if (t - (lastSellAttempt.get(mint) ?? -Infinity) < SELL_RETRY_MS) continue;
      const reason = shouldExit(pos, pos.lastPriceSol, complete, t, cfg);
      if (!reason) continue;
      lastSellAttempt.set(mint, t);
      fillCoin = s;
      fillAt = t + cfg.SIM_LATENCY_MS;
      const fill = await exec.sell({
        mint,
        tokensRaw: pos.tokensRaw,
        expectedPriceSol: pos.lastPriceSol,
        solInCurve: (pos.entryPriceSol * Number(pos.tokensRaw)) / 1e6,
      });
      if (fill.ok) {
        const tr = pf.close(mint, fill, reason, t)!;
        trades.push(tr);
        risk.recordClose(tr.pnlSol, t);
      } else {
        pf.recordFailedTx(fill);
      }
      afterTrade(t);
      continue;
    }

    if (done[ci] || t >= to) continue;
    if (s.meta.createdAt < from || s.meta.createdAt >= to) {
      done[ci] = 1;
      continue;
    }
    const h = hist[ci] ?? (hist[ci] = []);
    h.push(p);
    const d = shouldEnter(
      { createdAt: s.meta.createdAt, firstMcapSol: s.meta.firstMcapSol, devBuyPct: s.meta.devBuyPct, complete, history: h },
      t,
      cfg,
    );
    if (!d.enter && !d.final) continue;
    done[ci] = 1;
    hist[ci] = null;
    if (!d.enter) continue;

    const size = tradeSizeSol(cfg, pf.equitySol(exitFeePct));
    if (!risk.canOpen(t, { openPositions: pf.positions.size, cashSol: pf.cashSol, tradeSizeSol: size }).ok) continue;
    risk.recordBuy(t);
    fillCoin = s;
    fillAt = t + cfg.SIM_LATENCY_MS;
    const fill = await exec.buy({ mint, solAmount: size, expectedPriceSol: p.priceSol });
    if (fill.ok) {
      pf.open({ mint, symbol: s.meta.symbol, name: s.meta.symbol, entryReason: d.reason, bot: "primal" }, fill, t);
      coinOf.set(mint, ci);
    } else {
      pf.recordFailedTx(fill);
    }
    afterTrade(t);
  }

  // Positions still open when the data ends: value them at their last recorded price.
  for (const pos of [...pf.positions.values()]) {
    const s = coins[coinOf.get(pos.mint)!];
    const lastT = s.t[s.t.length - 1];
    const value = pf.positionValueSol(pos, exitFeePct);
    const txCost = cfg.BASE_FEE_SOL + cfg.PRIORITY_FEE_SOL;
    const fill: Fill = {
      ok: true,
      solDelta: value - txCost,
      tokensRaw: pos.tokensRaw,
      priceSol: pos.lastPriceSol,
      feesSol: (value - pos.rentSol) * (exitFeePct / 100) + txCost,
      rentSol: pos.rentSol,
    };
    trades.push(pf.close(pos.mint, fill, "end_of_data", lastT)!);
  }

  const wins = trades.filter((tr) => tr.pnlSol > 0);
  const grossWin = wins.reduce((a, tr) => a + tr.pnlSol, 0);
  const grossLoss = -trades.filter((tr) => tr.pnlSol <= 0).reduce((a, tr) => a + tr.pnlSol, 0);
  return {
    trades,
    startSol: opts.startSol,
    endSol: pf.cashSol,
    netPnlSol: pf.cashSol - opts.startSol,
    netPnlPct: (pf.cashSol / opts.startSol - 1) * 100,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownPct: maxDd,
    feesSol: pf.feesPaidSol,
  };
}
