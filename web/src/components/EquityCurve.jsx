import { fmt } from '../lib/stats'

/**
 * Inline SVG rather than a charting library - one series, no interaction
 * needed, and it keeps the bundle small.
 */
export default function EquityCurve({ points }) {
  if (!points || points.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-slate-600">
        Needs at least two completed rounds to plot.
      </p>
    )
  }

  const W = 600
  const H = 160
  const PAD = 6

  const values = points.map((p) => p.equity)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const span = max - min || 1

  const x = (i) => PAD + (i * (W - PAD * 2)) / (points.length - 1)
  const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2)

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.equity)}`).join(' ')
  const area = `${line} L ${x(points.length - 1)} ${y(min)} L ${x(0)} ${y(min)} Z`

  const last = values[values.length - 1]
  const positive = last >= 0
  const stroke = positive ? '#34d399' : '#fb7185'

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={`nums text-2xl font-semibold ${positive ? 'text-emerald-400' : 'text-rose-400'}`}>
          {fmt.signed(last)}
        </span>
        <span className="nums text-xs text-slate-500">{points.length} rounds</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-40 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Cumulative profit and loss by round"
      >
        <defs>
          <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {min < 0 && max > 0 && (
          <line
            x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)}
            stroke="#475569" strokeWidth="1" strokeDasharray="4 4"
          />
        )}
        <path d={area} fill="url(#eqfill)" />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
