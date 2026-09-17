import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchAccountPositions } from '../lib/supabase'
import { fetchBinaryTickers } from '../lib/delta'

/**
 * Positions / Recent Trades, laid out like Delta's Predict portfolio cards.
 *
 * A Y badge is a call (the "above" side) and N is a put, because one Predict
 * market is two contracts on this venue.
 */

const money = (v, d = 2) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

const signed = (v) => `${Number(v) >= 0 ? '+' : '-'}$${Math.abs(Number(v ?? 0)).toFixed(2)}`

function whenLabel(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const t = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
  const date = d.toLocaleDateString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric' })
  return `at ${t}, ${date}`
}

function Field({ label, value, tone = 'text-slate-200', align = 'text-left', title }) {
  return (
    <div className={align} title={title}>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`nums mt-0.5 text-sm font-medium ${tone}`}>{value}</p>
    </div>
  )
}

function SideBadge({ side }) {
  const yes = side === 'call'
  return (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs
                      font-bold text-white ${yes ? 'bg-emerald-600' : 'bg-rose-600'}`}>
      {yes ? 'Y' : 'N'}
    </span>
  )
}

function Card({ children }) {
  return (
    <div className="rounded-xl border border-white/5 bg-ink-800/50 p-4">{children}</div>
  )
}

function CardHead({ p, status, tone }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <SideBadge side={p.side} />
        <div className="min-w-0">
          <p className="nums truncate text-sm font-semibold text-slate-100">
            BTC above {Number(p.strike).toLocaleString('en-US')}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">{whenLabel(p.entry_time)}</p>
        </div>
      </div>
      <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
        {status}
      </span>
    </div>
  )
}

function OpenCard({ p, mark }) {
  const invested = Number(p.entry_price) * Number(p.qty)
  const value = mark === null || mark === undefined
    ? null : Number(mark) * Number(p.qty)
  const unreal = value === null ? null : value - invested

  return (
    <Card>
      <CardHead p={p} status="Open" tone="bg-sky-500/15 text-sky-400" />
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/5 pt-3">
        <Field label="Invested Amt." value={money(invested)} />
        <Field label="Current Value" value={value === null ? '—' : money(value)}
               align="text-center" />
        <Field
          label="Unrealized PnL"
          value={unreal === null ? '—' : signed(unreal)}
          tone={unreal === null ? 'text-slate-400'
            : unreal >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          align="text-right"
        />
        <Field label="Contracts" value={Number(p.qty).toLocaleString('en-US')} />
        <Field label="Entry Price" value={Number(p.entry_price).toFixed(4)}
               align="text-center" />
        <Field
          label="Slippage Paid"
          value={Number(p.entry_slippage) > 0
            ? money(Number(p.entry_slippage) * Number(p.qty)) : '$0.00'}
          tone={Number(p.entry_slippage) > 0 ? 'text-amber-400' : 'text-slate-400'}
          align="text-right"
          title="Average fill minus the touch price, times size."
        />
      </div>
    </Card>
  )
}

function ClosedCard({ p }) {
  const invested = Number(p.entry_price) * Number(p.qty)
  const payout = Number(p.exit_price) * Number(p.qty)
  const fees = Number(p.fees ?? 0)
  const pnl = payout - invested - fees
  const settled = p.status === 'settled'

  return (
    <Card>
      <CardHead p={p} status="Closed" tone="bg-rose-500/15 text-rose-400" />
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/5 pt-3">
        <Field label="Invested Amt." value={money(invested)} />
        <Field label="Final Payout" value={money(payout)} align="text-center" />
        <Field
          label="Realized PnL"
          value={signed(pnl)}
          tone={pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          align="text-right"
        />

        <Field label="Fees" value={money(fees)} />
        {settled ? (
          <>
            <Field
              label="Settlement Price"
              value={p.settlement_spot ? money(p.settlement_spot) : '—'}
              align="text-center"
              title="Last underlying spot observed before expiry — approximates the settlement mark, not the venue's official figure."
            />
            <Field
              label="Outcome"
              value={Number(p.exit_price) >= 0.5 ? 'Yes' : 'No'}
              align="text-right"
            />
          </>
        ) : (
          <div className="col-span-2 text-right">
            <p className="text-[11px] text-slate-500">Closed early</p>
            <p className="mt-0.5 truncate text-xs text-slate-400" title={p.exit_reason}>
              {p.exit_reason || '—'}
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}

export default function PortfolioTabs({ accountId }) {
  const [tab, setTab] = useState('positions')
  const [positions, setPositions] = useState([])
  const [marks, setMarks] = useState({})
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    if (!accountId) { setPositions([]); return }
    fetchAccountPositions(accountId)
      .then((rows) => { setPositions(rows); setError(null) })
      .catch((e) => {
        const msg = `${e?.message ?? e}`
        // account_id arrives with migration 004; until then show nothing
        // rather than an error the user cannot act on from here.
        setError(/account_id|column/i.test(msg)
          ? 'Run migration 004 to group trades by account.' : msg)
      })
  }, [accountId])

  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  // Live marks so open positions can show a current value.
  useEffect(() => {
    let alive = true
    const tick = () => fetchBinaryTickers()
      .then((rows) => {
        if (!alive) return
        const next = {}
        for (const r of rows ?? []) {
          const bid = r?.quotes?.best_bid
          if (bid !== null && bid !== undefined) next[r.symbol] = Number(bid)
        }
        setMarks(next)
      })
      .catch(() => {})
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const open = useMemo(
    () => positions.filter((p) => p.status === 'open'), [positions])
  const closed = useMemo(
    () => positions.filter((p) => p.status !== 'open'), [positions])

  const rows = tab === 'positions' ? open : closed

  return (
    <div className="rounded-xl border border-white/10 bg-ink-900">
      <div className="flex gap-6 border-b border-white/5 px-4">
        {[['positions', 'Positions', open.length],
          ['trades', 'Recent Trades', closed.length]].map(([key, label, n]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`relative -mb-px py-3 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-b-2 border-sky-500 text-slate-100'
                : 'border-b-2 border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            {label}
            {n > 0 && (
              <span className="nums ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px]">
                {n}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-4">
        {error && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                        text-xs text-rose-300">
            {error}
          </p>
        )}

        {!error && rows.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-600">
            {tab === 'positions'
              ? 'No open positions.'
              : 'No completed trades yet.'}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {rows.map((p) => (
            tab === 'positions'
              ? <OpenCard key={p.id ?? p.position_id} p={p} mark={marks[p.symbol]} />
              : <ClosedCard key={p.id ?? p.position_id} p={p} />
          ))}
        </div>
      </div>
    </div>
  )
}
