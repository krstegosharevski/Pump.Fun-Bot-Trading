import { loadConfig } from "./config";
import { log } from "./log";
import { makeConnection, redactUrl, SolPrice } from "./chain/rpc";
import { PumpPortalFeed } from "./feed/pumpPortal";
import { Tracker } from "./market/tracker";
import { TickRecorder } from "./market/recorder";
import { PoolTracker } from "./market/poolTracker";
import { runWatchMode } from "./watch";
import { BOTS, isBotId } from "./bots/registry";

async function main() {
  const { cfg, runMode } = loadConfig();
  const botArg = process.argv.includes("--bot") ? process.argv[process.argv.indexOf("--bot") + 1] : undefined;
  if (botArg !== undefined && !isBotId(botArg)) {
    throw new Error(`Unknown bot "${botArg}". Choose one of: ${BOTS.map((b) => b.id).join(", ")}`);
  }
  log.info(`Starting in ${runMode.toUpperCase()} mode | RPC ${redactUrl(cfg.RPC_URL)}`);

  const conn = makeConnection(cfg.RPC_URL);
  const solPrice = new SolPrice();
  await solPrice.refresh();
  solPrice.startAutoRefresh();
  if (solPrice.usd) log.info(`SOL price: $${solPrice.usd.toFixed(2)}`);

  const recorder = cfg.RECORD_TICKS ? new TickRecorder() : undefined;
  if (recorder) log.info("Recording price paths to data/ticks/ for the backtester");
  const tracker = new Tracker(conn, cfg, recorder);
  const feed = new PumpPortalFeed(cfg.PUMPPORTAL_WS, cfg.PUMPPORTAL_API_KEY);
  feed.on("newToken", (e) => tracker.add(e));
  feed.on("migration", (mint) => tracker.markMigrated(mint));

  if (runMode === "watch") {
    runWatchMode(cfg, feed, tracker);
  } else {
    const pools = new PoolTracker(conn, cfg);
    pools.start();
    const { startApp } = await import("./app");
    await startApp({ cfg, runMode, conn, solPrice, tracker, pools, feed }, botArg);
  }

  feed.start();
  tracker.start();
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
