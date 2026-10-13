import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../src/config";
import { buildSeries, buildTimeline, runBacktest, type BacktestResult, type Timeline } from "../src/backtest/engine";

// Usage: npm run backtest                    (sweep settings on data/ticks)
//        npm run backtest -- --min-trades 20 (accept combos with fewer trades)
//        npm run backtest -- --start-sol 9   (starting balance; default: your paper account's)
const argVal = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MIN_TRADES = Number(argVal("--min-trades") ?? 30);
const TICK_DIR = path.join("data", "ticks");
const TRAIL_OFF = 1_000_000;

type Combo = Partial<Config>;

function loadLines(): string[] {
  if (!fs.existsSync(TICK_DIR)) return [];
  const lines: string[] = [];
  for (const f of fs.readdirSync(TICK_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(TICK_DIR, f), "utf8").split("\n")) if (line) lines.push(line);
  }
  return lines;
}

function startBalance(cfg: Config): number {
  const fromArg = argVal("--start-sol");
  if (fromArg) return Number(fromArg);
  const state = path.join("data", "paper-state.json");
  if (fs.existsSync(state)) return JSON.parse(fs.readFileSync(state, "utf8")).startSol;
  return cfg.PAPER_START_SOL;
}

function grid(axes: Record<string, number[]>): Combo[] {
  let out: Combo[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    out = out.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  return out;
}

const TRAILS: Combo[] = [
  { TRAIL_ACTIVATE_PCT: TRAIL_OFF, TRAIL_DROP_PCT: 10 },
  { TRAIL_ACTIVATE_PCT: 25, TRAIL_DROP_PCT: 10 },
  { TRAIL_ACTIVATE_PCT: 20, TRAIL_DROP_PCT: 15 },
  { TRAIL_ACTIVATE_PCT: 40, TRAIL_DROP_PCT: 15 },
];

const score = (r: BacktestResult) => (r.trades.length >= MIN_TRADES ? r.netPnlPct : -Infinity);
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const fmtPf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "∞");
const describe = (c: Config) =>
  `gain≥${c.MIN_MCAP_GAIN_PCT}% sol≥${c.MIN_REAL_SOL} look ${c.RISING_LOOKBACK_SEC}s prog≤${c.MAX_CURVE_PROGRESS_PCT}% | ` +
  `TP ${c.TAKE_PROFIT_PCT}% SL ${c.STOP_LOSS_PCT}% trail ${c.TRAIL_ACTIVATE_PCT >= TRAIL_OFF ? "off" : `${c.TRAIL_ACTIVATE_PCT}/${c.TRAIL_DROP_PCT}`} hold ${c.MAX_HOLD_SEC}s`;
const summary = (r: BacktestResult) =>
  `${String(r.trades.length).padStart(4)} trades  win ${r.winRate.toFixed(0).padStart(3)}%  P&L ${fmtPct(r.netPnlPct).padStart(7)}  PF ${fmtPf(r.profitFactor).padStart(4)}  DD ${r.maxDrawdownPct.toFixed(1).padStart(4)}%`;

async function main() {
  const { cfg: base } = loadConfig([]);
  const started = Date.now();
  const coins = buildSeries(loadLines());
  if (coins.length === 0) {
    console.log("No recorded data yet. Run the bot (npm run dev or npm run watch) for a day, then try again.");
    return;
  }
  const tl: Timeline = buildTimeline(coins);
  const hours = (tl.end - tl.start) / 3_600_000;
  const startSol = startBalance(base);
  const split = tl.start + (tl.end - tl.start) * 0.7;
  const tune = { startSol, from: tl.start, to: split };
  const valid = { startSol, from: split };
  console.log(
    `Loaded ${coins.length} coins, ${tl.times.length} price points, ${hours.toFixed(1)} hours ` +
      `(${new Date(tl.start).toLocaleString()} → ${new Date(tl.end).toLocaleString()}). Start balance ${startSol.toFixed(3)} SOL.`,
  );
  console.log("Tuning on the first 70% of that time, validating on the last 30%.\n");
  if (hours < 24) console.log(`⚠ Only ${hours.toFixed(1)} hours of data. Results are unreliable until you have at least a day.\n`);

  const run = (combo: Combo, period: typeof tune | typeof valid) => runBacktest(tl, { ...base, ...combo }, period);

  // Stage 1: entry rules, with the current exits.
  const entryGrid = grid({
    MIN_MCAP_GAIN_PCT: [15, 25, 40],
    MIN_REAL_SOL: [2, 3, 5],
    RISING_LOOKBACK_SEC: [3, 5, 10],
    MAX_CURVE_PROGRESS_PCT: [30, 50],
  });
  console.log(`Stage 1: testing ${entryGrid.length} entry settings…`);
  const stage1: { combo: Combo; r: BacktestResult }[] = [];
  for (const combo of entryGrid) stage1.push({ combo, r: await run(combo, tune) });
  stage1.sort((a, b) => score(b.r) - score(a.r));
  const topEntries = stage1.slice(0, 3).map((x) => x.combo);

  // Stage 2: exit rules for the 3 best entry settings.
  const exitGrid = grid({ TAKE_PROFIT_PCT: [25, 40, 60, 100], STOP_LOSS_PCT: [10, 15, 20, 30], MAX_HOLD_SEC: [60, 180, 300] })
    .flatMap((c) => TRAILS.map((tr) => ({ ...c, ...tr })));
  console.log(`Stage 2: testing ${exitGrid.length * topEntries.length} exit settings…`);
  const stage2: { combo: Combo; r: BacktestResult }[] = [];
  for (const entry of topEntries) {
    for (const exit of exitGrid) {
      const combo = { ...entry, ...exit };
      stage2.push({ combo, r: await run(combo, tune) });
    }
  }
  stage2.sort((a, b) => score(b.r) - score(a.r));

  const baseTune = await run({}, tune);
  const baseValid = await run({}, valid);
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s.\n`);
  console.log("CURRENT .env SETTINGS");
  console.log(`  ${describe(base)}`);
  console.log(`  tune:  ${summary(baseTune)}`);
  console.log(`  valid: ${summary(baseValid)}\n`);

  const top = stage2.filter((x) => Number.isFinite(score(x.r))).slice(0, 10);
  if (top.length === 0) {
    console.log(`No setting produced ${MIN_TRADES}+ trades in the tuning period. Collect more data (or use --min-trades 10 for a rough look).`);
    return;
  }
  console.log(`TOP ${top.length} SETTINGS (ranked on the tuning period; validation is the honest check)`);
  for (const [i, x] of top.entries()) {
    const cfg = { ...base, ...x.combo };
    const v = await run(x.combo, valid);
    console.log(`#${i + 1} ${describe(cfg)}`);
    console.log(`   tune:  ${summary(x.r)}`);
    console.log(`   valid: ${summary(v)}`);
  }

  const best = { ...base, ...top[0].combo };
  console.log("\nTo try #1, put these lines in .env and restart the bot (then compare with a fresh paper run):");
  for (const key of [
    "MIN_MCAP_GAIN_PCT",
    "MIN_REAL_SOL",
    "RISING_LOOKBACK_SEC",
    "MAX_CURVE_PROGRESS_PCT",
    "TAKE_PROFIT_PCT",
    "STOP_LOSS_PCT",
    "TRAIL_ACTIVATE_PCT",
    "TRAIL_DROP_PCT",
    "MAX_HOLD_SEC",
  ] as const) {
    console.log(`${key}=${best[key]}`);
  }
  console.log("\nIf #1 does much worse on 'valid' than on 'tune', it is probably luck. Prefer a setting that is good on both.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
