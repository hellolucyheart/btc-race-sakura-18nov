// Sakura BTC Racer — 18 November race edition. A long-only cbBTC/USDC
// bot for the agent-fun/bars-replay/v1 protocol (one 1-minute bar per
// batch, $1,000 of paper money, fills at the next bar's open).
//
// Why this shape: a full-size round trip costs about 26 bps in fees,
// slippage and own price impact, so every entry must chase a move much
// bigger than that. The 18 Nov dev window grinds down 2.8% with sharp
// intraday snap-backs of 1% or more, and never falls 1.8% under its
// slow average — so the patient washout mode alone never fires there,
// while a tight dip-scalp off the fast average catches the snap-backs.
// The bot therefore leads with the scalper and keeps the washout and
// thrust modes as race-day options for flushes and breakouts.
//
//   Mode DIP — the scalper. Fires when the close prints at least 1.0%
//     under EMA(21) while RSI(14) is 45 or lower, and only while the
//     close sits within 0.4% of its own 30-bar low on a rising bar:
//     the market over-sold against its fast average AND printing a
//     bottom, not just pausing mid-slide. The low filter matters: in a
//     grind down, the fast average lags above the price for hours, so
//     a bare gap would keep buying every small pause. Buys 90% of
//     cash. Leaves at +0.9% take-profit, at -1.2% stop-loss, on a 0.8%
//     trailing stop under the best close since entry, or after 240 bars
//     at the latest.
//
//   Mode WASH — the flush bounce. Arms when the close sits 1.8% or more
//     under EMA(120) with RSI(14) at 35 or lower and the last 20 bars
//     down more than 1.2%. It stays armed 90 bars, tracks the lowest
//     close of the flush, and buys only after the close has climbed
//     0.5% off that low on a rising bar, so it never catches the knife
//     on the way down. Leaves at +4% take-profit, at -3% stop-loss, on
//     a 0.8% trailing stop, or after 720 bars.
//
//   Mode THRUST — the breakout ride. Fires when the close holds above
//     EMA(120) and the last 10 bars gained more than 1.5%: momentum
//     ignition. Leaves at +2% take-profit, at -1.2% stop-loss, on a
//     0.5% trailing stop, or after 240 bars.
//
//   Risk first: one open position at a time, long only, 90% of cash per
//   entry, a short cooldown after every exit, and a kill switch that
//   blocks all new entries once equity slips 3.5% under the start.
//   The dev gate only needs any profit at all, and the race is ranked
//   purely by net PnL, so surviving beats trading often.
//
// Everything is plain float64 arithmetic over the closes seen so far,
// seeded only by the bars themselves: no clock, no environment, no
// randomness, so two runs on the same bars answer byte for byte alike.
// Written fresh for the 18 Nov 2026 race; the dip scalper is new here.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- shared risk settings -------------------------------------------------
const STAKE = 0.9; // fraction of free cash staked on each entry
const KILL_FLOOR = 0.965; // equity below start * this blocks new entries
const BUY_SLIP_BPS = 200; // a buy may chase the close by up to 2%
const SELL_SLIP_BPS = 300; // a sell may concede up to 3% past the close

// --- Mode DIP: fast-average dip scalp ------------------------------------
const DIP_EMA_SPAN = 21;
const DIP_GAP = 0.01; // close must sit this far under EMA(21)
const DIP_RSI_MAX = 45; // RSI(14) ceiling, inclusive
const DIP_LOW_BARS = 30; // lookback of the local low the close must hug
const DIP_NEAR_LOW = 0.004; // close within this of the 30-bar low
const DIP_TAKE = 0.009;
const DIP_STOP = 0.012;
const DIP_TRAIL = 0.008;
const DIP_HOLD = 240;
const DIP_COOLDOWN = 15;

// --- Mode WASH: slow-average flush bounce --------------------------------
const WASH_EMA_SPAN = 120;
const WASH_GAP = 0.018; // close this far under EMA(120) to arm
const WASH_RSI_MAX = 35;
const WASH_DROP_BARS = 20;
const WASH_DROP = -0.012; // the flush's 20-bar return must beat this
const WASH_ARM_BARS = 90;
const WASH_BOUNCE = 0.005; // climb off the flush low before buying
const WASH_TAKE = 0.04;
const WASH_STOP = 0.03;
const WASH_TRAIL = 0.008;
const WASH_HOLD = 720;
const WASH_COOLDOWN = 30;

