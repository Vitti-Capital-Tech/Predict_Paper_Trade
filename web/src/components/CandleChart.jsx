import { useMemo, useRef, useState } from 'react'

/**
 * Price chart matching Delta's Predict panel: OHLC legend, candle/line series,
 * optional TWAP overlay, the market's strike, a crosshair, and price/time axes.
 *
 * Inline SVG rather than a charting library — one series and a couple of
 * overlays do not justify the bundle weight.
 */

const fmtPrice = (v) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtAxis = (v) => `$${Math.round(v).toLocaleString('en-US')}`

const hhmm = (ts) =>
  new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false })

const dateLabel = (ts) => {
  const d = new Date(ts * 1000)
  const day = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })
  const yr = `'${String(d.getFullYear()).slice(2)}`
  return `${day} ${yr}  ${hhmm(ts)}`
}

/**
 * Time-weighted average price across the visible window, using each bar's
 * typical price (H+L+C)/3. Delta settles Predict markets on a TWAP of the
 * underlying, so this is the line the panel's TWAP toggle reveals.
 */
function twapSeries(rows) {
  let sum = 0
  return rows.map((c, i) => {
    sum += (c.high + c.low + c.close) / 3
    return { time: c.time, value: sum / (i + 1) }
  })
}

export default function CandleChart({
  candles, strike, height = 300, chartType = 'candles', showTwap = true,
}) {
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  const view = useMemo(() => {
    const rows = (candles ?? []).filter(
      (c) => Number.isFinite(c.high) && Number.isFinite(c.low))
    if (rows.length < 2) return null

    const W = 760
    const H = height
    const AXIS_W = 74          // right price axis
    const TIME_H = 22          // bottom time axis
    const PAD_T = 30           // room for the OHLC legend
    const PAD_B = 8

    const twap = twapSeries(rows)

    let max = Math.max(...rows.map((c) => c.high))
    let min = Math.min(...rows.map((c) => c.low))
    if (Number.isFinite(strike)) { max = Math.max(max, strike); min = Math.min(min, strike) }
    if (showTwap) {
      max = Math.max(max, ...twap.map((t) => t.value))
      min = Math.min(min, ...twap.map((t) => t.value))
    }
    const pad = (max - min) * 0.1 || 1
    max += pad; min -= pad

    const plotW = W - AXIS_W
    const plotH = H - TIME_H - PAD_B
    const step = plotW / rows.length
    const bodyW = Math.max(1.5, Math.min(13, step * 0.6))

    const y = (v) => PAD_T + ((max - v) / (max - min)) * (plotH - PAD_T)
    const x = (i) => i * step + step / 2

    return {
      W, H, AXIS_W, TIME_H, plotW, plotH, rows, twap, x, y, step, bodyW,
      ticks: Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4),
      last: rows[rows.length - 1],
      strikeY: Number.isFinite(strike) ? y(strike) : null,
    }
  }, [candles, strike, height, showTwap])

  if (!view) {
    return (
      <div className="flex items-center justify-center text-xs text-slate-600"
           style={{ height }}>
        Loading chart…
      </div>
    )
  }

  const { W, H, AXIS_W, TIME_H, plotW, plotH, rows, twap, x, y, step, bodyW,
          ticks, last, strikeY } = view

  // Both tags sit on the right axis; when the strike and the last price are
  // close they would draw on top of each other, so nudge the strike clear.
  const lastY = y(last.close)
  const strikeTagY =
    strikeY !== null && Math.abs(strikeY - lastY) < 17
      ? strikeY + (strikeY <= lastY ? -17 : 17)
      : strikeY

  const active = hover !== null ? rows[hover] : last
  const chg = active.close - active.open
  const chgPct = active.open ? (chg / active.open) * 100 : 0
  const upBar = chg >= 0
  const barColor = upBar ? '#22c55e' : '#ef4444'

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px > plotW) { setHover(null); return }
    const i = Math.max(0, Math.min(rows.length - 1, Math.floor(px / step)))
    setHover(i)
  }

  const linePath = rows
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(c.close)}`).join(' ')
  const twapPath = twap
    .map((t, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(t.value)}`).join(' ')

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      // Width-driven: a fixed pixel height would letterbox the drawing inside
      // the SVG box, leaving dead space under the time axis.
      className="block w-full select-none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label="Price chart with market threshold"
    >
      {/* OHLC legend */}
      <text x={4} y={14} fontSize="10.5" fontFamily="ui-monospace, monospace">
        <tspan fill="#94a3b8">O</tspan><tspan fill={barColor}>{fmtPrice(active.open)} </tspan>
        <tspan fill="#94a3b8">H</tspan><tspan fill={barColor}>{fmtPrice(active.high)} </tspan>
        <tspan fill="#94a3b8">L</tspan><tspan fill={barColor}>{fmtPrice(active.low)} </tspan>
        <tspan fill="#94a3b8">C</tspan><tspan fill={barColor}>{fmtPrice(active.close)} </tspan>
        <tspan fill={barColor}>
          {chg >= 0 ? '+' : '-'}{Math.abs(chg).toFixed(2)} ({chgPct >= 0 ? '+' : '−'}
          {Math.abs(chgPct).toFixed(2)}%)
        </tspan>
      </text>

      {/* price grid + axis */}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke="#1e293b" strokeWidth="1" />
          <text x={plotW + 6} y={y(v) + 3.5} fill="#64748b" fontSize="10"
                fontFamily="ui-monospace, monospace">{fmtAxis(v)}</text>
        </g>
      ))}

      {/* strike threshold */}
      {strikeY !== null && (
        <g>
          <line x1={0} x2={plotW} y1={strikeY} y2={strikeY}
                stroke="#eab308" strokeWidth="1" strokeDasharray="5 4" />
          <rect x={plotW + 2} y={strikeTagY - 8} width={AXIS_W - 6} height={16} rx={3}
                fill="#eab308" />
          <text x={plotW + 2 + (AXIS_W - 6) / 2} y={strikeTagY + 3.5} fill="#1c1917"
                fontSize="10" fontWeight="700" textAnchor="middle"
                fontFamily="ui-monospace, monospace">
            {Math.round(strike).toLocaleString('en-US')}
          </text>
        </g>
      )}

      {/* series */}
      {chartType === 'candles' ? (
        rows.map((c, i) => {
          const rising = c.close >= c.open
          const color = rising ? '#22c55e' : '#ef4444'
          const top = y(Math.max(c.open, c.close))
          const bottom = y(Math.min(c.open, c.close))
          return (
            <g key={c.time}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)}
                    stroke={color} strokeWidth="1" />
              <rect x={x(i) - bodyW / 2} y={top} width={bodyW}
                    height={Math.max(1, bottom - top)} fill={color} />
            </g>
          )
        })
      ) : (
        <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="1.6"
              strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      )}

      {/* TWAP overlay */}
      {showTwap && (
        <path d={twapPath} fill="none" stroke="#f59e0b" strokeWidth="1.4"
              strokeDasharray="1 0" opacity="0.9"
              vectorEffect="non-scaling-stroke" />
      )}

      {/* last price tag */}
      <g>
        <line x1={0} x2={plotW} y1={y(last.close)} y2={y(last.close)}
              stroke={last.close >= last.open ? '#22c55e' : '#ef4444'}
              strokeWidth="1" strokeDasharray="2 3" opacity="0.65" />
        <rect x={plotW + 2} y={y(last.close) - 8} width={AXIS_W - 6} height={16} rx={3}
              fill={last.close >= last.open ? '#16a34a' : '#dc2626'} />
        <text x={plotW + 2 + (AXIS_W - 6) / 2} y={y(last.close) + 3.5} fill="#fff"
              fontSize="10" fontWeight="700" textAnchor="middle"
              fontFamily="ui-monospace, monospace">
          {fmtAxis(last.close).replace('$', '$')}
        </text>
      </g>

      {/* crosshair */}
      {hover !== null && (
        <g>
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={plotH}
                stroke="#64748b" strokeWidth="1" strokeDasharray="4 4" />
          <line x1={0} x2={plotW} y1={y(rows[hover].close)} y2={y(rows[hover].close)}
                stroke="#64748b" strokeWidth="1" strokeDasharray="4 4" />
        </g>
      )}

      {/* time axis */}
      <g>
        <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke="#1e293b" strokeWidth="1" />
        {rows.map((c, i) =>
          i % Math.max(1, Math.ceil(rows.length / 5)) === 0 && i < rows.length - 2 ? (
            <text key={c.time} x={x(i)} y={plotH + 15} fill="#64748b" fontSize="10"
                  textAnchor="middle" fontFamily="ui-monospace, monospace">
              {hhmm(c.time)}
            </text>
          ) : null)}
        <rect x={plotW - 148} y={plotH + 3} width={146} height={17} rx={2} fill="#334155" />
        <text x={plotW - 75} y={plotH + 15} fill="#e2e8f0" fontSize="10"
              textAnchor="middle" fontFamily="ui-monospace, monospace">
          {dateLabel(active.time)}
        </text>
      </g>
    </svg>
  )
}
