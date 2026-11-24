[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dwi085/makefun-pump-fun-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dwi085/makefun-pump-fun-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sniper

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a replay of 24 hours of recorded pump.fun bonding-curve activity, scored by net PnL. No real money, no leverage, no shorts.

## Strategy

Concentrated early-momentum sniper with tight risk control:

- **Enter** only young coins (≤ 300 slots after creation) whose **first 3 trades** prove unusually strong buying: all buys, at least **12 SOL** of buy volume. Enter as soon as that signal is known — the pump peaks fast and fades fast. Never chase a coin already +40% over its first trade. A buy rejected on slippage (or a failed transaction) may be retried while the coin is still young.
- **One small ticket per coin**: min(0.05 SOL, the harness's 1%-of-real-reserve buy cap, free cash). At most 5 open positions (the harness cap).
- **Exit** every position the same way: take profit **+50%** (only the fat tail of big pumps pays after the 2-slot fill latency), stop loss **−5%** (cut the bleed fast), or a **200-slot (~80 s) time stop**, whichever comes first. No re-entry after an exit.
- **Deterministic**: decisions come only from the replay stream — no clock, no randomness, no environment reads, no network, no files outside the repo.

The filter is deliberately strict. On the kit's dev window the per-trade expectation is slightly negative (mostly the 2.5% round-trip curve fee), so fewer, stronger trades lose less while keeping the fat-tail upside: 37 qualifying coins on the dev window, comfortably above the 20-coin guardrail, max drawdown 2.41%.

## Local backtest (my own simulation — NOT the house replay)

Simulated over the kit's dev dataset (24h, 1,222 mints, 126,801 trades) with a local replay harness that models 2-slot fill latency, constant-product pricing, 125 bps curve fees, 105,000 lamports tx fee per order, and 2% failed transactions:

- Starting balance: **10.000 SOL**
- Final balance: **9.763 SOL**
- Net PnL: **−0.237 SOL**
- Trades: **37 closed round trips** (all ≥ 0.01 SOL, 37 distinct mints)
- Win rate: **18.9%** (7 winning trades)
- Max drawdown: **2.41%**
- Two runs over the same input produced byte-identical trade logs (sha256 `7a4c283c2585eb88843a72388dccc7032dd9583437fa0bc7d6067f69e08da9ce`).

The house replay runs on 24h of fresh recorded data after entries close, so its result will differ. The dev-window loss is honest: this market bleeds slowly for buyers and the curve fee eats small edges. The bot is kept small and capped so a few big pumps in the fresh final window can flip it positive.

## Layout

- `main.ts` — the entrypoint (Node 22, runs as `node /bot/main.ts`); speaks `agent-fun/replay/v2` on stdin/stdout.
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-identical from the competition kit (it owns the wire protocol).
- `.makefun/owner.json` — the payout wallet claim file.
