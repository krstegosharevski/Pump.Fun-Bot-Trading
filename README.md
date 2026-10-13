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

## Commands

| Command | What it does |
|---|---|
| `npm run watch` | Watches new coins and shows which ones the strategy *would* buy. No trading. |
| `npm run dev` | **Paper trading** with fake money, plus the dashboard at http://127.0.0.1:3000 |
| `npm run report` | Summary of all paper trades: win rate, P&L, fees, drawdown, results by exit reason |
| `npm test` | Unit tests |
| `npm run live:check` | Dry run of the live trade path. Builds and inspects a transaction but **never signs or sends** anything. |
| `npm run wallet:new` | Creates a burner wallet for live trading and prints only its address |
| `npm run live` | Live trading (refuses to start unless `.env` has `MODE=live` and `LIVE_CONFIRM=YES_REAL_MONEY`) |
| `npm run wallet:withdraw -- <address>` | Sends all SOL from the bot wallet back to your own wallet (asks you to confirm) |

Stop the bot with **Ctrl+C**. Its state is saved to `data/`, and open positions are picked up again on the next start.
To restart paper trading from scratch, delete `data/paper-state.json` and `data/paper-trades.csv`.

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
