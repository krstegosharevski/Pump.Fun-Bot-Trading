# PumpFun Bot

A momentum trading bot for new [pump.fun](https://pump.fun) coins on Solana. It runs with **fake money (paper mode) by default**. Live trading needs several deliberate steps that you take yourself.

> **Read this first.** Most pump.fun coins go to zero, and the bot competes with much faster paid bots.
> Each round trip (buy then sell) costs about **5–6% in fees** at 0.02 SOL per trade: about 1.25% pump.fun + 0.5% PumpPortal on each side, plus priority fees.
> Only ever trade money you are fully prepared to lose.

## How it works

```
PumpPortal websocket ─ new coin ─▶ Tracker ─ prices every 1s from Solana RPC ─▶ Momentum strategy
                                                                                    │
                     Dashboard ◀── Portfolio (data/*.json, *.csv) ◀── Executor ◀── Risk guard
                                                                  (paper or live)
```

1. **Watch.** Every new pump.fun coin is watched for 45 s after launch.
2. **Buy** only if all of these hold:
   - the market cap is up at least 25%,
   - at least 3 SOL has gone into the bonding curve,
   - the curve is less than 50% of the way to graduating,
   - the price is still rising,
   - and the creator didn't buy more than 10% of the supply at launch.
3. **Sell** on whichever comes first:
   - +40% (take profit),
   - −20% (stop loss),
   - a 15% drop from the peak once it has been up 20% (trailing stop),
   - 3 minutes (time limit),
   - or graduation.
4. **Risk guard:**
   - at most 2 open positions,
   - always keeps 0.02 SOL for fees,
   - stops for the day after a 30% loss,
   - cools down for 5 min after 3 losses in a row,
   - at most 20 trades per hour.

Every number above can be changed in `.env` (see `.env.example`).

## Choosing a bot

The dashboard starts with a bot picker, like choosing a model in Claude. Pick one, press **Start**, and **Stop bot** when you want to switch. Stopping sells that bot's open trades first. Both bots trade from the same account, and every trade is tagged with the bot that made it.

| Bot | Style | Buys | Sells |
|---|---|---|---|
| **Primal 1-1** | Momentum | Watches each new coin for 45 s; buys only coins already gaining (market cap +25%, ≥3 SOL in, still rising) | Take profit +40%, stop loss −20%, trailing stop, 3 min limit |
| **Blazebit 1-1** | Hot memes | Graduated pump.fun coins on GeckoTerminal's 1h trending list ($100k–$20M market cap, ≥$30k liquidity, 1h +20%, lots of buyers), only while still climbing (5m +3% to +40%, rising on-chain) | Take profit +30%, stop loss −12%, trailing 10% after +20%, 30 min limit |
| **ErenTinx 3** | Final Stretch (modeled on how traders use Axiom's Pulse) | pump.fun coins 60–95% of the way to graduating that pass safety checks (creator ≤5%, top 10 wallets ≤30%) while SOL keeps flowing in | Sells in steps: half at +25%, the rest at +80%, on a 12% trailing stop, back at entry, at graduation or after 20 min; stop loss −15% |
| **Tabak 1-1** | Launch sniper (logic from [chainstacklabs/pumpfun-bonkfun-bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot)) | Within 2 s of launch, one coin at a time, 15 s pause between coins | 15 s after buying, whatever the price (`time_based`), or `tp_sl`: +40% / −40% / 15 s |

Tabak's settings are the `TABAK_*` lines in `.env`, Blazebit's the `BLAZE_*` lines, ErenTinx's the `ERENTINX_*` lines. ErenTinx reads pump.fun's own (unofficial) list of recently traded coins; its top-holder safety check needs a private RPC such as a free Helius key, because the public Solana RPC refuses that request. Until then the dashboard shows "top holders unchecked" for each coin. Blazebit trades on PumpSwap, where pump.fun coins go after graduating. Its fee is 1% per trade (measured on-chain), a bit less than the launch curve's 1.25%, and the deeper liquidity means stop-losses fill closer to their trigger. While it runs, the dashboard shows its **Hot list** with what it thinks of each trending coin. Compared with the original repo, Tabak:
- watches prices on every change, not every 2 s;
- keeps retrying a failed sale instead of giving up after 3 tries.

Its launch detection (PumpPortal) and 1.5 s paper fills are slower than the Geyser setup that repo recommends, so paper results show what it can do at *our* speed. The backtester only covers Primal: Tabak would need the first second of every coin, which the recorder doesn't keep.

## Commands

| Command | What it does |
|---|---|
| `npm run watch` | Watches new coins and shows which ones the strategy *would* buy. No trading. |
| `npm run dev` | **Paper trading** with fake money. Open http://127.0.0.1:3000, pick a bot, press Start |
| `npm run dev -- --bot tabak` | Same, but starts a bot right away (`primal` or `tabak`), useful for unattended restarts |
| `npm run report` | Summary of all paper trades: win rate, P&L, fees, drawdown, results by bot and by exit reason. Add `-- --bot tabak` for one bot |
| `npm run backtest` | Tests hundreds of setting combinations on recorded price data and shows the best ones |
| `npm test` | Unit tests |
| `npm run live:check` | Dry run of the live trade path. Builds and inspects a transaction but **never signs or sends** anything. |
| `npm run wallet:new` | Creates a burner wallet for live trading and prints only its address |
| `npm run live` | Live trading (refuses to start unless `.env` has `MODE=live` and `LIVE_CONFIRM=YES_REAL_MONEY`) |
| `npm run wallet:withdraw -- <address>` | Sends all SOL from the bot wallet back to your own wallet (asks you to confirm) |

Stop the bot with **Ctrl+C**. Its state is saved to `data/`, and open positions are picked up again on the next start.
To restart paper trading from scratch, delete `data/paper-state.json` and `data/paper-trades.csv`.

## Tuning with the backtester

While the bot runs (`npm run dev` or `npm run watch`), it records the price path of every promising coin to `data/ticks/`. That includes coins it didn't buy, for 5 minutes after their watch window.

1. Let the bot run for at least a day.
2. Run `npm run backtest`. It replays the recording through the bot's real strategy, fee model and risk limits:
   - Stage 1 tries 54 entry settings.
   - Stage 2 tries 576 exit settings for the 3 best entries.
3. It tunes on the first 70% of the recorded time, then checks the winners on the last 30% ("valid"). A setting that is good on *tune* but bad on *valid* was probably luck.
4. Paste the suggested lines into `.env`, then confirm with a fresh paper run. To restart paper trading, move `data/paper-state.json` and `data/paper-trades.csv` into `data/archive/`.

Trade size: `TRADE_SIZE_PCT=2` makes each trade 2% of the current balance, never more than `MAX_TRADE_SOL`. Set it to 0 to use the fixed `TRADE_SIZE_SOL` instead.

## Paper mode realism

Paper fills use the **real on-chain price** from 1.5 s after the decision, including price impact. The simulator also charges:
- the pump.fun and PumpPortal % fees,
- network and priority fees,
- token-account rent (locked on buy, refunded on sell),
- and a 5% chance of a failed transaction, which still costs the network fee.

Two things it can't model:
- the effect of our own buy on the price (tiny at 0.02 SOL),
- and competition for block space during very busy moments.

## Going live (only if paper results justify it)

Suggested bar before going live:
- at least 100 paper trades,
- positive net P&L after fees in `npm run report`,
- and a drawdown you can live with.

1. Get a free RPC key (for example at helius.dev) and set `RPC_URL` in `.env`.
2. `npm run wallet:new` creates a **separate** wallet. Never use your main wallet.
3. `npm run live:check` should print `Safety inspection: PASSED`.
4. Send about $25 of SOL to the printed address.
5. In `.env`, set `MODE=live` and `LIVE_CONFIRM=YES_REAL_MONEY`. Consider `TRADE_SIZE_SOL=0.01` for the first session.
6. Run `npm run live`. It shows the balance and limits and counts down 10 s before trading.

Before signing any transaction, the live bot checks:
- that it only calls known programs (pump.fun, PumpSwap, token, system, compute budget),
- that no instruction could hand over the wallet or approve token transfers,
- and, by simulation first, that it spends no more than the trade size plus fees.

Your private key never leaves `wallet/bot-wallet.json`. It is git-ignored and never logged. **Never share that file or paste its contents anywhere.**

## Project layout

```
src/index.ts            entry point
src/bot.ts              wires feed → strategy → risk → executor → portfolio → dashboard
src/config.ts           settings from .env
src/feed/pumpPortal.ts  new-coin websocket
src/chain/curve.ts      bonding-curve decoding and price math
src/market/tracker.ts   watchlist + price polling
src/strategy/momentum.ts entry/exit rules
src/risk.ts             limits, cooldown, daily loss stop
src/portfolio.ts        balances, positions, P&L, saved state
src/exec/paper.ts       fake-money executor
src/exec/live.ts        real executor (PumpPortal Local Transaction API + safety checks)
src/dashboard/          local web dashboard
scripts/                report, wallet tools, live dry run
```
