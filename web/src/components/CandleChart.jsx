import { useMemo, useRef, useState } from 'react'

/**
 * Price chart matching Delta's Predict panel.
 *
 * Deliberate choices copied from the venue: no gridlines, a blue line series,
 * a "Target" pill pinned to the strike, and right-axis tags for the target
 * (blue), the TWAP (amber) and the last price (bright blue).
 */

const axisPrice = (v) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const tagPrice = (v) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const hhmm = (ts) =>
  new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false })

// Sampled against Delta's own panel: a blue-tinted axis rather than neutral
// grey, and a pale guide line for the target so the blue pill and tag carry
// the colour instead of the rule across the plot.
const COLORS = {
  line: '#2f8fef',
  last: '#2f86eb',
  target: '#2f86eb',
  targetRule: '#8290a6',
  grid: '#1b2534',
  twap: '#f0b90b',
  up: '#26a69a',
  down: '#ef5350',
  axis: '#9aa7bd',
  time: '#8290a6',
}

/**
 * Time-weighted average price across the window, from each bar's typical
 * price. Delta settles on a TWAP of the final moments, so this is what the
 * TWAP toggle reveals.
 */
function twapSeries(rows) {
  let sum = 0
  return rows.map((c, i) => {
    sum += (c.high + c.low + c.close) / 3
    return { time: c.time, value: sum / (i + 1) }
  })
}

function Tag({ x, y, width, text, fill, color = '#fff' }) {
  return (
    <g>
      <rect x={x} y={y - 8} width={width} height={16} rx={2} fill={fill} />
      <text x={x + width / 2} y={y + 4} fill={color} fontSize="10.5"
            fontWeight="600" textAnchor="middle"
            fontFamily="ui-monospace, monospace">
        {text}
      </text>
    </g>
  )
}

