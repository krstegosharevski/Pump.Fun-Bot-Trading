import fs from "node:fs";
import path from "node:path";
import { TOKEN_DECIMALS } from "./chain/curve";
import type { Fill } from "./exec/types";

const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  openedAt: number;
  tokensRaw: bigint;
  entryPriceSol: number;
  /** Total SOL that left the wallet for the buy (trade + fees + rent). */
  costSol: number;
  rentSol: number;
  buyFeesSol: number;
  peakPriceSol: number;
  lastPriceSol: number;
  entryReason: string;
  buySig?: string;
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  holdSec: number;
  entryPriceSol: number;
  exitPriceSol: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  feesSol: number;
  reason: string;
  entryReason: string;
  buySig?: string;
  sellSig?: string;
}

export interface EquityPoint {
  t: number;
  equitySol: number;
}

type SavedPosition = Omit<Position, "tokensRaw"> & { tokensRaw: string };

interface SavedState {
  version: 1;
  mode: string;
  startedAt: number;
  startSol: number;
  cashSol: number;
  realizedPnlSol: number;
  feesPaidSol: number;
  failedTxCount: number;
  wins: number;
  losses: number;
  positions: SavedPosition[];
  recentTrades: ClosedTrade[];
  equityHistory: EquityPoint[];
  risk?: unknown;
}

export const CSV_HEADER =
  "closedAt,symbol,mint,reason,holdSec,entryPriceSol,exitPriceSol,costSol,proceedsSol,pnlSol,pnlPct,feesSol,entryReason,buySig,sellSig";

