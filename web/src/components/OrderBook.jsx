import { useState } from 'react'

/**
 * Order book in Delta's own layout, one panel per leg of the selected strike
 * (YES and NO side by side): asks above, the last traded price large in the
 * middle with the mark price beside it, bids below, then the contract's recent
 * trades. Price grouping and the both / asks / bids switch work as they do on
 * Delta.
 *
 * The books are the ones TradePanel already polls every 2s for its price
 * preview, and read the same on live and paper accounts - the book is Delta's
 * either way; only where a paper fill lands is simulated.
 */

// Grouping steps in ticks of 0.0001, the binaries' tick size.
const GROUPS = [['0.0001', 1], ['0.001', 10], ['0.005', 50], ['0.01', 100]]
const LEVELS_SHOWN = 20
const TRADES_SHOWN = 30
const BAR_ROWS = 9

// Three decimals is how the ticket shows a price; a fourth only when needed.
function px(p) {
  const s = Number(p).toFixed(4)
  return s.endsWith('0') ? s.slice(0, -1) : s
}
const qty = (v) => Math.round(Number(v)).toLocaleString('en-US')
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Best level first, grouped to `step` ticks (asks round up, bids round down,
// so a group never shows a better price than its worst member), with the
// running total from the touch outwards.
function side(levels, key, step) {
  const groups = new Map()
  for (const l of levels ?? []) {
    const ticks = Math.round(Number(l.price) * 10000)
    const size = Number(l.size)
    if (!Number.isFinite(ticks) || !(size > 0)) continue
    const g = (key === 'sell' ? Math.ceil(ticks / step) : Math.floor(ticks / step)) * step
    groups.set(g, (groups.get(g) ?? 0) + size)
  }
  const rows = [...groups.entries()]
    .map(([t, size]) => ({ price: t / 10000, size }))
    .sort((a, b) => (key === 'sell' ? a.price - b.price : b.price - a.price))
    .slice(0, LEVELS_SHOWN)
  let total = 0
  return rows.map((r) => ({ ...r, total: (total += r.size) }))
}

// Delta's three-way switch: both sides, asks only, bids only. Coloured blocks
// on the left say which sides show; the lines stand for the rows.
function ViewIcon({ mode }) {
  const top = mode === 'bids' ? 'fill-emerald-500' : 'fill-rose-500'
  const bottom = mode === 'asks' ? 'fill-rose-500' : 'fill-emerald-500'
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="1" y="2" width="5" height="5" rx="0.6" className={top} />
      <rect x="1" y="9" width="5" height="5" rx="0.6" className={bottom} />
      {[2.5, 5, 7.5, 10, 12.5].map((y) => (
        <rect key={y} x="8" y={y} width="7" height="1.3" rx="0.4" className="fill-slate-400" />
      ))}
    </svg>
  )
}