export default function CandleChart({
  candles, strike, height = 330, chartType = 'line', showTwap = true,
}) {
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  const view = useMemo(() => {
    const rows = (candles ?? []).filter(
      (c) => Number.isFinite(c.high) && Number.isFinite(c.low))
    if (rows.length < 2) return null

    const W = 760
    const H = height
    const AXIS_W = 86
    const TIME_H = 24
    const PAD_T = chartType === 'candles' ? 26 : 12
    const PAD_B = 6

    const twap = twapSeries(rows)

    let max = Math.max(...rows.map((c) => c.high))
    let min = Math.min(...rows.map((c) => c.low))
    if (Number.isFinite(strike)) { max = Math.max(max, strike); min = Math.min(min, strike) }
    if (showTwap) {
      max = Math.max(max, ...twap.map((t) => t.value))
      min = Math.min(min, ...twap.map((t) => t.value))
    }
    const pad = (max - min) * 0.12 || 1
    max += pad; min -= pad

    const plotW = W - AXIS_W
    const plotH = H - TIME_H - PAD_B
    const step = plotW / rows.length
    // Delta's bodies are slim with a clear gap between them; filling the
    // slot turned a sparse window into a row of slabs.
    const bodyW = Math.max(1.5, Math.min(7, step * 0.45))

    const y = (v) => PAD_T + ((max - v) / (max - min)) * (plotH - PAD_T)
    const x = (i) => i * step + step / 2

    // Delta labels the axis in round increments. Aim for ~9 rows, and pick the
    // nearest nice step rather than the next one up, which was jumping from
    // 250 to 500 and leaving only three labels on screen.
    const span = max - min
    const rawStep = span / 9
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
    const norm = rawStep / mag
    const niceNorm = [1, 2, 2.5, 5, 10].reduce((best, n) =>
      Math.abs(Math.log(n / norm)) < Math.abs(Math.log(best / norm)) ? n : best, 1)
    const niceStep = niceNorm * mag
    const ticks = []
    for (let v = Math.ceil(min / niceStep) * niceStep; v <= max; v += niceStep) {
      ticks.push(v)
    }

    return {
      W, H, AXIS_W, TIME_H, plotW, plotH, rows, twap, x, y, step, bodyW, ticks,
      last: rows[rows.length - 1],
      lastTwap: twap[twap.length - 1]?.value ?? null,
      strikeY: Number.isFinite(strike) ? y(strike) : null,
    }
  }, [candles, strike, height, showTwap, chartType])

  if (!view) {
    return (
      <div className="flex items-center justify-center text-xs text-slate-600"
           style={{ height }}>
        Loading chart…
      </div>
    )
  }

  const { W, H, AXIS_W, TIME_H, plotW, plotH, rows, twap, x, y, step, bodyW,
          ticks, last, lastTwap, strikeY } = view

  const active = hover !== null ? rows[hover] : last
  const chg = active.close - active.open
  const chgPct = active.open ? (chg / active.open) * 100 : 0
  const legendColor = chg >= 0 ? COLORS.up : COLORS.down

  const lastY = y(last.close)
  const twapY = lastTwap !== null ? y(lastTwap) : null

  // Nudge overlapping tags apart, but only after sorting by position — spacing
  // them in insertion order would push a higher price below a lower one.
  const tagSlots = [
    { key: 'last', y: lastY },
    showTwap && twapY !== null ? { key: 'twap', y: twapY } : null,
    strikeY !== null ? { key: 'target', y: strikeY } : null,
  ].filter(Boolean).sort((a, b) => a.y - b.y)

  const GAP = 17
  for (let i = 1; i < tagSlots.length; i += 1) {
    const prev = tagSlots[i - 1]
    if (tagSlots[i].y - prev.y < GAP) tagSlots[i].y = prev.y + GAP
  }
  const tagY = Object.fromEntries(tagSlots.map((t) => [t.key, t.y]))
  const lastTagY = tagY.last
  const twapTagY = tagY.twap ?? null
  const targetTagY = tagY.target ?? null

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px > plotW) { setHover(null); return }
    setHover(Math.max(0, Math.min(rows.length - 1, Math.floor(px / step))))
  }

  const tickEvery = Math.max(1, Math.ceil(rows.length / 6))

  const linePath = rows
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(c.close)}`).join(' ')
  const twapPath = twap
    .map((t, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(t.value)}`).join(' ')

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full select-none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label="Price chart with the market target"
    >
      {/* Candle mode carries a compact legend, as the app does */}
      {chartType === 'candles' && (
        <text x={4} y={13} fontSize="10.5" fill={legendColor}
              fontFamily="ui-monospace, monospace">
          ${active.close.toFixed(2)} {chg >= 0 ? '+' : '-'}
          {Math.abs(chg).toFixed(2)} ({chgPct >= 0 ? '+' : '−'}
          {Math.abs(chgPct).toFixed(2)}%)
        </text>
      )}

      {/* Price axis. The candle view carries faint gridlines, as the app does;
          the line view stays clean. */}
      {ticks.map((v) => (
        <g key={v}>
          {chartType === 'candles' && (
            <line x1={0} x2={plotW} y1={y(v)} y2={y(v)}
                  stroke={COLORS.grid} strokeWidth="1" />
          )}
          <text x={W - 6} y={y(v) + 3.5} fill={COLORS.axis} fontSize="10"
                textAnchor="end" fontFamily="ui-monospace, monospace">
            {axisPrice(v)}
          </text>
        </g>
      ))}

      {/* Vertical gridlines on the time ticks */}
      {chartType === 'candles' && rows.map((c, i) => (
        i % tickEvery === 0 && i > 0 && i < rows.length - 1 ? (
          <line key={`v${c.time}`} x1={x(i)} x2={x(i)} y1={0} y2={plotH}
                stroke={COLORS.grid} strokeWidth="1" strokeDasharray="2 4" />
        ) : null
      ))}

      {/* Target line + pill */}
      {strikeY !== null && (
        <g>
          <line x1={0} x2={plotW} y1={strikeY} y2={strikeY}
                stroke={COLORS.targetRule} strokeWidth="1" strokeDasharray="1 4"
                strokeLinecap="round" opacity="0.9" />
          <rect x={4} y={strikeY - 9} width={52} height={18} rx={3} fill={COLORS.target} />
          <text x={30} y={strikeY + 4} fill="#fff" fontSize="10.5" fontWeight="600"
                textAnchor="middle">
            Target
          </text>
        </g>
      )}

      {/* TWAP overlay */}
      {showTwap && (
        <path d={twapPath} fill="none" stroke={COLORS.twap} strokeWidth="1.3"
              opacity="0.95" vectorEffect="non-scaling-stroke" />
      )}

      {/* Series */}
      {chartType === 'candles' ? (
        rows.map((c, i) => {
          const rising = c.close >= c.open
          const color = rising ? COLORS.up : COLORS.down
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
        <path d={linePath} fill="none" stroke={COLORS.line} strokeWidth="1.6"
              strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke" />
      )}

      {/* Right-axis tags */}
      {targetTagY !== null && (
        <Tag x={plotW + 4} y={targetTagY} width={AXIS_W - 10}
             text={tagPrice(strike)} fill={COLORS.target} />
      )}
      {twapTagY !== null && lastTwap !== null && (
        <Tag x={plotW + 4} y={twapTagY} width={AXIS_W - 10}
             text={tagPrice(lastTwap)} fill={COLORS.twap} color="#1c1917" />
      )}
      <Tag x={plotW + 4} y={lastTagY} width={AXIS_W - 10}
           text={tagPrice(last.close)} fill={COLORS.last} />

      {/* Crosshair */}
      {hover !== null && (
        <g>
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={plotH}
                stroke="#64748b" strokeWidth="1" strokeDasharray="4 4" />
          <line x1={0} x2={plotW} y1={y(rows[hover].close)} y2={y(rows[hover].close)}
                stroke="#64748b" strokeWidth="1" strokeDasharray="4 4" />
        </g>
      )}

      {/* Time axis */}
      {rows.map((c, i) => {
        if (i % tickEvery !== 0 || i > rows.length - 2) return null
        const isActive = hover === i
        return (
          <text key={c.time} x={x(i)} y={plotH + 16}
                fill={isActive ? '#e2e8f0' : COLORS.time}
                fontSize="10" fontWeight={isActive ? '700' : '400'}
                textAnchor="middle" fontFamily="ui-monospace, monospace">
            {hhmm(c.time)}
          </text>
        )
      })}
    </svg>
  )
}
