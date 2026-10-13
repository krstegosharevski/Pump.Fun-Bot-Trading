import fs from "node:fs";
import path from "node:path";
import type { CurveState } from "../chain/curve";

/** First line written for a coin. */
export interface CoinMetaLine {
  k: "c";
  m: string;
  sym: string;
  t0: number;
  dev: number;
  mc0: number;
}

/** One price observation: raw curve reserves at time t. */
export interface TickLine {
  k: "t";
  m: string;
  t: number;
  vs: number;
  vt: number;
  rs: number;
  rt: number;
  c: 0 | 1;
}

export type RecordLine = CoinMetaLine | TickLine;

export interface CoinMeta {
  mint: string;
  symbol: string;
  createdAt: number;
  devBuyPct: number;
  firstMcapSol: number;
}

export function tickLine(mint: string, t: number, c: CurveState): TickLine {
  return {
    k: "t",
    m: mint,
    t,
    vs: Number(c.virtualSolReserves),
    vt: Number(c.virtualTokenReserves),
    rs: Number(c.realSolReserves),
    rt: Number(c.realTokenReserves),
    c: c.complete ? 1 : 0,
  };
}

export function parseLine(line: string): RecordLine | null {
  try {
    const o = JSON.parse(line);
    if (o && (o.k === "c" || o.k === "t") && typeof o.m === "string") return o as RecordLine;
  } catch {
    // ignore a torn last line
  }
  return null;
}

/**
 * Appends price paths to data/ticks/YYYY-MM-DD.jsonl (UTC day) for the backtester.
 * A coin is only recorded once it has `minRealSol` in its curve, which skips dead launches.
 */
export class TickRecorder {
  private stream?: fs.WriteStream;
  private day = "";
  private started = new Set<string>();
  linesWritten = 0;

  constructor(
    private dir = path.join("data", "ticks"),
    private minRealSol = 0.5,
  ) {}

  record(meta: CoinMeta, curve: CurveState, t: number) {
    if (!this.started.has(meta.mint)) {
      if (Number(curve.realSolReserves) / 1e9 < this.minRealSol) return;
      this.started.add(meta.mint);
      if (this.started.size > 50_000) this.started.delete(this.started.values().next().value!);
      const line: CoinMetaLine = {
        k: "c",
        m: meta.mint,
        sym: meta.symbol,
        t0: meta.createdAt,
        dev: Math.round(meta.devBuyPct * 100) / 100,
        mc0: Math.round(meta.firstMcapSol * 1e4) / 1e4,
      };
      this.write(line, t);
    }
    this.write(tickLine(meta.mint, t, curve), t);
  }

  close() {
    this.stream?.end();
    this.stream = undefined;
  }

  private write(line: RecordLine, t: number) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.day || !this.stream) {
      this.stream?.end();
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.dir, `${day}.jsonl`), { flags: "a" });
      this.day = day;
    }
    this.stream.write(JSON.stringify(line) + "\n");
    this.linesWritten++;
  }
}
