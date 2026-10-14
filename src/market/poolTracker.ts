import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config";
import { decodePool, poolPriceSol, poolState, type PoolInfo, type PoolState } from "../chain/pumpswap";
import type { PricePoint } from "../strategy/momentum";
import { log } from "../log";

const MAX_HISTORY = 600;
const MAX_POOLS = 33; // 3 accounts each, so one request (≤100 accounts) covers them all

export interface TrackedPool {
  mint: string;
  symbol: string;
  name: string;
  pool: PublicKey;
  info?: PoolInfo;
  state?: PoolState;
  history: PricePoint[];
  /** Kept because we hold it (or a buy is in flight). */
  held: boolean;
  /** Kept because it's on the hot list. */
  watched: boolean;
  lastDecision?: string;
}

type TickListener = (pools: TrackedPool[], now: number) => void | Promise<void>;

/** Live prices for graduated coins, read from their PumpSwap pools. */
export class PoolTracker {
  private pools = new Map<string, TrackedPool>();
  private listeners: TickListener[] = [];
  private timer?: NodeJS.Timeout;
  private polling = false;
  lastPollMs = 0;
  lastPollAt = 0;
  rpcErrors = 0;

  constructor(
    private conn: Connection,
    private cfg: Config,
  ) {}

  /** Track a hot-list coin. Returns false when the tracker is full. */
  watch(mint: string, pool: string, symbol: string): boolean {
    const existing = this.pools.get(mint);
    if (existing) {
      existing.watched = true;
      return true;
    }
    if (this.pools.size >= MAX_POOLS) return false;
    this.pools.set(mint, { mint, symbol, name: symbol, pool: new PublicKey(pool), history: [], held: false, watched: true });
    return true;
  }

  unwatch(mint: string) {
    const p = this.pools.get(mint);
    if (!p) return;
    p.watched = false;
    if (!p.held) this.pools.delete(mint);
  }

  /** Track a coin we already hold (e.g. restored from saved state). */
  addHeld(mint: string, pool: string, symbol: string, name: string) {
    if (!this.pools.has(mint)) {
      this.pools.set(mint, { mint, symbol, name, pool: new PublicKey(pool), history: [], held: true, watched: false });
    }
    this.pin(mint);
  }

  pin(mint: string) {
    const p = this.pools.get(mint);
    if (p) p.held = true;
  }

  release(mint: string) {
    const p = this.pools.get(mint);
    if (!p) return;
    p.held = false;
    if (!p.watched) this.pools.delete(mint);
  }

  get(mint: string): TrackedPool | undefined {
    return this.pools.get(mint);
  }

  onTick(fn: TickListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.cfg.BLAZE_POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  stats() {
    let held = 0;
    for (const p of this.pools.values()) if (p.held) held++;
    return { pools: this.pools.size, held, lastPollMs: this.lastPollMs, rpcErrors: this.rpcErrors };
  }

  /** Fresh pool reserves for one coin (used by the paper simulator after its latency delay). */
  async fetchFresh(mint: string): Promise<PoolState | null> {
    const p = this.pools.get(mint);
    if (!p) return null;
    if (!p.info) await this.loadInfo([p]);
    if (!p.info) return null;
    const [poolAcc, base, quote] = await this.conn.getMultipleAccountsInfo([p.pool, p.info.baseVault, p.info.quoteVault], "processed");
    if (!poolAcc || !base || !quote) return null;
    const info = decodePool(poolAcc.data) ?? p.info;
    return poolState(info, base.data, quote.data);
  }

  /** Vault addresses never change, so each pool account is decoded once up front. */
  private async loadInfo(list: TrackedPool[]) {
    const infos = await this.conn.getMultipleAccountsInfo(list.map((p) => p.pool), "processed");
    infos.forEach((acc, i) => {
      const info = acc ? decodePool(acc.data) : null;
      if (info && info.baseMint === list[i].mint) list[i].info = info;
      else log.warn(`Pool for ${list[i].symbol} could not be read; skipping it`);
    });
  }

  async poll() {
    if (this.polling || this.pools.size === 0) return;
    this.polling = true;
    const started = Date.now();
    try {
      const needInfo = [...this.pools.values()].filter((p) => !p.info);
      if (needInfo.length) await this.loadInfo(needInfo);
      const list = [...this.pools.values()].filter((p) => p.info);
      if (list.length === 0) return;
      // Pool account too: virtual quote reserves can change over time.
      const keys = list.flatMap((p) => [p.pool, p.info!.baseVault, p.info!.quoteVault]);
      const accs = await this.conn.getMultipleAccountsInfo(keys, "processed");
      const now = Date.now();
      list.forEach((p, i) => {
        const [poolAcc, base, quote] = accs.slice(i * 3, i * 3 + 3);
        if (!poolAcc || !base || !quote) return;
        p.info = decodePool(poolAcc.data) ?? p.info;
        p.state = poolState(p.info!, base.data, quote.data);
        const priceSol = poolPriceSol(p.state);
        p.history.push({ t: now, priceSol, mcapSol: priceSol * 1e9, realSol: Number(p.state.realQuote) / 1e9, progressPct: 100 });
        if (p.history.length > MAX_HISTORY) p.history.shift();
      });
      this.lastPollMs = now - started;
      this.lastPollAt = now;
      for (const fn of this.listeners) await fn(list, now);
    } catch (err) {
      this.rpcErrors++;
      if (this.rpcErrors % 10 === 1) log.warn(`Pool price poll failed (${this.rpcErrors} total): ${(err as Error).message.slice(0, 160)}`);
    } finally {
      this.polling = false;
    }
  }
}
