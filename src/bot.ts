import type { Connection } from "@solana/web3.js";
import type { Config, RunMode } from "./config";
import type { SolPrice } from "./chain/rpc";
import type { PumpPortalFeed } from "./feed/pumpPortal";
import type { TrackedCoin, Tracker } from "./market/tracker";
import { Portfolio } from "./portfolio";
import { RiskGuard } from "./risk";
import { shouldEnter, shouldExit } from "./strategy/momentum";
import { PaperExecutor } from "./exec/paper";
import type { Executor } from "./exec/types";
import { startDashboard } from "./dashboard/server";
import { log, recentLogs, sleep } from "./log";

export interface BotDeps {
  cfg: Config;
  runMode: RunMode;
  conn: Connection;
  solPrice: SolPrice;
  tracker: Tracker;
  feed: PumpPortalFeed;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const SELL_RETRY_MS = 3000;

export async function runBot({ cfg, runMode, conn, solPrice, tracker, feed }: BotDeps) {
  const mode = runMode === "live" ? "live" : "paper";
  const exitFeePct = cfg.PUMP_FEE_PCT + cfg.PUMPPORTAL_FEE_PCT;
  let portfolio = Portfolio.load(mode);
  let executor: Executor;
  let syncLiveBalance: (() => Promise<void>) | undefined;

  if (mode === "live") {
    const { LiveExecutor, loadWallet } = await import("./exec/live");
    const wallet = loadWallet(cfg.WALLET_PATH);
    const live = new LiveExecutor(cfg, conn, wallet);
    executor = live;
    const balance = await live.balanceSol();
    if (!portfolio) portfolio = new Portfolio("live", balance, balance);
    portfolio.cashSol = balance;
    const p = portfolio;
    syncLiveBalance = async () => {
      p.cashSol = await live.balanceSol();
    };
    log.warn("================ LIVE TRADING — REAL MONEY ================");
    log.warn(`Wallet ${wallet.publicKey.toBase58()}  balance ${balance.toFixed(4)} SOL`);
    log.warn(
      `Trade size ${cfg.TRADE_SIZE_SOL} SOL | max open ${cfg.MAX_OPEN_POSITIONS} | reserve ${cfg.MIN_SOL_RESERVE} SOL | daily loss stop ${cfg.DAILY_LOSS_LIMIT_PCT}%`,
    );
    if (balance < cfg.TRADE_SIZE_SOL + cfg.MIN_SOL_RESERVE) {
      throw new Error("Wallet balance is too low to trade. Send SOL to the wallet address above first.");
    }
    for (let s = 10; s > 0; s--) {
      log.warn(`Starting live trading in ${s}s — press Ctrl+C to cancel`);
      await sleep(1000);
    }
  } else {
    executor = new PaperExecutor(cfg, (mint) => tracker.fetchFresh(mint));
    if (!portfolio) {
      const startSol = solPrice.usd ? cfg.PAPER_START_USD / solPrice.usd : cfg.PAPER_START_SOL;
      portfolio = new Portfolio("paper", startSol, startSol);
      log.info(`New paper account: ${startSol.toFixed(4)} SOL (≈ $${cfg.PAPER_START_USD} of fake money)`);
    } else {
      log.info(
        `Resumed paper account: cash ${portfolio.cashSol.toFixed(4)} SOL, ${portfolio.positions.size} open position(s). Delete data/paper-state.json to start over.`,
      );
    }
  }

  const pf = portfolio;
  const risk = new RiskGuard(cfg, pf.equitySol(exitFeePct), Date.now(), pf.savedRisk);
  for (const pos of pf.positions.values()) tracker.addHeld(pos.mint, pos.name, pos.symbol, pos.openedAt);

  const inFlight = new Set<string>();
  const lastSellAttempt = new Map<string, number>();
  const persist = () => {
    try {
      pf.save(risk.toJSON());
    } catch (err) {
      log.error(`Could not save state: ${(err as Error).message}`);
    }
  };

  async function enter(coin: TrackedCoin, reason: string) {
    const price = coin.history.at(-1)!.priceSol;
    inFlight.add(coin.mint);
    tracker.pin(coin.mint);
    tracker.markDone(coin.mint);
    risk.recordBuy(Date.now());
    log.trade(`BUY  ${coin.symbol} for ${cfg.TRADE_SIZE_SOL} SOL — ${reason}  ${coin.mint}`);
    try {
      const fill = await executor.buy({ mint: coin.mint, solAmount: cfg.TRADE_SIZE_SOL, expectedPriceSol: price });
      if (fill.ok) {
        pf.open({ mint: coin.mint, symbol: coin.symbol, name: coin.name, entryReason: reason }, fill, Date.now());
        log.trade(
          `  bought ${coin.symbol}: paid ${(-fill.solDelta).toFixed(4)} SOL incl. fees, fill ${pct((fill.priceSol / price - 1) * 100)} vs signal price`,
        );
      } else {
        pf.recordFailedTx(fill);
        tracker.release(coin.mint);
        log.warn(`  buy ${coin.symbol} failed: ${fill.error}`);
      }
    } catch (err) {
      tracker.release(coin.mint);
      log.error(`  buy ${coin.symbol} error: ${(err as Error).message}`);
    } finally {
      inFlight.delete(coin.mint);
      await syncLiveBalance?.().catch(() => {});
      persist();
    }
  }

  async function exit(mint: string, reason: string) {
    const pos = pf.positions.get(mint);
    if (!pos || inFlight.has(mint)) return;
    inFlight.add(mint);
    lastSellAttempt.set(mint, Date.now());
    log.trade(`SELL ${pos.symbol} — ${reason} (${pct((pos.lastPriceSol / pos.entryPriceSol - 1) * 100)} on price)`);
    try {
      const fill = await executor.sell({ mint, tokensRaw: pos.tokensRaw, expectedPriceSol: pos.lastPriceSol });
      if (fill.ok) {
        const t = pf.close(mint, fill, reason, Date.now())!;
        risk.recordClose(t.pnlSol, Date.now());
        tracker.release(mint);
        lastSellAttempt.delete(mint);
        log.trade(
          `  closed ${t.symbol}: ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol.toFixed(4)} SOL (${pct(t.pnlPct)}) after ${t.holdSec}s, fees ${t.feesSol.toFixed(4)} SOL`,
        );
      } else {
        pf.recordFailedTx(fill);
        log.warn(`  sell ${pos.symbol} failed: ${fill.error} — will retry`);
      }
    } catch (err) {
      log.error(`  sell ${pos.symbol} error: ${(err as Error).message} — will retry`);
    } finally {
      inFlight.delete(mint);
      await syncLiveBalance?.().catch(() => {});
      persist();
    }
  }

  tracker.onTick((coins, now) => {
    // 1) Manage open positions.
    for (const pos of pf.positions.values()) {
      const coin = tracker.get(pos.mint);
      const last = coin?.history.at(-1);
      if (last) pf.markPrice(pos.mint, last.priceSol);
      if (inFlight.has(pos.mint)) continue;
      if (now - (lastSellAttempt.get(pos.mint) ?? 0) < SELL_RETRY_MS) continue;
      const reason = shouldExit(pos, pos.lastPriceSol, coin?.complete ?? false, now, cfg);
      if (reason) void exit(pos.mint, reason);
    }

    // 2) Look for entries.
    for (const coin of coins) {
      if (coin.held || coin.done || inFlight.has(coin.mint) || pf.positions.has(coin.mint)) continue;
      const d = shouldEnter(coin, now, cfg);
      coin.lastDecision = d.reason;
      if (d.final) {
        tracker.markDone(coin.mint);
        continue;
      }
      if (!d.enter) continue;
      const pendingBuys = [...inFlight].filter((m) => !pf.positions.has(m)).length;
      const ok = risk.canOpen(now, { openPositions: pf.positions.size + pendingBuys, cashSol: pf.cashSol });
      if (!ok.ok) {
        log.info(`Signal on ${coin.symbol} skipped: ${ok.reason}`);
        tracker.markDone(coin.mint);
        continue;
      }
      void enter(coin, d.reason);
    }

    // 3) Equity tracking and the daily loss stop.
    const equity = pf.equitySol(exitFeePct);
    if (risk.updateEquity(equity, now)) {
      log.error(`Daily loss limit (${cfg.DAILY_LOSS_LIMIT_PCT}%) reached — no new trades until tomorrow.`);
    }
    pf.sampleEquity(now, exitFeePct);
  });

  const closeAll = () => {
    for (const mint of [...pf.positions.keys()]) void exit(mint, "manual");
  };

  const snapshot = () => {
    const now = Date.now();
    const equity = pf.equitySol(exitFeePct);
    return {
      mode,
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
        ageSec: Math.round((now - p.openedAt) / 1000),
        entryPriceSol: p.entryPriceSol,
        lastPriceSol: p.lastPriceSol,
        pricePct: (p.lastPriceSol / p.entryPriceSol - 1) * 100,
        costSol: p.costSol,
        valueSol: pf.positionValueSol(p, exitFeePct),
        selling: inFlight.has(p.mint),
      })),
      recentTrades: pf.recentTrades.slice(0, 30),
      equityHistory: [...pf.equityHistory, { t: now, equitySol: equity }],
      risk: risk.snapshot(now),
      feed: {
        connected: feed.connected,
        lastMessageAgoSec: feed.lastMessageAt ? Math.round((now - feed.lastMessageAt) / 1000) : null,
        tokensSeen: feed.tokensSeen,
      },
      tracker: tracker.stats(),
      settings: {
        tradeSizeSol: cfg.TRADE_SIZE_SOL,
        maxOpen: cfg.MAX_OPEN_POSITIONS,
        takeProfitPct: cfg.TAKE_PROFIT_PCT,
        stopLossPct: cfg.STOP_LOSS_PCT,
        trailActivatePct: cfg.TRAIL_ACTIVATE_PCT,
        trailDropPct: cfg.TRAIL_DROP_PCT,
        maxHoldSec: cfg.MAX_HOLD_SEC,
      },
      logs: recentLogs.slice(-40),
    };
  };

  const server = startDashboard(cfg.DASHBOARD_PORT, snapshot, {
    pause: () => {
      risk.paused = true;
      log.warn("Paused from dashboard: no new entries (open positions are still managed)");
    },
    resume: () => {
      risk.paused = false;
      log.info("Resumed from dashboard");
    },
    closeAll: () => {
      risk.paused = true;
      log.warn("Close-all from dashboard: pausing and selling every open position");
      closeAll();
    },
  });

  const saveTimer = setInterval(persist, 15_000);
  const summaryTimer = setInterval(() => {
    const s = snapshot();
    const usd = s.solUsd ? ` ($${(s.equitySol * s.solUsd).toFixed(2)})` : "";
    log.info(
      `${mode.toUpperCase()} | equity ${s.equitySol.toFixed(4)} SOL${usd} ${pct(s.pnlPct)} | cash ${s.cashSol.toFixed(4)} | open ${s.positions.length} | W/L ${s.wins}/${s.losses} | watching ${s.tracker.watching}`,
    );
  }, 60_000);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(saveTimer);
    clearInterval(summaryTimer);
    tracker.stop();
    feed.stop();
    persist();
    server.close();
    if (pf.positions.size > 0) {
      log.warn(
        `Stopped with ${pf.positions.size} open position(s). They are saved and will be managed again on the next start.`,
      );
    }
    log.info("Bye.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
