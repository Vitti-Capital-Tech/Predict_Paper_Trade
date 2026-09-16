import { Badge } from './ui'

/**
 * The master switch: "Do it only when BTC ATR is more than 200".
 * Shown as a bar against the threshold so it is obvious at a glance whether
 * the bot is allowed to trade at all.
 */
export default function AtrGate({ atr, threshold, pass, spot }) {
  const value = Number(atr ?? 0)
  const limit = Number(threshold || 200)
  // Scale so the threshold sits at 50% of the bar - the gap reads clearly
  // whether ATR is far below or far above the gate.
  const pctOfBar = Math.max(2, Math.min(100, (value / (limit * 2)) * 100))

  return (
    <div className="rounded-xl border border-white/5 bg-ink-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-200">BTC ATR gate</h2>
          <Badge tone={pass ? 'green' : 'amber'}>
            {pass ? 'TRADING ENABLED' : 'STANDING DOWN'}
          </Badge>
        </div>
        <p className="nums text-xs text-slate-500">
          BTC spot {spot ? Number(spot).toLocaleString('en-US') : '—'}
        </p>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span
          className={`nums text-3xl font-semibold ${
            pass ? 'text-emerald-400' : 'text-amber-400'
          }`}
        >
          {atr === null || atr === undefined ? '—' : value.toFixed(1)}
        </span>
        <span className="nums text-sm text-slate-500">
          threshold {limit.toFixed(0)}
        </span>
      </div>

      <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            pass ? 'bg-emerald-500' : 'bg-amber-500'
          }`}
          style={{ width: `${pctOfBar}%` }}
        />
        <div
          className="absolute inset-y-0 w-0.5 bg-slate-300/70"
          style={{ left: '50%' }}
          title={`threshold ${limit}`}
        />
      </div>

      <p className="mt-2 text-xs text-slate-500">
        {pass
          ? `Volatility is above the ${limit} floor — entries are allowed.`
          : `Volatility is below the ${limit} floor — no entries will be taken.`}
      </p>
    </div>
  )
}
