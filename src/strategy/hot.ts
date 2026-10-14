import type { Config } from "../config";
import { WSOL_MINT } from "../chain/pumpswap";
import type { HotCoin } from "../feed/geckoTrending";
import type { EntryDecision } from "./momentum";

// Blazebit 1-1: trades "hot" meme coins, i.e. graduated pump.fun coins on the 1h trending list.

/** Is this trending pool a hot pump.fun meme coin we can trade? */
export function isHotMeme(c: HotCoin, cfg: Config): { ok: boolean; reason: string } {
  const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}k`);
  if (c.dex !== "pumpswap") return { ok: false, reason: `not a pump.fun coin (${c.dex})` };
  if (c.quoteMint !== WSOL_MINT) return { ok: false, reason: "not paired with SOL" };
  if (c.fdvUsd < cfg.BLAZE_MIN_MCAP_USD) return { ok: false, reason: `market cap ${usd(c.fdvUsd)} too small` };
  if (c.fdvUsd > cfg.BLAZE_MAX_MCAP_USD) return { ok: false, reason: `market cap ${usd(c.fdvUsd)} too big` };
  if (c.liquidityUsd < cfg.BLAZE_MIN_LIQUIDITY_USD) return { ok: false, reason: `liquidity ${usd(c.liquidityUsd)} too low` };
  if (c.volume1h < cfg.BLAZE_MIN_VOLUME_1H_USD) return { ok: false, reason: `1h volume ${usd(c.volume1h)} too low` };
  if (c.buyers1h < cfg.BLAZE_MIN_BUYERS_1H) return { ok: false, reason: `only ${c.buyers1h} buyers in 1h` };
  if (c.change1h < cfg.BLAZE_MIN_CHANGE_1H_PCT) return { ok: false, reason: `1h ${c.change1h.toFixed(0)}%, not hot` };
  return { ok: true, reason: "hot" };
}

/** Buy a hot coin only while it's still climbing, without chasing a vertical candle. */
export function shouldBuyHot(
  c: HotCoin,
  history: { t: number; priceSol: number }[],
  now: number,
  cfg: Config,
): EntryDecision {
  if (c.change5m < cfg.BLAZE_MIN_CHANGE_5M_PCT) return { enter: false, reason: `5m ${c.change5m.toFixed(1)}%, cooling off` };
  if (c.change5m > cfg.BLAZE_MAX_CHANGE_5M_PCT) return { enter: false, reason: `5m +${c.change5m.toFixed(0)}%, too vertical` };
  if (c.buys1h < c.sells1h) return { enter: false, reason: "more sells than buys in 1h" };

  const last = history.at(-1);
  if (!last) return { enter: false, reason: "no on-chain price yet" };
  const cutoff = now - cfg.BLAZE_RISING_LOOKBACK_SEC * 1000;
  let ref: { t: number; priceSol: number } | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= cutoff) {
      ref = history[i];
      break;
    }
  }
  if (!ref) return { enter: false, reason: "watching price" };
  if (last.priceSol <= ref.priceSol) return { enter: false, reason: `not rising over ${cfg.BLAZE_RISING_LOOKBACK_SEC}s` };

  const signed = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  return {
    enter: true,
    reason: `hot: 1h ${signed(c.change1h, 0)}%, 5m ${signed(c.change5m, 1)}%, ${c.buyers1h} buyers, rising`,
  };
}
