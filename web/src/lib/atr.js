// Wilder's ATR, computed in the browser so trade history can show what
// volatility was doing when a leg opened and when it closed.
//
// This mirrors predict_paper/indicators.py deliberately. Wilder's smoothing is
// not a rolling mean and the two differ by a lot — on the same window the
// simple average read 258 where Wilder read 170 — so a second, looser
// implementation here would quietly disagree with the gate that let the trade
// through in the first place.
//
// The figures are recomputed from the resolution and period currently set in
// the account's filters rather than read back from the row. That means
// changing the filter re-reads history through the new setting, which is the
// point: you are asking what these trades looked like under the rule you are
// considering now.

export const BAR_SECONDS = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900,
  '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400,
}

export function barSeconds(resolution) {
  return BAR_SECONDS[resolution] ?? 900
}

/** True range of `cur` against the previous bar's close. */
function trueRange(cur, prev) {
  const h = Number(cur.high)
  const l = Number(cur.low)
  const pc = Number(prev.close)
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
}

/**
 * Running Wilder ATR, one entry per bar once the seed period has elapsed.
 *
 * Returned as a series so a whole history of trades costs one pass rather than
 * a fresh reduction per timestamp.
 */
export function atrSeries(candles, period = 14) {
  const rows = (candles ?? [])
    .filter((c) => Number.isFinite(c?.high) && Number.isFinite(c?.low)
                   && Number.isFinite(c?.close))
    .slice()
    .sort((a, b) => a.time - b.time)

  const p = Math.max(2, Math.round(period))
  if (rows.length < p + 1) return []

  const tr = []
  for (let i = 1; i < rows.length; i += 1) tr.push(trueRange(rows[i], rows[i - 1]))

  // Seed with the simple mean of the first `p` true ranges, then smooth.
  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0) / p
  const out = [{ time: rows[p].time, atr }]
  for (let i = p; i < tr.length; i += 1) {
    atr = (atr * (p - 1) + tr[i]) / p
    out.push({ time: rows[i + 1].time, atr })
  }
  return out
}

/**
 * ATR as it stood at `tsSec` — the last bar that had closed by then.
 *
 * Binary search, because trade history can run to hundreds of legs against
 * thousands of bars.
 */
export function atrAt(series, tsSec) {
  if (!series?.length || !Number.isFinite(tsSec)) return null
  if (tsSec < series[0].time) return null

  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (series[mid].time <= tsSec) lo = mid
    else hi = mid - 1
  }
  return series[lo].atr
}

/** Hours of history needed to cover `fromMs` plus the ATR seed period. */
export function lookbackHours(fromMs, resolution, period) {
  if (!Number.isFinite(fromMs)) return 24
  const warmup = barSeconds(resolution) * (Math.round(period) + 2) * 1000
  const span = Date.now() - fromMs + warmup
  // A floor so a trade minutes old still gets a seedable window, and a ceiling
  // so one ancient row cannot ask the venue for a year of candles.
  return Math.min(24 * 30, Math.max(6, Math.ceil(span / 3600000)))
}
