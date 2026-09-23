import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAccountPositions, fetchRecentCloses, placeManualClose,
} from '../lib/supabase'
import { fetchOrderbook, walkBook, expiryCodeToDate } from '../lib/delta'
import { summarise, fmt } from '../lib/stats'

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

/** Expiry lives in the round id: BTC-DDMMYYHHMM. */
function expiryOf(roundId) {
  const code = String(roundId ?? '').split('-').pop()
  return /^\d{10}$/.test(code) ? expiryCodeToDate(code) : null
}

const clockLabel = (d) => (d
  ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase()
  : '—')

/** Time left, as mm:ss, or hh:mm:ss once it runs past an hour. */
function countdown(ms) {
  if (ms === null || ms === undefined) return null
  const s = Math.max(0, Math.round(ms / 1000))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
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

function CardHead({ p, status, tone, now }) {
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
            BTC above {Number(p.strike).toLocaleString('en-US')}
          </p>
          {/* Expiry leads: on an open position the question is how long is
              left, not when it was opened. */}
          <p className="nums mt-0.5 text-[11px] text-slate-400">
            Expires {clockLabel(expiry)}
            {left !== null && (
              <span className={halted ? 'text-amber-400'
                : done ? 'text-slate-600' : 'text-slate-500'}>
                {done ? ' · settling' : ` · ${countdown(left)} left`}
                {halted && ' (halted)'}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-600">
            opened {whenLabel(p.entry_time)}
          </p>
        </div>
      </div>
      <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
        {status}
      </span>
    </div>
  )
}

function OpenCard({ p, mark, close, onClose, busy, tolerance, now }) {
  const invested = Number(p.entry_price) * Number(p.qty)
  const exitPrice = mark?.ok ? mark.price : null
  const value = exitPrice === null ? null : exitPrice * Number(p.qty)
  const unreal = value === null ? null : value - invested

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
      <CardHead p={p} status="Open" tone="bg-sky-500/15 text-sky-400" now={now} />
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

      <button
        onClick={() => onClose(p, mark?.top)}
        disabled={pending || exitPrice === null || tooDeep}
        title={exitPrice === null
          ? (mark?.reason ?? 'No bid quoted — nothing to sell into')
          : `Sells ${Number(p.qty).toLocaleString('en-US')} contracts into the book at an average of ${Number(exitPrice).toFixed(4)}.`}
        className="mt-3 w-full rounded-lg border border-white/10 bg-ink-700 py-2 text-xs
                   font-medium text-slate-200 transition-colors hover:border-white/25
                   hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending
          ? 'Closing…'
          : value === null ? 'Close' : `Close at ${money(value)}`}
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
function TradesTable({ positions }) {
  const [openRound, setOpenRound] = useState(null)

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
      return {
        ...g,
        expiry: expiryCodeToDate(code),
        strikes: [...new Set(g.legs.map((p) => Number(p.strike)))].sort((a, b) => a - b),
        invested,
        returned,
        pnl: returned - invested - fees,
        settledAt: settledAt == null ? null : Number(settledAt),
        winners,
        closedEarly: g.legs.some((p) => p.status === 'closed'),
      }
    }).sort((a, b) => (b.expiry?.getTime() ?? 0) - (a.expiry?.getTime() ?? 0))
  }, [positions])

  if (!rounds.length) {
    return <p className="py-10 text-center text-sm text-slate-600">No completed trades yet.</p>
  }

  const when = (d) => (d
    ? d.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric',
                                  minute: '2-digit', hour12: true })
    : '—')

  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-white/10 text-[11px] uppercase tracking-wide
                         text-slate-500">
            <th className="px-4 py-2 text-left font-medium">Expiry</th>
            <th className="px-2 py-2 text-left font-medium">Strikes</th>
            <th className="px-2 py-2 text-right font-medium">Settled at</th>
            <th className="px-2 py-2 text-right font-medium">Legs</th>
            <th className="px-2 py-2 text-right font-medium">Invested</th>
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
                    {r.strikes.map((v) => v.toLocaleString('en-US')).join(' / ')}
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
                  <tr key={p.id ?? p.position_id} className="bg-ink-950/40 text-[12px]">
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
                    {/* Settled at is a property of the round, not the leg. */}
                    <td />
                    <td className="nums px-2 py-1.5 text-right text-slate-500">
                      {Number(p.qty).toLocaleString('en-US')}
                    </td>
                    {/* Money under the money columns. The price is what each
                        contract cost, not what the leg cost - showing 0.3307
                        under a heading that says Invested reads as a bug. */}
                    <td className="nums px-2 py-1.5 text-right text-slate-400">
                      {money(Number(p.entry_price) * Number(p.qty))}
                      <span className="ml-1 text-[10px] text-slate-600">
                        @{Number(p.entry_price).toFixed(4)}
                      </span>
                    </td>
                    <td className="nums px-2 py-1.5 text-right text-slate-400">
                      {p.exit_price === null || p.exit_price === undefined
                        ? '—'
                        : (<>
                            {money(Number(p.exit_price) * Number(p.qty))}
                            <span className="ml-1 text-[10px] text-slate-600">
                              @{Number(p.exit_price).toFixed(4)}
                            </span>
                          </>)}
                    </td>
                    <td className={`nums px-2 py-1.5 text-right ${
                      Number(p.pnl ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                      {signed(Number(p.pnl ?? 0))}
                    </td>
                    <td className="px-4 py-1.5 text-[11px] text-slate-500">
                      {p.exit_price === null || p.exit_price === undefined ? ''
                        : Number(p.exit_price) >= 0.5 ? 'paid $1.00' : 'expired'}
                    </td>
                  </tr>
                ))}

                {expanded && (
                  <tr className="bg-ink-950/40">
                    <td colSpan={8} className="px-4 pb-2.5 pl-11 text-[11px] text-slate-600">
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
                                        refreshKey = 0 }) {
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
  // Bridges the gap between the click and the row appearing in the next poll.
  const [busy, setBusy] = useState({})
  // Ticks the expiry countdowns. The data polls are far slower than a second
  // and a clock that jumps in 2.5s steps reads as broken.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

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
  const unreal = useMemo(() => scopedOpen.reduce((a, p) => {
    const m = marks[p.symbol]
    if (!m?.ok) return a
    return a + (m.price - Number(p.entry_price)) * Number(p.qty)
  }, 0), [scopedOpen, marks])
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
          sub={scopedOpen.length
            ? `${scopedOpen.length} open · ${fmt.usd(committed)} in` : 'nothing open'}
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
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {open.map((p) => (
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
          </>
        ) : (
          <TradesTable positions={closed} />
        )}
      </div>
    </div>
  )
}
