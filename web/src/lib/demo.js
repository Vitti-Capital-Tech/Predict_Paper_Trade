// Synthetic data for `?demo=1`, so the dashboard can be reviewed before a
// Supabase project exists. Numbers are shaped like real Delta Predict rounds:
// cheap wings, occasional 0.50 take-profits, and most legs settling worthless.

const now = Date.now()
const iso = (secsAgo) => new Date(now - secsAgo * 1000).toISOString()

export const demoRun = {
  id: 1,
  run_name: 'demo',
  started_at: iso(7200),
  last_heartbeat: iso(2),
  status: 'running',
  starting_cash: 10000,
  cash: 10041.5,
  config: { atr: { min_atr: 200 } },
}

// Eight rounds: wings entered ~0.13-0.16, a few reaching the 0.50 exit.
const ROUNDS = [
  { id: '1609261500', low: 0.152, high: 0.141, lowExit: 0.5,  highExit: 0,    tp: 'low'  },
  { id: '1609261515', low: 0.139, high: 0.160, lowExit: 0,    highExit: 0,    tp: null   },
  { id: '1609261530', low: 0.147, high: 0.133, lowExit: 0,    highExit: 0.5,  tp: 'high' },
  { id: '1609261545', low: 0.158, high: 0.149, lowExit: 0,    highExit: 0,    tp: null   },
  { id: '1609261600', low: 0.131, high: 0.144, lowExit: 0.5,  highExit: 0,    tp: 'low'  },
  { id: '1609261615', low: 0.165, high: 0.157, lowExit: 0,    highExit: 0,    tp: null   },
  { id: '1609261630', low: 0.142, high: 0.136, lowExit: 0,    highExit: 1.0,  tp: null   },
  { id: '1609261645', low: 0.154, high: 0.148, lowExit: 0,    highExit: 0,    tp: null   },
]

export const demoPositions = ROUNDS.flatMap((r, i) => {
  const base = 6600 - i * 700
  const strikeMid = 75500 + i * 100
  const mk = (role, side, strike, entry, exit, slip, reason) => ({
    id: `${r.id}-${role}`,
    position_id: `B-${side === 'put' ? 'P' : 'C'}-BTC-${strike}-${r.id}#${i}`,
    round_id: `BTC-${r.id}`,
    symbol: `B-${side === 'put' ? 'P' : 'C'}-BTC-${strike}-${r.id}`,
    role, side, strike, qty: 100,
    entry_price: entry,
    entry_time: iso(base),
    entry_top_price: entry - slip,
    entry_slippage: slip,
    entry_levels: slip > 0.004 ? 3 : 1,
    entry_spot: strikeMid + 40,
    entry_atr: 240 + i * 6,
    status: 'settled',
    exit_price: exit,
    exit_time: iso(base - 620),
    exit_reason: reason,
    exit_slippage: 0,
    fees: 0,
  })
  return [
    mk('wing_low', 'put', strikeMid - 100, r.low, r.lowExit, 0.006,
      r.tp === 'low' ? 'take profit: bid 0.5020 >= 0.50' : 'settled OTM'),
    mk('wing_high', 'call', strikeMid + 100, r.high, r.highExit, 0.005,
      r.tp === 'high' ? 'take profit: bid 0.5010 >= 0.50'
        : r.highExit >= 0.5 ? 'settled ITM' : 'settled OTM'),
  ]
})

// One live round still open.
demoPositions.unshift(
  {
    id: 'open-1', position_id: 'B-P-BTC-76100-1609261700#9',
    round_id: 'BTC-1609261700', symbol: 'B-P-BTC-76100-1609261700',
    role: 'wing_low', side: 'put', strike: 76100, qty: 100,
    entry_price: 0.148, entry_time: iso(240), entry_top_price: 0.143,
    entry_slippage: 0.005, entry_levels: 2, entry_spot: 76210, entry_atr: 263,
    status: 'open', exit_price: null, exit_time: null, exit_reason: null,
    exit_slippage: 0, fees: 0,
  },
  {
    id: 'open-2', position_id: 'B-C-BTC-76300-1609261700#10',
    round_id: 'BTC-1609261700', symbol: 'B-C-BTC-76300-1609261700',
    role: 'wing_high', side: 'call', strike: 76300, qty: 100,
    entry_price: 0.139, entry_time: iso(240), entry_top_price: 0.135,
    entry_slippage: 0.004, entry_levels: 2, entry_spot: 76210, entry_atr: 263,
    status: 'open', exit_price: null, exit_time: null, exit_reason: null,
    exit_slippage: 0, fees: 0,
  },
)

