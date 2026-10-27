import { useEffect, useMemo, useState } from 'react'
import { fetchAccounts, fetchBalanceHistory, fetchDailyPnl, fetchOpenStakes } from '../lib/supabase'
import { fmt } from '../lib/stats'
import Dropdown from './Dropdown'
import InfoDot from './InfoDot'

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
const monthOf = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US',
  { month: 'long', year: 'numeric' })

const tone = (v) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-300')
const signedUsd = (v) => `${v >= 0 ? '+' : '-'}${fmt.usd(Math.abs(v))}`
const signedPct = (v) => `${v >= 0 ? '+' : ''}${fmt.pct(v)}`

const INFO = 'Every figure comes from finished trades, or from the balance saved at '
  + 'midnight IST - nothing is worked back from today, so past days never change. '
  + 'Return is P&L divided by money invested. Days run to IST midnight. Balance now '
  + 'is the same as the top right.'

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

// A thin bar beside a day's return, sized against the biggest in view, so the
// good and bad days stand out without reading every number.
function ReturnBar({ ret, max }) {
  const w = Math.max(4, (48 * Math.abs(ret)) / max)
  return (
    <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-white/5">
      <span className={`h-full rounded-full ${ret >= 0 ? 'bg-emerald-400/80' : 'bg-rose-400/80'}`}
            style={{ width: `${Math.min(48, w)}px` }} />
    </span>
  )
}

const PERIODS = [['7', '7 days'], ['30', '30 days'], ['all', 'All']]
const VIEW_KEY = 'predict.dailyView'

const SIMPLE_INFO = 'Each day: the balance at the end of the day, and that day\'s P&L '
  + '(in brackets: how much it grew the balance the day started with). The newest '
  + 'balance is the real one - the same as the top right - and earlier days count '
  + 'back from it using each day\'s P&L, or use the balance saved at midnight IST '
  + 'where there is one. Days run to IST midnight.'

/**
 * The familiar view: days down the side, one column per account, each cell
 * the day-end balance with the day's P&L beneath it.
 *
 * Balances count BACK from the real balance (plus open trades at cost), so
 * the newest row always equals the header - the old forward count from the
 * starting balance read $550.82 for Prathav against $1,128.36 held. Where the
 * database saved a balance at midnight, that recorded figure wins and the
 * count continues back from it.
 */
