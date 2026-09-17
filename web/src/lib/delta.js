// Browser-side Delta client.
//
// Delta's public API sends permissive CORS headers, so the trade panel can pull
// live quotes and candles directly rather than waiting on the worker's snapshot
// cadence. Orders still go through Supabase to the worker, because a fill
// invented in the browser would bypass the order-book slippage model.

const BASE = 'https://api.delta.exchange'
const BINARY_TYPES = 'binary_call_options,binary_put_options'

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`Delta ${path} → ${res.status}`)
  const body = await res.json()
  if (!body.success) throw new Error(`Delta ${path} → success=false`)
  return body.result
}

export function fetchBinaryTickers() {
  return get('/v2/tickers', { contract_types: BINARY_TYPES })
}

/**
 * Underlying ticker — carries spot and the 24h change the panel header shows.
 * The binary tickers expose `spot_price` but not the underlying's 24h move.
 */
export async function fetchSpotTicker(symbol = 'BTCUSDT') {
  const t = await get(`/v2/tickers/${symbol}`)
  if (!t) return null
  return {
    symbol: t.symbol,
    spot: Number(t.spot_price ?? t.close),
    last: Number(t.close),
    changePct: Number(t.mark_change_24h ?? t.ltp_change_24h ?? 0),
    high24h: Number(t.high),
    low24h: Number(t.low),
    turnover: Number(t.turnover ?? 0),
  }
}

export async function fetchCandles(symbol = 'BTCUSDT', resolution = '15m', hours = 6) {
  const end = Math.floor(Date.now() / 1000)
  const start = Math.floor(end - hours * 3600)
  const rows = await get('/v2/history/candles', { symbol, resolution, start, end })
  return (rows ?? []).slice().sort((a, b) => a.time - b.time)
}

// ---------------------------------------------------------------- rounds ----

const SYMBOL_RE = /^B-([CP])-([A-Z0-9]+)-([0-9.]+)-(\d{10})$/

export function parseSymbol(symbol) {
  const m = SYMBOL_RE.exec(symbol ?? '')
  if (!m) return null
  return {
    symbol,
    side: m[1] === 'C' ? 'call' : 'put',
    asset: m[2],
    strike: Number(m[3]),
    expiryCode: m[4],
  }
}

/** DDMMYYHHMM → Date (UTC). */
export function expiryCodeToDate(code) {
  if (!/^\d{10}$/.test(code)) return null
  const dd = +code.slice(0, 2)
  const mm = +code.slice(2, 4)
  const yy = +code.slice(4, 6)
  const hh = +code.slice(6, 8)
  const mi = +code.slice(8, 10)
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, 0))
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

/**
 * Group tickers into rounds. Mirrors predict_paper/rounds.py so the panel and
 * the worker classify strikes identically.
 */
export function buildRounds(tickers, asset = 'BTC') {
  const byExpiry = new Map()

  for (const t of tickers ?? []) {
    const p = parseSymbol(t.symbol)
    if (!p || p.asset !== asset) continue

    const q = t.quotes ?? {}
    const leg = {
      ...p,
      bid: num(q.best_bid),
      ask: num(q.best_ask),
      bidSize: num(q.bid_size),
      askSize: num(q.ask_size),
      mark: num(t.mark_price),
      spot: num(t.spot_price),
      // Delta's "Vol" is contracts x $1 (each contract's max payout), which is
      // `oi_contracts` / `oi_value` — NOT `oi_value_usd`, which is contracts
      // times the underlying's price and is ~76,000x larger for BTC.
      volUsd: num(t.oi_value) ?? num(t.oi_contracts) ?? 0,
      oiContracts: num(t.oi_contracts) ?? 0,
    }

    if (!byExpiry.has(p.expiryCode)) {
      byExpiry.set(p.expiryCode, {
        roundId: `${asset}-${p.expiryCode}`,
        expiryCode: p.expiryCode,
        expiry: expiryCodeToDate(p.expiryCode),
        legs: [],
      })
    }
    byExpiry.get(p.expiryCode).legs.push(leg)
  }

  return [...byExpiry.values()]
    .map((r) => ({
      ...r,
      strikes: [...new Set(r.legs.map((l) => l.strike))].sort((a, b) => a - b),
      spot: r.legs.find((l) => l.spot !== null)?.spot ?? null,
    }))
    .sort((a, b) => a.expiry - b.expiry)
}

/**
 * Which underlyings actually have live Predict markets right now.
 * Delta lists BTC and ETH today; reading it from the feed means a third
 * asset appears on its own rather than needing a code change.
 */
export function availableAssets(tickers) {
  const seen = new Set()
  for (const t of tickers ?? []) {
    const p = parseSymbol(t.symbol)
    if (p) seen.add(p.asset)
  }
  return [...seen].sort()
}

/** Ticker symbol for the header quote (24h high/low and change). */
export function spotSymbolFor(asset) {
  return `${asset}USDT`
}

/**
 * Candle series for the chart: Delta's own spot index.
 *
 * The perpetual series (BTCUSDT) is the obvious choice and the wrong one — it
 * barely trades at short resolutions, so 51 of 60 five-minute bars come back
 * flat with zero volume and the chart draws a staircase. The index updates
 * continuously and is what these markets settle against.
 */
export function indexSymbolFor(asset) {
  return { BTC: '.DEXBTUSDT', ETH: '.DEETHUSDT' }[asset] ?? `.DE${asset}USDT`
}

/**
 * The timeframes Delta's panel offers, in its order.
 *
 * These are chart *windows*, not bar sizes: its "30m" view spans about half an
 * hour drawn from roughly one-minute bars, not thirty-minute candles. Each
 * window therefore picks the finest resolution that still fills it.
 */
export const RESOLUTIONS = ['5m', '15m', '30m', '1h', '4h', '1d']

const WINDOW_MINUTES = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 }

/**
 * Bar size for a window — the finest that keeps the request sane, so the plot
 * is as dense as the venue allows.
 *
 * The API floor is one minute, so a 5m or 15m window can only ever hold 5 or
 * 15 bars. Delta's own app draws those windows from tick data it has and the
 * public API does not, which is why its short views look denser than this one.
 * Longer windows match it.
 */
export function barResolutionFor(window) {
  return { '5m': '1m', '15m': '1m', '30m': '1m',
           '1h': '1m', '4h': '3m', '1d': '15m' }[window] ?? '1m'
}

/** Roughly how many bars a window yields, for sizing decisions. */
export function barCountFor(window) {
  const mins = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 }[window] ?? 30
  const bar = { '1m': 1, '3m': 3, '15m': 15 }[barResolutionFor(window)] ?? 1
  return Math.round(mins / bar)
}

/** Hours of history to request for a window. */
export function lookbackHoursFor(window) {
  const minutes = WINDOW_MINUTES[window] ?? 30
  return Math.max(0.25, minutes / 60)
}

export function legFor(round, strike, side) {
  return round?.legs.find((l) => l.strike === strike && l.side === side) ?? null
}

/**
 * Delta's panel sizes by dollars, not contracts:
 *   contracts = round(investment / price), each paying 1.00 if correct.
 * Verified against the app: $25 at 0.036 → 694 contracts, $24.98 in, $694 out.
 */
export function sizeOrder(investment, price) {
  if (!price || price <= 0 || !investment || investment <= 0) {
    return { contracts: 0, invested: 0, payout: 0 }
  }
  const contracts = Math.round(investment / price)
  return {
    contracts,
    invested: contracts * price,
    payout: contracts * 1.0,
  }
}
