import { useState } from 'react'

const DEPTHS = [5, 10]

// Delta books are 20 levels a side, quoted to the tick. Three decimals is how
// the ticket shows a price; a fourth only appears when the tick needs it.
function px(p) {
  const s = Number(p).toFixed(4)
  return s.endsWith('0') ? s.slice(0, -1) : s
}

const qty = (v) => Math.round(Number(v)).toLocaleString('en-US')

const TRADES_SHOWN = 10
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Best level first, with the running total from the touch outwards: "Total"
// is how many contracts you could take before the price moves past that row.
function side(levels, key, n) {
  const rows = (levels ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.size > 0)
    .sort((a, b) => (key === 'sell' ? a.price - b.price : b.price - a.price))
    .slice(0, n)
  let total = 0
  return rows.map((r) => ({ ...r, total: (total += r.size) }))
}

// Newest first. Green when the taker bought (lifted the ask), red when the
// taker sold (hit the bid) - the side that moved the price.
function Trades({ trades }) {
  return (
    <div className="mt-2 border-t border-white/5 pt-1.5">
      <div className="grid grid-cols-3 px-2 pb-1 text-[10px] uppercase tracking-wider text-slate-600">
        <span>Recent trades</span>
        <span className="text-right">Price</span>
        <span className="text-right">Qty</span>
      </div>
      {!trades ? (
        <p className="px-2 py-2 text-center text-slate-600">Loading trades…</p>
      ) : !trades.length ? (
        <p className="px-2 py-2 text-center text-slate-600">No trades yet</p>
      ) : trades.slice(0, TRADES_SHOWN).map((t, i) => (
        <div key={`${t.time}-${i}`} className="grid grid-cols-3 px-2 py-[3px]">
          <span className="text-slate-500">{clock(t.time)}</span>
          <span className={`text-right ${t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {px(t.price)}
          </span>
          <span className="text-right text-slate-300">{qty(t.size)}</span>
        </div>
      ))}
    </div>
  )
}

function Ladder({ label, tone, leg, book, depth, now, trades }) {
  const asks = side(book?.sell, 'sell', depth)
  const bids = side(book?.buy, 'buy', depth)
  // One scale for both halves, so a deep bid side reads as deeper than a thin
  // ask side rather than each filling its own width.
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0, 1)
  const spread = asks.length && bids.length ? asks[0].price - bids[0].price : null
  // last_updated_at (microseconds) is when Delta last changed the book, not
  // when it was fetched - that is every 2s. A contract pinned at the price
  // limits (1.000 / 0.969, 0.031 / 0.001) can sit unchanged for minutes.
  const ageSec = book?.last_updated_at ? (now - book.last_updated_at / 1000) / 1000 : null
  const stale = ageSec !== null && ageSec > 15
  const last = trades?.[0]

  const row = (r, kind) => (
    <div key={`${kind}${r.price}`} className="relative grid grid-cols-3 px-2 py-[3px]">
      <div
        className={`absolute inset-y-px right-0 rounded-sm ${
          kind === 'ask' ? 'bg-rose-500/15' : 'bg-emerald-500/15'}`}
        style={{ width: `${(r.total / max) * 100}%` }}
      />
      <span className={`relative ${kind === 'ask' ? 'text-rose-400' : 'text-emerald-400'}`}>
        {px(r.price)}
      </span>
      <span className="relative text-right text-slate-300">{qty(r.size)}</span>
      <span className="relative text-right text-slate-500">{qty(r.total)}</span>
    </div>
  )

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-2">
        <span className={`text-xs font-semibold ${tone}`} title={leg?.symbol ?? ''}>
          {label}
        </span>
        {stale && (
          <span className="nums text-[10px] text-amber-400"
                title="Delta's quotes on this contract have not moved for this long. The book itself is fetched every 2s.">
            unchanged {Math.round(ageSec)}s
          </span>
        )}
      </div>
      <div className="nums text-[11px]">
        <div className="grid grid-cols-3 px-2 pb-1 text-[10px] uppercase tracking-wider text-slate-600">
          <span>Price</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Total</span>
        </div>
        {!leg ? (
          <p className="px-2 py-6 text-center text-slate-600">No contract</p>
        ) : !book ? (
          <p className="px-2 py-6 text-center text-slate-600">Loading book…</p>
        ) : (
          <>
            {/* Asks printed highest first, so the best ask sits on the spread
                line and both best prices meet in the middle. */}
            {asks.length
              ? [...asks].reverse().map((r) => row(r, 'ask'))
              : <p className="px-2 py-1 text-slate-600">No asks</p>}
            <div className="my-0.5 border-y border-white/5 px-2 py-0.5 text-center text-[10px] text-slate-500">
              {spread !== null ? `spread ${px(spread)}` : '—'}
              {last && <> · last <span className={last.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                {px(last.price)}</span></>}
            </div>
            {bids.length
              ? bids.map((r) => row(r, 'bid'))
              : <p className="px-2 py-1 text-slate-600">No bids</p>}
          </>
        )}
        {leg && <Trades trades={trades} />}
      </div>
    </div>
  )
}

/**
 * Bid/ask ladder for the YES and NO legs of the selected strike, each with its
 * recent trades underneath. Draws the books TradePanel already polls for its
 * price preview, and reads the same on live and paper accounts - the book is
 * Delta's either way; only where a paper fill lands is simulated.
 */
export default function OrderBook({ strike, yesLeg, noLeg, yesBook, noBook, now,
                                    yesTrades, noTrades }) {
  const [depth, setDepth] = useState(DEPTHS[0])
  const at = strike !== null && strike !== undefined ? strike.toLocaleString('en-US') : '—'

  return (
    <div className="border-t border-white/5 px-2 py-3">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-xs font-medium text-slate-300">
          Order book <span className="text-slate-600">· live from Delta, every 2s</span>
        </span>
        <div className="flex gap-0.5" role="group" aria-label="Levels shown">
          {DEPTHS.map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                depth === d ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Ladder label={`YES · Above ${at}`} tone="text-emerald-400"
                leg={yesLeg} book={yesBook} depth={depth} now={now} trades={yesTrades} />
        <Ladder label={`NO · Below ${at}`} tone="text-rose-400"
                leg={noLeg} book={noBook} depth={depth} now={now} trades={noTrades} />
      </div>
    </div>
  )
}
