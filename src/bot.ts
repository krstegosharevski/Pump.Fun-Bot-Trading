import type { Connection } from "@solana/web3.js";
import type { Config, RunMode } from "./config";
import type { SolPrice } from "./chain/rpc";
import type { PumpPortalFeed } from "./feed/pumpPortal";
import type { Tracker } from "./market/tracker";
import type { PoolTracker } from "./market/poolTracker";
import { TOKEN_DECIMALS } from "./chain/curve";
import { Portfolio, type Position, type Venue } from "./portfolio";
import { botConfig, isBotId } from "./bots/registry";
import { RiskGuard, tradeSizeSol } from "./risk";
import { shouldExit } from "./strategy/momentum";
import { shouldExitLaunch } from "./strategy/launch";
import { PaperExecutor } from "./exec/paper";
import { AmmPaperExecutor } from "./exec/paperAmm";
import type { Executor } from "./exec/types";
import { log, recentLogs } from "./log";

export interface TraderDeps {
  cfg: Config;
  runMode: RunMode;
  conn: Connection;
  solPrice: SolPrice;
  tracker: Tracker;
  pools: PoolTracker;
  feed: PumpPortalFeed;
}

export interface EnterOrder {
  bot: string;
  reason: string;
  sizeSol: number;
  /** Price when the bot decided; the fill's slippage is measured against it. */
  expectedPriceSol: number;
  /** Default "curve". */
  venue?: Venue;
  pool?: string;
}

export interface CoinRef {
  mint: string;
  symbol: string;
  name: string;
}

export const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const SELL_RETRY_MS = 3000;
/** After this many failed sales of one position, sell at any price so it can't get stuck. */
const ANY_PRICE_AFTER_FAILURES = 2;
const ANY_PRICE_SLIPPAGE_PCT = 95;

/**
 * The always-on part of the bot: the shared account, buying and selling, exit checks
 * for every open position (using the rules of the bot that opened it), and saving.
 * Bots (Primal, Tabak) only decide when to buy; see src/bots/engines.ts.
 */
export class Trader {
  readonly exitFeePct: number;
  readonly risk: RiskGuard;
  /** When the last coin was finished with: sold, or its buy failed. */
  lastDoneAt = 0;
  private inFlight = new Set<string>();
  private lastSellAttempt = new Map<string, number>();
  private sellFailures = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  private constructor(
    private deps: TraderDeps,
    readonly mode: "paper" | "live",
    readonly pf: Portfolio,
    private executors: Record<Venue, Executor>,
    readonly liveBalanceSol?: () => Promise<number>,
  ) {
    this.exitFeePct = deps.cfg.PUMP_FEE_PCT + deps.cfg.PUMPPORTAL_FEE_PCT;
    this.risk = new RiskGuard(deps.cfg, pf.equitySol(this.exitFeePct), Date.now(), pf.savedRisk);
  }

  static async create(deps: TraderDeps): Promise<Trader> {
    const { cfg, conn, solPrice, tracker, pools } = deps;
    const mode = deps.runMode === "live" ? "live" : "paper";
    let portfolio = Portfolio.load(mode);

    if (mode === "live") {
      const { LiveExecutor, loadWallet } = await import("./exec/live");
      const wallet = loadWallet(cfg.WALLET_PATH);
      const live = new LiveExecutor(cfg, conn, wallet);
      const balance = await live.balanceSol();
      if (!portfolio) portfolio = new Portfolio("live", balance, balance);
      portfolio.cashSol = balance;
      log.warn("================ LIVE MODE — REAL MONEY ================");
      log.warn(`Wallet ${wallet.publicKey.toBase58()}  balance ${balance.toFixed(4)} SOL`);
      // PumpPortal routes each trade to the curve or PumpSwap itself (pool: "auto").
      return new Trader(deps, "live", portfolio, { curve: live, pumpswap: live }, () => live.balanceSol());
    }

    if (!portfolio) {
      const startSol = solPrice.usd ? cfg.PAPER_START_USD / solPrice.usd : cfg.PAPER_START_SOL;
      portfolio = new Portfolio("paper", startSol, startSol);
      log.info(`New paper account: ${startSol.toFixed(4)} SOL (≈ $${cfg.PAPER_START_USD} of fake money)`);
    } else {
      log.info(
        `Paper account: cash ${portfolio.cashSol.toFixed(4)} SOL, ${portfolio.positions.size} open position(s). Delete data/paper-state.json to start over.`,
      );
    }
    return new Trader(deps, "paper", portfolio, {
      curve: new PaperExecutor(cfg, (mint) => tracker.fetchFresh(mint)),
      pumpswap: new AmmPaperExecutor(cfg, (mint) => pools.fetchFresh(mint)),
    });
  }

