import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config";
import {
  bondingCurvePda,
  curveProgressPct,
  decodeCurve,
  fetchCurves,
  isSolPaired,
  marketCapSol,
  realSol,
  spotPriceSol,
  type CurveState,
} from "../chain/curve";
import type { NewTokenEvent } from "../feed/pumpPortal";
import type { PricePoint } from "../strategy/momentum";
import type { TickRecorder } from "./recorder";
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
  /** Keep polling (for the recorder only) until this time. */
  shadowUntil?: number;
  lastDecision?: string;
}

const MAX_HISTORY = 400;
const MAX_SEEN = 50_000;
// A coin worth recording after its watch window: some real money went in, or it moved.
const SHADOW_MIN_REAL_SOL = 2;
const SHADOW_MIN_GAIN_PCT = 15;

type TickListener = (coins: TrackedCoin[], now: number) => void | Promise<void>;
type HeldListener = (coin: TrackedCoin, now: number) => void;

/** Watchlist of new coins + held coins, with prices polled from the chain. */
export class Tracker {
  private coins = new Map<string, TrackedCoin>();
  private seen = new Set<string>();
  private polling = false;
  private timer?: NodeJS.Timeout;
  private listeners: TickListener[] = [];
  private heldListeners: HeldListener[] = [];
  private subscriptions = new Map<string, number>();
  lastPollMs = 0;
  lastPollAt = 0;
  rpcErrors = 0;
  lastRpcError = "";
  skippedNonSol = 0;
  skippedOtherPool = 0;
  skippedMayhem = 0;
  realtimeUpdates = 0;