const leg = (side, strike, ask, bid, max) => ({
  symbol: `B-${side === 'put' ? 'P' : 'C'}-BTC-${strike}-x`,
  side, strike, bid, ask, mark: (bid + ask) / 2,
  bid_size: 30, ask_size: 30, max_price: max, qualifies: ask <= max,
})

export const demoSnapshot = {
  id: 1, run_id: 1, ts: iso(1), spot: 76210, atr: 263.4, atr_pass: true,
  rounds: [
    {
      round_id: 'BTC-1609261700', expiry: new Date(now + 517000).toISOString(),
      seconds_to_expiry: 517, seconds_since_launch: 683,
      strikes: [76100, 76200, 76300], spot: 76210, would_enter: false,
      reasons: ['already positioned in this round'],
      wing_low: leg('put', 76100, 0.152, 0.121, 0.1667),
      wing_high: leg('call', 76300, 0.147, 0.118, 0.1667),
      middle_call: leg('call', 76200, 0.523, 0.489, 0.25),
      middle_put: leg('put', 76200, 0.498, 0.462, 0.25),
    },
    {
      round_id: 'BTC-1609261715', expiry: new Date(now + 1417000).toISOString(),
      seconds_to_expiry: 1417, seconds_since_launch: 22,
      strikes: [76200, 76300, 76400], spot: 76210, would_enter: false,
      reasons: ['timing: round too young (22s < 30s)'],
      wing_low: leg('put', 76200, 0.214, 0.166, 0.1667),
      wing_high: leg('call', 76400, 0.158, 0.129, 0.1667),
      middle_call: leg('call', 76300, 0.441, 0.401, 0.25),
      middle_put: leg('put', 76300, 0.573, 0.538, 0.25),
    },
  ],
}

export const demoEvents = [
  { id: 9, run_id: 1, ts: iso(4), kind: 'skip', round_id: 'BTC-1609261715',
    reason: 'timing: round too young (22s < 30s)', payload: {} },
  { id: 8, run_id: 1, ts: iso(238), kind: 'entry', round_id: 'BTC-1609261700',
    symbol: 'B-C-BTC-76300-1609261700', reason: null,
    payload: { qty: 100, price: 0.139, slippage: 0.004 } },
  { id: 7, run_id: 1, ts: iso(240), kind: 'entry', round_id: 'BTC-1609261700',
    symbol: 'B-P-BTC-76100-1609261700', reason: null,
    payload: { qty: 100, price: 0.148, slippage: 0.005 } },
  { id: 6, run_id: 1, ts: iso(620), kind: 'settlement', round_id: 'BTC-1609261645',
    symbol: 'B-C-BTC-76000-1609261645', reason: 'settled OTM',
    payload: { pnl: -14.8 } },
  { id: 5, run_id: 1, ts: iso(1180), kind: 'exit', round_id: 'BTC-1609261630',
    symbol: 'B-C-BTC-75900-1609261630', reason: 'take profit: bid 0.5010 >= 0.50',
    payload: { pnl: 36.4 } },
  { id: 4, run_id: 1, ts: iso(1900), kind: 'skip', round_id: 'BTC-1609261615',
    reason: 'wings: wing_low ask 0.2140 above max 0.1667 (odds worse than required)',
    payload: {} },
  { id: 3, run_id: 1, ts: iso(2600), kind: 'skip', round_id: 'BTC-1609261600',
    reason: 'ATR gate: 182.4 <= 200', payload: {} },
  { id: 2, run_id: 1, ts: iso(3400), kind: 'exit_blocked', round_id: 'BTC-1609261545',
    symbol: 'B-P-BTC-75400-1609261545',
    reason: 'insufficient depth (62/100 available)', payload: {} },
  { id: 1, run_id: 1, ts: iso(4200), kind: 'exit', round_id: 'BTC-1609261530',
    symbol: 'B-C-BTC-75700-1609261530', reason: 'take profit: bid 0.5020 >= 0.50',
    payload: { pnl: 36.7 } },
]

export const demoRuns = [demoRun]
