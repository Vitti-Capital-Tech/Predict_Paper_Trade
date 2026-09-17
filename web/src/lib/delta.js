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
  const start = end - hours * 3600
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
      // The public tickers expose no traded-volume field for binaries. On a
      // 15-minute contract that listed ~20 minutes ago there is no prior book,
      // so open interest is effectively the volume traded this round.
      oiUsd: num(t.oi_value_usd) ?? 0,
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