// --- Mode THRUST: breakout ride ------------------------------------------
const THRUST_BARS = 10;
const THRUST_GAIN = 0.015; // 10-bar return that counts as ignition
const THRUST_TAKE = 0.02;
const THRUST_STOP = 0.012;
const THRUST_TRAIL = 0.005;
const THRUST_HOLD = 240;
const THRUST_COOLDOWN = 60;

const RSI_SPAN = 14;
const WARMUP = 40; // bars before EMA(21)/RSI(14) are trusted

// --- indicator state: EMA(21), EMA(120), Wilder RSI(14) over closes -----
const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let gainAvg = 0;
let lossAvg = 0;
let rsi: number | null = null;

function pushClose(close: number): void {
  const prev = closes.length > 0 ? closes[closes.length - 1] : null;
  closes.push(close);
  if (emaFast === null) emaFast = close;
  else emaFast += (2 / (DIP_EMA_SPAN + 1)) * (close - emaFast);
  if (emaSlow === null) emaSlow = close;
  else emaSlow += (2 / (WASH_EMA_SPAN + 1)) * (close - emaSlow);
  if (prev === null) return;
  const delta = close - prev;
  const gain = delta > 0 ? delta : 0;
  const loss = delta < 0 ? -delta : 0;
  const seen = closes.length - 1;
  if (seen <= RSI_SPAN) {
    gainAvg += gain / RSI_SPAN;
    lossAvg += loss / RSI_SPAN;
    if (seen === RSI_SPAN) rsi = lossAvg === 0 ? 100 : 100 - 100 / (1 + gainAvg / lossAvg);
  } else if (rsi !== null) {
    gainAvg = (gainAvg * (RSI_SPAN - 1) + gain) / RSI_SPAN;
    lossAvg = (lossAvg * (RSI_SPAN - 1) + loss) / RSI_SPAN;
    rsi = lossAvg === 0 ? 100 : 100 - 100 / (1 + gainAvg / lossAvg);
  }
}

function pastReturn(bars: number): number | null {
  if (closes.length <= bars) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - bars];
  return now / then - 1;
}

// --- trade state -----------------------------------------------------------
type Mode = 'DIP' | 'WASH' | 'THRUST';
let mode: Mode | null = null; // mode that owns the open (or in-flight) trade
let entryPrice = 0; // fill price of the open position, raw units
let entrySeq = -1; // batch seq at which the entry filled
let peakClose = 0; // best close printed since the entry filled
let sentSeq = -1; // seq at which the in-flight entry order was decided
let armedUntil = -1; // last seq an armed WASH may still trigger
let flushLow = 0; // lowest close of the flush that armed WASH
let coolDipUntil = -1;
let coolWashUntil = -1;
let coolThrustUntil = -1;
let startEquity: bigint | null = null;

function noteFills(state: BarsState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy' && mode !== null && entrySeq === -1) {
      entryPrice = Number(fill.price);
      entrySeq = batch.seq;
      peakClose = closes.length > 0 ? closes[closes.length - 1] : entryPrice;
    }
  }
  if (!state.positions.has(SYMBOL) && mode !== null && entrySeq !== -1) {
    mode = null;
    entrySeq = -1;
    entryPrice = 0;
    peakClose = 0;
  }
}

function buyOrder(state: BarsState, next: Mode): (BuyInput | SellInput)[] {
  mode = next;
  entrySeq = -1;
  sentSeq = state.seq;
  // A fresh entry voids any armed WASH: a flush low from before this
  // trade is stale, and letting it fire later would buy mid-chop on
  // yesterday's bottom instead of on a live bounce.
  armedUntil = -1;
  flushLow = 0;
  const notional = (state.cash * BigInt(Math.round(STAKE * 1000))) / 1000n;
  if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: BUY_SLIP_BPS }];
  }
  mode = null;
  return [];
}