function Book({ label, tone, leg, book, trades, now }) {
  const [group, setGroup] = useState(1)
  const [view, setView] = useState('both')
  const asks = side(book?.sell, 'sell', group)
  const bids = side(book?.buy, 'buy', group)
  // Bars scale to what is on screen without scrolling, as Delta's do, so the
  // visible rows use the full width; deeper rows cap at full.
  const max = Math.max(asks[BAR_ROWS - 1]?.total ?? asks.at(-1)?.total ?? 0,
                       bids[BAR_ROWS - 1]?.total ?? bids.at(-1)?.total ?? 0, 1)
  const last = trades?.[0]
  // last_updated_at (microseconds) is when Delta last changed the book, not
  // when it was fetched - that is every 2s. A contract pinned at the price
  // limits (1.000 / 0.969, 0.031 / 0.001) can sit unchanged for minutes.
  const ageSec = book?.last_updated_at ? (now - book.last_updated_at / 1000) / 1000 : null
  const stale = ageSec !== null && ageSec > 15
  const rowsH = view === 'both' ? 'max-h-[216px]' : 'max-h-[432px]'

  const row = (r, kind) => (
    <div key={`${kind}${r.price}`} className="grid shrink-0 grid-cols-3 items-center px-3 py-[3px]">
      <span className={kind === 'ask' ? 'text-rose-400' : 'text-emerald-400'}>{px(r.price)}</span>
      <span className="text-right text-slate-200">{qty(r.size)}</span>
      <span className="relative ml-3 text-right text-slate-200">
        <span className={`absolute inset-y-[-2px] left-0 rounded-sm ${
          kind === 'ask' ? 'bg-rose-500/20' : 'bg-emerald-500/20'}`}
              style={{ width: `${Math.min(1, r.total / max) * 100}%` }} />
        <span className="relative">{qty(r.total)}</span>
      </span>
    </div>
  )

  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-ink-950">
      {/* Header: title, grouping, view switch */}
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <span className={`truncate text-[13px] font-semibold ${tone}`} title={leg?.symbol ?? ''}>{label}</span>
        <div className="flex shrink-0 items-center gap-2">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))}
                  aria-label="Price grouping"
                  className="nums cursor-pointer bg-ink-950 text-[12px] text-slate-400 outline-none [color-scheme:dark] hover:text-slate-200">
            {GROUPS.map(([name, step]) => <option key={step} value={step}>{name}</option>)}
          </select>
          <div className="flex rounded bg-white/5 p-0.5" role="group" aria-label="Book view">
            {['both', 'asks', 'bids'].map((m) => (
              <button key={m} onClick={() => setView(m)} aria-pressed={view === m}
                      title={m === 'both' ? 'Bids and asks' : m === 'asks' ? 'Asks only' : 'Bids only'}
                      className={`rounded p-0.5 ${view === m ? 'bg-white/15' : 'opacity-50 hover:opacity-100'}`}>
                <ViewIcon mode={m} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="nums text-[12px]">
        <div className="grid grid-cols-3 px-3 pb-1 pt-2 text-[11px] text-slate-500">
          <span>Price (USD)</span>
          <span className="text-right">Size (Cont)</span>
          <span className="text-right">Total (Cont)</span>
        </div>

        {!leg ? (
          <p className="px-3 py-8 text-center text-slate-600">No contract</p>
        ) : !book ? (
          <p className="px-3 py-8 text-center text-slate-600">Loading book…</p>
        ) : (
          <>
            {/* Asks: highest at the top, best ask against the price line.
                flex-col-reverse keeps the scroll pinned to the best ask. */}
            {view !== 'bids' && (
              <div className={`flex ${rowsH} flex-col-reverse overflow-y-auto`}>
                {asks.length ? asks.map((r) => row(r, 'ask'))
                  : <p className="px-3 py-2 text-slate-600">No asks</p>}
              </div>
            )}

            {/* Last traded price, large, coloured by who took it; mark beside it. */}
            <div className="flex items-center justify-between border-y border-white/5 px-3 py-1.5">
              <span className={`text-xl font-semibold ${
                !last ? 'text-slate-500' : last.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}
                    title={last ? `Last trade ${clock(last.time)} IST` : 'No trades yet'}>
                {last ? px(last.price) : '—'}
              </span>
              {stale && (
                <span className="nums ml-auto mr-3 text-[10px] text-amber-400"
                      title="Delta's quotes on this contract have not moved for this long. The book itself is fetched every 2s.">
                  unchanged {Math.round(ageSec)}s
                </span>
              )}
              <span className="flex items-center gap-1.5 text-slate-300" title="Mark price">
                <span className="rounded border border-slate-500 px-1 text-[10px] leading-4 text-slate-400">M</span>
                <span className="border-b border-dashed border-slate-500">
                  {leg.mark != null ? px(leg.mark) : '—'}
                </span>
              </span>
            </div>

            {view !== 'asks' && (
              <div className={`${rowsH} overflow-y-auto`}>
                {bids.length ? bids.map((r) => row(r, 'bid'))
                  : <p className="px-3 py-2 text-slate-600">No bids</p>}
              </div>
            )}
          </>
        )}

        {/* Recent trades: price and the way it went, size, time / taker side.
            Left out entirely until the contract has traded - most strikes
            never do, and an empty table only read as broken. */}
        {leg && trades?.length > 0 && (
          <div className="border-t border-white/10">
            <p className="px-3 pb-1 pt-2.5 text-[13px] text-slate-200">Recent Trades</p>
            <div className="grid grid-cols-[1fr_1fr_1.3fr] px-3 pb-1 text-[11px] text-slate-500">
              <span>Price (USD)</span>
              <span className="text-right">Size (Cont)</span>
              <span className="text-right">Time/Taker</span>
            </div>
            <div className="max-h-[180px] overflow-y-auto pb-1.5">
              {trades.slice(0, TRADES_SHOWN).map((t, i) => (
                <div key={`${t.time}-${i}`} className="grid grid-cols-[1fr_1fr_1.3fr] px-3 py-[3px]">
                  <span className={t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                    {px(t.price)} {t.side === 'buy' ? '↗' : '↙'}
                  </span>
                  <span className="text-right text-slate-200">{qty(t.size)}</span>
                  <span className="text-right text-slate-300">
                    {clock(t.time)} /<span className={t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                      {t.side === 'buy' ? 'B' : 'S'}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function OrderBook({ strike, yesLeg, noLeg, yesBook, noBook, now,
                                    yesTrades, noTrades }) {
  const at = strike !== null && strike !== undefined ? strike.toLocaleString('en-US') : '—'
  return (
    <div className="border-t border-white/5 px-2 py-3">
      <p className="mb-2 px-2 text-xs font-medium text-slate-300">
        Order Book <span className="text-slate-600">· live from Delta, every 2s</span>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Book label={`YES · Above ${at}`} tone="text-emerald-400"
              leg={yesLeg} book={yesBook} trades={yesTrades} now={now} />
        <Book label={`NO · Below ${at}`} tone="text-rose-400"
              leg={noLeg} book={noBook} trades={noTrades} now={now} />
      </div>
    </div>
  )
}
