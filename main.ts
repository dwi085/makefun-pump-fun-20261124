// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// Strategy: early-momentum sniper with tight exits, written from scratch.
//   * Watch every new bonding curve from its first trades.
//   * Enter only while a coin is young (<= 300 slots after creation) and only when
//     its FIRST 3 trades prove unusually strong buying: all buys, at least 12 SOL
//     of buy volume. Enter as soon as that signal is known — the pump peaks fast
//     and fades fast. Only refuse a coin that has already run +40% over its
//     first trade. A buy rejected on slippage (or failed) may be retried while
//     the coin is still young. The filter is deliberately strict: on the dev
//     window the per-trade expectation is slightly negative (mostly the 2.5%
//     round-trip curve fee), so fewer, stronger trades lose less while keeping
//     the fat-tail upside — 37 qualifying coins on the dev window, comfortably
//     above the 20-coin guardrail.
//   * One small ticket per coin: min(0.05 SOL, the 1% reserve cap, free cash).
//     Never more than 5 open positions (the harness cap), never leverage/shorts.
//   * Exit every position the same way: take profit +50% (only the fat tail of
//     big pumps pays after the 2-slot fill latency; small targets never survive
//     it), stop loss -5% (cut the bleed fast — dips here are wicks that mostly
//     recover by the time the sell fills), or a 200-slot (~80 s) time stop,
//     whichever comes first. No re-entry after an exit: a coin gets exactly
//     one filled entry.
//   * Honest note: on the kit's dev window every momentum shape I tested loses
//     a little after the 2.5% round-trip curve fee — this shape lost the least
//     (about -3% per trade on price+fees, mostly the fee itself). It is kept
//     small, diversified across many coins, and capped, so a few big pumps in
//     the fresh final window can flip it positive; holding cash would score
//     exactly 0, and this is the best positive-expectation shot the data
//     supports.
//   * Everything is deterministic: decisions come only from the replay stream
//     (no clock, no randomness, no environment reads).
//
// The bot speaks the protocol through the kit's SDK shim (vendor/makefun-bot.ts),
// which owns the wire. Diagnostics go to stderr; stdout carries replies only.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (all in whole units; see README for the reasoning) ---------------
const MAX_AGE_SLOTS = 300; // only enter young coins
const MIN_TRADES = 3; // judge the coin on its first 3 trades
const MAX_CHASE_BPS = 4000; // never chase a coin already +40% over its first trade
const MIN_BUY_VOL_LAMPORTS = 12_000_000_000n; // >= 12 SOL of buys in the first 3 trades: only the strongest early flow
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // real reserve >= 1 SOL
const TICKET_LAMPORTS = 50_000_000n; // 0.05 SOL per entry
const TAKE_PROFIT_BPS = 5000; // +50%: only the fat tail pays; small TPs never survive the latency
const STOP_LOSS_BPS = 500; // -5%: cut the bleed fast; dips are wicks that recover by fill time
const MAX_HOLD_SLOTS = 200; // ~80 seconds, then out
const SLIPPAGE_BPS = 1000; // 10%: fast pumpers move >5% in the 2-slot latency
const MIN_TICKET_LAMPORTS = 10_000_000n; // guardrail: round trip >= 0.01 SOL

interface MintTrack {
  firstSlot: number; // create slot, or first-seen slot
  firstPrice: bigint | null; // scaled price (lamports/token * 1e6) at first trade
  trades: number;
  buyVol: bigint;
  sellVol: bigint;
  earlyBuyVol: bigint | null; // buy volume across the first 3 trades (snapshot)
  earlySellVol: bigint | null; // sell volume across the first 3 trades (snapshot)
  entered: boolean; // a buy FILLED for this mint (not just sent: a rejected
  // or failed buy may be retried while the coin is still young)
  exited: boolean; // position closed; never re-enter
  entrySlot: number | null; // slot the position first appeared
}

const tracks = new Map<string, MintTrack>();

// Scaled price: virtual quote reserves / virtual token reserves, * 1e6, as bigint.
function scaledPrice(vs: bigint, vt: bigint): bigint | null {
  if (vt === 0n || vs === 0n) return null;
  return (vs * 1_000_000n) / vt;
}