  /** Starts exit management, equity tracking and periodic saving. Runs whether or not a bot is active. */
  start() {
    const { tracker, pools } = this.deps;
    for (const pos of this.pf.positions.values()) {
      if (pos.venue === "pumpswap" && pos.pool) pools.addHeld(pos.mint, pos.pool, pos.symbol, pos.name);
      else tracker.addHeld(pos.mint, pos.name, pos.symbol, pos.openedAt);
    }

    // Held coins stream price changes over the RPC websocket: react to each one immediately.
    tracker.onHeldUpdate((coin, now) => {
      const pos = this.pf.positions.get(coin.mint);
      if (pos) this.checkExit(pos, now);
    });
    pools.onTick((_pools, now) => {
      for (const pos of this.pf.positions.values()) if (pos.venue === "pumpswap") this.checkExit(pos, now);
    });
    tracker.onTick((_coins, now) => {
      for (const pos of this.pf.positions.values()) if (pos.venue !== "pumpswap") this.checkExit(pos, now);
      const equity = this.equitySol();
      if (this.risk.updateEquity(equity, now)) {
        log.error(`Daily loss limit (${this.deps.cfg.DAILY_LOSS_LIMIT_PCT}%) reached — no new trades until tomorrow.`);
      }
      this.pf.sampleEquity(now, this.exitFeePct);
    });
    this.timers.push(setInterval(() => this.persist(), 15_000));
  }

  equitySol(): number {
    return this.pf.equitySol(this.exitFeePct);
  }

  sizeFor(cfg: Config): number {
    return tradeSizeSol(cfg, this.equitySol());
  }

  pendingBuys(): number {
    return [...this.inFlight].filter((m) => !this.pf.positions.has(m)).length;
  }

  isInFlight(mint: string): boolean {
    return this.inFlight.has(mint);
  }

  /** Nothing open and nothing being bought or sold. */
  isIdle(): boolean {
    return this.pf.positions.size === 0 && this.inFlight.size === 0;
  }

  private pin(mint: string, venue: Venue) {
    if (venue === "pumpswap") this.deps.pools.pin(mint);
    else {
      this.deps.tracker.pin(mint);
      this.deps.tracker.markDone(mint);
    }
  }

  private release(mint: string, venue: Venue) {
    if (venue === "pumpswap") this.deps.pools.release(mint);
    else this.deps.tracker.release(mint);
  }

  async enter(coin: CoinRef, order: EnterOrder) {
    const pf = this.pf;
    const venue = order.venue ?? "curve";
    const price = order.expectedPriceSol;
    this.inFlight.add(coin.mint);
    this.pin(coin.mint, venue);
    this.risk.recordBuy(Date.now());
    log.trade(`BUY  ${coin.symbol} for ${order.sizeSol.toFixed(4)} SOL — ${order.reason}  ${coin.mint}`);
    try {
      const fill = await this.executors[venue].buy({ mint: coin.mint, solAmount: order.sizeSol, expectedPriceSol: price });
      if (fill.ok) {
        pf.open(
          { mint: coin.mint, symbol: coin.symbol, name: coin.name, entryReason: order.reason, bot: order.bot, venue, pool: order.pool },
          fill,
          Date.now(),
        );
        log.trade(
          `  bought ${coin.symbol}: paid ${(-fill.solDelta).toFixed(4)} SOL incl. fees, fill ${pct((fill.priceSol / price - 1) * 100)} vs signal price`,
        );
      } else {
        pf.recordFailedTx(fill);
        this.release(coin.mint, venue);
        this.lastDoneAt = Date.now();
        log.warn(`  buy ${coin.symbol} failed: ${fill.error}`);
      }
    } catch (err) {
      this.release(coin.mint, venue);
      this.lastDoneAt = Date.now();
      log.error(`  buy ${coin.symbol} error: ${(err as Error).message}`);
    } finally {
      this.inFlight.delete(coin.mint);
      await this.syncLiveBalance();
      this.persist();
    }
  }

