import { useEffect, useMemo, useState } from 'react'
import { fetchAccounts, fetchBalanceHistory, fetchDailyPnl } from '../lib/supabase'
import { fmt } from '../lib/stats'

/**
 * Daily report.
 *
 * Every number here is either recorded when it happened or labelled "now";
 * nothing is worked back from today. The old table rebuilt each day's balance
 * as starting balance + trades since, so a deposit, an edited starting balance
 * or an open trade changed every past day and none of them matched the
 * header (24 Oct: Prathav $550.82 shown against $1,128.36 held).
 *
 *   - P&L, rounds, invested, win rate: from finished trades (daily_account_pnl).
 *   - Return: P&L / money invested that day - fixed once the day is over.
 *   - Total so far: P&L added up to that day.
 *   - Balance at day end: saved at midnight IST by the database (migration
 *     031), balance plus open trades at cost. "-" before saving began.
 *   - Balance now: accounts.balance, the same figure as the header.
 */

const IST = 'Asia/Kolkata'
const istDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: IST })
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US',
  { day: 'numeric', month: 'short', weekday: 'short' })

const tone = (v) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-300')
const signedUsd = (v) => `${v >= 0 ? '+' : '-'}${fmt.usd(Math.abs(v))}`
const signedPct = (v) => `${v >= 0 ? '+' : ''}${fmt.pct(v)}`

function total(rows) {
  const pnl = rows.reduce((a, r) => a + Number(r.pnl ?? 0), 0)
  const invested = rows.reduce((a, r) => a + Number(r.invested ?? 0), 0)
  return { pnl, invested, ret: invested ? (100 * pnl) / invested : null, any: rows.length > 0 }
}

function PnlCell({ t, muted = 'no trades' }) {
  if (!t.any) return <span className="text-slate-700">{muted}</span>
  return (
    <span className={tone(t.pnl)}>
      {signedUsd(t.pnl)}
      {t.ret != null && <span className="ml-1 text-[11px] opacity-80">({signedPct(t.ret)})</span>}
    </span>
  )
}

