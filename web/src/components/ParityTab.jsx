import { useEffect, useMemo, useState } from 'react'
import { fetchStrategyConfig, fetchTradeHistory } from '../lib/supabase'
import { fmt } from '../lib/stats'

/**
 * Paper vs Live: does a paper account behave like the live one it mirrors?
 *
 * Asked for so the team can trust paper results as a stand-in for live. Four
 * answers, each from data already stored:
 *
 *   - are the settings actually the same (otherwise nothing below means much)
 *   - side-by-side results, in % since the two trade different sizes
 *   - round by round: did both make the same decision
 *   - two headline numbers: how often they agreed, and how far apart the
 *     prices were on the contracts both bought - the test of whether paper's
 *     simulated fills are kinder than the exchange
 *
 * Only the overlap counts: rounds from when both accounts had started trading.
 * Before that one side simply did not exist, which is not disagreement.
 */

// Settings that are allowed to differ, or mean different things per side.
const NOT_COMPARED = new Set(['id', 'account_id', 'updated_at', 'enabled',
  'live_enabled', 'investment_per_leg'])

const LABELS = {
  underlying: 'Asset', atr_min: 'Min ATR', atr_period: 'ATR period',
  atr_resolution: 'ATR timeframe', wing_odds: 'Wing odds', middle_odds: 'Middle odds',
  outside_odds: 'Outside odds', trade_outside_range: 'Outside-range trading',
  trade_middle: 'Trade middle', extremes_mode: 'Wing mode', exit_points: 'Exit points',
  exit_mode: 'Exit rule', max_slippage: 'Slippage / limit offset',
  sessions: 'Session hours', partial_entry: 'Partial entry',
  middle_needs_both_wings: 'Middle needs both wings',
  max_seconds_to_expiry: 'Max time to expiry', min_seconds_to_expiry: 'Min time to expiry',
}
const label = (k) => LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const show = (v) => (v === null || v === undefined ? '—'
  : typeof v === 'boolean' ? (v ? 'ON' : 'OFF')
    : typeof v === 'object' ? JSON.stringify(v) : String(v))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const IST = 'Asia/Kolkata'