  async exit(mint: string, reason: string) {
    const pf = this.pf;
    const pos = pf.positions.get(mint);
    if (!pos || this.inFlight.has(mint)) return;
    this.inFlight.add(mint);
    this.lastSellAttempt.set(mint, Date.now());
    const failures = this.sellFailures.get(mint) ?? 0;
    const anyPrice = failures >= ANY_PRICE_AFTER_FAILURES;
    log.trade(
      `SELL ${pos.symbol} — ${reason} (${pct((pos.lastPriceSol / pos.entryPriceSol - 1) * 100)} on price)${anyPrice ? `, attempt ${failures + 1}: at any price` : ""}`,
    );
    try {
      const fill = await this.executors[pos.venue ?? "curve"].sell({
        mint,
        tokensRaw: pos.tokensRaw,
        expectedPriceSol: pos.lastPriceSol,
        solInCurve: (pos.entryPriceSol * Number(pos.tokensRaw)) / 10 ** TOKEN_DECIMALS,
        slippagePct: anyPrice ? ANY_PRICE_SLIPPAGE_PCT : undefined,
      });
      if (fill.ok) {
        this.sellFailures.delete(mint);
        const t = pf.close(mint, fill, reason, Date.now())!;
        this.risk.recordClose(t.pnlSol, Date.now());
        this.release(mint, pos.venue ?? "curve");
        this.lastSellAttempt.delete(mint);
        this.lastDoneAt = Date.now();
        log.trade(
          `  closed ${t.symbol}: ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol.toFixed(4)} SOL (${pct(t.pnlPct)}) after ${t.holdSec}s, fees ${t.feesSol.toFixed(4)} SOL`,
        );
      } else {
        this.sellFailures.set(mint, failures + 1);
        pf.recordFailedTx(fill);
        log.warn(`  sell ${pos.symbol} failed: ${fill.error} — will retry`);
      }
    } catch (err) {
      this.sellFailures.set(mint, failures + 1);
      log.error(`  sell ${pos.symbol} error: ${(err as Error).message} — will retry`);
    } finally {
      this.inFlight.delete(mint);
      await this.syncLiveBalance();
      this.persist();
    }
  }

  /** Each position is sold by the rules of the bot that opened it. */
  private checkExit(pos: Position, now: number) {
    const { cfg, tracker, pools } = this.deps;
    const onPool = pos.venue === "pumpswap";
    const last = onPool ? pools.get(pos.mint)?.history.at(-1) : tracker.get(pos.mint)?.history.at(-1);
    if (last) this.pf.markPrice(pos.mint, last.priceSol);
    if (this.inFlight.has(pos.mint)) return;
    if (now - (this.lastSellAttempt.get(pos.mint) ?? 0) < SELL_RETRY_MS) return;
    const complete = onPool ? false : (tracker.get(pos.mint)?.complete ?? false);
    const rules = isBotId(pos.bot) ? botConfig(cfg, pos.bot) : cfg;
    const reason =
      pos.bot === "tabak"
        ? shouldExitLaunch(pos, pos.lastPriceSol, complete, now, rules)
        : shouldExit(pos, pos.lastPriceSol, complete, now, rules);
    if (reason) void this.exit(pos.mint, reason);
  }

  closeAll(reason = "manual") {
    for (const mint of [...this.pf.positions.keys()]) void this.exit(mint, reason);
  }

  persist() {
    try {
      this.pf.save(this.risk.toJSON());
    } catch (err) {
      log.error(`Could not save state: ${(err as Error).message}`);
    }
  }

  shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.persist();
  }

  private async syncLiveBalance() {
    if (!this.liveBalanceSol) return;
    try {
      this.pf.cashSol = await this.liveBalanceSol();
    } catch {
      // keep the last known balance
    }
  }

  snapshot(cfg: Config) {
    const { solPrice, feed, tracker } = this.deps;
    const pf = this.pf;
    const now = Date.now();
    const equity = this.equitySol();
    return {
      mode: this.mode,
      now,
      startedAt: pf.startedAt,
      solUsd: solPrice.usd,
      startSol: pf.startSol,
      cashSol: pf.cashSol,
      equitySol: equity,
      pnlSol: equity - pf.startSol,
      pnlPct: (equity / pf.startSol - 1) * 100,
      realizedPnlSol: pf.realizedPnlSol,
      feesPaidSol: pf.feesPaidSol,
      failedTxCount: pf.failedTxCount,
      wins: pf.wins,
      losses: pf.losses,
      positions: [...pf.positions.values()].map((p) => ({
        mint: p.mint,
        symbol: p.symbol,
        name: p.name,
        bot: p.bot,
        venue: p.venue ?? "curve",
        ageSec: Math.round((now - p.openedAt) / 1000),
        entryPriceSol: p.entryPriceSol,
        lastPriceSol: p.lastPriceSol,
        pricePct: (p.lastPriceSol / p.entryPriceSol - 1) * 100,
        costSol: p.costSol,
        valueSol: pf.positionValueSol(p, this.exitFeePct),
        selling: this.inFlight.has(p.mint),
      })),
      recentTrades: pf.recentTrades.slice(0, 30),
      equityHistory: [...pf.equityHistory, { t: now, equitySol: equity }],
      risk: this.risk.snapshot(now),
      feed: {
        connected: feed.connected,
        lastMessageAgoSec: feed.lastMessageAt ? Math.round((now - feed.lastMessageAt) / 1000) : null,
        tokensSeen: feed.tokensSeen,
      },
      tracker: tracker.stats(),
      pools: this.deps.pools.stats(),
      settings: { tradeSizeSol: tradeSizeSol(cfg, equity), maxOpen: cfg.MAX_OPEN_POSITIONS },
      logs: recentLogs.slice(-40),
    };
  }
}
