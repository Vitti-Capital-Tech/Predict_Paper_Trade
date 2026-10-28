import { useEffect, useMemo, useState } from 'react'
import { fetchCandles, indexSymbolFor } from '../lib/delta'
import { atrSeries, atrAt } from '../lib/atr'
import { fetchLegsSince, fetchStrategyConfig } from '../lib/supabase'
import { fmt } from '../lib/stats'

/**
 * ETH vs BTC ATR, bar by bar on 15m candles.
 *
 * Asked for to decide which asset's ATR should gate an account's entries (the
 * "ATR from" toggle in its filters). Three answers:
 *
 *   - how closely the two move: both series over time, a scatter of one
 *     against the other, and correlation on levels, bar-to-bar changes and
 *     raw 15m ranges
 *   - how often the two gates agree at the thresholds below
 *   - the account's own rounds in each corner of that matrix: count, win rate
 *     and P&L, so "would BTC's gate have picked better rounds?" has a number
 *
 * One asset is the base (ETH by default, gate > 10). The other's equivalent
 * gate comes from a least-squares fit of its ATR on the base's over the
 * window, with bands at ±1 and ±2 residual SDs: how far its real ATR has sat
 * from what the fit predicts.
 *
 * The rounds are only ones the bot actually entered under its real gate.
 * Rounds the other gate would have opened but the real one kept shut never
 * happened, so they cannot be scored - the matrix shows which of the trades
 * taken each gate would have kept, not every trade it would have made.
 */

const RES = '15m'
const STEP = 900
const BTC_C = '#f59e0b'   // amber-500
const ETH_C = '#a78bfa'   // violet-400
const IST = 'Asia/Kolkata'
const RANGES = [['1d', '1D', 1], ['7d', '7D', 7], ['30d', '30D', 30]]
const COLOR = { BTC: BTC_C, ETH: ETH_C }
const KEY = { BTC: 'btc', ETH: 'eth' }
const OTHER = { BTC: 'ETH', ETH: 'BTC' }
const DEFAULT_BASE = 'ETH'
const DEFAULT_MIN = 10
// BTC's ATR runs in the hundreds, ETH's around ten.
const atrText = (asset, v) => (asset === 'BTC' ? v.toFixed(0) : v.toFixed(1))
const roundAtr = (asset, v) => (asset === 'BTC' ? Math.round(v) : Math.round(v * 10) / 10)

const chip = (on) => `rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
  on ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`

const when = (sec) => new Date(sec * 1000).toLocaleString('en-US', {
  timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  hour12: true })
const clock = (sec) => new Date(sec * 1000).toLocaleString('en-US', {
  timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true })

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0; let sy = 0
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n; const my = sy / n
  let num = 0; let dx = 0; let dy = 0
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx; const b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null
}

/** Sample covariance: how far two series move away from their means together. */
function covariance(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0; let sy = 0
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n; const my = sy / n
  let c = 0
  for (let i = 0; i < n; i += 1) c += (xs[i] - mx) * (ys[i] - my)
  return c / (n - 1)
}

/**
 * Least squares of y on x, with the residual SD - how far the real y sits from
 * the line - and the share of points that actually fall within 1 and 2 SDs.
 */
function fitLine(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0; let sy = 0
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n; const my = sy / n
  let num = 0; let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2
  }
  if (!den) return null
  const b = num / den; const a = my - b * mx
  const res = []
  let ss = 0
  for (let i = 0; i < n; i += 1) {
    const r = ys[i] - (a + b * xs[i])
    ss += r * r; res.push(Math.abs(r))
  }
  const sd = Math.sqrt(ss / (n - 2))
  const within = (k) => (100 * res.filter((r) => r <= k * sd).length) / n
  return { a, b, sd, in1: within(1), in2: within(2) }
}

