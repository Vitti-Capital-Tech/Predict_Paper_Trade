import { useMemo } from 'react'

/**
 * Candlestick chart as inline SVG — one series, no interaction beyond the
 * strike line, so a charting library would be pure bundle weight.
 *
 * `strike` draws the market's threshold, which is the line that actually
 * decides YES vs NO.
 */
export default function CandleChart({ candles, strike, height = 260 }) {
  const view = useMemo(() => {
    const rows = (candles ?? []).filter(
      (c) => Number.isFinite(c.high) && Number.isFinite(c.low))
    if (rows.length < 2) return null

    const W = 720
    const H = height
    const PAD_R = 62      // right gutter for the price axis
    const PAD_Y = 14

    const highs = rows.map((c) => c.high)
    const lows = rows.map((c) => c.low)
    let max = Math.max(...highs)
    let min = Math.min(...lows)
    if (Number.isFinite(strike)) {           // keep the strike on-screen
      max = Math.max(max, strike)
      min = Math.min(min, strike)
    }
    const pad = (max - min) * 0.08 || 1
    max += pad
    min -= pad

    const plotW = W - PAD_R
    const step = plotW / rows.length
    const bodyW = Math.max(1.5, Math.min(14, step * 0.62))
    const y = (v) => PAD_Y + ((max - v) / (max - min)) * (H - PAD_Y * 2)
    const x = (i) => i * step + step / 2

    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4)

    return {
      W, H, PAD_R, rows, x, y, bodyW, plotW,
      ticks,
      last: rows[rows.length - 1],
      strikeY: Number.isFinite(strike) ? y(strike) : null,
    }
  }, [candles, strike, height])

  if (!view) {
    return (
      <div
        className="flex items-center justify-center text-xs text-slate-600"
        style={{ height }}
      >
        Loading chart…
      </div>
    )
  }

  const { W, H, PAD_R, rows, x, y, bodyW, plotW, ticks, last, strikeY } = view
  const up = last.close >= last.open

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}
         role="img" aria-label="Price chart with market threshold">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={plotW} y1={y(v)} y2={y(v)}
                stroke="#1e293b" strokeWidth="1" />
          <text x={plotW + 6} y={y(v) + 3.5} fill="#64748b" fontSize="10"
                fontFamily="ui-monospace, monospace">
            ${Math.round(v).toLocaleString('en-US')}
          </text>
        </g>
      ))}

      {strikeY !== null && (
        <g>
          <line x1={0} x2={plotW} y1={strikeY} y2={strikeY}
                stroke="#eab308" strokeWidth="1" strokeDasharray="5 4" />
          <rect x={plotW + 2} y={strikeY - 8} width={PAD_R - 4} height={16}
                rx={3} fill="#eab308" />
          <text x={plotW + PAD_R / 2} y={strikeY + 3.5} fill="#1c1917"
                fontSize="10" fontWeight="700" textAnchor="middle"
                fontFamily="ui-monospace, monospace">
            {Math.round(strike).toLocaleString('en-US')}
          </text>
        </g>
      )}

      {rows.map((c, i) => {
        const rising = c.close >= c.open
        const color = rising ? '#22c55e' : '#ef4444'
        const bodyTop = y(Math.max(c.open, c.close))
        const bodyBottom = y(Math.min(c.open, c.close))
        return (
          <g key={c.time}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)}
                  stroke={color} strokeWidth="1" />
            <rect x={x(i) - bodyW / 2} y={bodyTop} width={bodyW}
                  height={Math.max(1, bodyBottom - bodyTop)} fill={color} />
          </g>
        )
      })}

      <g>
        <line x1={0} x2={plotW} y1={y(last.close)} y2={y(last.close)}
              stroke={up ? '#22c55e' : '#ef4444'} strokeWidth="1"
              strokeDasharray="2 3" opacity="0.7" />
        <rect x={plotW + 2} y={y(last.close) - 8} width={PAD_R - 4} height={16}
              rx={3} fill={up ? '#16a34a' : '#dc2626'} />
        <text x={plotW + PAD_R / 2} y={y(last.close) + 3.5} fill="#fff"
              fontSize="10" fontWeight="700" textAnchor="middle"
              fontFamily="ui-monospace, monospace">
          {Math.round(last.close).toLocaleString('en-US')}
        </text>
      </g>
    </svg>
  )
}
