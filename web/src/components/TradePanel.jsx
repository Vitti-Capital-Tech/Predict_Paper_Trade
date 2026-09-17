import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchBinaryTickers, fetchCandles, buildRounds, legFor, sizeOrder } from '../lib/delta'
import { placeManualOrder, fetchManualOrders, isConfigured } from '../lib/supabase'
import CandleChart from './CandleChart'

const PRESETS = [5, 25, 50]
const SLIPPAGE_OPTIONS = [0.01, 0.02, 0.05, 0.1, 0.25]

const money = (v, d = 2) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

const priceLabel = (p) =>
  p === null || p === undefined ? '—' : p >= 1 ? '$1' : `$${Number(p).toFixed(3)}`

function clock(secs) {
  if (secs === null || secs === undefined) return '--:--'
  const s = Math.max(0, Math.round(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

function expiryLabel(date) {
  if (!date) return '—'
  return `At ${date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true })}`
}

function Select({ value, onChange, options, className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-white/10 bg-ink-800
                   py-2 pl-3 pr-8 text-sm text-slate-200 outline-none
                   focus:border-sky-500/50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg viewBox="0 0 20 20" fill="none"
           className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400">
        <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export default function TradePanel({ cash }) {
  const [rounds, setRounds] = useState([])
  const [error, setError] = useState(null)
  const [expiryCode, setExpiryCode] = useState(null)
  const [strike, setStrike] = useState(null)
  const [investment, setInvestment] = useState(25)
  const [slippage, setSlippage] = useState(0.05)
  const [candles, setCandles] = useState([])
  const [now, setNow] = useState(Date.now())
  const [placing, setPlacing] = useState(null)
  const [orders, setOrders] = useState([])
  const [toast, setToast] = useState(null)
  const touched = useRef(false)

  // Live quotes straight from Delta.
  const poll = useCallback(async () => {
    try {
      const built = buildRounds(await fetchBinaryTickers(), 'BTC')
      setRounds(built)
      setError(null)
      if (!touched.current && built.length) {
        setExpiryCode((prev) => prev ?? built[0].expiryCode)
      }
    } catch (e) {
      setError(e.message ?? String(e))
    }
  }, [])

  useEffect(() => {
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [poll])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true
    const load = () => fetchCandles('BTCUSDT', '15m', 6)
      .then((c) => alive && setCandles(c))
      .catch(() => {})
    load()
    const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const refreshOrders = useCallback(() => {
    if (!isConfigured) return
    fetchManualOrders(8).then(setOrders).catch(() => {})
  }, [])
  useEffect(() => {
    refreshOrders()
    const t = setInterval(refreshOrders, 3000)
    return () => clearInterval(t)
  }, [refreshOrders])

  const round = useMemo(
    () => rounds.find((r) => r.expiryCode === expiryCode) ?? rounds[0] ?? null,
    [rounds, expiryCode])

  // Default to the strike nearest spot, the way the app opens.
  useEffect(() => {
    if (!round) return
    setStrike((prev) => {
      if (prev !== null && round.strikes.includes(prev)) return prev
      if (!round.spot) return round.strikes[0] ?? null
      return round.strikes.reduce(
        (best, s) => (Math.abs(s - round.spot) < Math.abs(best - round.spot) ? s : best),
        round.strikes[0])
    })
  }, [round])

  const yesLeg = round && strike !== null ? legFor(round, strike, 'call') : null
  const noLeg = round && strike !== null ? legFor(round, strike, 'put') : null

  const secondsLeft = round?.expiry ? (round.expiry.getTime() - now) / 1000 : null
  const expired = secondsLeft !== null && secondsLeft <= 0

  const yesSize = sizeOrder(investment, yesLeg?.ask)
  const noSize = sizeOrder(investment, noLeg?.ask)

  // Depth on each side, as a share of the two — the panel's YES/NO bar.
  const yesDepth = Number(yesLeg?.askSize ?? 0)
  const noDepth = Number(noLeg?.askSize ?? 0)
  const yesShare = yesDepth + noDepth > 0 ? (yesDepth / (yesDepth + noDepth)) * 100 : 50

  const spot = round?.spot ?? null

  async function submit(outcome) {
    const leg = outcome === 'yes' ? yesLeg : noLeg
    const size = outcome === 'yes' ? yesSize : noSize
    if (!leg || !leg.ask || expired || size.contracts < 1) return
    setPlacing(outcome)
    setToast(null)
    try {
      await placeManualOrder({
        symbol: leg.symbol,
        roundId: round.roundId,
        outcome,
        strike: leg.strike,
        investment: Number(investment),
        slippageTolerance: Number(slippage),
        quotedPrice: leg.ask,
      })
      setToast({
        kind: 'ok',
        msg: `Queued ${outcome.toUpperCase()} · ${size.contracts} contracts at ${priceLabel(leg.ask)} — the worker fills it against the real book.`,
      })
      refreshOrders()
    } catch (e) {
      setToast({ kind: 'err', msg: e.message ?? String(e) })
    } finally {
      setPlacing(null)
    }
  }

  const disabled = expired || !round

  return (
    <div className="mx-auto max-w-lg">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-900">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold italic text-sky-400">Predict</span>
            <span className="text-sm font-semibold text-slate-200">BTC</span>
          </div>
          <span className="nums text-sm font-semibold text-emerald-400">
            {spot ? money(spot) : '—'}
          </span>
        </div>

        {/* Market selectors */}
        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          <Select value="BTC" onChange={() => {}} options={[{ value: 'BTC', label: 'BTC' }]} />
          <Select
            value={strike ?? ''}
            onChange={(v) => { touched.current = true; setStrike(Number(v)) }}
            options={(round?.strikes ?? []).map((s) => ({
              value: s, label: `Above ${s.toLocaleString('en-US')}` }))}
          />
          <Select
            value={expiryCode ?? ''}
            onChange={(v) => { touched.current = true; setExpiryCode(v) }}
            options={rounds.map((r) => ({
              value: r.expiryCode, label: expiryLabel(r.expiry) }))}
          />
        </div>

        {/* Status strip */}
        <div className={`flex items-center justify-center gap-2 py-2 text-xs ${
          expired ? 'bg-ink-800 text-slate-400' : 'bg-ink-800 text-slate-300'}`}>
          {expired ? (
            <span>⏱ Contract Expired</span>
          ) : (
            <span className="nums">⏳ Settles in {clock(secondsLeft)}</span>
          )}
        </div>

        {/* Chart */}
        <div className="border-b border-white/5 px-2 pb-2 pt-3">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs font-medium text-sky-400">15m</span>
            <span className="nums text-xs text-slate-500">
              ⧗ {expired ? '00:00' : clock(secondsLeft)}
            </span>
          </div>
          <CandleChart candles={candles} strike={strike} height={230} />
        </div>

        {/* Depth split */}
        <div className="px-4 py-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className="bg-emerald-500 transition-all duration-500"
                 style={{ width: `${yesShare}%` }} />
            <div className="flex-1 bg-rose-500/70" />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px]">
            <span className="text-emerald-400">
              YES <span className="nums text-slate-500">(depth: {yesDepth || 0})</span>
            </span>
            <span className="text-rose-400">
              <span className="nums text-slate-500">(depth: {noDepth || 0})</span> NO
            </span>
          </div>
        </div>

        {/* Investment */}
        <div className="border-t border-white/5 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Investment</span>
            <span className="nums text-[11px] text-slate-500">
              Avbl. Balance: {cash === null || cash === undefined ? '--' : money(cash)}
            </span>
          </div>

          <div className="mt-2 flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setInvestment(p)}
                className={`relative rounded-lg border px-4 py-2 text-sm transition-colors ${
                  Number(investment) === p
                    ? 'border-sky-500/60 bg-sky-500/10 text-sky-300'
                    : 'border-white/10 bg-ink-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                ${p}
                {p === 25 && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded bg-sky-500
                                   px-1 py-px text-[9px] font-semibold text-white">
                    Popular
                  </span>
                )}
              </button>
            ))}
            <input
              type="number"
              min="1"
              value={investment}
              onChange={(e) => setInvestment(e.target.value)}
              className="nums w-full rounded-lg border border-white/10 bg-ink-800 px-3 py-2
                         text-right text-sm text-slate-200 outline-none focus:border-sky-500/50"
            />
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Slippage Tolerance</span>
            <Select
              value={slippage}
              onChange={(v) => setSlippage(Number(v))}
              options={SLIPPAGE_OPTIONS.map((s) => ({ value: s, label: `$${s.toFixed(2)}` }))}
              className="w-28"
            />
          </div>
        </div>

        {/* YES / NO */}
        <div className="grid grid-cols-2 gap-3 px-4 pb-4">
          {[
            { key: 'yes', leg: yesLeg, size: yesSize,
              cls: 'bg-emerald-700/90 hover:bg-emerald-600 border-emerald-500/40' },
            { key: 'no', leg: noLeg, size: noSize,
              cls: 'bg-rose-800/90 hover:bg-rose-700 border-rose-500/40' },
          ].map(({ key, leg, size, cls }) => (
            <div key={key}>
              <button
                onClick={() => submit(key)}
                disabled={disabled || !leg?.ask || placing !== null || size.contracts < 1}
                className={`w-full rounded-lg border py-3 text-center transition-colors
                            disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
              >
                <span className="block text-sm font-bold tracking-wide text-white">
                  {key.toUpperCase()}
                </span>
                <span className="nums block text-xs text-white/90">
                  {placing === key ? 'placing…' : priceLabel(leg?.ask)}
                </span>
              </button>
              <p className="nums mt-1.5 text-center text-[11px] text-slate-500">
                You Invest: {money(size.invested)}
              </p>
              <p className="nums text-center text-[11px] text-slate-500">
                Payout if correct:{' '}
                <span className="text-slate-300">{money(size.payout)}</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                      text-xs text-rose-300">
          Delta feed: {error}
        </p>
      )}

      {toast && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
          toast.kind === 'ok'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>
          {toast.msg}
        </p>
      )}

      {!isConfigured && (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                      text-xs text-amber-300">
          Supabase is not configured, so orders cannot be queued. Prices above are live.
        </p>
      )}

      {orders.length > 0 && (
        <div className="mt-4 rounded-xl border border-white/5 bg-ink-900 p-4">
          <h3 className="text-xs font-semibold tracking-wide text-slate-300">
            Recent paper orders
          </h3>
          <ul className="mt-2 space-y-1.5">
            {orders.map((o) => (
              <li key={o.id} className="flex items-start justify-between gap-3 text-[11px]">
                <div className="min-w-0">
                  <span className={`font-semibold ${
                    o.outcome === 'yes' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {String(o.outcome).toUpperCase()}
                  </span>
                  <span className="nums ml-1.5 text-slate-500">
                    {Number(o.strike).toLocaleString('en-US')} · {money(o.investment)}
                  </span>
                  {o.reject_reason && (
                    <p className="mt-0.5 text-slate-600">{o.reject_reason}</p>
                  )}
                  {o.status === 'filled' && (
                    <p className="nums mt-0.5 text-slate-600">
                      {Number(o.contracts)} contracts @ {Number(o.fill_price).toFixed(4)}
                    </p>
                  )}
                </div>
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                  o.status === 'filled' ? 'bg-emerald-500/10 text-emerald-400'
                    : o.status === 'rejected' ? 'bg-rose-500/10 text-rose-400'
                    : 'bg-slate-500/10 text-slate-400'}`}>
                  {o.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