export default function DailyReport({ mode = 'paper', accountId }) {
  const [rows, setRows] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [history, setHistory] = useState(null)   // null until 031 has run
  const [error, setError] = useState(null)
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchDailyPnl(), fetchAccounts(), fetchBalanceHistory().catch(() => null)])
      .then(([daily, accts, hist]) => {
        if (!alive) return
        setRows(daily)
        setAccounts(accts)
        setHistory(hist)
        setError(null)
      })
      .catch((e) => alive && setError(e.message ?? String(e)))
    return () => { alive = false }
  }, [])

  const shown = useMemo(
    () => accounts.filter((a) => (a.mode ?? 'paper') === mode), [accounts, mode])

  // The account in the header, unless a summary row was clicked.
  const selectedId = (picked && shown.some((a) => a.id === picked)) ? picked
    : shown.some((a) => a.id === accountId) ? accountId : shown[0]?.id

  const today = istDate(Date.now())
  const weekStart = istDate(Date.now() - 6 * 86400000)

  const byAccount = useMemo(() => {
    const m = new Map()
    for (const r of rows ?? []) {
      if (!m.has(r.account_id)) m.set(r.account_id, [])
      m.get(r.account_id).push(r)
    }
    return m
  }, [rows])

  const days = useMemo(() => {
    const mine = byAccount.get(selectedId) ?? []
    const snaps = new Map((history ?? []).filter((h) => h.account_id === selectedId)
      .map((h) => [h.day, h]))
    const all = [...new Set([...mine.map((r) => r.day), ...snaps.keys()])].sort()
    const byDay = new Map(mine.map((r) => [r.day, r]))
    let running = 0
    return all.map((d) => {
      const r = byDay.get(d)
      running += Number(r?.pnl ?? 0)
      const s = snaps.get(d)
      return {
        day: d,
        r,
        t: total(r ? [r] : []),
        soFar: running,
        snap: s ? { total: Number(s.balance) + Number(s.open_stake ?? 0),
                    balance: Number(s.balance), open: Number(s.open_stake ?? 0) } : null,
      }
    }).reverse()
  }, [byAccount, history, selectedId])

  if (error) {
    return <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                          text-xs text-amber-300">Could not load the daily report: {error}</p>
  }
  if (rows === null) return <p className="py-10 text-center text-sm text-slate-600">Loading…</p>
  if (!shown.length) return <p className="py-10 text-center text-sm text-slate-600">No accounts on this side.</p>

  const selected = shown.find((a) => a.id === selectedId)
  const hasWinRate = (rows ?? []).some((r) => r.rounds_won != null)
  const th = 'px-3 py-2 font-medium'

  return (
    <div className="space-y-5">
      <p className="text-[11px] leading-relaxed text-slate-500">
        Every figure comes from finished trades, or from the balance saved at midnight IST -
        nothing is worked back from today, so past days never change. <b className="font-medium text-slate-400">Return</b> is
        P&amp;L ÷ money invested. Days run to IST midnight.
      </p>

      {/* Summary: one line per account on this side. */}
      <div className="-mx-4 overflow-x-auto">
        <table className="nums w-full min-w-[640px] text-[13px]">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr className="border-b border-white/10">
              <th className={`${th} pl-4 text-left`}>Account</th>
              <th className={`${th} text-right`} title="The account's balance right now - the same figure as the top right.">Balance now</th>
              <th className={`${th} text-right`}>Today</th>
              <th className={`${th} text-right`}>Last 7 days</th>
              <th className={`${th} pr-4 text-right`}>All time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {shown.map((a) => {
              const mine = byAccount.get(a.id) ?? []
              const on = a.id === selectedId
              return (
                <tr key={a.id} onClick={() => setPicked(a.id)}
                    className={`cursor-pointer transition-colors ${on ? 'bg-sky-500/[0.08]' : 'hover:bg-white/[0.03]'}`}>
                  <td className={`py-2 pl-4 pr-3 ${on ? 'font-semibold text-sky-300' : 'text-slate-300'}`}>
                    {on && <span className="mr-1.5">▸</span>}{a.name}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-200">{fmt.usd(Number(a.balance ?? 0))}</td>
                  <td className="px-3 py-2 text-right"><PnlCell t={total(mine.filter((r) => r.day === today))} muted="—" /></td>
                  <td className="px-3 py-2 text-right"><PnlCell t={total(mine.filter((r) => r.day >= weekStart))} muted="—" /></td>
                  <td className="py-2 pl-3 pr-4 text-right"><PnlCell t={total(mine)} muted="—" /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* The selected account, day by day. */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-300">
          {selected?.name} <span className="font-normal text-slate-500">· day by day</span>
          <span className="ml-2 font-normal text-slate-600">(click an account above to switch)</span>
        </h4>
        {!days.length ? (
          <p className="py-6 text-center text-sm text-slate-600">No finished trades yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="nums w-full min-w-[760px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <th className={`${th} pl-4 text-left`}>Day</th>
                  <th className={`${th} text-right`}>Rounds</th>
                  <th className={`${th} text-right`} title="Rounds that made money ÷ rounds finished that day">Win rate</th>
                  <th className={`${th} text-right`}>Invested</th>
                  <th className={`${th} text-right`}>P&amp;L</th>
                  <th className={`${th} text-right`}>Return</th>
                  <th className={`${th} text-right`} title="P&L added up from the first trade to the end of this day">Total so far</th>
                  <th className={`${th} pr-4 text-right`} title="Saved at midnight IST: balance plus open trades at cost. '—' for days before saving began.">Balance at day end</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {days.map(({ day, r, t, soFar, snap }) => (
                  <tr key={day} className="hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap py-2 pl-4 pr-3 text-slate-300">
                      {dayLabel(day)}{day === today && <span className="ml-1.5 text-[10px] text-sky-400">today</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-400">{r ? r.rounds : '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-400">
                      {r && hasWinRate && r.rounds ? fmt.pct((100 * Number(r.rounds_won ?? 0)) / Number(r.rounds), 0) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-400">{r ? fmt.usd(Number(r.invested)) : '—'}</td>
                    <td className={`px-3 py-2 text-right ${r ? tone(t.pnl) : 'text-slate-700'}`}>{r ? signedUsd(t.pnl) : 'no trades'}</td>
                    <td className={`px-3 py-2 text-right ${r ? tone(t.pnl) : 'text-slate-700'}`}>{r && t.ret != null ? signedPct(t.ret) : '—'}</td>
                    <td className={`px-3 py-2 text-right ${tone(soFar)}`}>{signedUsd(soFar)}</td>
                    <td className="py-2 pl-3 pr-4 text-right text-slate-200"
                        title={snap ? `${fmt.usd(snap.balance)} balance + ${fmt.usd(snap.open)} in open trades` : undefined}>
                      {snap ? fmt.usd(snap.total) : <span className="text-slate-700">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history === null ? (
          <p className="mt-2 text-[11px] text-amber-300/80">
            Balance at day end starts once migration 031 has been run.
          </p>
        ) : !history.some((h) => h.account_id === selectedId) && (
          <p className="mt-2 text-[11px] text-slate-500">
            Balance at day end is saved every night at midnight IST, from the first
            midnight after this was set up - earlier days show &quot;—&quot;.
          </p>
        )}
      </div>
    </div>
  )
}
