import type { Config } from "../config";

export type BotId = "primal" | "tabak" | "blazebit" | "erentinx";

export interface BotInfo {
  id: BotId;
  name: string;
  kind: "momentum" | "launch" | "hot" | "stretch";
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
  {
    id: "blazebit",
    name: "Blazebit 1-1",
    kind: "hot",
    tagline: "Hot memes: rides trending coins with real volume",
    description:
      "Trades graduated pump.fun coins on the 1-hour trending list (GeckoTerminal), only while they are still climbing with lots of buyers. Deeper liquidity than new launches, so exits fill closer to their target.",
  },
  {
    id: "erentinx",
    name: "ErenTinx 3",
    kind: "stretch",
    tagline: "Final Stretch: safety-checked coins close to graduating, sold in steps",
    description:
      "Modeled on how top trading terminals like Axiom are used: watches pump.fun coins that are 60–95% of the way to graduating, skips coins whose creator or a few wallets hold too much, buys only while SOL keeps flowing in, then sells half at the first target and lets the rest ride.",
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
  if (id === "erentinx") {
    return { ...cfg, MAX_OPEN_POSITIONS: cfg.ERENTINX_MAX_OPEN_POSITIONS, MAX_TRADES_PER_HOUR: cfg.ERENTINX_MAX_TRADES_PER_HOUR };
  }
  if (id === "blazebit") {
    return {
      ...cfg,
      TAKE_PROFIT_PCT: cfg.BLAZE_TAKE_PROFIT_PCT,
      STOP_LOSS_PCT: cfg.BLAZE_STOP_LOSS_PCT,
      TRAIL_ACTIVATE_PCT: cfg.BLAZE_TRAIL_ACTIVATE_PCT,
      TRAIL_DROP_PCT: cfg.BLAZE_TRAIL_DROP_PCT,
      MAX_HOLD_SEC: cfg.BLAZE_MAX_HOLD_MIN * 60,
      MAX_OPEN_POSITIONS: cfg.BLAZE_MAX_OPEN_POSITIONS,
      MAX_TRADES_PER_HOUR: cfg.BLAZE_MAX_TRADES_PER_HOUR,
    };
  }
  return cfg;
}

const size = (cfg: Config) =>
  cfg.TRADE_SIZE_PCT > 0 ? `${cfg.TRADE_SIZE_PCT}% of balance per trade (max ${cfg.MAX_TRADE_SOL} SOL)` : `${cfg.TRADE_SIZE_SOL} SOL per trade`;

/** Human-readable rules for the picker and the dashboard footer. */
export function settingsSummary(cfg: Config, id: BotId): { label: string; value: string }[] {
  if (id === "erentinx") {
    return [
      {
        label: "Watches",
        value: `pump.fun coins ${cfg.ERENTINX_MIN_PROGRESS_PCT}–${cfg.ERENTINX_MAX_PROGRESS_PCT}% of the way to graduating, traded in the last ${cfg.ERENTINX_MAX_IDLE_SEC}s${cfg.ERENTINX_REQUIRE_SOCIALS ? ", with socials" : ""}`,
      },
      {
        label: "Safety",
        value: `Creator holds ≤${cfg.ERENTINX_MAX_DEV_PCT}%, top 10 wallets ≤${cfg.ERENTINX_MAX_TOP10_PCT}%, no single wallet >${cfg.ERENTINX_MAX_TOP1_PCT}% (top-holder check needs a private RPC)`,
      },
      { label: "Buys", value: `When ≥${cfg.ERENTINX_MIN_INFLOW_SOL} SOL flowed in over ${cfg.ERENTINX_LOOKBACK_SEC}s and the price is up` },
      {
        label: "Sells",
        value: `Stop loss −${cfg.ERENTINX_STOP_LOSS_PCT}%. At +${cfg.ERENTINX_TP1_PCT}% sells ${cfg.ERENTINX_TP1_SELL_PCT}%; the rest at +${cfg.ERENTINX_TP2_PCT}%, a ${cfg.ERENTINX_TRAIL_DROP_PCT}% drop from the peak, back at the entry price, ${cfg.ERENTINX_SELL_ON_GRADUATION ? "graduation, " : ""}or ${cfg.ERENTINX_MAX_HOLD_MIN} min`,
      },
      { label: "Size", value: size(cfg) },
      {
        label: "Limits",
        value: `Up to ${cfg.ERENTINX_MAX_OPEN_POSITIONS} open, ${cfg.ERENTINX_MAX_TRADES_PER_HOUR} trades per hour, same coin again after ${cfg.ERENTINX_COIN_COOLDOWN_MIN} min`,
      },
    ];
  }
  if (id === "blazebit") {
    const usd = (x: number) => (x >= 1e6 ? `$${x / 1e6}M` : `$${x / 1e3}k`);
    return [
      {
        label: "Hot list",
        value: `1h trending pump.fun coins: market cap ${usd(cfg.BLAZE_MIN_MCAP_USD)}–${usd(cfg.BLAZE_MAX_MCAP_USD)}, liquidity ≥${usd(cfg.BLAZE_MIN_LIQUIDITY_USD)}, 1h volume ≥${usd(cfg.BLAZE_MIN_VOLUME_1H_USD)}, ≥${cfg.BLAZE_MIN_BUYERS_1H} buyers, 1h +${cfg.BLAZE_MIN_CHANGE_1H_PCT}% or more`,
      },
      {
        label: "Buys",
        value: `While still climbing: 5m +${cfg.BLAZE_MIN_CHANGE_5M_PCT}% to +${cfg.BLAZE_MAX_CHANGE_5M_PCT}%, more buys than sells, price up over ${cfg.BLAZE_RISING_LOOKBACK_SEC}s`,
      },
      {
        label: "Sells",
        value: `Take profit +${cfg.BLAZE_TAKE_PROFIT_PCT}%, stop loss −${cfg.BLAZE_STOP_LOSS_PCT}%, trailing ${cfg.BLAZE_TRAIL_DROP_PCT}% after +${cfg.BLAZE_TRAIL_ACTIVATE_PCT}%, at most ${cfg.BLAZE_MAX_HOLD_MIN} min`,
      },
      { label: "Size", value: size(cfg) },
      {
        label: "Limits",
        value: `Up to ${cfg.BLAZE_MAX_OPEN_POSITIONS} open, ${cfg.BLAZE_MAX_TRADES_PER_HOUR} trades per hour, same coin again after ${cfg.BLAZE_COIN_COOLDOWN_MIN} min`,
      },
    ];
  }
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
