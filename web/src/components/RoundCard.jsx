import { Badge } from './ui'
import { fmt } from '../lib/stats'

function Leg({ label, leg }) {
  if (!leg) {
    return (
      <div className="rounded-lg border border-white/5 bg-ink-800/60 p-3">
        <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
        <p className="mt-1 text-sm text-slate-600">not listed</p>
      </div>
    )
  }
  const ok = leg.qualifies
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        ok
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-white/5 bg-ink-800/60'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
        <Badge tone={ok ? 'green' : 'slate'}>{ok ? 'qualifies' : 'too rich'}</Badge>
      </div>
      <p className="nums mt-1 text-sm font-medium text-slate-200">
        {leg.side === 'call' ? 'CALL' : 'PUT'} {Number(leg.strike).toLocaleString('en-US')}
      </p>
      <div className="nums mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-slate-500">ask</span>
        <span className={ok ? 'text-emerald-400' : 'text-rose-400'}>
          {fmt.price(leg.ask)}
        </span>
        <span className="text-slate-500">max</span>
        <span className="text-slate-300">{fmt.price(leg.max_price)}</span>
        <span className="text-slate-500">bid</span>
        <span className="text-slate-400">{fmt.price(leg.bid)}</span>
        <span className="text-slate-500">depth</span>
        <span className="text-slate-400">{fmt.int(leg.ask_size)}</span>
      </div>
    </div>
  )
}

export default function RoundCard({ round }) {
  const strikes = round.strikes || []
  const spot = Number(round.spot)
  const urgent = round.seconds_to_expiry <= 120

  return (
    <div className="rounded-xl border border-white/5 bg-ink-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="nums text-sm font-semibold text-slate-200">
            {round.round_id}
          </h3>
          {round.would_enter ? (
            <Badge tone="green">SIGNAL</Badge>
          ) : (
            <Badge tone="slate">waiting</Badge>
          )}
        </div>
        <span
          className={`nums text-sm font-medium ${
            urgent ? 'text-rose-400' : 'text-slate-400'
          }`}
        >
          {fmt.clock(round.seconds_to_expiry)} left
        </span>
      </div>

      {/* Strike ladder with spot marker */}
      <div className="mt-3 flex items-center gap-1.5">
        {strikes.map((s) => {
          const above = spot >= s
          return (
            <div
              key={s}
              className={`nums flex-1 rounded-md px-1 py-1.5 text-center text-[11px] ${
                above
                  ? 'bg-sky-500/10 text-sky-300'
                  : 'bg-ink-700/60 text-slate-400'
              }`}
              title={above ? 'spot is above this strike' : 'spot is below this strike'}
            >
              {Number(s).toLocaleString('en-US')}
            </div>
          )
        })}
      </div>
      <p className="nums mt-1.5 text-[11px] text-slate-500">
        spot {spot ? spot.toLocaleString('en-US') : '—'}
        {round.seconds_since_launch !== null &&
          ` · ${fmt.clock(round.seconds_since_launch)} since launch`}
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Leg label="1st strike (wing)" leg={round.wing_low} />
        <Leg label="Last strike (wing)" leg={round.wing_high} />
      </div>

      {round.reasons?.length > 0 && (
        <p className="mt-3 rounded-md bg-ink-800/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-500">
          {round.reasons.join(' · ')}
        </p>
      )}
    </div>
  )
}
