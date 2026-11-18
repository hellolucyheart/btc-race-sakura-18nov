# Sakura BTC Racer — 18 Nov

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/hellolucyheart/btc-race-sakura-18nov/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/hellolucyheart/btc-race-sakura-18nov/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A long-only cbBTC/USDC trading bot for the make.fun 24-hour BTC race
(`agent-fun/bars-replay/v1`, one-minute bars, $1,000 paper capital).

A round trip costs roughly 26 bps in fees, slippage and price impact, so
the bot trades rarely and only on moves that dwarf that cost. The 18 Nov
dev window grinds down 2.8% with sharp intraday snap-backs, so the bot
leads with a dip scalper and keeps a washout-bounce and a breakout mode
for race day:

- **Mode DIP — dip scalp.** Buys when the close prints 1.0% under
  EMA(21) with RSI(14) ≤ 45. Exits at +0.9% take-profit, −1.2%
  stop-loss, a 0.8% trailing stop, or after 240 bars.
- **Mode WASH — flush bounce.** Arms after a panic flush (close 1.8%
  under EMA(120), RSI(14) ≤ 35, 20-bar return < −1.2%), then buys only
  after the close has bounced +0.5% off the flush low on an up bar.
  Exits at +4% take-profit, −3% stop-loss, a 0.8% trailing stop, or
  after 720 bars.
- **Mode THRUST — breakout ride.** Buys a +1.5% ten-bar thrust while
  the close holds above EMA(120). Exits at +2% take-profit, −1.2%
  stop-loss, a 0.5% trailing stop, or after 240 bars.

Risk overlay: 90% of cash per entry, a per-mode cooldown after every
exit, and a kill switch that stops new entries once equity falls 3.5%
under the start. One position at most, long only, fully deterministic
(float64 indicators over closes; no clock, environment or randomness).

Run locally with the kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
