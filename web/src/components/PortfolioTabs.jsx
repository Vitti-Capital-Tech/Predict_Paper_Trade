import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAccountPositions, fetchRecentCloses, placeManualClose,
  fetchAccounts, fetchDailyPnl,
  fetchStrategyConfig,
} from '../lib/supabase'
import {
  fetchOrderbook, walkBook, expiryCodeToDate, fetchCandles, indexSymbolFor,
} from '../lib/delta'
import { atrSeries, atrAt, lookbackHours } from '../lib/atr'
import { summarise, fmt } from '../lib/stats'
import ExportTrades from './ExportTrades'

/**
 * Positions / Recent Trades, laid out like Delta's Predict portfolio cards.
 *
 * A Y badge is a call (the "above" side) and N is a put, because one Predict
 * market is two contracts on this venue.
 */

const money = (v, d = 2) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

const signed = (v) => `${Number(v) >= 0 ? '+' : '-'}$${Math.abs(Number(v ?? 0)).toFixed(2)}`

/**
 * Every time on this screen is IST.
 *
 * The daily table groups by IST midnight, because the team reads these as
 * working days. The trade and position times used to render in whatever zone
 * the browser was in, so on a UTC+10 machine a round that settled at 23:45
 * IST was labelled 04:15 the next morning - and then did not appear in that
 * next day's row, which read "no trades". Same instants, two day boundaries.
 * One zone for the whole tab is what makes the two tables agree.
 */
const IST = 'Asia/Kolkata'

/** Clock time for a trade stamp; the date is already on the round's row. */
const clockOf = (iso) => (iso
  ? new Date(iso).toLocaleTimeString('en-US', {
      timeZone: IST,
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
  : '—')

const atrText = (v) => (v == null ? 'ATR —' : `ATR ${v.toFixed(1)}`)
/** Spot beside the ATR, on one line: the two numbers the entry and
 *  exit rules are actually written in. */
const spotText = (v) => (v == null ? ''
  : ` · ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)

/** Asset and expiry both live in the round id: ETH-DDMMYYHHMM. */
function assetOf(roundId) {
  const head = String(roundId ?? '').split('-')[0]
  return head || 'BTC'
}

/** Expiry lives in the round id: BTC-DDMMYYHHMM. */
function expiryOf(roundId) {
  const code = String(roundId ?? '').split('-').pop()
  return /^\d{10}$/.test(code) ? expiryCodeToDate(code) : null
}

const clockLabel = (d) => (d
  ? d.toLocaleTimeString('en-US', {
      timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase()
  : '—')

/** Time left as hh:mm:ss, zero-padded, the way a position card shows it. */
function hms(ms) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000))
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
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

/**
 * Header of an open position, laid out the way Delta lays one out: what you
 * bought, when it expires and how long is left, and the move on the right.
 *
 * The move is a percentage rather than the "Open" pill that used to sit
 * there. Every card in this list is open, so the pill said nothing; the
 * percentage is the one number you actually look for.
 */
function CardHead({ p, now, pct }) {
  const expiry = expiryOf(p.round_id)
  const left = expiry && now ? expiry.getTime() - now : null
  const halted = left !== null && left > 0 && left <= 60000
  const done = left !== null && left <= 0

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <SideBadge side={p.side} />
        <div className="min-w-0">
          <p className="nums truncate text-sm font-semibold text-slate-100">
            {assetOf(p.round_id)} above {Number(p.strike).toLocaleString('en-US')}
          </p>
          <p className="nums mt-0.5 text-[11px] text-slate-500">
            At {clockLabel(expiry)}<span className="text-slate-600"> IST</span>
            {left !== null && (
              <>
                <span className="mx-1.5 text-slate-700">|</span>
                <span className={halted ? 'text-amber-400'
                  : done ? 'text-slate-600' : 'text-slate-400'}>
                  {done ? 'settling' : hms(left)}
                  {halted && ' (halted)'}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      {pct !== null && (
        <span
          title={`Against what you paid, at what the book would pay to close now.`}
          className={`nums shrink-0 text-sm font-semibold ${
            pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
        >
          {pct >= 0 ? '+' : '-'}{Math.abs(pct).toFixed(2)}%
        </span>
      )}
    </div>
  )
}

