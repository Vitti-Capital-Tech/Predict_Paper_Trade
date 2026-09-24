import { useMemo, useRef, useState, useEffect } from 'react'

/**
 * Price chart matching Delta's Predict panel.
 *
 * Deliberate choices copied from the venue: no gridlines, a blue line series,
 * a "Target" pill pinned to the strike, and right-axis tags for the target
 * (blue), the TWAP (amber) and the last price (bright blue).
 */

// Cents on the axis cost about 40px and say nothing at these prices, so a
// narrow screen drops them the way Delta's own axis stays readable.
const axisPrice = (v, compact = false) =>
  `$${Number(v).toLocaleString('en-US', {
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 0 : 2 })}`

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

// Minutes in the rolling TWAP.
//
// Delta does not publish the settlement window, so this is calibrated rather
// than quoted: with their tag at 81,178.08 against a spot of 81,175.70, only a
// very short window fits — a 2-minute rolling mean landed $5.60 away while 5
// minutes was $48 away and 15 was $69. Two minutes it is, and the constant is
// here so it can be re-fitted rather than hunted for.
const TWAP_MINUTES = 2

/**
 * Rolling time-weighted average price, from each bar's typical price.
 *
 * Previously this was a cumulative mean from the left edge of the chart, which
 * made the number a property of whichever timeframe button was pressed: the
 * same instant read 81,246 on the 15m view and something else entirely on 1d.
 * Delta's TWAP is a trailing average — it tracks spot a couple of dollars
 * behind — and it is the mechanism the contract settles on, so it cannot
 * depend on how the viewer is looking at the chart.
 */
function barSecondsOf(rows) {
  if (!rows || rows.length < 2) return 60
  const gaps = []
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i].time - rows[i - 1].time
    if (d > 0) gaps.push(d)
  }
  if (!gaps.length) return 60
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]  // median resists a gap in the feed
}

function twapSeries(rows, barSeconds = 60) {
  const span = Math.max(1, Math.round((TWAP_MINUTES * 60) / barSeconds))
  const typical = rows.map((c) => (c.high + c.low + c.close) / 3)
  let sum = 0
  return rows.map((c, i) => {
    sum += typical[i]
    if (i >= span) sum -= typical[i - span]
    return { time: c.time, value: sum / Math.min(i + 1, span) }
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
  const wrapRef = useRef(null)

  // Draw at the container's real width so one SVG unit is one CSS pixel.
  //
  // The viewBox used to be a fixed 760 wide scaled to fit, which on a 375px
  // phone shrank everything by 0.49x: a 330px chart rendered about 160px tall
  // and 10.5px axis labels came out near 5px. The chart was not styled
  // differently from Delta's, it was half size.
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const apply = () => {
      const w = el.clientWidth
      if (w > 0) setWidth(w)
    }
    apply()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply)
      return () => window.removeEventListener('resize', apply)
    }
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view = useMemo(() => {
    const rows = (candles ?? []).filter(
      (c) => Number.isFinite(c.high) && Number.isFinite(c.low))
    if (rows.length < 2) return null
    if (width < 120) return null   // before the first measure

    const W = width
    const H = height
    // Wide enough for a price tag, which carries cents and so needs about 64px
    // of 10.5px monospace. The axis *labels* drop their cents on a narrow
    // screen (see axisPrice) so they still fit comfortably in the same gutter.
    const AXIS_W = W < 520 ? 78 : 86
    const TIME_H = 24
    const PAD_T = chartType === 'candles' ? 26 : 12
    const PAD_B = 6

    const twap = twapSeries(rows, barSecondsOf(rows))

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
    // Body width has to follow the slot, not a fixed cap. A flat 7 was
    // tuned when a window held ~30 bars; the 15m window holds 15, so slots
    // are twice as wide and the same 7 drew hairlines adrift in whitespace.
    // 62% of the slot reads as a candle at every bar count, and the cap only
    // stops the sparsest windows turning into billboards.
    const bodyW = Math.max(2, Math.min(22, step * 0.62))

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
  }, [candles, strike, height, showTwap, chartType, width])

  if (!view) {
    // Keeps wrapRef mounted: the observer lives on this node, so returning a
    // different element here would leave width at 0 and never recover.
    return (
      <div ref={wrapRef}
           className="flex w-full items-center justify-center overflow-hidden
                      text-xs text-slate-600"
           style={{ height }}>
        {width < 120 ? '' : 'Loading chart…'}
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

  // An axis label sitting behind a tag renders as a smear. Drop any tick the
  // tags already cover — the tag states that price more precisely anyway.
  const occupied = tagSlots.map((t) => t.y)
  const isCovered = (py) => occupied.some((oy) => Math.abs(oy - py) < 10)

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px > plotW) { setHover(null); return }
    setHover(Math.max(0, Math.min(rows.length - 1, Math.floor(px / step))))
  }

  const tickEvery = Math.max(1, Math.ceil(rows.length / 6))

  const linePath = rows
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(c.close)}`).join(' ')


  return (
    <div ref={wrapRef} className="w-full overflow-hidden">
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="block select-none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label="Price chart with the market target"
    >
      {/* Candle mode carries a compact legend, as the app does */}
      {chartType === 'candles' && (
        <text x={4} y={13} fontSize="10.5" fill={legendColor}
              fontFamily="ui-monospace, monospace">
          ${active.close.toFixed(2)} {chg >= 0 ? '+$' : '-$'}
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
          {!isCovered(y(v)) && (
            <text x={W - 6} y={y(v) + 3.5} fill={COLORS.axis} fontSize="10"
                  textAnchor="end" fontFamily="ui-monospace, monospace">
              {axisPrice(v, W < 520)}
            </text>
          )}
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

      {/* TWAP as a horizontal rule at the current level, not a series tracking
          price. The venue's candle view shows exactly this — an amber dotted
          line — and its line view appears to have none only because the rule
          sits on top of the price. A second line following the series, which
          is what this used to draw, is not something Delta shows anywhere. */}
      {showTwap && lastTwap !== null && (
        <line x1={0} x2={plotW} y1={y(lastTwap)} y2={y(lastTwap)}
              stroke={COLORS.twap} strokeWidth="1" strokeDasharray="2 3"
              opacity="0.9" vectorEffect="non-scaling-stroke" />
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
                    height={Math.max(1.5, bottom - top)} fill={color} />
            </g>
          )
        })
      ) : (
        <path d={linePath} fill="none" stroke={COLORS.line} strokeWidth="1.6"
              strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke" />
      )}

      {/* Right-axis tags.
          The target is blue *text*, not a filled badge: Delta badges only the
          live price, and giving both a solid blue pill made two different
          things read as the same thing. */}
      {targetTagY !== null && (
        <text x={W - 6} y={targetTagY + 3.5} fill={COLORS.target} fontSize="10.5"
              fontWeight="600" textAnchor="end"
              fontFamily="ui-monospace, monospace">
          {tagPrice(strike)}
        </text>
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
    </div>
  )
}
