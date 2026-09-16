// Mirrors predict_paper/report.py so the dashboard and the CLI never disagree.

export function pnlOf(p) {
  if (p.exit_price === null || p.exit_price === undefined) return 0
  return (Number(p.exit_price) - Number(p.entry_price)) * Number(p.qty) - Number(p.fees || 0)
}

export function summarise(positions, startingCash = 0) {
  const done = positions.filter((p) => p.exit_price !== null && p.exit_price !== undefined)
  const open = positions.filter((p) => p.status === 'open')

  const base = {
    trades: done.length,
    openCount: open.length,
    totalPnl: 0,
    totalCost: 0,
    returnOnCost: 0,
    legWinRate: 0,
    rounds: 0,
    roundWinRate: 0,
    avgPerRound: 0,
    slippageCost: 0,
    maxDrawdown: 0,
    equityCurve: [],
    byRole: [],
    startingCash,
    endingCash: startingCash,
    returnPct: 0,
  }
  if (!done.length) return base

  const pnls = done.map(pnlOf)
  const totalPnl = pnls.reduce((a, b) => a + b, 0)
  const totalCost = done.reduce((a, p) => a + Number(p.entry_price) * Number(p.qty), 0)
  const slippageCost = done.reduce(
    (a, p) => a + Number(p.entry_slippage || 0) * Number(p.qty), 0)

  // Round-level results: on a strangle the individual legs lose by design, so
  // the per-round number is the one that actually reflects the strategy.
  const byRound = new Map()
  done.forEach((p, i) => {
    byRound.set(p.round_id, (byRound.get(p.round_id) || 0) + pnls[i])
  })
  const roundPnls = [...byRound.values()]
  const roundWins = roundPnls.filter((v) => v > 0).length

  // Equity curve ordered by when each round finished.
  const roundOrder = new Map()
  done.forEach((p) => {
    const t = new Date(p.exit_time || p.entry_time).getTime()
    roundOrder.set(p.round_id, Math.max(roundOrder.get(p.round_id) || 0, t))
  })
  const ordered = [...byRound.entries()].sort(
    (a, b) => (roundOrder.get(a[0]) || 0) - (roundOrder.get(b[0]) || 0))

  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  const equityCurve = ordered.map(([roundId, v]) => {
    equity += v
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity - peak)
    return { roundId, pnl: v, equity }
  })

  const roles = [...new Set(done.map((p) => p.role))].sort()
  const byRole = roles.map((role) => {
    const rows = done.filter((p) => p.role === role)
    const rp = rows.map(pnlOf)
    return {
      role,
      trades: rows.length,
      pnl: rp.reduce((a, b) => a + b, 0),
      winRate: (100 * rp.filter((v) => v > 0).length) / rows.length,
      avgEntry: rows.reduce((a, p) => a + Number(p.entry_price), 0) / rows.length,
    }
  })

  return {
    ...base,
    totalPnl,
    totalCost,
    returnOnCost: totalCost ? (100 * totalPnl) / totalCost : 0,
    legWinRate: (100 * pnls.filter((v) => v > 0).length) / pnls.length,
    rounds: roundPnls.length,
    roundWinRate: roundPnls.length ? (100 * roundWins) / roundPnls.length : 0,
    avgPerRound: roundPnls.length ? totalPnl / roundPnls.length : 0,
    slippageCost,
    maxDrawdown,
    equityCurve,
    byRole,
    endingCash: startingCash + totalPnl,
    returnPct: startingCash ? (100 * totalPnl) / startingCash : 0,
  }
}

export const fmt = {
  usd: (v, digits = 2) =>
    `${v < 0 ? '-' : ''}$${Math.abs(Number(v) || 0).toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits })}`,
  signed: (v, digits = 2) =>
    `${Number(v) >= 0 ? '+' : '-'}${Math.abs(Number(v) || 0).toFixed(digits)}`,
  pct: (v, digits = 1) => `${Number(v ?? 0).toFixed(digits)}%`,
  price: (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(4)),
  int: (v) => Number(v ?? 0).toLocaleString('en-US'),
  clock: (secs) => {
    if (secs === null || secs === undefined) return '—'
    const s = Math.max(0, Math.round(secs))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  },
  time: (iso) =>
    iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false }) : '—',
}
