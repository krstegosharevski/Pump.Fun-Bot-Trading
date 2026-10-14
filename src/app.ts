import { Trader, pct, type TraderDeps } from "./bot";
import { BOTS, botConfig, botInfo, settingsSummary, type BotId } from "./bots/registry";
import { startEngine, type EngineHandle } from "./bots/engines";
import { startDashboard } from "./dashboard/server";
import { log, sleep } from "./log";

const STOP_TIMEOUT_MS = 60_000;
const RESELL_EVERY_MS = 3_000;

type Phase = "idle" | "starting" | "running" | "stopping";

/**
 * The app: one shared account (Trader), the dashboard, and at most one running bot.
 * Bots are picked and started from the dashboard, or with `npm run dev -- --bot <id>`.
 */
export async function startApp(deps: TraderDeps, autoStart?: BotId) {
  const { cfg, tracker, pools, feed } = deps;
  const trader = await Trader.create(deps);
  trader.start();

  let phase: Phase = "idle";
  let active: { id: BotId; since: number; engine: EngineHandle } | null = null;
  let pending: BotId | null = null;

  async function start(id: BotId): Promise<void> {
    if (phase !== "idle") return;
    const info = botInfo(id);
    const botCfg = botConfig(cfg, id);
    phase = "starting";
    pending = id;
    if (trader.mode === "live") {
      const balance = await trader.liveBalanceSol!().catch(() => 0);
      if (balance < trader.sizeFor(botCfg) + cfg.MIN_SOL_RESERVE) {
        log.error(`Can't start ${info.name}: wallet balance ${balance.toFixed(4)} SOL is too low.`);
        phase = "idle";
        pending = null;
        return;
      }
      for (let s = 10; s > 0; s--) {
        log.warn(`Starting ${info.name} with REAL money in ${s}s — press Stop to cancel`);
        await sleep(1000);
        if (phase !== "starting") return;
      }
    }
    trader.risk.setConfig(botCfg);
    trader.risk.paused = false;
    active = { id, since: Date.now(), engine: startEngine(id, { cfg, tracker, pools, feed, trader }) };
    phase = "running";
    pending = null;
    log.info(`▶ ${info.name} started (${info.tagline}). About ${trader.sizeFor(botCfg).toFixed(4)} SOL per trade.`);
  }

  async function stop(): Promise<void> {
    if (phase === "starting") {
      phase = "idle";
      pending = null;
      log.info("Start cancelled.");
      return;
    }
    if (phase !== "running" || !active) return;
    phase = "stopping";
    const name = botInfo(active.id).name;
    active.engine.stop();
    const open = trader.pf.positions.size;
    log.info(`■ Stopping ${name}${open ? `: selling ${open} open position(s) first` : ""}`);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    let lastSell = 0;
    while (!trader.isIdle() && Date.now() < deadline) {
      if (Date.now() - lastSell >= RESELL_EVERY_MS) {
        trader.closeAll("switch");
        lastSell = Date.now();
      }
      await sleep(500);
    }
    if (!trader.isIdle()) {
      log.warn(`${name} stopped with ${trader.pf.positions.size} position(s) still open. They stay saved and keep being watched.`);
    }
    trader.risk.setConfig(cfg);
    active = null;
    phase = "idle";
    log.info(`${name} stopped. Pick a bot on the dashboard to continue.`);
  }

  const getState = () => {
    const runningCfg = active ? botConfig(cfg, active.id) : cfg;
    return {
      ...trader.snapshot(runningCfg),
      hot: active?.engine.hotList?.() ?? null,
      app: {
        phase,
        activeBot: active?.id ?? pending,
        activeSince: active?.since ?? null,
        bots: BOTS.map((b) => ({ ...b, rules: settingsSummary(cfg, b.id) })),
      },
    };
  };

  const server = startDashboard(cfg.DASHBOARD_PORT, getState, {
    start: (id) => {
      if (phase !== "idle") return "Stop the running bot first.";
      void start(id);
      return null;
    },
    stop: () => void stop(),
    pause: () => {
      trader.risk.paused = true;
      log.warn("Paused from dashboard: no new buys (open positions are still managed)");
    },
    resume: () => {
      trader.risk.paused = false;
      log.info("Resumed from dashboard");
    },
    closeAll: () => {
      trader.risk.paused = true;
      log.warn("Close-all from dashboard: pausing and selling every open position");
      trader.closeAll();
    },
    resetHourlyLimit: () => {
      trader.risk.resetHourlyLimit();
      trader.persist();
      log.info("Hourly trade limit reset from dashboard");
    },
    sell: (mint) => {
      const pos = trader.pf.positions.get(mint);
      if (!pos) return "That position is no longer open.";
      if (trader.isInFlight(mint)) return `${pos.symbol} is already being sold.`;
      log.info(`Manual sell of ${pos.symbol} from dashboard`);
      void trader.exit(mint, "manual");
      return null;
    },
  });

  const summaryTimer = setInterval(() => {
    const s = getState();
    const usd = s.solUsd ? ` ($${(s.equitySol * s.solUsd).toFixed(2)})` : "";
    const who = active ? botInfo(active.id).name : "no bot running";
    log.info(
      `${trader.mode.toUpperCase()} | ${who} | equity ${s.equitySol.toFixed(4)} SOL${usd} ${pct(s.pnlPct)} | open ${s.positions.length} | W/L ${s.wins}/${s.losses} | watching ${s.tracker.watching}`,
    );
  }, 60_000);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(summaryTimer);
    active?.engine.stop();
    trader.shutdown();
    tracker.stop();
    pools.stop();
    feed.stop();
    server.close();
    if (trader.pf.positions.size > 0) {
      log.warn(`Stopped with ${trader.pf.positions.size} open position(s). They are saved and will be managed again on the next start.`);
    }
    log.info("Bye.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (autoStart) {
    void start(autoStart);
  } else {
    log.info(`Choose a bot at http://127.0.0.1:${cfg.DASHBOARD_PORT}  (or start one directly: npm run dev -- --bot primal|tabak)`);
  }
}