const roundTime = (rid) => {
  const c = String(rid).split('-').pop()
  if (!/^\d{10}$/.test(c)) return null
  const [d, m, y, hh, mm] = [0, 2, 4, 6, 8].map((i) => Number(c.slice(i, i + 2)))
  return new Date(Date.UTC(2000 + y, m - 1, d, hh, mm))
}
const when = (d) => (d ? d.toLocaleString('en-US', { timeZone: IST, day: 'numeric',
  month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—')
const legText = (p) => `${p.side === 'call' ? 'Y' : 'N'} ${Number(p.strike).toLocaleString('en-US')}`

function summarise(legs) {
  const byRound = new Map()
  let invested = 0
  let pnl = 0
  for (const p of legs) {
    const v = Number(p.pnl ?? 0)
    byRound.set(p.round_id, (byRound.get(p.round_id) ?? 0) + v)
    invested += Number(p.entry_price) * Number(p.qty)
    pnl += v
  }
  const rounds = byRound.size
  const wins = [...byRound.values()].filter((v) => v > 0).length
  return { rounds, winRate: rounds ? (100 * wins) / rounds : 0, pnl, invested,
           ret: invested ? (100 * pnl) / invested : 0 }
}

const STATUS = {
  same: { text: '✓ Same', cls: 'bg-emerald-500/15 text-emerald-300' },
  diff: { text: '≠ Different legs', cls: 'bg-amber-500/15 text-amber-300' },
  paper: { text: '⚠ Only paper', cls: 'bg-sky-500/15 text-sky-300' },
  live: { text: '⚠ Only live', cls: 'bg-rose-500/15 text-rose-300' },
}

export default function ParityTab({ accounts, refreshKey = 0 }) {
  const live = useMemo(() => accounts.filter((a) => a.mode === 'live'), [accounts])
  const paper = useMemo(() => accounts.filter((a) => a.mode !== 'live'), [accounts])
  const [liveId, setLiveId] = useState(null)
  const [paperId, setPaperId] = useState(null)
  const [cfg, setCfg] = useState({})            // account id -> strategy_config
  const [legs, setLegs] = useState(null)        // { live: [], paper: [] }
  const [error, setError] = useState(null)
  const [limit, setLimit] = useState(50)

  // Every config once, so the default pair can be the closest settings match.
  useEffect(() => {
    let alive = true
    Promise.all(accounts.map((a) => fetchStrategyConfig(a.id).then((c) => [a.id, c])))
      .then((rows) => { if (alive) setCfg(Object.fromEntries(rows)) })
      .catch((e) => { if (alive) setError(`${e?.message ?? e}`) })
    return () => { alive = false }
  }, [accounts])

  const diffsOf = (a, b) => {
    const ca = cfg[a]
    const cb = cfg[b]
    if (!ca || !cb) return null
    return Object.keys(ca).filter((k) => !NOT_COMPARED.has(k) && !same(ca[k], cb[k]))
  }

  // Default: the first live account, and the paper account with the fewest
  // differing settings - the twin, where there is one.
  useEffect(() => {
    if (!liveId && live.length) setLiveId(live[0].id)
  }, [live, liveId])
  useEffect(() => {
    if (paperId || !liveId || !paper.length || !Object.keys(cfg).length) return
    const ranked = paper
      .map((p) => ({ id: p.id, n: diffsOf(liveId, p.id)?.length ?? 99 }))
      .sort((a, b) => a.n - b.n)
    setPaperId(ranked[0]?.id ?? paper[0].id)
  }, [liveId, paper, cfg, paperId])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!liveId || !paperId) return
    let alive = true
    setLegs(null)
    Promise.all([fetchTradeHistory(liveId), fetchTradeHistory(paperId)])
      .then(([l, p]) => { if (alive) { setLegs({ live: l, paper: p }); setError(null) } })
      .catch((e) => { if (alive) setError(`${e?.message ?? e}`) })
    return () => { alive = false }
  }, [liveId, paperId, refreshKey])

  const diffs = liveId && paperId ? diffsOf(liveId, paperId) : null
  const liveAcct = accounts.find((a) => a.id === liveId)
  const paperAcct = accounts.find((a) => a.id === paperId)

  const view = useMemo(() => {
    if (!legs) return null
    const first = (rows) => rows.reduce((m, p) => {
      const t = new Date(p.entry_time).getTime()
      return Number.isFinite(t) && t < m ? t : m
    }, Infinity)
    const since = Math.max(first(legs.live), first(legs.paper))
    if (!Number.isFinite(since)) return { since: null, rounds: [], live: summarise([]), paper: summarise([]) }
    const inWindow = (p) => new Date(p.entry_time).getTime() >= since
    const L = legs.live.filter(inWindow)
    const P = legs.paper.filter(inWindow)

    const byRound = new Map()
    const add = (side) => (p) => {
      const r = byRound.get(p.round_id) ?? { roundId: p.round_id, live: [], paper: [] }
      r[side].push(p)
      byRound.set(p.round_id, r)
    }
    L.forEach(add('live'))
    P.forEach(add('paper'))

    const gaps = []
    const rounds = [...byRound.values()].map((r) => {
      const ls = new Set(r.live.map((p) => p.symbol))
      const ps = new Set(r.paper.map((p) => p.symbol))
      for (const p of r.paper) {
        const l = r.live.find((x) => x.symbol === p.symbol)
        if (l) gaps.push(Number(p.entry_price) - Number(l.entry_price))
      }
      const status = !ls.size ? 'paper' : !ps.size ? 'live'
        : (ls.size === ps.size && [...ls].every((s) => ps.has(s))) ? 'same' : 'diff'
      const pnlOf = (rows) => rows.reduce((a, p) => a + Number(p.pnl ?? 0), 0)
      return { ...r, status, time: roundTime(r.roundId),
               livePnl: pnlOf(r.live), paperPnl: pnlOf(r.paper) }
    }).sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0))

    const agreed = rounds.filter((r) => r.status === 'same').length
    return {
      since: new Date(since),
      rounds,
      live: summarise(L),
      paper: summarise(P),
      matchPct: rounds.length ? (100 * agreed) / rounds.length : null,
      gap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
      gapCount: gaps.length,
    }
  }, [legs])

  const select = 'rounded-lg border border-white/10 bg-ink-950 px-2.5 py-1.5 text-xs text-slate-200'

  if (!live.length || !paper.length) {
    return <p className="py-10 text-center text-sm text-slate-600">
      Needs at least one live and one paper account.</p>
  }

  return (
    <div className="space-y-4">
      {/* Pair */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="font-semibold text-rose-300">Live</span>
        <select className={select} value={liveId ?? ''} onChange={(e) => { setLiveId(Number(e.target.value)); setPaperId(null) }}>
          {live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className="text-slate-600">vs</span>
        <span className="font-semibold text-sky-300">Paper</span>
        <select className={select} value={paperId ?? ''} onChange={(e) => setPaperId(Number(e.target.value))}>
          {paper.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {view?.since && (
          <span className="ml-auto text-[11px] text-slate-500">
            Comparing from {when(view.since)} IST, when both were trading
          </span>
        )}
      </div>

      {/* Settings check */}
      {diffs && (diffs.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-300">
          ✓ Same settings
          {cfg[liveId]?.investment_per_leg !== cfg[paperId]?.investment_per_leg && (
            <span className="text-slate-500"> · trade size differs (${cfg[liveId]?.investment_per_leg} vs
              ${cfg[paperId]?.investment_per_leg} per leg), so results are compared in %</span>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          ⚠ {diffs.length} setting{diffs.length > 1 ? 's' : ''} differ{diffs.length > 1 ? '' : 's'} - the
          two will not always make the same decision:
          <ul className="mt-1 space-y-0.5 text-amber-100/80">
            {diffs.map((k) => (
              <li key={k}>{label(k)}: live <b>{show(cfg[liveId][k])}</b> · paper <b>{show(cfg[paperId][k])}</b></li>
            ))}
          </ul>
        </div>
      ))}

      {error && <p className="text-xs text-rose-300">{error}</p>}
      {!view && !error && <p className="py-6 text-center text-sm text-slate-600">Loading…</p>}

      {view && !view.since && (
        <p className="py-6 text-center text-sm text-slate-600">
          No finished trades on both yet - the comparison starts once both have traded.
        </p>
      )}

      {view?.since && (
        <>
          {/* Headline numbers */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5">
              <p className="text-[11px] text-slate-500">Same decision</p>
              <p className="nums text-lg font-semibold text-slate-100">
                {view.matchPct == null ? '—' : fmt.pct(view.matchPct, 0)}
                <span className="ml-1.5 text-xs font-normal text-slate-500">of {view.rounds.length} rounds</span>
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5">
              <p className="text-[11px] text-slate-500">Entry price, paper vs live</p>
              <p className="nums text-lg font-semibold text-slate-100">
                {view.gap == null ? '—'
                  : Math.abs(view.gap) < 0.00005 ? 'Same'
                    : `Paper ${Math.abs(view.gap).toFixed(4)} ${view.gap < 0 ? 'cheaper' : 'dearer'}`}
                <span className="ml-1.5 text-xs font-normal text-slate-500">
                  {view.gapCount ? `per contract, avg of ${view.gapCount} shared legs` : 'no shared legs yet'}
                </span>
              </p>
            </div>
          </div>

          {/* Side by side */}
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[420px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <th className="py-2 text-left font-medium" />
                  <th className="py-2 text-right font-medium text-rose-300/80">Live · {liveAcct?.name}</th>
                  <th className="py-2 text-right font-medium text-sky-300/80">Paper · {paperAcct?.name}</th>
                </tr>
              </thead>
              <tbody className="nums divide-y divide-white/5">
                {[
                  ['Rounds traded', (s) => s.rounds],
                  ['Round win rate', (s) => (s.rounds ? fmt.pct(s.winRate, 0) : '—')],
                  ['Return on invested', (s) => (s.invested ? `${s.ret >= 0 ? '+' : ''}${fmt.pct(s.ret)}` : '—')],
                  ['P&L', (s) => fmt.usd(s.pnl)],
                  ['Invested', (s) => fmt.usd(s.invested)],
                ].map(([name, f]) => (
                  <tr key={name}>
                    <td className="py-2 text-slate-400">{name}</td>
                    <td className="py-2 text-right text-slate-200">{f(view.live)}</td>
                    <td className="py-2 text-right text-slate-200">{f(view.paper)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Round by round */}
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <th className="px-4 py-2 text-left font-medium">Round <span className="normal-case text-slate-600">IST</span></th>
                  <th className="px-2 py-2 text-left font-medium text-rose-300/80">Live legs · entry</th>
                  <th className="px-2 py-2 text-left font-medium text-sky-300/80">Paper legs · entry</th>
                  <th className="px-2 py-2 text-right font-medium">Live P&amp;L</th>
                  <th className="px-2 py-2 text-right font-medium">Paper P&amp;L</th>
                  <th className="px-4 py-2 text-left font-medium">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {view.rounds.slice(0, limit).map((r) => (
                  <tr key={r.roundId} className="align-top">
                    <td className="nums whitespace-nowrap px-4 py-2 text-slate-300">{when(r.time)}</td>
                    {['live', 'paper'].map((side) => (
                      <td key={side} className="nums px-2 py-2 text-slate-400">
                        {r[side].length ? r[side].map((p) => (
                          <div key={p.id}>{legText(p)} <span className="text-slate-600">@</span> {Number(p.entry_price).toFixed(4)}</div>
                        )) : <span className="text-slate-700">—</span>}
                      </td>
                    ))}
                    {['livePnl', 'paperPnl'].map((k, i) => (
                      <td key={k} className={`nums px-2 py-2 text-right ${
                        !r[i ? 'paper' : 'live'].length ? 'text-slate-700'
                          : r[k] >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {r[i ? 'paper' : 'live'].length ? fmt.usd(r[k]) : '—'}
                      </td>
                    ))}
                    <td className="px-4 py-2">
                      <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[r.status].cls}`}>
                        {STATUS[r.status].text}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.rounds.length > limit && (
              <button onClick={() => setLimit((n) => n + 50)}
                      className="mx-4 mt-2 text-xs text-sky-400 hover:text-sky-300">
                Show more ({view.rounds.length - limit} older)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
