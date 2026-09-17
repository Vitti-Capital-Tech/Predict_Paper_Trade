import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchBinaryTickers, fetchCandles, fetchSpotTicker,
  buildRounds, legFor, sizeOrder, availableAssets, spotSymbolFor,
  RESOLUTIONS, lookbackHoursFor,
} from '../lib/delta'
import { placeManualOrder, fetchManualOrders, isConfigured } from '../lib/supabase'
import CandleChart from './CandleChart'
import Dropdown from './Dropdown'

const PRESETS = [5, 25, 50]
const SLIPPAGE_OPTIONS = [0.01, 0.02, 0.05, 0.1, 0.25]

const money = (v, d = 2) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`

const priceLabel = (p) =>
  p === null || p === undefined ? '—' : p >= 1 ? '$1' : `$${Number(p).toFixed(3)}`

function clock(secs) {
  if (secs === null || secs === undefined) return '--:--'
  const s = Math.max(0, Math.round(secs))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function expiryLabel(date) {
  if (!date) return '—'
  return `At ${date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()}`
}

function LineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
      <path d="M1 11.5 5 6.5l3 2.5 6-7" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CandleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
      <path d="M5 2v12M11 2v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="3.2" y="4.5" width="3.6" height="6" rx="0.6" fill="currentColor" />
      <rect x="9.2" y="6.5" width="3.6" height="5" rx="0.6" fill="currentColor" />
    </svg>
  )
}

export default function TradePanel({ account, workerLive }) {
  const [assets, setAssets] = useState(['BTC'])
  const [asset, setAsset] = useState('BTC')
  const [resolution, setResolution] = useState('15m')
  const [rounds, setRounds] = useState([])
  const [spotTicker, setSpotTicker] = useState(null)
  const [error, setError] = useState(null)
  const [expiryCode, setExpiryCode] = useState(null)
  const [strike, setStrike] = useState(null)
  const [investment, setInvestment] = useState(25)
  const [slippage, setSlippage] = useState(0.05)
  const [candles, setCandles] = useState([])
  const [chartType, setChartType] = useState('candles')
  const [showTwap, setShowTwap] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [placing, setPlacing] = useState(null)
  const [orders, setOrders] = useState([])
  const [ordersOffline, setOrdersOffline] = useState(false)
  const [toast, setToast] = useState(null)
  const touched = useRef(false)

  // Live quotes straight from Delta.
  const poll = useCallback(async () => {
    try {
      const [tickers, spotT] = await Promise.all([
        fetchBinaryTickers(),
        fetchSpotTicker(spotSymbolFor(asset)).catch(() => null),
      ])
      const found = availableAssets(tickers)
      if (found.length) setAssets(found)
      const built = buildRounds(tickers, asset)
      setRounds(built)
      if (spotT) setSpotTicker(spotT)
      setError(null)
      if (!touched.current && built.length) {
        setExpiryCode((prev) => prev ?? built[0].expiryCode)
      }
    } catch (e) {
      setError(e.message ?? String(e))
    }
  }, [asset])

  useEffect(() => {
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [poll])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // A different underlying has different strikes and expiries.
  useEffect(() => {
    touched.current = false
    setExpiryCode(null)
    setStrike(null)
    setSpotTicker(null)
  }, [asset])

  useEffect(() => {
    let alive = true
    setCandles([])
    const load = () => fetchCandles(
      spotSymbolFor(asset), resolution, lookbackHoursFor(resolution))
      .then((c) => alive && setCandles(c))
      .catch(() => {})
    load()
    const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [asset, resolution])

  // Poll queued orders, but stop entirely once the table turns out to be
  // missing — otherwise an un-run migration means a 404 every 3 seconds.
  const refreshOrders = useCallback(() => {
    if (!isConfigured || ordersOffline) return
    fetchManualOrders(8, account?.id ?? null)
      .then(setOrders)
      .catch((e) => {
        const msg = `${e?.message ?? e}`
        if (/manual_orders|schema cache|does not exist|PGRST205|404/i.test(msg)) {
          setOrdersOffline(true)
        }
      })
  }, [ordersOffline, account?.id])

  useEffect(() => {
    if (ordersOffline) return
    refreshOrders()
    const t = setInterval(refreshOrders, 3000)
    return () => clearInterval(t)
  }, [refreshOrders, ordersOffline])

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
  const nextLiveRound = rounds.find((r) => r.expiry && r.expiry.getTime() > now) ?? null

  const yesSize = sizeOrder(investment, yesLeg?.ask)
  const noSize = sizeOrder(investment, noLeg?.ask)

  const yesVol = Number(yesLeg?.oiUsd ?? 0)
  const noVol = Number(noLeg?.oiUsd ?? 0)
  const yesShare = yesVol + noVol > 0 ? (yesVol / (yesVol + noVol)) * 100 : 50

  const spot = spotTicker?.spot ?? round?.spot ?? null
  const changeUp = (spotTicker?.changePct ?? 0) >= 0

  async function submit(outcome) {
    const leg = outcome === 'yes' ? yesLeg : noLeg
    const size = outcome === 'yes' ? yesSize : noSize
    if (!leg || !leg.ask || expired || size.contracts < 1) return
    if (account && size.invested > Number(account.balance)) {
      setToast({ kind: 'err',
                 msg: `Not enough balance: needs ${money(size.invested)}, have ${money(account.balance)}.` })
      return
    }
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
        accountId: account?.id ?? null,
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

  const pendingCount = orders.filter((o) => o.status === 'pending').length

  const sides = [
    { key: 'yes', leg: yesLeg, size: yesSize,
      btn: 'bg-emerald-700/90 hover:bg-emerald-600 border-emerald-500/40' },
    { key: 'no', leg: noLeg, size: noSize,
      btn: 'bg-rose-800/90 hover:bg-rose-700 border-rose-500/40' },
  ]

  return (
    <div className="space-y-4">
      {/* Market header — full width */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl
                      border border-white/10 bg-ink-900 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-200">{asset}</span>
          <button
            type="button"
            title="Binary market: each contract pays $1 if the condition is true at settlement, $0 otherwise."
            className="ml-1 text-sky-400/80 transition-colors hover:text-sky-300"
          >
            <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" fill="none">
              <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-4">
          {spotTicker && (
            <div className="nums hidden gap-4 text-[11px] text-slate-500 sm:flex">
              <span>24h H <span className="text-slate-300">{money(spotTicker.high24h)}</span></span>
              <span>24h L <span className="text-slate-300">{money(spotTicker.low24h)}</span></span>
            </div>
          )}
          <span className={`nums text-lg font-semibold ${
            changeUp ? 'text-emerald-400' : 'text-rose-400'}`}>
            {spot ? money(spot) : '—'}
            {spotTicker && (
              <span className="ml-2 text-sm font-normal">
                {changeUp ? '↑' : '↓'} {Math.abs(spotTicker.changePct).toFixed(2)}%
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Chart on the left, trade ticket on the right */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">

        <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-900">
          {/* Market selectors */}
          <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-3">
            <Dropdown
              ariaLabel="Underlying"
              value={asset}
              onChange={(v) => setAsset(v)}
              options={assets.map((a) => ({ value: a, label: a }))}
              className="w-28 shrink-0"
            />
            <Dropdown
              ariaLabel="Threshold"
              value={strike ?? ''}
              onChange={(v) => { touched.current = true; setStrike(Number(v)) }}
              options={(round?.strikes ?? []).map((s) => ({
                value: s, label: `Above ${s.toLocaleString('en-US')}` }))}
              className="min-w-[160px] flex-1"
            />
            <Dropdown
              ariaLabel="Expiry"
              value={expiryCode ?? ''}
              onChange={(v) => { touched.current = true; setExpiryCode(v) }}
              options={rounds.map((r) => ({
                value: r.expiryCode, label: expiryLabel(r.expiry) }))}
              className="min-w-[140px] flex-1"
            />
          </div>

          {/* Status strip */}
          <div className="flex items-center justify-center gap-2 bg-ink-800 py-2 text-xs text-slate-300">
            {expired ? (
              <>
                <span>🕐 Contract Expired</span>
                {nextLiveRound && (
                  <button
                    onClick={() => { touched.current = true
                                     setExpiryCode(nextLiveRound.expiryCode) }}
                    className="font-medium text-sky-400 hover:text-sky-300"
                  >
                    Go to live contract →
                  </button>
                )}
              </>
            ) : (
              <span className="nums">⏳ Settles in {clock(secondsLeft)}</span>
            )}
          </div>

          {/* Chart toolbar */}
          <div className="flex items-center justify-between px-4 pt-3">
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {[['line', LineIcon], ['candles', CandleIcon]].map(([key, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setChartType(key)}
                    title={key === 'line' ? 'Line' : 'Candlesticks'}
                    className={`rounded border p-1 transition-colors ${
                      chartType === key
                        ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                        : 'border-white/10 text-slate-500 hover:text-slate-300'}`}
                  >
                    <Icon />
                  </button>
                ))}
              </div>
              <Dropdown
                ariaLabel="Chart timeframe"
                size="sm"
                value={resolution}
                onChange={setResolution}
                options={RESOLUTIONS.map((r) => ({ value: r, label: r }))}
                className="w-20"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowTwap((v) => !v)}
                className="flex items-center gap-1.5 rounded-md bg-ink-800 px-2 py-1"
                title="Time-weighted average price of the underlying"
              >
                <span className="text-[11px] font-medium text-slate-300">TWAP</span>
                <span className={`relative h-3.5 w-7 rounded-full transition-colors ${
                  showTwap ? 'bg-amber-500' : 'bg-slate-600'}`}>
                  <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white
                                    transition-all ${showTwap ? 'left-[16px]' : 'left-0.5'}`} />
                </span>
              </button>
              <span className="nums text-xs text-slate-400">
                ⧗ {expired ? '00:00' : clock(secondsLeft)}
              </span>
            </div>
          </div>

          <div className="px-2 pb-1 pt-2">
            <CandleChart candles={candles} strike={strike} height={340}
                         chartType={chartType} showTwap={showTwap} />
          </div>

          {/* YES / NO interest split */}
          <div className="border-t border-white/5 px-4 py-3">
            <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div className="bg-emerald-500 transition-all duration-500"
                   style={{ width: `${yesShare}%` }} />
              <div className="flex-1 bg-rose-500/70" />
            </div>
            <div
              className="mt-1.5 flex justify-between text-[11px]"
              title="Open interest in USD. Delta's public API exposes no traded-volume field for binaries, but these contracts list ~20 minutes before expiry with no prior book, so open interest is effectively this round's volume."
            >
              <span className="text-emerald-400">
                YES <span className="nums text-slate-500">(Vol: {money(yesVol)})</span>
              </span>
              <span className="text-rose-400">
                <span className="nums text-slate-500">(Vol: {money(noVol)})</span> NO
              </span>
            </div>
          </div>
        </div>

        {/* Trade ticket */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Place paper trade</h3>
              <span className="nums text-[11px] text-slate-500">
                Avbl: {account ? money(account.balance) : '--'}
              </span>
            </div>

            <p className="mt-3 text-xs font-medium text-slate-300">Investment</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setInvestment(p)}
                  className={`relative rounded-lg border py-2 text-sm transition-colors ${
                    Number(investment) === p
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-300'
                      : 'border-white/10 bg-ink-800 text-slate-400 hover:text-slate-200'}`}
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
            </div>
            <input
              type="number"
              min="1"
              value={investment}
              onChange={(e) => setInvestment(e.target.value)}
              className="nums mt-2 w-full rounded-lg border border-white/10 bg-ink-800 px-3 py-2
                         text-right text-sm text-slate-200 outline-none focus:border-sky-500/50"
            />

            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">Slippage Tolerance</span>
              <Dropdown
                ariaLabel="Slippage tolerance"
                value={slippage}
                onChange={(v) => setSlippage(Number(v))}
                options={SLIPPAGE_OPTIONS.map((s) => ({ value: s, label: `$${s.toFixed(2)}` }))}
                className="w-28"
                align="right"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {sides.map(({ key, leg, size, btn }) => (
                <div key={key}>
                  <button
                    onClick={() => submit(key)}
                    disabled={expired || !round || !leg?.ask || placing !== null || size.contracts < 1}
                    className={`w-full rounded-lg border py-3 text-center transition-colors
                                disabled:cursor-not-allowed disabled:opacity-40 ${btn}`}
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
                    Payout: <span className="text-slate-300">{money(size.payout)}</span>
                  </p>
                </div>
              ))}
            </div>

            {toast && (
              <p className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
                toast.kind === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>
                {toast.msg}
              </p>
            )}

            {error && (
              <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                            text-[11px] text-rose-300">
                Delta feed: {error}
              </p>
            )}

            {pendingCount > 0 && !workerLive && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                            text-[11px] text-amber-300">
                {pendingCount} order{pendingCount > 1 ? 's' : ''} waiting — no worker is
                running to fill {pendingCount > 1 ? 'them' : 'it'}. Start one with{' '}
                <code className="rounded bg-black/30 px-1">python run_live.py</code>.
              </p>
            )}

            {ordersOffline && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                            text-[11px] text-amber-300">
                Order queue unavailable — run{' '}
                <code className="rounded bg-black/30 px-1">
                  supabase/migrations/002_manual_orders.sql
                </code>{' '}
                once. Prices above are live regardless.
              </p>
            )}

            {!isConfigured && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
                            text-[11px] text-amber-300">
                Supabase not configured, so orders cannot be queued. Prices are live.
              </p>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