// Entry scan, tried in order: WASH (rare, biggest edge), DIP (the
// workhorse), THRUST (breakouts). Only one fires per batch.
function entryOrders(state: BarsState): (BuyInput | SellInput)[] {
  if (startEquity === null) startEquity = state.equity;
  if (state.equity * 1000n < startEquity * BigInt(Math.round(KILL_FLOOR * 1000))) return [];
  const close = closes[closes.length - 1];
  const seq = state.seq;

  // WASH arming runs every bar, even while another mode cools down.
  if (emaSlow !== null && rsi !== null) {
    const drop = pastReturn(WASH_DROP_BARS);
    if (drop !== null && close < emaSlow * (1 - WASH_GAP) && rsi <= WASH_RSI_MAX && drop < WASH_DROP) {
      if (armedUntil < seq) flushLow = close;
      else if (close < flushLow) flushLow = close;
      armedUntil = seq + WASH_ARM_BARS;
    }
  }
  if (
    seq >= coolWashUntil &&
    armedUntil >= seq &&
    flushLow > 0 &&
    closes.length >= 2 &&
    close >= flushLow * (1 + WASH_BOUNCE) &&
    close > closes[closes.length - 2]
  ) {
    armedUntil = -1;
    flushLow = 0;
    return buyOrder(state, 'WASH');
  }

  if (seq >= coolDipUntil && emaFast !== null && rsi !== null && closes.length > DIP_LOW_BARS) {
    let low = closes[closes.length - 1];
    for (let j = closes.length - DIP_LOW_BARS; j < closes.length; j++) {
      if (closes[j] < low) low = closes[j];
    }
    const bottomed = close <= low * (1 + DIP_NEAR_LOW) && closes.length >= 2 && close > closes[closes.length - 2];
    if (bottomed && close < emaFast * (1 - DIP_GAP) && rsi <= DIP_RSI_MAX) {
      return buyOrder(state, 'DIP');
    }
  }

  if (seq >= coolThrustUntil && emaSlow !== null && close > emaSlow) {
    const thrust = pastReturn(THRUST_BARS);
    if (thrust !== null && thrust > THRUST_GAIN) {
      return buyOrder(state, 'THRUST');
    }
  }
  return [];
}

// Exit scan, consulted only while a position is open. The position is
// sold in full on take-profit, stop-loss, trailing stop under the best
// close since entry, or the mode's maximum hold in bars.
function exitOrders(state: BarsState): (BuyInput | SellInput)[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || mode === null || entrySeq === -1 || entryPrice === 0) return [];
  const close = closes[closes.length - 1];
  if (close > peakClose) peakClose = close;
  const change = close / entryPrice - 1;
  const heldBars = state.seq - entrySeq;
  const tp = mode === 'DIP' ? DIP_TAKE : mode === 'WASH' ? WASH_TAKE : THRUST_TAKE;
  const sl = mode === 'DIP' ? DIP_STOP : mode === 'WASH' ? WASH_STOP : THRUST_STOP;
  const trail = mode === 'DIP' ? DIP_TRAIL : mode === 'WASH' ? WASH_TRAIL : THRUST_TRAIL;
  const maxHold = mode === 'DIP' ? DIP_HOLD : mode === 'WASH' ? WASH_HOLD : THRUST_HOLD;
  const exit = change >= tp || change <= -sl || heldBars >= maxHold || close < peakClose * (1 - trail);
  if (!exit) return [];
  if (mode === 'DIP') coolDipUntil = state.seq + DIP_COOLDOWN;
  else if (mode === 'WASH') coolWashUntil = state.seq + WASH_COOLDOWN;
  else coolThrustUntil = state.seq + THRUST_COOLDOWN;
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIP_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushClose(Number(bar.c));
    }
    noteFills(state, batch);
    if (state.warmingUp) return [];
    if (closes.length < WARMUP) return [];
    if (state.positions.has(SYMBOL)) return exitOrders(state);
    if (mode !== null) {
      // An entry order was sent but never filled: drop it after one bar.
      if (sentSeq !== -1 && state.seq > sentSeq + 1) {
        mode = null;
        sentSeq = -1;
      } else {
        return [];
      }
    }
    return entryOrders(state);
  },
});