function OpenCard({ p, mark, close, onClose, busy, tolerance, now }) {
  const invested = Number(p.entry_price) * Number(p.qty)
  // A binary settles at $1.00 or nothing, so the win is the contract count.
  const payout = Number(p.qty) * 1.0
  const exitPrice = mark?.ok ? mark.price : null
  const value = exitPrice === null ? null : exitPrice * Number(p.qty)
  const unreal = value === null ? null : value - invested

  // The move on the position, against what it cost. Delta puts this where the
  // status pill used to sit, and it is why the card no longer carries a
  // separate unrealised-PnL column: invested against current value says it.
  const pct = value === null || !invested ? null : ((value - invested) / invested) * 100

  const pending = close?.status === 'pending' || busy
  const rejected = close?.status === 'rejected' ? close.reject_reason : null
  // How far the book's bid for your whole size sits below its top. Shown for
  // the same reason as on the buy side: the top is the price of one contract.
  const depthCost = mark?.ok && mark.top ? mark.top - mark.price : 0
  // The worker compares this same figure against the tolerance, so refuse it
  // here instead of letting the click bounce back as a rejection.
  const tooDeep = depthCost > tolerance

  return (
    <Card>
      <CardHead p={p} now={now} pct={pct} />
      {/* Three numbers, in the order Delta reads them: what it cost, what it
          is worth now, what it pays if it comes in. Entry price and contract
          count were a restatement of the first and third in other units. */}
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/5 pt-3">
        <Field
          label={Number(p.entry_fills) > 1
            ? `Invested · ${p.entry_fills} fills` : 'Invested'}
          value={money(invested)}
          title={`Filled at ${Number(p.entry_price).toFixed(4)} per contract.`
                 + (Number(p.entry_fills) > 1
                   ? ` Built from ${p.entry_fills} fills across separate ticks,`
                     + ' averaged — the book would not sell the whole leg at once.'
                   : '')
                 + (Number(p.entry_slippage) > 0
                   ? ` Slippage paid: ${money(Number(p.entry_slippage) * Number(p.qty))}.`
                   : ' No slippage — filled at the touch.')}
        />
        <Field
          label="Current Value"
          value={value === null ? '—' : money(value)}
          align="text-center"
          title={unreal === null
            ? 'No bid quoted, so there is nothing to value the position against.'
            : `What the book would pay to close the whole position right now`
              + ` — ${signed(unreal)} against what you paid.`}
        />
        {/* Every contract settles at exactly $1.00 or $0.00, so the winning
            payout is just the size. */}
        <Field
          label="Payout if Correct"
          value={money(payout)}
          align="text-right"
          title={`${Number(p.qty).toLocaleString('en-US')} contracts x $1.00 if `
                 + `${p.side === 'call' ? 'above' : 'below'} `
                 + `${Number(p.strike).toLocaleString('en-US')} at expiry`}
        />
      </div>

      <button
        onClick={() => onClose(p, mark?.top)}
        disabled={pending || exitPrice === null || tooDeep}
        title={exitPrice === null
          ? (mark?.reason ?? 'No bid quoted — nothing to sell into')
          : `Sells ${Number(p.qty).toLocaleString('en-US')} contracts into the book at an average of ${Number(exitPrice).toFixed(4)}.`}
        className="mt-3 w-full rounded-lg bg-ink-700/70 py-2 text-xs font-semibold
                   text-rose-400 transition-colors hover:bg-ink-600
                   hover:text-rose-300 disabled:cursor-not-allowed
                   disabled:opacity-40 disabled:hover:bg-ink-700/70"
      >
        {pending ? 'Closing…' : 'Close'}
      </button>

      {depthCost > 0.0005 && !tooDeep && (
        <p className="nums mt-1 text-center text-[10px] text-amber-400/90">
          book {money(mark.top, 3)}/contract · −{money(depthCost, 3)} depth on this size
        </p>
      )}

      {tooDeep && (
        <p className="nums mt-1.5 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1
                      text-center text-[10px] leading-snug text-rose-300">
          selling this size costs {money(depthCost, 4)}/contract in depth, over your{' '}
          {money(tolerance)} tolerance — raise it, or hold to settlement
        </p>
      )}

      {!mark?.ok && mark?.reason && (
        <p className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1
                      text-center text-[10px] text-amber-300">
          {mark.reason}
        </p>
      )}

      {rejected && (
        <p className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5
                      text-[11px] text-rose-300">
          Close rejected: {rejected}
        </p>
      )}
    </Card>
  )
}


/**
 * One number in the strip. `tone` colours it by sign where that means
 * something; a win rate is not better for being green.
 */
function Stat({ label, value, sub, tone }) {
  const colour = tone === undefined ? 'text-slate-100'
    : tone >= 0 ? 'text-emerald-400' : 'text-rose-400'
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] text-slate-500">{label}</p>
      <p className={`nums mt-0.5 truncate text-base font-semibold ${colour}`}>{value}</p>
      {sub && <p className="nums truncate text-[10px] text-slate-600">{sub}</p>}
    </div>
  )
}

/**
 * Closed trades grouped by the round they belonged to.
 *
 * A strangle is one bet made of two legs, and reading it leg by leg says very
 * little - one wing losing everything is the normal shape of a winning round.
 * The round is the unit that means something, so that is the row; the legs are
 * there when you want them.
 */
/**
 * Open P&L for a set of legs, honest about the ones it cannot price.
 *
 * A leg with no bid has no current value, and the old total simply skipped
 * it — so a round with one unpriced leg reported a P&L for fewer legs than
 * you hold, with nothing to say so. That can flatter a strangle badly: the
 * wing nobody is bidding for is usually the losing one. `priced` against
 * `total` is carried so every caller can say "2 of 3 priced".
 */
function combine(legs, marks) {
  let invested = 0
  let value = 0
  let pricedCost = 0
  let priced = 0
  const bySide = {}
  for (const p of legs) {
    const cost = Number(p.entry_price) * Number(p.qty)
    invested += cost
    bySide[p.side] = (bySide[p.side] ?? 0) + Number(p.qty)
    const m = marks[p.symbol]
    if (m?.ok) {
      value += m.price * Number(p.qty)
      pricedCost += cost
      priced += 1
    }
  }
  return {
    invested,
    value,
    // Against the cost of the legs that WERE priced, so an unpriced leg does
    // not count as a total loss either. Both errors are wrong; this one says
    // which legs it covers.
    pnl: value - pricedCost,
    priced,
    total: legs.length,
    // Same rule as trade history: the sides cannot both pay, so the best case
    // is the better side, not the sum of the legs.
    payout: Math.max(0, ...Object.values(bySide)),
  }
}

/**
 * One round's open legs, read together.
 *
 * A strangle is a single bet made of two or three positions, and one wing is
 * nearly always under water — so its legs read one at a time mostly say
 * "losing", which tells you nothing about the trade. The header is the round:
 * what it cost, what the book would pay for all of it now, and what it pays
 * if it comes in.
 */
