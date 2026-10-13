import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config";
import {
  bondingCurvePda,
  curveProgressPct,
  fetchCurves,
  isSolPaired,
  marketCapSol,
  realSol,
  spotPriceSol,
  type CurveState,
} from "../chain/curve";
import type { NewTokenEvent } from "../feed/pumpPortal";
import type { PricePoint } from "../strategy/momentum";
import { log } from "../log";

export interface TrackedCoin {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  devBuyPct: number;
  firstMcapSol: number;
  curveAddress: PublicKey;
  history: PricePoint[];
  curve?: CurveState;
  complete: boolean;
  /** Pinned because we hold it or a buy is in flight; never pruned. */
  held: boolean;
  /** No longer a candidate for entry. */
  done: boolean;
  lastDecision?: string;
}

const MAX_HISTORY = 400;
const MAX_SEEN = 50_000;

type TickListener = (coins: TrackedCoin[], now: number) => void | Promise<void>;

/** Watchlist of new coins + held coins, with prices polled from the chain. */
export class Tracker {
  private coins = new Map<string, TrackedCoin>();
  private seen = new Set<string>();
  private polling = false;
  private timer?: NodeJS.Timeout;
  private listeners: TickListener[] = [];
  lastPollMs = 0;
  lastPollAt = 0;
  rpcErrors = 0;
  lastRpcError = "";
  skippedNonSol = 0;
  skippedOtherPool = 0;
  skippedMayhem = 0;

  constructor(
    private conn: Connection,
    private cfg: Config,
  ) {}

  add(evt: NewTokenEvent) {
    if (this.seen.has(evt.mint)) return;
    this.seen.add(evt.mint);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    if (evt.pool && evt.pool !== "pump") {
      this.skippedOtherPool++;
      return;
    }
    if (evt.isMayhem && this.cfg.SKIP_MAYHEM) {
      this.skippedMayhem++;
      return;
    }
    let mintKey: PublicKey;
    try {
      mintKey = new PublicKey(evt.mint);
    } catch {
      return;
    }
    this.evictIfFull();
    this.coins.set(evt.mint, {
      mint: evt.mint,
      name: evt.name,
      symbol: evt.symbol,
      creator: evt.creator,
      createdAt: evt.receivedAt,
      devBuyPct: (evt.initialBuyTokens / 1e9) * 100,
      firstMcapSol: evt.marketCapSol,
      curveAddress: bondingCurvePda(mintKey),
      history: [],
      complete: false,
      held: false,
      done: false,
    });
  }

  /** Track a coin we already hold (e.g. restored from saved state). */
  addHeld(mint: string, name: string, symbol: string, openedAt: number) {
    this.seen.add(mint);
    const existing = this.coins.get(mint);
    if (existing) {
      existing.held = true;
      return;
    }
    this.coins.set(mint, {
      mint,
      name,
      symbol,
      creator: "",
      createdAt: openedAt,
      devBuyPct: 0,
      firstMcapSol: 0,
      curveAddress: bondingCurvePda(new PublicKey(mint)),
      history: [],
      complete: false,
      held: true,
      done: true,
    });
  }

  pin(mint: string) {
    const c = this.coins.get(mint);
    if (c) c.held = true;
  }

  /** Stop tracking a coin once we no longer hold it. */
  release(mint: string) {
    const c = this.coins.get(mint);
    if (!c) return;
    c.held = false;
    c.done = true;
  }

  markDone(mint: string) {
    const c = this.coins.get(mint);
    if (c) c.done = true;
  }

  markMigrated(mint: string) {
    const c = this.coins.get(mint);
    if (c) c.complete = true;
  }

  get(mint: string): TrackedCoin | undefined {
    return this.coins.get(mint);
  }

  onTick(fn: TickListener) {
    this.listeners.push(fn);
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.cfg.POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Fresh read of one curve (used by the paper simulator after its latency delay). */
  async fetchFresh(mint: string): Promise<CurveState | null> {
    const addr = this.coins.get(mint)?.curveAddress ?? bondingCurvePda(new PublicKey(mint));
    const [c] = await fetchCurves(this.conn, [addr]);
    return c;
  }

  stats() {
    let watching = 0;
    let held = 0;
    for (const c of this.coins.values()) {
      if (c.held) held++;
      else if (!c.done) watching++;
    }
    return {
      watching,
      held,
      lastPollMs: this.lastPollMs,
      lastPollAgoSec: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
      rpcErrors: this.rpcErrors,
      lastRpcError: this.lastRpcError,
      skippedNonSol: this.skippedNonSol,
      skippedOtherPool: this.skippedOtherPool,
      skippedMayhem: this.skippedMayhem,
    };
  }

  private evictIfFull() {
    let candidates = 0;
    for (const c of this.coins.values()) if (!c.held) candidates++;
    if (candidates < this.cfg.MAX_WATCHLIST) return;
    for (const [mint, c] of this.coins) {
      if (!c.held) {
        this.coins.delete(mint);
        return;
      }
    }
  }

  private prune(now: number) {
    const graceMs = (this.cfg.WATCH_WINDOW_SEC + 2) * 1000;
    for (const [mint, c] of this.coins) {
      if (c.held) continue;
      if (c.done || now - c.createdAt > graceMs) this.coins.delete(mint);
    }
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    const started = Date.now();
    try {
      this.prune(started);
      const list = [...this.coins.values()];
      if (list.length === 0) return;
      const curves = await fetchCurves(
        this.conn,
        list.map((c) => c.curveAddress),
      );
      const now = Date.now();
      list.forEach((coin, i) => {
        const c = curves[i];
        if (!c) return; // account not visible yet
        if (!coin.held && (!isSolPaired(c) || (c.isMayhem && this.cfg.SKIP_MAYHEM))) {
          coin.done = true;
          if (c.isMayhem) this.skippedMayhem++;
          else this.skippedNonSol++;
          return;
        }
        coin.curve = c;
        coin.complete ||= c.complete;
        if (coin.firstMcapSol <= 0) coin.firstMcapSol = marketCapSol(c);
        coin.history.push({
          t: now,
          priceSol: spotPriceSol(c),
          mcapSol: marketCapSol(c),
          realSol: realSol(c),
          progressPct: curveProgressPct(c),
        });
        if (coin.history.length > MAX_HISTORY) coin.history.shift();
      });
      this.lastPollMs = now - started;
      this.lastPollAt = now;
      for (const fn of this.listeners) await fn(list, now);
    } catch (err) {
      this.rpcErrors++;
      this.lastRpcError = (err as Error).message.slice(0, 200);
      if (this.rpcErrors % 10 === 1) log.warn(`RPC poll failed (${this.rpcErrors} total): ${this.lastRpcError}`);
    } finally {
      this.polling = false;
    }
  }
}
