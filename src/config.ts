import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const num = (def: number) => z.coerce.number().default(def);
const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const schema = z.object({
  // --- Mode & connections ---
  MODE: z.enum(["paper", "live"]).default("paper"),
  LIVE_CONFIRM: z.string().default(""),
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  PUMPPORTAL_WS: z.string().default("wss://pumpportal.fun/api/data"),
  PUMPPORTAL_API_KEY: z.string().optional(),
  DASHBOARD_PORT: num(3000),
  WALLET_PATH: z.string().default("wallet/bot-wallet.json"),
  POLL_MS: num(1000),
  MAX_WATCHLIST: num(80),

  // --- Recording (data for the backtester) ---
  RECORD_TICKS: bool(true),
  SHADOW_SEC: num(300),
  MAX_SHADOW: num(60),

  // --- Bankroll & sizing ---
  PAPER_START_USD: num(25),
  PAPER_START_SOL: num(0.15),
  TRADE_SIZE_SOL: num(0.02),
  /** If > 0, each trade is this % of current equity instead of TRADE_SIZE_SOL. */
  TRADE_SIZE_PCT: num(0),
  MAX_TRADE_SOL: num(0.5),
  MAX_OPEN_POSITIONS: num(2),
  MIN_SOL_RESERVE: num(0.02),

  // --- Costs (used by the paper simulator and live safety checks) ---
  PRIORITY_FEE_SOL: num(0.0002),
  BASE_FEE_SOL: num(0.000005),
  PUMP_FEE_PCT: num(1.25),
  PUMPPORTAL_FEE_PCT: num(0.5),
  ATA_RENT_SOL: num(0.00203928),
  BUY_SLIPPAGE_PCT: num(20),
  SELL_SLIPPAGE_PCT: num(40),

  // --- Paper simulator ---
  SIM_LATENCY_MS: num(1500),
  SIM_FAIL_RATE: num(0.05),

  // --- Momentum entry ---
  WATCH_WINDOW_SEC: num(45),
  MAX_DEV_BUY_PCT: num(10),
  SKIP_MAYHEM: bool(true),
  MIN_MCAP_GAIN_PCT: num(25),
  MIN_REAL_SOL: num(3),
  MAX_CURVE_PROGRESS_PCT: num(50),
  RISING_LOOKBACK_SEC: num(5),

  // --- Exits ---
  TAKE_PROFIT_PCT: num(40),
  STOP_LOSS_PCT: num(20),
  TRAIL_ACTIVATE_PCT: num(25),
  TRAIL_DROP_PCT: num(10),
  MAX_HOLD_SEC: num(180),

  // --- Tabak 1-1 (launch sniper, logic from chainstacklabs/pumpfun-bonkfun-bot) ---
  /** Buy as soon as a coin is announced (their "extreme fast mode"). */
  TABAK_EXTREME_FAST: bool(true),
  TABAK_MAX_TOKEN_AGE_SEC: num(2),
  /** When extreme fast is off: wait this long after launch, then buy. */
  TABAK_WAIT_AFTER_CREATION_SEC: num(15),
  /** Pause after each coin before taking the next one. */
  TABAK_WAIT_BEFORE_NEW_TOKEN_SEC: num(15),
  /** Only buy coins whose name or symbol contains this text (empty = any). */
  TABAK_MATCH_STRING: z.string().default(""),
  /** Only buy coins created by this wallet (empty = any). */
  TABAK_CREATOR: z.string().default(""),
  /** time_based = sell after TABAK_WAIT_AFTER_BUY_SEC; tp_sl = take profit / stop loss / max hold. */
  TABAK_EXIT_STRATEGY: z.enum(["time_based", "tp_sl"]).default("time_based"),
  TABAK_WAIT_AFTER_BUY_SEC: num(15),
  TABAK_TAKE_PROFIT_PCT: num(40),
  TABAK_STOP_LOSS_PCT: num(40),
  TABAK_MAX_HOLD_SEC: num(15),
  TABAK_MAX_TRADES_PER_HOUR: num(120),

  // --- Blazebit 1-1 (hot meme coins: trending graduated pump.fun coins) ---
  /** How often to refresh GeckoTerminal's trending list (its free limit is ~10 calls/min). */
  BLAZE_REFRESH_SEC: num(60),
  /** How often to read hot coins' pools on-chain. */
  BLAZE_POLL_MS: num(1500),
  BLAZE_MIN_MCAP_USD: num(100_000),
  BLAZE_MAX_MCAP_USD: num(20_000_000),
  BLAZE_MIN_LIQUIDITY_USD: num(30_000),
  BLAZE_MIN_VOLUME_1H_USD: num(50_000),
  BLAZE_MIN_BUYERS_1H: num(100),
  BLAZE_MIN_CHANGE_1H_PCT: num(20),
  /** Buy only while still rising, but not into a vertical candle. */
  BLAZE_MIN_CHANGE_5M_PCT: num(3),
  BLAZE_MAX_CHANGE_5M_PCT: num(40),
  BLAZE_RISING_LOOKBACK_SEC: num(30),
  /** Don't buy the same coin again for this long. */
  BLAZE_COIN_COOLDOWN_MIN: num(60),
  BLAZE_TAKE_PROFIT_PCT: num(30),
  BLAZE_STOP_LOSS_PCT: num(12),
  BLAZE_TRAIL_ACTIVATE_PCT: num(20),
  BLAZE_TRAIL_DROP_PCT: num(10),
  BLAZE_MAX_HOLD_MIN: num(30),
  BLAZE_MAX_OPEN_POSITIONS: num(3),
  BLAZE_MAX_TRADES_PER_HOUR: num(10),
  /** PumpSwap fee per trade, read from on-chain buy events: 0.20 LP + 0.05 protocol + 0.75 creator. */
  BLAZE_POOL_FEE_PCT: num(1.0),

  // --- Risk guard ---
  DAILY_LOSS_LIMIT_PCT: num(30),
  MAX_CONSEC_LOSSES: num(3),
  COOLDOWN_MIN: num(5),
  MAX_TRADES_PER_HOUR: num(20),

  // --- Live safety ---
  EXTRA_ALLOWED_PROGRAMS: z.string().default(""),
});

export type Config = z.infer<typeof schema>;
export type RunMode = "watch" | "paper" | "live";

/** Defaults only (no .env); used by tests. */
export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return { ...schema.parse({}), ...overrides };
}

export function loadConfig(argv = process.argv): { cfg: Config; runMode: RunMode } {
  // Treat empty values in .env ("KEY=") as "not set" so defaults apply.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error("Invalid settings in .env:\n" + z.prettifyError(parsed.error));
  }
  const cfg = parsed.data;

  const wantsLive = argv.includes("--live");
  if (wantsLive && (cfg.MODE !== "live" || cfg.LIVE_CONFIRM !== "YES_REAL_MONEY")) {
    throw new Error(
      "Refusing to start LIVE trading. To trade real money you must set BOTH in .env:\n" +
        "  MODE=live\n  LIVE_CONFIRM=YES_REAL_MONEY",
    );
  }
  const runMode: RunMode = argv.includes("--watch-only") ? "watch" : wantsLive ? "live" : "paper";
  return { cfg, runMode };
}