const clean = (s: string | undefined) => (s ?? "").replace(/[,"\r\n]/g, " ").trim();

export class Portfolio {
  positions = new Map<string, Position>();
  recentTrades: ClosedTrade[] = [];
  equityHistory: EquityPoint[] = [];
  realizedPnlSol = 0;
  feesPaidSol = 0;
  failedTxCount = 0;
  wins = 0;
  losses = 0;
  savedRisk: unknown;

  constructor(
    public readonly mode: "paper" | "live",
    public startSol: number,
    public cashSol: number,
    public startedAt = Date.now(),
    private dataDir = "data",
  ) {}

  get statePath() {
    return path.join(this.dataDir, `${this.mode}-state.json`);
  }

  get tradesPath() {
    return path.join(this.dataDir, `${this.mode}-trades.csv`);
  }

  static load(mode: "paper" | "live", dataDir = "data"): Portfolio | null {
    const file = path.join(dataDir, `${mode}-state.json`);
    if (!fs.existsSync(file)) return null;
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as SavedState;
    const p = new Portfolio(mode, s.startSol, s.cashSol, s.startedAt, dataDir);
    p.realizedPnlSol = s.realizedPnlSol;
    p.feesPaidSol = s.feesPaidSol;
    p.failedTxCount = s.failedTxCount ?? 0;
    p.wins = s.wins;
    p.losses = s.losses;
    p.recentTrades = s.recentTrades ?? [];
    p.equityHistory = s.equityHistory ?? [];
    p.savedRisk = s.risk;
    for (const sp of s.positions) p.positions.set(sp.mint, { ...sp, tokensRaw: BigInt(sp.tokensRaw) });
    return p;
  }

  save(risk?: unknown) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const state: SavedState = {
      version: 1,
      mode: this.mode,
      startedAt: this.startedAt,
      startSol: this.startSol,
      cashSol: this.cashSol,
      realizedPnlSol: this.realizedPnlSol,
      feesPaidSol: this.feesPaidSol,
      failedTxCount: this.failedTxCount,
      wins: this.wins,
      losses: this.losses,
      positions: [...this.positions.values()].map((p) => ({ ...p, tokensRaw: p.tokensRaw.toString() })),
      recentTrades: this.recentTrades,
      equityHistory: this.equityHistory,
      risk,
    };
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, this.statePath);
  }

  open(meta: { mint: string; symbol: string; name: string; entryReason: string }, fill: Fill, now: number) {
    this.cashSol += fill.solDelta;
    this.feesPaidSol += fill.feesSol;
    this.positions.set(meta.mint, {
      ...meta,
      openedAt: now,
      tokensRaw: fill.tokensRaw,
      entryPriceSol: fill.priceSol,
      costSol: -fill.solDelta,
      rentSol: fill.rentSol,
      buyFeesSol: fill.feesSol,
      peakPriceSol: fill.priceSol,
      lastPriceSol: fill.priceSol,
      buySig: fill.signature,
    });
  }

  close(mint: string, fill: Fill, reason: string, now: number): ClosedTrade | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;
    this.positions.delete(mint);
    this.cashSol += fill.solDelta;
    this.feesPaidSol += fill.feesSol;

    const pnlSol = fill.solDelta - pos.costSol;
    const invested = pos.costSol - pos.rentSol;
    const trade: ClosedTrade = {
      mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: now,
      holdSec: Math.round((now - pos.openedAt) / 1000),
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol: fill.priceSol,
      costSol: pos.costSol,
      proceedsSol: fill.solDelta,
      pnlSol,
      pnlPct: invested > 0 ? (pnlSol / invested) * 100 : 0,
      feesSol: pos.buyFeesSol + fill.feesSol,
      reason,
      entryReason: pos.entryReason,
      buySig: pos.buySig,
      sellSig: fill.signature,
    };
    this.realizedPnlSol += pnlSol;
    if (pnlSol > 0) this.wins++;
    else this.losses++;
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > 200) this.recentTrades.pop();
    this.appendCsv(trade);
    return trade;
  }

  /** A transaction that failed still costs its network fees. */
  recordFailedTx(fill: Fill) {
    this.cashSol += fill.solDelta;
    this.feesPaidSol += fill.feesSol;
    if (fill.feesSol > 0) this.failedTxCount++;
  }

  markPrice(mint: string, priceSol: number) {
    const pos = this.positions.get(mint);
    if (!pos || !(priceSol > 0)) return;
    pos.lastPriceSol = priceSol;
    if (priceSol > pos.peakPriceSol) pos.peakPriceSol = priceSol;
  }

  /** Estimated SOL if the position were sold now at the last price, after % fees, plus rent back. */
  positionValueSol(pos: Position, exitFeePct: number): number {
    const gross = (Number(pos.tokensRaw) / TOKEN_UNIT) * pos.lastPriceSol;
    return gross * (1 - exitFeePct / 100) + pos.rentSol;
  }

  equitySol(exitFeePct: number): number {
    let total = this.cashSol;
    for (const pos of this.positions.values()) total += this.positionValueSol(pos, exitFeePct);
    return total;
  }

  sampleEquity(now: number, exitFeePct: number, everyMs = 30_000) {
    const last = this.equityHistory.at(-1);
    if (last && now - last.t < everyMs) return;
    this.equityHistory.push({ t: now, equitySol: this.equitySol(exitFeePct) });
    if (this.equityHistory.length > 2880) this.equityHistory.shift();
  }

  private appendCsv(t: ClosedTrade) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.tradesPath)) fs.writeFileSync(this.tradesPath, CSV_HEADER + "\n");
    const row = [
      new Date(t.closedAt).toISOString(),
      clean(t.symbol),
      t.mint,
      t.reason,
      t.holdSec,
      t.entryPriceSol.toExponential(6),
      t.exitPriceSol.toExponential(6),
      t.costSol.toFixed(6),
      t.proceedsSol.toFixed(6),
      t.pnlSol.toFixed(6),
      t.pnlPct.toFixed(2),
      t.feesSol.toFixed(6),
      clean(t.entryReason),
      clean(t.buySig),
      clean(t.sellSig),
    ];
    fs.appendFileSync(this.tradesPath, row.join(",") + "\n");
  }
}