  constructor(
    private conn: Connection,
    private cfg: Config,
    private recorder?: TickRecorder,
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
    this.evictIfFull(evt.receivedAt);
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
    if (!this.coins.has(mint)) {
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
        held: false,
        done: true,
      });
    }
    this.pin(mint);
  }

  /** Mark a coin as held and stream its price in real time over the RPC websocket. */
  pin(mint: string) {
    const c = this.coins.get(mint);
    if (!c) return;
    c.held = true;
    if (this.subscriptions.has(mint)) return;
    try {
      const id = this.conn.onAccountChange(
        c.curveAddress,
        (info) => this.onRealtimeAccount(c, info.data),
        { commitment: "processed" },
      );
      this.subscriptions.set(mint, id);
    } catch (err) {
      log.warn(`Real-time price feed unavailable for ${c.symbol}: ${(err as Error).message}`);
    }
  }

  /** Stop tracking a coin once we no longer hold it. */
  release(mint: string) {
    const c = this.coins.get(mint);
    if (c) {
      c.held = false;
      c.done = true;
    }
    const id = this.subscriptions.get(mint);
    if (id !== undefined) {
      this.subscriptions.delete(mint);
      void this.conn.removeAccountChangeListener(id).catch(() => {});
    }
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

  /** Returns a function that removes the listener. */
  onTick(fn: TickListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Called on every real-time price change of a held coin. Returns a function that removes the listener. */
  onHeldUpdate(fn: HeldListener): () => void {
    this.heldListeners.push(fn);
    return () => {
      this.heldListeners = this.heldListeners.filter((l) => l !== fn);
    };
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.cfg.POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.recorder?.close();
    for (const mint of [...this.subscriptions.keys()]) {
      const id = this.subscriptions.get(mint)!;
      this.subscriptions.delete(mint);
      void this.conn.removeAccountChangeListener(id).catch(() => {});
    }
  }

  /** Fresh read of one curve (used by the paper simulator after its latency delay). */
  async fetchFresh(mint: string): Promise<CurveState | null> {
    const addr = this.coins.get(mint)?.curveAddress ?? bondingCurvePda(new PublicKey(mint));
    const [c] = await fetchCurves(this.conn, [addr]);
    return c;
  }

  stats() {
    const now = Date.now();
    let watching = 0;
    let held = 0;
    let shadow = 0;
    for (const c of this.coins.values()) {
      if (c.held) held++;
      else if (this.isWatching(c, now)) watching++;
      else if (this.isShadow(c, now)) shadow++;
    }
    return {
      watching,
      held,
      shadow,
      lastPollMs: this.lastPollMs,
      lastPollAgoSec: this.lastPollAt ? Math.round((now - this.lastPollAt) / 1000) : null,
      rpcErrors: this.rpcErrors,
      lastRpcError: this.lastRpcError,
      skippedNonSol: this.skippedNonSol,
      skippedOtherPool: this.skippedOtherPool,
      skippedMayhem: this.skippedMayhem,
      realtimeUpdates: this.realtimeUpdates,
      recordedLines: this.recorder?.linesWritten ?? 0,
    };
  }

  private isWatching(c: TrackedCoin, now: number) {
    return !c.held && !c.done && now - c.createdAt <= (this.cfg.WATCH_WINDOW_SEC + 2) * 1000;
  }

  private isShadow(c: TrackedCoin, now: number) {
    return !c.held && c.shadowUntil !== undefined && now < c.shadowUntil;
  }

  private evictIfFull(now: number) {
    let watching = 0;
    for (const c of this.coins.values()) if (this.isWatching(c, now)) watching++;
    if (watching < this.cfg.MAX_WATCHLIST) return;
    for (const [mint, c] of this.coins) {
      if (this.isWatching(c, now) && !this.isShadow(c, now)) {
        this.coins.delete(mint);
        return;
      }
    }
  }

  private prune(now: number) {
    for (const [mint, c] of this.coins) {
      if (c.held || this.isShadow(c, now)) continue;
      if (!this.isWatching(c, now)) this.coins.delete(mint);
    }
  }

  /** Give a promising coin a few more minutes of tracking so the backtester sees what happened next. */
  private maybeShadow(c: TrackedCoin, point: PricePoint, now: number) {
    if (!this.recorder || c.shadowUntil !== undefined || c.held || !this.isWatching(c, now)) return;
    const gainPct = c.firstMcapSol > 0 ? (point.mcapSol / c.firstMcapSol - 1) * 100 : 0;
    if (point.realSol < SHADOW_MIN_REAL_SOL && gainPct < SHADOW_MIN_GAIN_PCT) return;
    let shadows = 0;
    for (const o of this.coins.values()) if (o.shadowUntil !== undefined && now < o.shadowUntil) shadows++;
    if (shadows >= this.cfg.MAX_SHADOW) return;
    c.shadowUntil = c.createdAt + (this.cfg.WATCH_WINDOW_SEC + this.cfg.SHADOW_SEC) * 1000;
  }

  private applyCurve(coin: TrackedCoin, c: CurveState, now: number): PricePoint {
    coin.curve = c;
    coin.complete ||= c.complete;
    if (coin.firstMcapSol <= 0) coin.firstMcapSol = marketCapSol(c);
    const point: PricePoint = {
      t: now,
      priceSol: spotPriceSol(c),
      mcapSol: marketCapSol(c),
      realSol: realSol(c),
      progressPct: curveProgressPct(c),
    };
    coin.history.push(point);
    if (coin.history.length > MAX_HISTORY) coin.history.shift();
    if (this.recorder) {
      this.recorder.record(
        {
          mint: coin.mint,
          symbol: coin.symbol,
          createdAt: coin.createdAt,
          devBuyPct: coin.devBuyPct,
          firstMcapSol: coin.firstMcapSol,
        },
        c,
        now,
      );
    }
    return point;
  }

  private onRealtimeAccount(coin: TrackedCoin, data: Buffer) {
    if (!coin.held) return;
    const c = decodeCurve(data);
    if (!c) return;
    const now = Date.now();
    this.realtimeUpdates++;
    this.applyCurve(coin, c, now);
    for (const fn of this.heldListeners) fn(coin, now);
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
          coin.shadowUntil = undefined;
          if (c.isMayhem) this.skippedMayhem++;
          else this.skippedNonSol++;
          return;
        }
        const point = this.applyCurve(coin, c, now);
        this.maybeShadow(coin, point, now);
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
