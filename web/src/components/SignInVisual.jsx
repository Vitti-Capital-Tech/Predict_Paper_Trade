import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchCandles, fetchSpotTicker, indexSymbolFor, spotSymbolFor,
  barResolutionFor, lookbackHoursFor, mergeLiveBar,
} from '../lib/delta'
import CandleChart from './CandleChart'

/**
 * The sign-in hero shows the *real* dashboard chart — the same CandleChart, fed
 * with live data from Delta's public API (open CORS, no auth) — so the gate
 * previews exactly what the product is.
 *
 * It mirrors the dashboard's data path: the spot *index* series (which updates
 * continuously, unlike the perpetual), with the live spot folded into the last
 * bar so the right edge stays current. Rotates between BTC and ETH.
 */
const ASSETS = ['BTC', 'ETH']
const WINDOW = '1h' // a lively, recent window drawn from 1-minute bars

export default function SignInVisual() {
  const wrapRef = useRef(null)
  const [height, setHeight] = useState(420)
  const [idx, setIdx] = useState(0)
  const [chart, setChart] = useState(null)   // { asset, candles }
  const [spot, setSpot] = useState(null)     // { asset, price }

  // Fill the panel's height.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const apply = () => { const h = el.clientHeight; if (h > 0) setHeight(h) }
    apply()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply)
      return () => window.removeEventListener('resize', apply)
    }
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Rotate markets so the hero shows both BTC and ETH.
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % ASSETS.length), 18000)
    return () => clearInterval(t)
  }, [])

  // Candle series for the current asset, refreshed periodically. Keeps the
  // previous chart until the next set arrives (no flicker on rotate).
  useEffect(() => {
    let alive = true
    const asset = ASSETS[idx]
    const load = async () => {
      try {
        const rows = await fetchCandles(
          indexSymbolFor(asset), barResolutionFor(WINDOW), lookbackHoursFor(WINDOW))
        if (alive && rows?.length) setChart({ asset, candles: rows })
      } catch { /* keep whatever is showing */ }
    }
    load()
    const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [idx])

  // Live spot for the current asset, polled often so the right edge moves.
  useEffect(() => {
    let alive = true
    const asset = ASSETS[idx]
    const load = async () => {
      try {
        const t = await fetchSpotTicker(spotSymbolFor(asset))
        if (alive && t?.spot) setSpot({ asset, price: t.spot })
      } catch { /* ignore */ }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [idx])

  // Fold the live spot into the last bar, but only when both belong to the same
  // asset (during a rotate the old chart stays up until its replacement lands).
  const liveCandles = useMemo(() => {
    if (!chart) return null
    if (spot && spot.asset === chart.asset) {
      return mergeLiveBar(chart.candles, spot.price, barResolutionFor(WINDOW))
    }
    return chart.candles
  }, [chart, spot])

  // Label follows whatever asset is actually on screen, so the two never
  // disagree mid-rotate.
  const label = chart ? `${chart.asset} · USD` : ''

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-ink-950">
      {liveCandles && liveCandles.length > 1 ? (
        <div className="absolute inset-0">
          <CandleChart candles={liveCandles} height={height} chartType="line" showTwap />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">
          Loading live market…
        </div>
      )}

      {/* Scrims so the branding stays legible over the chart. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-12
                      bg-gradient-to-b from-ink-950/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28
                      bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent" />

      {/* Branding, bottom-left — clear of the chart's price axis on the right. */}
      <div className="pointer-events-none absolute bottom-5 left-5 right-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
            {label ? `${label} · Live` : 'Live market'}
          </span>
        </div>
        <p className="text-base font-semibold text-slate-100">Call the next move.</p>
        <p className="mt-0.5 text-xs text-slate-400">
          Up/down predictions on BTC &amp; ETH — paper and live.
        </p>
      </div>
    </div>
  )
}