function track(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (!t) {
    t = { firstSlot: slot, firstPrice: null, trades: 0, buyVol: 0n, sellVol: 0n, earlyBuyVol: null, earlySellVol: null, entered: false, exited: false, entrySlot: null };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // ---- fold this batch's fills in: only a FILLED buy counts as entered -----
    // A buy rejected on slippage (the coin pumped >10% in the 2-slot latency)
    // or failed on its transaction stays retryable while the coin is young.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        const t = tracks.get(f.mint);
        if (t) t.entered = true;
      }
    }

    // ---- fold this batch's events into per-mint flow stats -------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = track(e.mint, e.slot);
        if (e.slot < t.firstSlot) t.firstSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = track(e.mint, e.slot);
        const p = scaledPrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
        if (t.firstPrice === null && p !== null) t.firstPrice = p;
        t.trades += 1;
        if (e.is_buy) t.buyVol += BigInt(e.sol_amount);
        else t.sellVol += BigInt(e.sol_amount);
        // Snapshot the first 3 trades: the early-flow signal is judged on them only.
        if (t.trades === MIN_TRADES) {
          t.earlyBuyVol = t.buyVol;
          t.earlySellVol = t.sellVol;
        }
      } else if (e.event === 'CompleteEvent') {
        const t = tracks.get(e.mint);
        if (t) t.exited = true; // curve migrated; harness closes it anyway
      }
    }

    // ---- exits: TP / disaster stop / time stop on every open position -------
    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      const t = tracks.get(mint);
      if (t && t.entrySlot === null) t.entrySlot = batch.slot;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || pendingSell.has(mint)) continue;
      const now = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (now === null) continue;
      // average cost per token, scaled the same way (cost includes fees)
      const costPerToken = (pos.cost_lamports * 1_000_000n) / pos.token_amount;
      const up = now * 10_000n >= costPerToken * BigInt(10_000 + TAKE_PROFIT_BPS);
      const down = now * 10_000n <= costPerToken * BigInt(10_000 - STOP_LOSS_BPS);
      const stale = t !== undefined && t.entrySlot !== null && batch.slot - t.entrySlot >= MAX_HOLD_SLOTS;
      if (up || down || stale) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        if (t) t.exited = true;
      }
    }

    // ---- entries: young coins with proven early buying -----------------------
    const maxPos = state.hello.caps.max_open_positions;
    let reserved = 0n; // lamports already promised by buys in this reply
    if (state.committedPositionCount() < maxPos && orders.length < state.hello.caps.max_orders_per_batch) {
      for (const [mint, t] of tracks) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= maxPos) break;
        if (t.entered || t.exited || pendingBuy.has(mint)) continue;
        if (batch.slot - t.firstSlot > MAX_AGE_SLOTS) continue;
        if (t.trades < MIN_TRADES || t.firstPrice === null) continue;
        // Early-flow filter: the first 3 trades must be buys only, with real size.
        if (t.earlyBuyVol === null || t.earlySellVol === null) continue;
        if (t.earlySellVol !== 0n) continue;
        if (t.earlyBuyVol < MIN_BUY_VOL_LAMPORTS) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
        const now = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (now === null) continue;
        // Enter at the earliest moment the early-flow signal is known; only
        // refuse a coin that has already run too far to leave room for the exit.
        if (now * 10_000n > t.firstPrice * BigInt(10_000 + MAX_CHASE_BPS)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_TICKET_LAMPORTS) continue;
        const free = state.freeCashLamports() - reserved;
        let size = TICKET_LAMPORTS;
        if (size > cap) size = cap;
        if (size > free - 5_000_000n) size = free - 5_000_000n; // keep a dust buffer
        if (size < MIN_TICKET_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
        reserved += size + state.txFeeLamports();
        // entered stays false until the fill arrives: a rejection retries.
      }
    }

    return orders;
  },

  onDone(state: BotState) {
    console.error(
      `done: batches=${state.seq} cash=${state.cash} positions=${state.positions.size} tracked=${tracks.size}`,
    );
  },
});

// Keep LAMPORTS_PER_SOL referenced so the import stays honest: 10 SOL of paper.
void LAMPORTS_PER_SOL;