function SimpleGrid({ shown, byAccount, history, stakes, today }) {
  const { days, cells } = useMemo(() => {
    const snap = new Map((history ?? []).map((h) => [`${h.account_id}|${h.day}`,
      Number(h.balance) + Number(h.open_stake ?? 0)]))
    const pnl = new Map()
    const daySet = new Set()
    for (const a of shown) {
      for (const r of byAccount.get(a.id) ?? []) {
        pnl.set(`${a.id}|${r.day}`, r)
        daySet.add(r.day)
      }
    }
    for (const h of history ?? []) {
      if (shown.some((a) => a.id === h.account_id)) daySet.add(h.day)
    }
    const days = [...daySet].sort().reverse()
    const cells = new Map()
    for (const a of shown) {
      let bal = Number(a.balance ?? 0) + (stakes.get(a.id) ?? 0)
      for (const d of days) {
        const key = `${a.id}|${d}`
        if (snap.has(key)) bal = snap.get(key)
        const r = pnl.get(key)
        const dayPnl = Number(r?.pnl ?? 0)
        const opening = bal - dayPnl
        cells.set(key, { bal, r, pnl: dayPnl,
                         pct: r && opening > 0 ? (100 * dayPnl) / opening : null })
        bal = opening
      }
    }
    return { days, cells }
  }, [shown, byAccount, history, stakes])

  if (!days.length) {
    return <p className="py-10 text-center text-sm text-slate-600">Nothing has settled yet.</p>
  }
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="nums w-full text-[13px]">
        <thead className="text-[11px] uppercase tracking-wide text-slate-500">
          <tr className="border-b border-white/10">
            <th className="px-4 py-2.5 text-left font-medium">Day</th>
            {shown.map((a) => (
              <th key={a.id} className="px-4 py-2.5 text-right font-medium">{a.name}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {days.map((d) => (
            <tr key={d} className="hover:bg-white/[0.02]">
              <td className="whitespace-nowrap px-4 py-2.5 text-slate-300">
                {dayLabel(d)}
                {d === today && (
                  <span className="ml-1.5 rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-300">today</span>
                )}
              </td>
              {shown.map((a) => {
                const c = cells.get(`${a.id}|${d}`)
                return (
                  <td key={a.id} className="px-4 py-2.5 text-right"
                      title={c?.r ? `${c.r.rounds} rounds, ${fmt.usd(Number(c.r.invested))} invested` : 'No trades finished this day'}>
                    <div className="text-slate-200">{fmt.usd(c.bal)}</div>
                    <div className={`text-[11px] ${c.r ? tone(c.pnl) : 'text-slate-700'}`}>
                      {c.r ? signedUsd(c.pnl) : 'no trades'}
                      {c.pct != null && <span className="ml-1 opacity-80">({signedPct(c.pct)})</span>}
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DailyReport({ mode = 'paper', accountId }) {
  const [rows, setRows] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [history, setHistory] = useState(null)   // null until 031 has run
  const [error, setError] = useState(null)
  const [picked, setPicked] = useState(null)
  const [period, setPeriod] = useState('30')
  const [stakes, setStakes] = useState(new Map())
  // Simple (the familiar grid) is the default; Detailed is opt-in.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'detailed' ? 'detailed' : 'simple' } catch { return 'simple' }
  })
  const pickView = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ }
  }

  useEffect(() => {
    let alive = true
    Promise.all([fetchDailyPnl(), fetchAccounts(), fetchBalanceHistory().catch(() => null),
                 fetchOpenStakes().catch(() => new Map())])
      .then(([daily, accts, hist, open]) => {
        if (!alive) return
        setRows(daily)
        setAccounts(accts)
        setHistory(hist)
        setStakes(open)
        setError(null)
      })
      .catch((e) => alive && setError(e.message ?? String(e)))
    return () => { alive = false }
  }, [])

  const shown = useMemo(
    () => accounts.filter((a) => (a.mode ?? 'paper') === mode), [accounts, mode])

  // The account in the header, unless one was picked here.
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
  const th = 'px-3 py-2.5 font-medium'

  // Summary totals across every account on this side.
  const sideRows = shown.flatMap((a) => byAccount.get(a.id) ?? [])
  const sideBalance = shown.reduce((a, x) => a + Number(x.balance ?? 0), 0)

  // Day table: the chosen period, newest first.
  const cutoff = period === 'all' ? null
    : istDate(Date.now() - (Number(period) - 1) * 86400000)
  const shownDays = cutoff ? days.filter((d) => d.day >= cutoff) : days
  const traded = shownDays.filter((d) => d.r)
  const sumRounds = traded.reduce((a, d) => a + Number(d.r.rounds), 0)
  const sumWon = traded.reduce((a, d) => a + Number(d.r.rounds_won ?? 0), 0)
  const periodTotal = total(traded.map((d) => d.r))
  const maxRet = Math.max(1, ...traded.map((d) => Math.abs(d.t.ret ?? 0)))

  const seg = (on) => `rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
    on ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300'}`

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Daily report</h4>
          <InfoDot side="bottom" text={view === 'simple' ? SIMPLE_INFO : INFO} />
        </div>
        <div role="tablist" aria-label="Report view"
             className="flex rounded-lg border border-white/10 bg-ink-950 p-0.5">
          {[['simple', 'Simple'], ['detailed', 'Detailed']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k}
                    onClick={() => pickView(k)} className={seg(view === k)}>{l}</button>
          ))}
        </div>
      </div>

      {view === 'simple' ? (
        <SimpleGrid shown={shown} byAccount={byAccount} history={history}
                    stakes={stakes} today={today} />
      ) : (
    <div className="space-y-6">
      {/* ------------------------------------------------------ summary -- */}
      <section>
        <div className="mb-2 flex items-center gap-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Accounts</h4>
          <InfoDot side="bottom" text={INFO} />
        </div>
        <div className="-mx-4 overflow-x-auto">
          <table className="nums w-full min-w-[640px] text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr className="border-b border-white/10">
                <th className={`${th} pl-4 text-left`}>Account</th>
                <th className={`${th} text-right`}>Balance now</th>
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
                      className={`cursor-pointer transition-colors ${
                        on ? 'bg-sky-500/[0.07] shadow-[inset_3px_0_0_0_rgb(56_189_248)]'
                          : 'hover:bg-white/[0.03]'}`}>
                    <td className={`py-2.5 pl-4 pr-3 ${on ? 'font-semibold text-slate-100' : 'text-slate-300'}`}>
                      {a.name}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-200">{fmt.usd(Number(a.balance ?? 0))}</td>
                    <td className="px-3 py-2.5 text-right">
                      <PnlCell t={total(mine.filter((r) => r.day === today))} muted="—" />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <PnlCell t={total(mine.filter((r) => r.day >= weekStart))} muted="—" />
                    </td>
                    <td className="py-2.5 pl-3 pr-4 text-right"><PnlCell t={total(mine)} muted="—" /></td>
                  </tr>
                )
              })}
            </tbody>
            {shown.length > 1 && (
              <tfoot>
                <tr className="border-t border-white/15 font-semibold">
                  <td className="py-2.5 pl-4 pr-3 text-[11px] uppercase tracking-wide text-slate-400">Total</td>
                  <td className="px-3 py-2.5 text-right text-slate-100">{fmt.usd(sideBalance)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <PnlCell t={total(sideRows.filter((r) => r.day === today))} muted="—" />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <PnlCell t={total(sideRows.filter((r) => r.day >= weekStart))} muted="—" />
                  </td>
                  <td className="py-2.5 pl-3 pr-4 text-right"><PnlCell t={total(sideRows)} muted="—" /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* --------------------------------------------------- day by day -- */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Day by day <span className="normal-case tracking-normal text-slate-500">· {selected?.name}</span>
          </h4>
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Period"
                 className="flex rounded-lg border border-white/10 bg-ink-950 p-0.5">
              {PERIODS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={period === k}
                        onClick={() => setPeriod(k)} className={seg(period === k)}>{l}</button>
              ))}
            </div>
            <Dropdown
              ariaLabel="Account" size="sm" align="right" className="min-w-[10rem]"
              value={selectedId} onChange={setPicked}
              options={shown.map((a) => ({ value: a.id, label: a.name }))}
            />
          </div>
        </div>

        {!shownDays.length ? (
          <p className="rounded-lg border border-white/5 py-8 text-center text-sm text-slate-600">
            No finished trades in this period.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="nums w-full min-w-[820px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <th className={`${th} pl-4 text-left`}>Day</th>
                  <th className={`${th} text-right`}>Rounds</th>
                  <th className={`${th} text-right`} title="Rounds that made money ÷ rounds finished that day">Win rate</th>
                  <th className={`${th} text-right`}>Invested</th>
                  <th className={`${th} text-right`}>P&amp;L</th>
                  <th className={`${th} text-right`} title="P&L ÷ money invested that day">Return</th>
                  <th className={`${th} text-right`} title="P&L added up from the first trade to the end of this day">Total so far</th>
                  <th className={`${th} pr-4 text-right`}
                      title="Saved at midnight IST: balance plus open trades at cost. '—' for days before saving began.">
                    Balance at day end
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownDays.map(({ day, r, t, soFar, snap }, i) => {
                  const newMonth = i === 0 || monthOf(day) !== monthOf(shownDays[i - 1].day)
                  return [
                    newMonth && (
                      <tr key={`m-${day}`}>
                        <td colSpan={8}
                            className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          {monthOf(day)}
                        </td>
                      </tr>
                    ),
                    <tr key={day} className="border-t border-white/5 hover:bg-white/[0.02]">
                      <td className="whitespace-nowrap py-2.5 pl-4 pr-3 text-slate-300">
                        {dayLabel(day)}
                        {day === today && (
                          <span className="ml-1.5 rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-300">today</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{r ? r.rounds : '—'}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">
                        {r && hasWinRate && r.rounds
                          ? fmt.pct((100 * Number(r.rounds_won ?? 0)) / Number(r.rounds), 0) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{r ? fmt.usd(Number(r.invested)) : '—'}</td>
                      <td className={`px-3 py-2.5 text-right font-medium ${r ? tone(t.pnl) : 'text-slate-700'}`}>
                        {r ? signedUsd(t.pnl) : 'no trades'}
                      </td>
                      <td className="px-3 py-2.5">
                        {r && t.ret != null ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className={tone(t.pnl)}>{signedPct(t.ret)}</span>
                            <ReturnBar ret={t.ret} max={maxRet} />
                          </div>
                        ) : <div className="text-right text-slate-700">—</div>}
                      </td>
                      <td className={`px-3 py-2.5 text-right ${tone(soFar)}`}>{signedUsd(soFar)}</td>
                      <td className="py-2.5 pl-3 pr-4 text-right text-slate-200"
                          title={snap ? `${fmt.usd(snap.balance)} balance + ${fmt.usd(snap.open)} in open trades` : undefined}>
                        {snap ? fmt.usd(snap.total) : <span className="text-slate-700">—</span>}
                      </td>
                    </tr>,
                  ]
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/15 font-semibold">
                  <td className="py-2.5 pl-4 pr-3 text-[11px] uppercase tracking-wide text-slate-400">
                    {period === 'all' ? 'All time' : `Last ${period} days`}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-200">{sumRounds || '—'}</td>
                  <td className="px-3 py-2.5 text-right text-slate-200">
                    {hasWinRate && sumRounds ? fmt.pct((100 * sumWon) / sumRounds, 0) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-200">{fmt.usd(periodTotal.invested)}</td>
                  <td className={`px-3 py-2.5 text-right ${tone(periodTotal.pnl)}`}>{signedUsd(periodTotal.pnl)}</td>
                  <td className={`px-3 py-2.5 text-right ${tone(periodTotal.pnl)}`}>
                    {periodTotal.ret != null ? signedPct(periodTotal.ret) : '—'}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {history === null ? (
          <p className="mt-2 text-[11px] text-amber-300/80">
            Balance at day end starts once migration 031 has been run.
          </p>
        ) : !history.some((h) => h.account_id === selectedId) && (
          <p className="mt-2 text-[11px] text-slate-500">
            Balance at day end is saved every night at midnight IST - days before that show &quot;—&quot;.
          </p>
        )}
      </section>
    </div>
      )}
    </div>
  )
}
