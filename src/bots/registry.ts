import type { Config } from "../config";

export type BotId = "primal" | "tabak";

export interface BotInfo {
  id: BotId;
  name: string;
  kind: "momentum" | "launch";
  tagline: string;
  description: string;
}

export const BOTS: BotInfo[] = [
  {
    id: "primal",
    name: "Primal 1-1",
    kind: "momentum",
    tagline: "Momentum: waits for proof, then rides it",
    description:
      "Watches each new coin for its first 45 seconds and buys only the ones already gaining real buying pressure. Sells on take-profit, stop-loss, trailing stop or a time limit.",
  },
  {
    id: "tabak",
    name: "Tabak 1-1",
    kind: "launch",
    tagline: "Launch sniper: buys the moment a coin is born",
    description:
      "Buys brand-new coins within seconds of launch, one coin at a time, and sells shortly after. Logic based on the Chainstack pump.fun bot (chainstacklabs/pumpfun-bonkfun-bot).",
  },
];

export const isBotId = (x: unknown): x is BotId => BOTS.some((b) => b.id === x);

export function botInfo(id: BotId): BotInfo {
  return BOTS.find((b) => b.id === id)!;
}

/** The settings a bot trades with: the shared account settings plus the bot's own limits. */
export function botConfig(cfg: Config, id: BotId): Config {
  if (id === "tabak") {
    return { ...cfg, MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_HOUR: cfg.TABAK_MAX_TRADES_PER_HOUR };
  }
  return cfg;
}

const size = (cfg: Config) =>
  cfg.TRADE_SIZE_PCT > 0 ? `${cfg.TRADE_SIZE_PCT}% of balance per trade (max ${cfg.MAX_TRADE_SOL} SOL)` : `${cfg.TRADE_SIZE_SOL} SOL per trade`;

/** Human-readable rules for the picker and the dashboard footer. */
export function settingsSummary(cfg: Config, id: BotId): { label: string; value: string }[] {
  if (id === "tabak") {
    const filters = [
      cfg.TABAK_MATCH_STRING ? `name contains "${cfg.TABAK_MATCH_STRING}"` : "",
      cfg.TABAK_CREATOR ? `creator ${cfg.TABAK_CREATOR.slice(0, 4)}…${cfg.TABAK_CREATOR.slice(-4)}` : "",
    ].filter(Boolean);
    return [
      {
        label: "Buys",
        value: cfg.TABAK_EXTREME_FAST
          ? `Within ${cfg.TABAK_MAX_TOKEN_AGE_SEC}s of launch${filters.length ? `, ${filters.join(", ")}` : ", any coin"}`
          : `${cfg.TABAK_WAIT_AFTER_CREATION_SEC}s after launch${filters.length ? `, ${filters.join(", ")}` : ""}`,
      },
      { label: "Pace", value: `One coin at a time, ${cfg.TABAK_WAIT_BEFORE_NEW_TOKEN_SEC}s pause between coins` },
      {
        label: "Sells",
        value:
          cfg.TABAK_EXIT_STRATEGY === "time_based"
            ? `${cfg.TABAK_WAIT_AFTER_BUY_SEC}s after buying, whatever the price`
            : `Take profit +${cfg.TABAK_TAKE_PROFIT_PCT}%, stop loss −${cfg.TABAK_STOP_LOSS_PCT}%, at most ${cfg.TABAK_MAX_HOLD_SEC}s`,
      },
      { label: "Size", value: size(cfg) },
      { label: "Limits", value: `${cfg.TABAK_MAX_TRADES_PER_HOUR} trades per hour, daily loss stop ${cfg.DAILY_LOSS_LIMIT_PCT}%` },
    ];
  }
  const trail = cfg.TRAIL_ACTIVATE_PCT >= 10_000 ? "no trailing stop" : `trailing ${cfg.TRAIL_DROP_PCT}% after +${cfg.TRAIL_ACTIVATE_PCT}%`;
  return [
    {
      label: "Buys",
      value: `Within ${cfg.WATCH_WINDOW_SEC}s of launch if market cap +${cfg.MIN_MCAP_GAIN_PCT}%, ≥${cfg.MIN_REAL_SOL} SOL in, still rising, creator ≤${cfg.MAX_DEV_BUY_PCT}%`,
    },
    {
      label: "Sells",
      value: `Take profit +${cfg.TAKE_PROFIT_PCT}%, stop loss −${cfg.STOP_LOSS_PCT}%, ${trail}, at most ${Math.round(cfg.MAX_HOLD_SEC / 60)} min`,
    },
    { label: "Size", value: size(cfg) },
    { label: "Limits", value: `Up to ${cfg.MAX_OPEN_POSITIONS} open, ${cfg.MAX_TRADES_PER_HOUR} trades per hour, daily loss stop ${cfg.DAILY_LOSS_LIMIT_PCT}%` },
  ];
}