const median = (arr) => {
  const s = arr.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Each bar's true range, stamped at its close like atrSeries. */
function rangeByClose(candles) {
  const out = new Map()
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]; const pc = Number(candles[i - 1].close)
    const h = Number(c.high); const l = Number(c.low)
    out.set(c.time + STEP, Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  return out
}

const rTone = (r) => (r == null ? 'text-slate-500'
  : r >= 0.7 ? 'text-emerald-300' : r >= 0.4 ? 'text-sky-300' : 'text-amber-300')
const rText = (r) => (r == null ? '—' : r.toFixed(2))

function Stat({ label, value, sub, tone = 'text-slate-100', title }) {
  return (
    <div className="rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5" title={title}>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`nums mt-0.5 text-lg font-semibold leading-tight ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-slate-600">{sub}</p>}
    </div>
  )
}

function Threshold({ asset, color, value, onChange, hint }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="font-semibold" style={{ color }}>{asset}</span> gate &gt;
      <input
        type="number" min={0} step={asset === 'ETH' ? 0.5 : 5}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="nums w-20 rounded-md border border-white/10 bg-ink-950 px-2 py-1
                   text-[11px] text-slate-200 [color-scheme:dark]"
      />
      {hint && <span className="text-slate-600">{hint}</span>}
    </label>
  )
}

/**
 * Both ATRs over time, each on its own axis: BTC left, ETH right. With a fit,
 * the other asset's ATR as predicted from the base's is drawn dotted on its
 * axis, inside a shaded ±1 SD band.
 */
function TimeChart({ bars, btcMin, ethMin, base, fit }) {
  const W = 760; const H = 220; const L = 44; const R = 44; const T = 10; const B = 24
  if (bars.length < 2) return null
  const t0 = bars[0].t; const t1 = bars[bars.length - 1].t
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R)
  const scale = (vals, extra) => {
    const all = vals.concat(Number.isFinite(extra) ? [extra] : [])
    let lo = Infinity; let hi = -Infinity
    for (const v of all) { if (v < lo) lo = v; if (v > hi) hi = v }
    const pad = (hi - lo) * 0.08 || 1
    return [lo - pad, hi + pad]
  }
  const other = OTHER[base]
  const pred = fit ? bars.map((b) => fit.a + fit.b * b[KEY[base]]) : null
  const band = pred ? pred.flatMap((p) => [p - fit.sd, p + fit.sd]) : []
  const [bLo, bHi] = scale(bars.map((b) => b.btc).concat(other === 'BTC' ? band : []), btcMin)
  const [eLo, eHi] = scale(bars.map((b) => b.eth).concat(other === 'ETH' ? band : []), ethMin)
  const yB = (v) => T + (1 - (v - bLo) / (bHi - bLo)) * (H - T - B)
  const yE = (v) => T + (1 - (v - eLo) / (eHi - eLo)) * (H - T - B)
  const path = (key, y) => bars.map((b, i) => `${i ? 'L' : 'M'}${x(b.t).toFixed(1)},${y(b[key]).toFixed(1)}`).join('')
  const yO = other === 'BTC' ? yB : yE
  const predPath = pred && pred.map((p, i) => `${i ? 'L' : 'M'}${x(bars[i].t).toFixed(1)},${yO(p).toFixed(1)}`).join('')
  const bandPath = pred && [
    ...pred.map((p, i) => `${i ? 'L' : 'M'}${x(bars[i].t).toFixed(1)},${yO(p + fit.sd).toFixed(1)}`),
    ...pred.map((p, i) => [i, p]).reverse()
      .map(([i, p]) => `L${x(bars[i].t).toFixed(1)},${yO(p - fit.sd).toFixed(1)}`),
    'Z'].join('')
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
         aria-label="BTC and ETH ATR over time">
      {ticks.map((f) => {
        const yy = T + f * (H - T - B)
        return (
          <g key={f}>
            <line x1={L} x2={W - R} y1={yy} y2={yy} stroke="rgba(255,255,255,0.05)" />
            <text x={L - 6} y={yy + 3} textAnchor="end" fontSize="10" fill={BTC_C}>
              {(bHi - f * (bHi - bLo)).toFixed(0)}
            </text>
            <text x={W - R + 6} y={yy + 3} fontSize="10" fill={ETH_C}>
              {(eHi - f * (eHi - eLo)).toFixed(1)}
            </text>
          </g>
        )
      })}
      {xTicks.map((t, i) => (
        <text key={i} x={x(t)} y={H - 6} fontSize="10" fill="#64748b"
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
          {when(t)}
        </text>
      ))}
      {Number.isFinite(btcMin) && btcMin > bLo && btcMin < bHi && (
        <line x1={L} x2={W - R} y1={yB(btcMin)} y2={yB(btcMin)} stroke={BTC_C}
              strokeDasharray="4 4" strokeOpacity="0.5" />
      )}
      {Number.isFinite(ethMin) && ethMin > eLo && ethMin < eHi && (
        <line x1={L} x2={W - R} y1={yE(ethMin)} y2={yE(ethMin)} stroke={ETH_C}
              strokeDasharray="4 4" strokeOpacity="0.5" />
      )}
      {bandPath && <path d={bandPath} fill={COLOR[other]} fillOpacity="0.25" stroke="none" />}
      <path d={path('btc', yB)} fill="none" stroke={BTC_C} strokeWidth="1.5" />
      <path d={path('eth', yE)} fill="none" stroke={ETH_C} strokeWidth="1.5" />
      {predPath && (
        <path d={predPath} fill="none" stroke={COLOR[other]} strokeWidth="1"
              strokeDasharray="2 3" strokeOpacity="0.9" />
      )}
    </svg>
  )
}

/**
 * The other asset's ATR against the base's, one dot per bar, with the fit
 * line and its ±1 SD band (clipped to the plot).
 */
function Scatter({ bars, base, baseMin, otherMin, fit }) {
  const S = 300; const P = 36
  if (bars.length < 3) return null
  const other = OTHER[base]
  const xs = bars.map((b) => b[KEY[base]]); const ys = bars.map((b) => b[KEY[other]])
  let xLo = Infinity; let xHi = -Infinity; let yLo = Infinity; let yHi = -Infinity
  for (const v of xs) { if (v < xLo) xLo = v; if (v > xHi) xHi = v }
  for (const v of ys) { if (v < yLo) yLo = v; if (v > yHi) yHi = v }
  const x = (v) => P + ((v - xLo) / (xHi - xLo || 1)) * (S - P - 8)
  const y = (v) => 8 + (1 - (v - yLo) / (yHi - yLo || 1)) * (S - P - 8)
  const line = (v, k) => fit.a + fit.b * v + k * fit.sd
  const cx = COLOR[base]; const cy = COLOR[other]
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto h-auto w-full max-w-[340px]" role="img"
         aria-label={`${other} ATR against ${base} ATR`}>
      <defs>
        <clipPath id="atr-scatter-plot">
          <rect x={P} y={8} width={S - P - 8} height={S - P - 8} />
        </clipPath>
      </defs>
      <rect x={P} y={8} width={S - P - 8} height={S - P - 8} fill="none"
            stroke="rgba(255,255,255,0.08)" />
      {fit && (
        <path clipPath="url(#atr-scatter-plot)" fill={cy} fillOpacity="0.12"
              d={`M${x(xLo)},${y(line(xLo, 1))}L${x(xHi)},${y(line(xHi, 1))}`
                 + `L${x(xHi)},${y(line(xHi, -1))}L${x(xLo)},${y(line(xLo, -1))}Z`} />
      )}
      {Number.isFinite(baseMin) && baseMin > xLo && baseMin < xHi && (
        <line x1={x(baseMin)} x2={x(baseMin)} y1={8} y2={S - P} stroke={cx}
              strokeDasharray="4 4" strokeOpacity="0.6" />
      )}
      {Number.isFinite(otherMin) && otherMin > yLo && otherMin < yHi && (
        <line x1={P} x2={S - 8} y1={y(otherMin)} y2={y(otherMin)} stroke={cy}
              strokeDasharray="4 4" strokeOpacity="0.6" />
      )}
      {bars.map((b) => (
        <circle key={b.t} cx={x(b[KEY[base]])} cy={y(b[KEY[other]])} r="2"
                fill="#7dd3fc" fillOpacity="0.45" />
      ))}
      {fit && (
        <line clipPath="url(#atr-scatter-plot)"
              x1={x(xLo)} y1={y(line(xLo, 0))} x2={x(xHi)} y2={y(line(xHi, 0))}
              stroke="#e2e8f0" strokeOpacity="0.6" strokeWidth="1" />
      )}
      <text x={P} y={S - P + 14} fontSize="10" fill={cx}>{atrText(base, xLo)}</text>
      <text x={S - 8} y={S - P + 14} fontSize="10" fill={cx} textAnchor="end">{atrText(base, xHi)}</text>
      <text x={(P + S) / 2} y={S - 6} fontSize="10" fill={cx} textAnchor="middle">{base} ATR →</text>
      <text x={P - 4} y={S - P} fontSize="10" fill={cy} textAnchor="end">{atrText(other, yLo)}</text>
      <text x={P - 4} y={16} fontSize="10" fill={cy} textAnchor="end">{atrText(other, yHi)}</text>
      <text x={10} y={(S - P) / 2} fontSize="10" fill={cy} textAnchor="middle"
            transform={`rotate(-90 10 ${(S - P) / 2})`}>{other} ATR →</text>
    </svg>
  )
}

/** The other asset's gate that matches the base's, from the fit, with its SD bands. */
function Equivalent({ base, baseMin, otherMin, fit, onUse }) {
  if (!fit || !Number.isFinite(baseMin)) return null
  const other = OTHER[base]
  const c = fit.a + fit.b * baseMin
  const lo = (k) => Math.max(0, c - k * fit.sd)
  const hi = (k) => c + k * fit.sd
  const t = (v) => atrText(other, v)
  const use = (v, key) => {
    const r = roundAtr(other, v)
    return (
      <button key={key} type="button" onClick={() => onUse(r)} disabled={otherMin === r}
              className="nums rounded-md border border-sky-500/30 px-2.5 py-1 text-[11px]
                         font-medium text-sky-300 hover:bg-sky-500/10 disabled:opacity-40">
        Use {t(r)}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                    border-sky-500/25 bg-sky-500/[0.06] px-3 py-2.5"
         title={`Least-squares fit ${other} = ${fit.a.toFixed(2)} + ${fit.b.toFixed(3)} × ${base} over the window's bars. SD is the residual: how far ${other}'s real ATR has sat from the line. Percentages are the share of bars that actually fell inside each band.`}>
      <div className="text-xs text-slate-300">
        <p className="text-[11px] text-slate-500">Equivalent {other} ATR</p>
        <p className="nums mt-0.5 text-sm">
          <span style={{ color: COLOR[base] }}>{base} {atrText(base, baseMin)}</span>
          {' → '}
          <span className="font-semibold" style={{ color: COLOR[other] }}>{other} ≈ {t(c)}</span>
        </p>
        <p className="nums mt-1 text-[11px] text-slate-400">
          ±1 SD {t(lo(1))} – {t(hi(1))}
          <span className="text-slate-600"> ({fit.in1.toFixed(0)}% of bars)</span>
          <span className="mx-2 text-slate-700">·</span>
          ±2 SD {t(lo(2))} – {t(hi(2))}
          <span className="text-slate-600"> ({fit.in2.toFixed(0)}% of bars)</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {use(c, 'c')}{use(lo(1), 'lo')}{use(hi(1), 'hi')}
      </div>
    </div>
  )
}

const score = (rounds) => {
  const n = rounds.length
  const wins = rounds.filter((r) => r.pnl > 0).length
  const pnl = rounds.reduce((a, r) => a + r.pnl, 0)
  return { n, win: n ? (100 * wins) / n : null, pnl }
}

function Cell({ bars, total, rounds, tone }) {
  const s = score(rounds)
  return (
    <td className={`px-3 py-2.5 align-top ${tone}`}>
      <p className="nums text-sm font-semibold text-slate-100">
        {s.n ? `${s.win.toFixed(0)}% win` : '—'}
        <span className={`ml-2 text-xs font-normal ${s.pnl > 0 ? 'text-emerald-400'
          : s.pnl < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
          {s.n ? fmt.usd(s.pnl) : ''}
        </span>
      </p>
      <p className="nums mt-0.5 text-[11px] text-slate-500">
        {s.n} round{s.n === 1 ? '' : 's'} · {bars} bars ({total ? ((100 * bars) / total).toFixed(0) : 0}%)
      </p>
    </td>
  )
}

function GateSummary({ asset, color, rounds, kept }) {
  const s = score(kept)
  return (
    <div className="rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5">
      <p className="text-[11px] text-slate-500">
        Gate on <span className="font-semibold" style={{ color }}>{asset}</span> keeps
      </p>
      <p className="nums mt-0.5 text-lg font-semibold leading-tight text-slate-100">
        {s.n}<span className="text-xs font-normal text-slate-500"> / {rounds} rounds</span>
      </p>
      <p className="nums mt-0.5 text-[11px] text-slate-500">
        {s.n ? `${s.win.toFixed(0)}% win · ` : ''}
        <span className={s.pnl > 0 ? 'text-emerald-400' : s.pnl < 0 ? 'text-rose-400' : ''}>
          {fmt.usd(s.pnl)}
        </span>
      </p>
    </div>
  )
}

export default function AtrCompareTab({ accountId, accountName }) {
  const [range, setRange] = useState('7d')
  const [cfg, setCfg] = useState(null)
  const [candles, setCandles] = useState(null)   // { BTC: [...], ETH: [...] }
  const [legs, setLegs] = useState([])
  const [error, setError] = useState(null)
  const [base, setBase] = useState(DEFAULT_BASE)
  const [baseMin, setBaseMin] = useState(DEFAULT_MIN)
  // NaN = follow the fit: the other gate sits at the base gate's equivalent
  // until a value is typed or picked.
  const [otherPick, setOtherPick] = useState(NaN)
  const [showBars, setShowBars] = useState(false)
  const other = OTHER[base]

  const days = RANGES.find(([k]) => k === range)[2]
  const period = Math.max(2, Number(cfg?.atr_period) || 14)

  useEffect(() => {
    if (!accountId) return
    let alive = true
    setCfg(null)
    fetchStrategyConfig(accountId).then((c) => { if (alive) setCfg(c ?? {}) })
      .catch(() => { if (alive) setCfg({}) })
    return () => { alive = false }
  }, [accountId])

  // Candles for both, with enough extra bars before the window to seed
  // Wilder's smoothing so the first bars shown are settled.
  useEffect(() => {
    let alive = true
    setCandles(null)
    setError(null)
    const hours = days * 24 + Math.ceil((STEP * (period * 5 + 20)) / 3600)
    Promise.all(['BTC', 'ETH'].map((a) => fetchCandles(indexSymbolFor(a), RES, hours)))
      .then(([btc, eth]) => { if (alive) setCandles({ BTC: btc, ETH: eth }) })
      .catch((e) => { if (alive) setError(`Could not load candles: ${e?.message ?? e}`) })
    return () => { alive = false }
  }, [days, period])

  useEffect(() => {
    if (!accountId) return
    let alive = true
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString()
    fetchLegsSince(accountId, since)
      .then((rows) => { if (alive) setLegs(rows) })
      .catch(() => { if (alive) setLegs([]) })
    return () => { alive = false }
  }, [accountId, days])

  const data = useMemo(() => {
    if (!candles) return null
    const from = Math.floor(Date.now() / 1000) - days * 86400
    const sB = atrSeries(candles.BTC, period, RES)
    const sE = atrSeries(candles.ETH, period, RES)
    const eByT = new Map(sE.map((p) => [p.time, p.atr]))
    const trB = rangeByClose(candles.BTC)
    const trE = rangeByClose(candles.ETH)
    const now = Math.floor(Date.now() / 1000)
    // Only bars that have closed: the newest candle is still forming.
    const bars = sB
      .filter((p) => p.time >= from && p.time <= now && eByT.has(p.time))
      .map((p) => ({ t: p.time, btc: p.atr, eth: eByT.get(p.time),
                     trB: trB.get(p.time), trE: trE.get(p.time) }))
    const dB = []; const dE = []
    for (let i = 1; i < bars.length; i += 1) {
      dB.push(bars[i].btc - bars[i - 1].btc)
      dE.push(bars[i].eth - bars[i - 1].eth)
    }
    const withTr = bars.filter((b) => Number.isFinite(b.trB) && Number.isFinite(b.trE))
    const xs = bars.map((b) => b.btc); const ys = bars.map((b) => b.eth)
    const r = pearson(xs, ys)
    // 15m price returns, in %, for the plain "do BTC and ETH move together"
    // question - ATR answers it for volatility, this for direction.
    const closeE = new Map(candles.ETH.map((c) => [c.time, Number(c.close)]))
    const inWin = candles.BTC.filter((c) => c.time + STEP >= from && c.time + STEP <= now
                                            && closeE.has(c.time))
    const retB = []; const retE = []
    for (let i = 1; i < inWin.length; i += 1) {
      const pb = Number(inWin[i - 1].close); const pe = closeE.get(inWin[i - 1].time)
      if (!pb || !pe) continue
      retB.push((100 * (Number(inWin[i].close) - pb)) / pb)
      retE.push((100 * (closeE.get(inWin[i].time) - pe)) / pe)
    }
    const covRet = covariance(retB, retE)
    const varB = covariance(retB, retB)
    // The other asset's ATR fitted on each possible base. Two separate fits,
    // not one inverted: regressing BTC on ETH is a different line from ETH on
    // BTC whenever the correlation is below 1.
    const fits = { BTC: fitLine(xs, ys), ETH: fitLine(ys, xs) }
    return {
      bars, sB, sE, fits,
      rLevel: r,
      covLevel: covariance(xs, ys),
      rRet: pearson(retB, retE),
      covRet,
      beta: covRet != null && varB ? covRet / varB : null,
      rChange: pearson(dB, dE),
      rRange: pearson(withTr.map((b) => b.trB), withTr.map((b) => b.trE)),
      ratio: median(bars.map((b) => b.btc / b.eth)),
    }
  }, [candles, days, period])

  const source = cfg ? (cfg.atr_asset || cfg.underlying || 'BTC') : null
  const fit = data?.fits[base] ?? null
  // The other gate follows the base's fitted equivalent until one is picked.
  const otherMin = Number.isFinite(otherPick) ? otherPick
    : fit && Number.isFinite(baseMin) ? roundAtr(other, fit.a + fit.b * baseMin) : NaN
  const btcMin = base === 'BTC' ? baseMin : otherMin
  const ethMin = base === 'ETH' ? baseMin : otherMin
  const changeBase = (b) => {
    if (b === base) return
    // Swap: the other gate becomes the base, so the strictness carries over.
    setBase(b)
    setBaseMin(Number.isFinite(otherMin) ? otherMin : b === DEFAULT_BASE ? DEFAULT_MIN : NaN)
    setOtherPick(NaN)
  }

  const matrix = useMemo(() => {
    if (!data) return null
    const open = (v, m) => Number.isFinite(m) && v > m
    const cells = { oo: 0, os: 0, so: 0, ss: 0 }   // [eth][btc]
    for (const b of data.bars) {
      const k = (open(b.eth, ethMin) ? 'o' : 's') + (open(b.btc, btcMin) ? 'o' : 's')
      cells[k] += 1
    }
    // Rounds: legs grouped by round, timed by the first leg in and scored on
    // the round's total P&L.
    const byRound = new Map()
    for (const l of legs) {
      const t = new Date(l.entry_time).getTime() / 1000
      if (!Number.isFinite(t)) continue
      const r = byRound.get(l.round_id) ?? { t, pnl: 0 }
      r.t = Math.min(r.t, t)
      r.pnl += Number(l.pnl) || 0
      byRound.set(l.round_id, r)
    }
    const rounds = { oo: [], os: [], so: [], ss: [] }
    let scored = 0
    for (const r of byRound.values()) {
      const b = atrAt(data.sB, r.t); const e = atrAt(data.sE, r.t)
      if (b == null || e == null) continue
      scored += 1
      rounds[(open(e, ethMin) ? 'o' : 's') + (open(b, btcMin) ? 'o' : 's')].push(r)
    }
    return { cells, rounds, scored, total: data.bars.length,
             agree: data.bars.length ? (100 * (cells.oo + cells.ss)) / data.bars.length : null }
  }, [data, legs, btcMin, ethMin])

  // The other gate that is open for the same share of bars as the base's.
  // With the two this correlated, it opens at nearly the same times.
  const matching = useMemo(() => {
    if (!data?.bars.length || !Number.isFinite(baseMin)) return null
    const open = data.bars.filter((b) => b[KEY[base]] > baseMin).length
    const share = open / data.bars.length
    const sorted = data.bars.map((b) => b[KEY[other]]).sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - share) * sorted.length)))
    return { share: 100 * share, value: roundAtr(other, sorted[idx]) }
  }, [data, base, other, baseMin])

  if (!accountId) {
    return <p className="py-10 text-center text-sm text-slate-600">Pick an account.</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
        <div className="flex items-center gap-1" role="group" aria-label="Range">
          {RANGES.map(([k, lbl]) => (
            <button key={k} type="button" onClick={() => setRange(k)} className={chip(range === k)}>
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          Base
          <div className="flex items-center gap-1" role="group" aria-label="Base ATR">
            {['ETH', 'BTC'].map((a) => (
              <button key={a} type="button" onClick={() => changeBase(a)}
                      aria-pressed={base === a} className={chip(base === a)}
                      style={base === a ? { color: COLOR[a] } : undefined}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <Threshold asset={base} color={COLOR[base]} value={baseMin}
                   onChange={(v) => { setBaseMin(v); setOtherPick(NaN) }} />
        <Threshold asset={other} color={COLOR[other]} value={otherMin} onChange={setOtherPick}
                   hint={Number.isFinite(otherPick) ? '(set)' : '(from fit)'} />
        <span className="text-[11px] text-slate-500 sm:ml-auto">
          {RES} candles · Wilder ATR({period}) · {accountName ?? 'account'} gates on{' '}
          <span className="font-semibold" style={{ color: source === 'ETH' ? ETH_C : BTC_C }}>
            {source ?? '…'}
          </span>
        </span>
      </div>

      {error && <p className="text-xs text-rose-300">{error}</p>}
      {!data && !error && <p className="py-6 text-center text-sm text-slate-600">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Correlation · ATR level" value={rText(data.rLevel)} tone={rTone(data.rLevel)}
                  sub="do they rise and fall together"
                  title="Pearson correlation of the two ATR values, bar by bar. 1 = always together, 0 = unrelated." />
            <Stat label="Correlation · ATR change" value={rText(data.rChange)} tone={rTone(data.rChange)}
                  sub="bar-to-bar moves"
                  title="Correlation of each bar's change in ATR. Levels can correlate just because both trend; this asks whether they turn together." />
            <Stat label="Correlation · 15m range" value={rText(data.rRange)} tone={rTone(data.rRange)}
                  sub="raw true range per bar"
                  title="Correlation of each 15m bar's true range, before any smoothing." />
            <Stat label="Correlation · 15m returns" value={rText(data.rRet)} tone={rTone(data.rRet)}
                  sub="price moves, % per bar"
                  title="Correlation of each 15m bar's % price change: do BTC and ETH move in the same direction." />
            <Stat label="Covariance · ATR" value={data.covLevel != null ? data.covLevel.toFixed(1) : '—'}
                  sub="BTC pts × ETH pts"
                  title="Sample covariance of the two ATRs. Positive = they rise and fall together; its size depends on the units, so read it next to the correlation." />
            <Stat label="Covariance · 15m returns"
                  value={data.covRet != null ? data.covRet.toFixed(4) : '—'}
                  sub={`%² per bar · ETH beta ${data.beta != null ? data.beta.toFixed(2) : '—'}`}
                  title="Sample covariance of 15m % returns. Beta = covariance ÷ BTC variance: how many % ETH moves for each 1% BTC move." />
            <Stat label="BTC ÷ ETH ATR" value={data.ratio ? `${data.ratio.toFixed(1)}×` : '—'}
                  sub="median over the window" />
            <Stat label="Gates agree"
                  value={matrix?.agree != null ? `${matrix.agree.toFixed(0)}%` : '—'}
                  sub={`of ${data.bars.length} bars, at these thresholds`} />
          </div>

          <Equivalent base={base} baseMin={baseMin} otherMin={otherMin} fit={fit}
                      onUse={setOtherPick} />

          {matching && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border
                            border-white/10 bg-ink-950 px-3 py-2.5">
              <div className="text-xs text-slate-300">
                <p className="text-[11px] text-slate-500">Same share of bars open</p>
                <p className="nums mt-0.5">
                  <span style={{ color: COLOR[base] }}>{base} &gt; {atrText(base, baseMin)}</span> is open{' '}
                  {matching.share.toFixed(0)}% of bars.{' '}
                  <span style={{ color: COLOR[other] }}>{other} &gt; {atrText(other, matching.value)}</span> is
                  open the same {matching.share.toFixed(0)}%.
                </p>
              </div>
              <button type="button" onClick={() => setOtherPick(matching.value)}
                      disabled={otherMin === matching.value}
                      className="rounded-md border border-sky-500/30 px-2.5 py-1 text-[11px]
                                 font-medium text-sky-300 hover:bg-sky-500/10 disabled:opacity-40">
                Use {atrText(other, matching.value)} as {other} gate
              </button>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-white/10 bg-ink-950 p-3">
              <p className="mb-2 flex items-center gap-3 text-[11px] text-slate-500">
                ATR over time
                <span style={{ color: BTC_C }}>━ BTC (left)</span>
                <span style={{ color: ETH_C }}>━ ETH (right)</span>
                <span className="text-slate-600">dashed = gate</span>
                {fit && (
                  <span style={{ color: COLOR[other] }}>
                    ┄ {other} from {base}, shaded ±1 SD
                  </span>
                )}
              </p>
              <TimeChart bars={data.bars} btcMin={btcMin} ethMin={ethMin} base={base} fit={fit} />
            </div>
            <div className="rounded-lg border border-white/10 bg-ink-950 p-3">
              <p className="mb-2 text-[11px] text-slate-500">
                {other} vs {base}, one dot per 15m bar · fit ±1 SD
              </p>
              <Scatter bars={data.bars} base={base} baseMin={baseMin} otherMin={otherMin} fit={fit} />
            </div>
          </div>

          {matrix && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <GateSummary asset="BTC" color={BTC_C} rounds={matrix.scored}
                             kept={[...matrix.rounds.oo, ...matrix.rounds.so]} />
                <GateSummary asset="ETH" color={ETH_C} rounds={matrix.scored}
                             kept={[...matrix.rounds.oo, ...matrix.rounds.os]} />
              </div>
              <div className="overflow-x-auto rounded-lg border border-white/10 bg-ink-950">
                <table className="w-full min-w-[520px] text-left">
                  <thead>
                    <tr className="border-b border-white/5 text-[11px] text-slate-500">
                      <th className="px-3 py-2 font-medium">Gate matrix</th>
                      <th className="px-3 py-2 font-medium">
                        <span style={{ color: BTC_C }}>BTC</span> open (&gt; {Number.isFinite(btcMin) ? btcMin : '—'})
                      </th>
                      <th className="px-3 py-2 font-medium">
                        <span style={{ color: BTC_C }}>BTC</span> shut
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-white/5">
                      <th className="px-3 py-2.5 text-[11px] font-medium text-slate-500">
                        <span style={{ color: ETH_C }}>ETH</span> open (&gt; {Number.isFinite(ethMin) ? ethMin : '—'})
                      </th>
                      <Cell bars={matrix.cells.oo} total={matrix.total} rounds={matrix.rounds.oo}
                            tone="bg-emerald-500/[0.05]" />
                      <Cell bars={matrix.cells.os} total={matrix.total} rounds={matrix.rounds.os} tone="" />
                    </tr>
                    <tr>
                      <th className="px-3 py-2.5 text-[11px] font-medium text-slate-500">
                        <span style={{ color: ETH_C }}>ETH</span> shut
                      </th>
                      <Cell bars={matrix.cells.so} total={matrix.total} rounds={matrix.rounds.so} tone="" />
                      <Cell bars={matrix.cells.ss} total={matrix.total} rounds={matrix.rounds.ss}
                            tone="bg-white/[0.02]" />
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-600">
                Rounds are {accountName ?? 'this account'}&apos;s own over the window, placed by
                both ATRs at the moment they were entered. Only rounds the bot actually took are
                here, so this shows which of them each gate would have kept, not the rounds a
                gate would have added.
              </p>
            </div>
          )}

          <div>
            <button type="button" onClick={() => setShowBars((v) => !v)}
                    className="text-[11px] text-sky-400 hover:text-sky-300">
              {showBars ? 'Hide' : 'Show'} the last 48 bars
            </button>
            {showBars && (
              <div className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-ink-950">
                <table className="nums w-full min-w-[560px] text-right text-[11px]">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-500">
                      <th className="px-3 py-2 text-left font-medium">Bar close (IST)</th>
                      <th className="px-3 py-2 font-medium" style={{ color: BTC_C }}>BTC ATR</th>
                      <th className="px-3 py-2 font-medium" style={{ color: ETH_C }}>ETH ATR</th>
                      <th className="px-3 py-2 font-medium">BTC range</th>
                      <th className="px-3 py-2 font-medium">ETH range</th>
                      <th className="px-3 py-2 font-medium">Ratio</th>
                      <th className="px-3 py-2 font-medium">Gates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bars.slice(-48).reverse().map((b) => {
                      const bo = Number.isFinite(btcMin) && b.btc > btcMin
                      const eo = Number.isFinite(ethMin) && b.eth > ethMin
                      return (
                        <tr key={b.t} className="border-b border-white/[0.03] text-slate-300">
                          <td className="px-3 py-1.5 text-left text-slate-400">{clock(b.t)}</td>
                          <td className="px-3 py-1.5">{b.btc.toFixed(1)}</td>
                          <td className="px-3 py-1.5">{b.eth.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-slate-500">{b.trB?.toFixed(1) ?? '—'}</td>
                          <td className="px-3 py-1.5 text-slate-500">{b.trE?.toFixed(2) ?? '—'}</td>
                          <td className="px-3 py-1.5 text-slate-500">{(b.btc / b.eth).toFixed(1)}×</td>
                          <td className="px-3 py-1.5">
                            <span className={bo ? 'text-amber-400' : 'text-slate-600'}>B</span>{' '}
                            <span className={eo ? 'text-violet-300' : 'text-slate-600'}>E</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