function OpenRound({ roundId, legs, marks, children }) {
  const c = combine(legs, marks)
  const pct = c.invested ? (c.pnl / c.invested) * 100 : null
  const expiry = expiryCodeToDate(String(roundId).split('-').pop())
  const partial = c.priced < c.total
  return (
    <div className="rounded-xl border border-white/5 bg-ink-950/40 p-3">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 px-1">
        <div className="text-sm text-slate-200">
          <span className="mr-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold
                           text-slate-400">
            {assetOf(roundId)}
          </span>
          {expiry ? expiry.toLocaleTimeString('en-US',
            { timeZone: IST, hour: 'numeric', minute: '2-digit' }) : roundId}
          <span className="ml-2 text-[11px] text-slate-500">
            {c.total} leg{c.total === 1 ? '' : 's'}
          </span>
        </div>
        <RoundStat label="Invested" value={money(c.invested)} />
        <RoundStat label="Value now"
              value={c.priced ? money(c.value) : '—'}
              title="What the book would pay to close every priced leg now." />
        <RoundStat
          label="Open P&L"
          value={c.priced ? `${signed(c.pnl)}${pct === null ? ''
            : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`}` : '—'}
          tone={c.priced ? c.pnl : undefined}
          sub={partial ? `${c.priced} of ${c.total} legs priced` : null}
          title={partial
            ? 'Some legs have no bid, so they cannot be valued. This covers the'
              + ' priced legs only, against what those legs cost.'
            : 'Every leg, valued at what the book would pay for your whole size.'} />
        <RoundStat label="Pays if right" value={money(c.payout)}
              title="The better side. The wings are on opposite sides of spot and
                     cannot both pay." />
      </div>
      {children}
    </div>
  )
}

/** The round header's figures — smaller than the Performance stats. */
function RoundStat({ label, value, tone, sub, title }) {
  return (
    <div title={title}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`nums text-sm font-semibold ${
        tone === undefined ? 'text-slate-200'
          : tone >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-amber-500/80">{sub}</div>}
    </div>
  )
}

/**
 * What a leg was actually built from, in the table's own columns.
 *
 * The averaged entry price says what a leg cost. It does not say whether
 * that average was earned evenly or dragged by one slice that had to reach
 * down the book — and on a strategy whose whole thesis is slippage, that is
 * the part worth reading.
 *
 * Every fill sits under the column it actually belongs to, and the two money
 * columns are the reason the layout works: each fill's cost stacks beneath
 * the leg's Invested figure and adds up to it, and — because a binary
 * contract pays exactly $1 — each fill's contract count IS its payout, so
 * those add up to the leg's Payout too. The arithmetic is visible rather
 * than asserted. A running total would have had to borrow a column that
 * means something else, so it lives in the cost cell's tooltip instead.
 */
function FillRows({ fills, open }) {
  if (!open || !Array.isArray(fills) || fills.length < 2) return null
  let running = 0
  return fills.map((f, i) => {
    const qty = Number(f.qty)
    const cost = qty * Number(f.price)
    running += cost
    const slip = Number(f.slip ?? 0)
    return (
      <tr key={i} className="bg-ink-950/60 text-[11px] text-slate-500">
        <td className="py-px pl-16 pr-2 text-[10px] uppercase tracking-wide
                       text-slate-600">
          {i === 0 ? 'fills' : ''}
        </td>
        <td className="nums px-2 py-px text-slate-500">
          {qty.toLocaleString('en-US')} @ {Number(f.price).toFixed(4)}
        </td>
        <td className="nums px-2 py-px text-slate-600">{clockOf(f.t)}</td>
        <td />
        <td />
        <td />
        <td className="nums px-2 py-px text-right text-slate-400"
            title={`${money(running)} of the leg bought after this fill.`}>
          {money(cost)}
        </td>
        <td className="nums px-2 py-px text-right text-slate-600"
            title={`${qty.toLocaleString('en-US')} contracts, $1 each if it wins.`}>
          {money(qty)}
        </td>
        <td />
        <td />
        <td className={`px-4 py-px text-[10px] ${
          slip > 0 ? 'text-amber-500/70' : 'text-emerald-500/60'}`}
            title={f.top == null ? ''
              : `Best offer was ${Number(f.top).toFixed(4)} when this filled;`
                + ` it reached ${f.levels} level${f.levels === 1 ? '' : 's'}`
                + ' down the book.'}>
          {slip > 0 ? `+${slip.toFixed(4)} slip` : 'at touch'}
        </td>
      </tr>
    )
  })
}

/**
 * Every account's balance, day by day.
 *
 * Deliberately ignores the account selector above it. The question this
 * answers is comparative — which account is ahead, and on which days — and
 * that is unanswerable one account at a time.
 *
 * Balance is derived rather than read from `accounts.balance`, which is a
 * single live figure with no history and which also has the cost of any
 * open position already taken out of it. Starting balance plus realised
 * P&L to the end of that day is the number that can be stated per day and
 * that adds up across them.
 */
function DailyTable({ mode = 'paper' }) {
  const [rows, setRows] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchDailyPnl(), fetchAccounts()])
      .then(([daily, accts]) => {
        if (!alive) return
        setRows(daily)
        setAccounts(accts)
        setError(null)
      })
      .catch((e) => alive && setError(e.message ?? String(e)))
    return () => { alive = false }
  }, [])

  const { days, byDay, closing, shown } = useMemo(() => {
    // Only accounts that still exist, and only the ones on this side.
    // Positions outlive the account they belonged to, so a deleted account
    // leaves its days behind in the view — and those would render as a run of
    // empty rows above the real ones, reading as "nothing happened" rather
    // than "not this account". Paper and live are different money, so putting
    // both in one comparison says nothing worth reading.
    const shown = accounts.filter((a) => (a.mode ?? 'paper') === mode)
    const live = new Set(shown.map((a) => a.id))
    const mine = (rows ?? []).filter((r) => live.has(r.account_id))
    const days = [...new Set(mine.map((r) => r.day))].sort()
    const byDay = new Map()
    for (const r of mine) {
      if (!byDay.has(r.day)) byDay.set(r.day, new Map())
      byDay.get(r.day).set(r.account_id, r)
    }
    // Running balance per account, walked forward so a day with no trades
    // carries the previous close rather than showing a gap.
    const closing = new Map()
    for (const a of shown) {
      let bal = Number(a.starting_balance ?? 0)
      const series = new Map()
      for (const d of days) {
        bal += Number(byDay.get(d)?.get(a.id)?.pnl ?? 0)
        series.set(d, bal)
      }
      closing.set(a.id, series)
    }
    return { days, byDay, closing, shown }
  }, [rows, accounts, mode])

  if (error) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                      text-xs text-amber-300">
        Day-by-day balances need{' '}
        <code className="rounded bg-black/30 px-1">
          supabase/migrations/019_daily_account_pnl.sql
        </code>{' '}
        run once. ({error})
      </div>
    )
  }
  if (rows === null) {
    return <p className="py-10 text-center text-sm text-slate-600">Loading…</p>
  }
  if (!days.length) {
    return <p className="py-10 text-center text-sm text-slate-600">
      Nothing has settled yet.
    </p>
  }

  const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short' })

  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-[11px] text-slate-600">
        Closing balance each day, with the day&apos;s realised P&amp;L beneath it.
        All accounts, newest first. Days run to IST midnight.
      </p>
      <table className="w-full text-[13px]">
        <thead className="text-[11px] uppercase tracking-wide text-slate-500">
          <tr className="border-b border-white/5">
            <th className="px-3 py-2 text-left font-medium">Day</th>
            {shown.map((a) => (
              <th key={a.id} className="px-3 py-2 text-right font-medium"
                  title={`Started at ${money(Number(a.starting_balance))}`}>
                {a.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {[...days].reverse().map((d) => (
            <tr key={d} className="hover:bg-white/[0.02]">
              <td className="nums whitespace-nowrap px-3 py-2 text-slate-300">
                {dayLabel(d)}
              </td>
              {shown.map((a) => {
                const cell = byDay.get(d)?.get(a.id)
                const bal = closing.get(a.id)?.get(d)
                const pnl = Number(cell?.pnl ?? 0)
                return (
                  <td key={a.id} className="nums px-3 py-2 text-right"
                      title={cell
                        ? `${cell.rounds} rounds, ${cell.legs} legs,`
                          + ` ${cell.legs_won} paid`
                        : 'No rounds settled on this day.'}>
                    <div className="text-slate-200">
                      {bal == null ? '—' : money(bal)}
                    </div>
                    <div className={`text-[10px] ${
                      !cell ? 'text-slate-700'
                        : pnl >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                      {cell ? signed(pnl) : 'no trades'}
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

function TradesTable({ positions, atrFor, atrLabel }) {
  const [openRound, setOpenRound] = useState(null)
  // Which legs have their fill breakdown open. A set rather than a single
  // id: a round can have more than one leg worth comparing at a time.
  const [openFills, setOpenFills] = useState(() => new Set())
  const toggleFills = (id) => setOpenFills((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const rounds = useMemo(() => {
    const by = new Map()
    for (const p of positions) {
      const g = by.get(p.round_id) ?? { roundId: p.round_id, legs: [] }
      g.legs.push(p)
      by.set(p.round_id, g)
    }
    return [...by.values()].map((g) => {
      const invested = g.legs.reduce(
        (a, p) => a + Number(p.entry_price) * Number(p.qty), 0)
      const returned = g.legs.reduce(
        (a, p) => a + Number(p.exit_price ?? 0) * Number(p.qty), 0)
      const fees = g.legs.reduce((a, p) => a + Number(p.fees ?? 0), 0)
      const code = String(g.roundId).split('-').pop()
      // Every leg of a round settles against the same underlying price, so
      // the first one that recorded it speaks for the round.
      const settledAt = g.legs.find((p) => p.settlement_spot != null)?.settlement_spot
      const winners = g.legs.filter((p) => Number(p.exit_price) >= 0.5).length
      // What the round pays if it comes good, worked out at entry: every
      // contract that finishes in the money pays exactly $1, so a leg's
      // payout is its contract count.
      //
      // Summing the legs would be wrong. The wings are on opposite sides,
      // and spot cannot finish both below the low strike and above the high
      // one, so they can never both pay. Legs on the SAME side do all pay
      // together - if spot clears the higher call strike it has cleared the
      // lower one too - so the honest figure is the better of the two sides.
      const bySide = g.legs.reduce((m, p) => {
        m[p.side] = (m[p.side] ?? 0) + Number(p.qty)
        return m
      }, {})
      const payout = Math.max(0, ...Object.values(bySide))
      // The round opened when its first leg filled and finished when its last
      // one did, so the row spans the legs rather than picking one of them.
      const entryTimes = g.legs.map((p) => p.entry_time).filter(Boolean)
        .map((t) => new Date(t).getTime())
      const exitTimes = g.legs.map((p) => p.exit_time).filter(Boolean)
        .map((t) => new Date(t).getTime())
      const openedAt = entryTimes.length ? Math.min(...entryTimes) : null
      const closedAt = exitTimes.length ? Math.max(...exitTimes) : null
      const asset = assetOf(g.roundId)
      return {
        ...g,
        openedAt,
        closedAt,
        entryAtr: atrFor(asset, openedAt),
        exitAtr: atrFor(asset, closedAt),
        expiry: expiryCodeToDate(code),
        strikes: [...new Set(g.legs.map((p) => Number(p.strike)))].sort((a, b) => a - b),
        invested,
        payout,
        returned,
        pnl: returned - invested - fees,
        settledAt: settledAt == null ? null : Number(settledAt),
        winners,
        closedEarly: g.legs.some((p) => p.status === 'closed'),
      }
    }).sort((a, b) => (b.expiry?.getTime() ?? 0) - (a.expiry?.getTime() ?? 0))
  }, [positions, atrFor])

  if (!rounds.length) {
    return <p className="py-10 text-center text-sm text-slate-600">No completed trades yet.</p>
  }

  const when = (d) => (d
    ? d.toLocaleString('en-US', { timeZone: IST, day: 'numeric', month: 'short',
                                  hour: 'numeric', minute: '2-digit', hour12: true })
    : '—')

  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[1040px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-white/10 text-[11px] uppercase tracking-wide
                         text-slate-500">
            <th className="px-4 py-2 text-left font-medium">Expiry <span className="font-normal normal-case text-slate-600">IST</span></th>
            <th className="px-2 py-2 text-left font-medium">Strikes</th>
            <th className="px-2 py-2 text-left font-medium" title={atrLabel}>Entry <span className="font-normal normal-case text-slate-600">IST</span></th>
            <th className="px-2 py-2 text-left font-medium" title={atrLabel}>Exit <span className="font-normal normal-case text-slate-600">IST</span></th>
            <th className="px-2 py-2 text-right font-medium">Settled at</th>
            <th className="px-2 py-2 text-right font-medium">Legs</th>
            <th className="px-2 py-2 text-right font-medium">Invested</th>
            <th className="px-2 py-2 text-right font-medium">Payout</th>
            <th className="px-2 py-2 text-right font-medium">Returned</th>
            <th className="px-2 py-2 text-right font-medium">P&amp;L</th>
            <th className="px-4 py-2 text-left font-medium">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => {
            const expanded = openRound === r.roundId
            return (
              <Fragment key={r.roundId}>
                <tr
                  onClick={() => setOpenRound(expanded ? null : r.roundId)}
                  className="cursor-pointer border-b border-white/5 transition-colors
                             hover:bg-white/5"
                >
                  <td className="px-4 py-2.5 text-slate-200">
                    <span className="mr-1.5 inline-block w-2 text-slate-600">
                      {expanded ? '▾' : '▸'}
                    </span>
                    {when(r.expiry)}
                  </td>
                  <td className="nums px-2 py-2.5 text-slate-400">
                    <span className="mr-1.5 rounded bg-white/5 px-1.5 py-px text-[10px]
                                     font-semibold text-slate-400">
                      {assetOf(r.roundId)}
                    </span>
                    {r.strikes.map((v) => v.toLocaleString('en-US')).join(' / ')}
                  </td>
                  <td className="nums px-2 py-2.5 text-slate-400">
                    <div className="text-slate-300">{clockOf(
                      r.openedAt ? new Date(r.openedAt).toISOString() : null)}</div>
                    <div className="text-[10px] text-slate-600">{atrText(r.entryAtr)}</div>
                  </td>
                  <td className="nums px-2 py-2.5 text-slate-400">
                    <div className="text-slate-300">{clockOf(
                      r.closedAt ? new Date(r.closedAt).toISOString() : null)}</div>
                    <div className="text-[10px] text-slate-600">{atrText(r.exitAtr)}</div>
                  </td>
                  <td className="nums px-2 py-2.5 text-right text-slate-400"
                      title="Underlying price when the round settled. This is the last
                             spot the worker saw before expiry, not the venue's published
                             figure - close to it, but not the same number.">
                    {r.settledAt == null ? '—' : money(r.settledAt)}
                  </td>
                  <td className="nums px-2 py-2.5 text-right text-slate-400"
                      title={r.legs
                        .map((l) => `${l.role} ${Number(l.strike).toLocaleString('en-US')}`
                                    + ` ${l.side}`)
                        .join(', ')}>
                    {r.legs.length}
                  </td>
                  <td className="nums px-2 py-2.5 text-right text-slate-300"
                      title="What the legs cost to open, at the price actually filled.">
                    {money(r.invested)}
                  </td>
                  <td className="nums px-2 py-2.5 text-right text-slate-400"
                      title="What this round pays if it wins, as it stood at entry.
                             Every winning contract pays $1. The two wings are on
                             opposite sides and cannot both win, so this is the better
                             side rather than the sum of the legs.">
                    <div>{money(r.payout)}</div>
                    <div className="text-[10px] text-slate-600">
                      {r.invested > 0 ? `${(r.payout / r.invested).toFixed(1)}x` : '—'}
                    </div>
                  </td>
                  <td className="nums px-2 py-2.5 text-right text-slate-300"
                      title="What came back: every winning contract pays $1.00, losers pay nothing.">
                    {money(r.returned)}
                  </td>
                  <td className={`nums px-2 py-2.5 text-right font-semibold ${
                    r.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {signed(r.pnl)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.pnl >= 0 ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-rose-500/15 text-rose-400'}`}>
                      {r.pnl >= 0 ? 'WON' : 'LOST'}
                    </span>
                    <span className="ml-1.5 text-[11px] text-slate-600">
                      {r.winners}/{r.legs.length} leg{r.legs.length > 1 ? 's' : ''} paid
                      {r.closedEarly && ' · closed early'}
                    </span>
                  </td>
                </tr>

                {expanded && r.legs.map((p) => (
                  <Fragment key={p.id ?? p.position_id}>
                  <tr className="bg-ink-950/40 text-[12px]">
                    <td className="py-1.5 pl-11 pr-2 text-slate-400">
                      <span className={`mr-1.5 rounded px-1 py-px text-[10px] font-bold
                                        text-white ${
                        p.side === 'call' ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                        {p.side === 'call' ? 'Y' : 'N'}
                      </span>
                      {p.role}
                    </td>
                    <td className="nums px-2 py-1.5 text-slate-400">
                      {Number(p.strike).toLocaleString('en-US')}
                    </td>
                    <td className="nums px-2 py-1.5 text-slate-500">
                      <div>{clockOf(p.entry_time)}</div>
                      <div className="text-[10px] text-slate-600"
                           title="ATR and the underlying price when this leg was bought.">
                        {atrText(atrFor(assetOf(r.roundId), p.entry_time
                          ? new Date(p.entry_time).getTime() : null))}
                        {spotText(p.entry_spot)}
                      </div>
                    </td>
                    <td className="nums px-2 py-1.5 text-slate-500">
                      <div>{clockOf(p.exit_time)}</div>
                      <div className="text-[10px] text-slate-600"
                           title={'ATR and the underlying price when this leg ended'
                                  + ' — whether it was closed early or held to'
                                  + ' settlement. Legs closed before this was'
                                  + ' recorded show no price.'}>
                        {atrText(atrFor(assetOf(r.roundId), p.exit_time
                          ? new Date(p.exit_time).getTime() : null))}
                        {spotText(p.exit_spot ?? p.settlement_spot)}
                      </div>
                    </td>
                    {/* Settled at is a property of the round, not the leg. */}
                    <td />
                    {/* Legs counts legs on the round row; a contract count
                        here would be the same heading meaning two things. The
                        size belongs with the money it bought. */}
                    <td />
                    <td className="nums px-2 py-1.5 text-right text-slate-400"
                        title={`${Number(p.qty).toLocaleString('en-US')} contracts at `
                               + Number(p.entry_price).toFixed(4)
                               + (Number(p.entry_fills) > 1
                                 ? `, bought in ${p.entry_fills} fills and averaged`
                                 : '')}>
                      <div>{money(Number(p.entry_price) * Number(p.qty))}</div>
                      {/* The only visible trace that partial entry did
                          anything: the fills are averaged into one position,
                          which is right, but it hides that it happened. */}
                      {Number(p.entry_fills) > 1 && (
                        <button
                          onClick={() => toggleFills(p.id ?? p.position_id)}
                          title="Show each fill that built this leg"
                          className="text-[10px] text-sky-500/80 transition-colors
                                     hover:text-sky-400"
                        >
                          {openFills.has(p.id ?? p.position_id) ? '▾' : '▸'}{' '}
                          {p.entry_fills} fills
                        </button>
                      )}
                    </td>
                    <td className="nums px-2 py-1.5 text-right text-slate-500"
                        title={`${Number(p.qty).toLocaleString('en-US')} contracts at `
                               + `$1.00 each if this leg finishes in the money`}>
                      {money(Number(p.qty))}
                    </td>
                    <td className="nums px-2 py-1.5 text-right text-slate-400">
                      {p.exit_price === null || p.exit_price === undefined
                        ? '—' : money(Number(p.exit_price) * Number(p.qty))}
                    </td>
                    <td className={`nums px-2 py-1.5 text-right ${
                      Number(p.pnl ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                      {signed(Number(p.pnl ?? 0))}
                    </td>
                    <td className={`px-4 py-1.5 text-[11px] ${
                      Number(p.pnl ?? 0) >= 0 ? 'text-emerald-400/70' : 'text-slate-500'}`}>
                      {p.exit_price === null || p.exit_price === undefined
                        ? '' : Number(p.pnl ?? 0) >= 0 ? 'Won' : 'Lost'}
                    </td>
                  </tr>
                  <FillRows
                    fills={p.fills}
                    open={openFills.has(p.id ?? p.position_id)} />
                  </Fragment>
                ))}

                {expanded && (
                  <tr className="bg-ink-950/40">
                    <td colSpan={11} className="px-4 pb-2.5 pl-11 text-[11px] text-slate-600">
                      {[...new Set(r.legs.map((p) => p.exit_reason).filter(Boolean))]
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function PortfolioTabs({ account, accountId, slippage = 0.05,
                                        refreshKey = 0, mode = 'paper' }) {
  const [tab, setTab] = useState('positions')
  // Which trades the figures describe. Mixing hand-placed trades into a
  // round win rate makes it meaningless: a manual single leg is not a
  // round the strategy played.
  const [scope, setScope] = useState('strategy')
  const [positions, setPositions] = useState([])
  const [marks, setMarks] = useState({})
  const [error, setError] = useState(null)
  // Latest close order per position, so a card can say "Closing…" or explain a
  // rejection. Keyed by position_id.
  const [closes, setCloses] = useState({})
  const [closesOffline, setClosesOffline] = useState(false)
  // ATR settings come from the account's filters, so history is read through
  // whatever rule is currently in force rather than a value frozen at entry.
  const [atrCfg, setAtrCfg] = useState({ resolution: '15m', period: 14 })
  // One running ATR series per underlying, keyed by asset.
  const [atrByAsset, setAtrByAsset] = useState({})
  // Bridges the gap between the click and the row appearing in the next poll.
  const [busy, setBusy] = useState({})
  // Ticks the expiry countdowns. The data polls are far slower than a second
  // and a clock that jumps in 2.5s steps reads as broken.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!accountId) return
    let alive = true
    fetchStrategyConfig(accountId)
      .then((cfg) => {
        if (!alive || !cfg) return
        setAtrCfg({
          resolution: cfg.atr_resolution ?? '15m',
          period: Number(cfg.atr_period ?? 14),
        })
      })
      .catch(() => { /* fall back to the defaults above */ })
    return () => { alive = false }
  }, [accountId, refreshKey])

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
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [load])

  // A fill just landed; don't make the user wait for the next tick.
  useEffect(() => { if (refreshKey) load() }, [refreshKey, load])

  // Candles for the ATR shown in trade history. One request per underlying
  // covering the whole history, rather than one per trade — a few hundred legs
  // would otherwise be a few hundred round-trips.
  // Primitives, not an object. positions is a fresh array every poll, so a
  // memo returning `{assets, from}` handed the effect a new identity every
  // 2.5s and it refetched the same candles each time — four requests where
  // one was due. A string and a number compare by value and settle.
  const atrAssets = useMemo(() => [...new Set(positions
    .filter((p) => p.status !== 'open')
    .map((p) => assetOf(p.round_id))
    .filter(Boolean))].sort().join(','), [positions])

  const atrFrom = useMemo(() => {
    const stamps = positions
      .filter((p) => p.status !== 'open')
      .flatMap((p) => [p.entry_time, p.exit_time])
      .filter(Boolean)
      .map((t) => new Date(t).getTime())
      .filter(Number.isFinite)
    return stamps.length ? Math.min(...stamps) : null
  }, [positions])

  const { resolution: atrResolution, period: atrPeriod } = atrCfg

  useEffect(() => {
    if (!atrAssets || atrFrom == null) { setAtrByAsset({}); return }
    let alive = true
    const resolution = atrResolution
    const period = atrPeriod
    const hours = lookbackHours(atrFrom, resolution, period)
    Promise.all(atrAssets.split(',').map(async (asset) => {
      try {
        const rows = await fetchCandles(indexSymbolFor(asset), resolution, hours)
        return [asset, atrSeries(rows, period, resolution)]
      } catch {
        return [asset, []]
      }
    })).then((pairs) => { if (alive) setAtrByAsset(Object.fromEntries(pairs)) })
    return () => { alive = false }
  }, [atrAssets, atrFrom, atrResolution, atrPeriod])

  const atrFor = useCallback((asset, tsMs) => {
    if (!Number.isFinite(tsMs)) return null
    return atrAt(atrByAsset[asset], Math.floor(tsMs / 1000))
  }, [atrByAsset])

  const atrLabel = `Wilder ATR(${atrCfg.period}) on ${atrCfg.resolution} candles,`
    + ' taken from the filters this account is running now'

  // What each open position is actually worth, walked through the book for
  // its own size. The ticker's best_bid is both stale and top-of-book only, so
  // "Close at $4.85" was a price the book would not have paid — the same
  // mistake the YES/NO buttons used to make, and the reason a close could come
  // back rejected for slippage the panel never showed.
  const openSymbols = useMemo(
    () => [...new Set(positions.filter((p) => p.status === 'open')
      .map((p) => `${p.symbol}|${p.qty}`))].join(','),
    [positions])

  useEffect(() => {
    if (!openSymbols) { setMarks({}); return }
    let alive = true
    const wanted = openSymbols.split(',').map((s) => {
      const [symbol, qty] = s.split('|')
      return { symbol, qty: Number(qty) }
    })
    const tick = () => {
      for (const { symbol, qty } of wanted) {
        fetchOrderbook(symbol)
          .then((book) => {
            if (!alive) return
            const walk = walkBook(book, 'sell', qty)
            setMarks((prev) => ({
              ...prev,
              [symbol]: walk.filled
                ? { price: walk.avgPrice, top: walk.top, ok: true }
                : { price: null, ok: false, reason: walk.reason },
            }))
          })
          .catch(() => {})
      }
    }
    tick()
    const t = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(t) }
  }, [openSymbols])

  // Close orders in flight. Stops polling once the column turns out to be
  // missing, so an un-run migration is one failed request rather than one
  // every four seconds.
  const loadCloses = useCallback(() => {
    if (!accountId || closesOffline) return
    fetchRecentCloses(accountId, 40)
      .then((rows) => {
        const latest = {}
        // Newest first, so the first row seen for a position is its latest.
        for (const r of rows) {
          const key = r.close_position_id
          if (key && !(key in latest)) latest[key] = r
        }
        setCloses(latest)
        setBusy((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(next)) if (latest[key]) delete next[key]
          return next
        })
      })
      .catch((e) => {
        const msg = `${e?.message ?? e}`
        if (/action|close_position_id|schema cache|does not exist|PGRST205|404|400/i
            .test(msg)) {
          setClosesOffline(true)
        }
      })
  }, [accountId, closesOffline])

  useEffect(() => {
    if (closesOffline) return
    loadCloses()
    const t = setInterval(loadCloses, 3000)
    return () => clearInterval(t)
  }, [loadCloses, closesOffline])

  const requestClose = useCallback(async (p, quoted) => {
    const pid = p.position_id
    setBusy((prev) => ({ ...prev, [pid]: true }))
    try {
      await placeManualClose({
        positionId: pid,
        symbol: p.symbol,
        roundId: p.round_id,
        // Top of book, not the walked average. The worker measures drift
        // against this; sending the walked price would make drift ~0 and
        // disable the tolerance check entirely.
        quotedPrice: quoted ?? null,
        slippageTolerance: slippage,
        accountId,
      })
      loadCloses()
    } catch (e) {
      setBusy((prev) => { const n = { ...prev }; delete n[pid]; return n })
      setError(e.message ?? String(e))
    }
  }, [accountId, slippage, loadCloses])

  const open = useMemo(
    () => positions.filter((p) => p.status === 'open'), [positions])
  const closed = useMemo(
    () => positions.filter((p) => p.status !== 'open'), [positions])
  // Open legs grouped by round, soonest expiry first — the round you have to
  // act on before the halt is the one at the top.
  const openRounds = useMemo(() => {
    const by = new Map()
    for (const p of open) {
      if (!by.has(p.round_id)) by.set(p.round_id, [])
      by.get(p.round_id).push(p)
    }
    const when = (rid) => expiryCodeToDate(String(rid).split('-').pop())?.getTime() ?? 0
    return [...by.entries()].sort((a, b) => when(a[0]) - when(b[0]))
  }, [open])

  const rows = tab === 'positions' ? open : closed

  // Realised performance, from the same helper the CLI report uses so the two
  // can never disagree.
  const scoped = useMemo(() => positions.filter(
    (p) => scope === 'all' ? true
      : scope === 'manual' ? p.role === 'manual'
        : p.role !== 'manual'), [positions, scope])

  const perf = useMemo(
    () => summarise(scoped, Number(account?.starting_balance) || 0),
    [scoped, account?.starting_balance])

  // Unrealised, from the depth-walked marks already fetched for the cards, so
  // this is what the book would actually pay to close everything right now -
  // not a top-of-book figure that no size could get.
  const scopedOpen = useMemo(
    () => scoped.filter((p) => p.status === 'open'), [scoped])
  // Same arithmetic as each round's header, so the total and the rounds
  // beneath it cannot disagree.
  const openTotal = useMemo(() => combine(scopedOpen, marks), [scopedOpen, marks])
  const unreal = openTotal.pnl
  const committed = useMemo(
    () => scopedOpen.reduce((a, p) => a + Number(p.entry_price) * Number(p.qty), 0),
    [scopedOpen])

  return (
    <div className="rounded-xl border border-white/10 bg-ink-900">
      {/* Performance. Round win rate leads because on a strangle most legs
          lose by design - a leg rate near 25% is normal and says nothing. */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Performance
        </h3>
        <div className="flex gap-0.5 rounded-lg border border-white/10 bg-ink-800 p-0.5">
          {[['strategy', 'Strategy'], ['manual', 'Manual'], ['all', 'All']].map(
            ([k, label]) => (
              <button
                key={k} onClick={() => setScope(k)}
                className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                  scope === k ? 'bg-sky-500/20 text-sky-300'
                    : 'text-slate-500 hover:text-slate-300'}`}
              >
                {label}
              </button>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-white/5 px-4 pb-3 pt-2
                      sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Realised P&L"
          value={fmt.usd(perf.totalPnl)}
          tone={perf.totalPnl}
          sub={`${fmt.pct(perf.returnPct)} of starting`}
        />
        <Stat
          label="Unrealised"
          value={scopedOpen.length ? fmt.usd(unreal) : '—'}
          tone={scopedOpen.length ? unreal : undefined}
          sub={!scopedOpen.length ? 'nothing open'
            : openTotal.priced < openTotal.total
              ? `${openTotal.priced} of ${openTotal.total} legs priced · ${fmt.usd(committed)} in`
              : `${scopedOpen.length} open · ${fmt.usd(committed)} in`}
        />
        <Stat
          label="Round win rate"
          value={perf.rounds ? fmt.pct(perf.roundWinRate, 0) : '—'}
          sub={perf.rounds ? `${perf.rounds} round${perf.rounds > 1 ? 's' : ''} settled` : ''}
        />
        <Stat
          label="Avg / round"
          value={perf.rounds ? fmt.usd(perf.avgPerRound) : '—'}
          tone={perf.rounds ? perf.avgPerRound : undefined}
          sub={perf.rounds ? `${fmt.pct(perf.legWinRate, 0)} of legs won` : ''}
        />
        <Stat
          label="Slippage paid"
          value={fmt.usd(perf.slippageCost)}
          sub={perf.totalCost ? `${fmt.pct(100 * perf.slippageCost / perf.totalCost)} of cost` : ''}
        />
        <Stat
          label="Max drawdown"
          value={fmt.usd(perf.maxDrawdown)}
          tone={perf.maxDrawdown ? -1 : undefined}
          sub="worst run of rounds"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2
                      border-b border-white/5 px-4">
        <div className="flex gap-6">
        {[['positions', 'Positions', open.length],
          ['trades', 'Recent Trades', closed.length],
          ['daily', mode === 'live' ? 'Daily · live accounts'
                                    : 'Daily · paper accounts', 0]].map(([key, label, n]) => (
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

        {/* History, not a view of the current tab, so it stays put rather
            than appearing only under Recent Trades. */}
        <ExportTrades accountId={accountId} accountName={account?.name} mode={mode} />
      </div>

      <div className="p-4">
        {error && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                        text-xs text-rose-300">
            {error}
          </p>
        )}

        {closesOffline && tab === 'positions' && (
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                        text-xs text-amber-300">
            Closing early needs{' '}
            <code className="rounded bg-black/30 px-1">
              supabase/migrations/005_manual_close.sql
            </code>{' '}
            run once.
          </p>
        )}

        {/* Open positions stay as cards - each one is a live thing you might
            act on. History is a table grouped by round, because by then the
            question is how the round did, not what each leg looked like. */}
        {tab === 'positions' ? (
          <>
            {!error && !open.length && (
              <p className="py-10 text-center text-sm text-slate-600">
                No open positions.
              </p>
            )}
            <div className="space-y-3">
              {openRounds.map(([roundId, legs]) => (
                <OpenRound key={roundId} roundId={roundId} legs={legs} marks={marks}>
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {legs.map((p) => (
                      <OpenCard
                        key={p.id ?? p.position_id}
                        p={p}
                        mark={marks[p.symbol]}
                        close={closes[p.position_id]}
                        busy={Boolean(busy[p.position_id])}
                        tolerance={slippage}
                        now={now}
                        onClose={requestClose}
                      />
                    ))}
                  </div>
                </OpenRound>
              ))}
            </div>
          </>
        ) : tab === 'daily' ? (
          <DailyTable mode={mode} />
        ) : (
          <TradesTable positions={closed} atrFor={atrFor} atrLabel={atrLabel} />
        )}
      </div>
    </div>
  )
}
