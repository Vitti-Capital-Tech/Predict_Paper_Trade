import { fmt } from '../lib/stats'

const KIND_STYLE = {
  entry: { dot: 'bg-sky-400', label: 'ENTRY' },
  exit: { dot: 'bg-emerald-400', label: 'EXIT' },
  settlement: { dot: 'bg-violet-400', label: 'SETTLED' },
  skip: { dot: 'bg-slate-600', label: 'SKIP' },
  exit_blocked: { dot: 'bg-rose-400', label: 'BLOCKED' },
}

/**
 * Shows why the bot is doing nothing, which on a filtered strategy like this
 * is most of the time - a silent dashboard is indistinguishable from a broken one.
 */
export default function EventFeed({ events }) {
  if (!events.length) {
    return <p className="py-8 text-center text-sm text-slate-600">No activity yet.</p>
  }
  return (
    <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
      {events.map((e) => {
        const style = KIND_STYLE[e.kind] ?? { dot: 'bg-slate-600', label: String(e.kind).toUpperCase() }
        const detail =
          e.reason ||
          e.payload?.reason ||
          (Array.isArray(e.payload?.reasons) ? e.payload.reasons.join('; ') : '') ||
          e.symbol ||
          ''
        return (
          <li key={e.id} className="flex gap-2.5 rounded-md px-1 py-1.5 hover:bg-white/[0.02]">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium tracking-wide text-slate-400">
                  {style.label}
                  {e.round_id && (
                    <span className="nums ml-1.5 font-normal text-slate-600">{e.round_id}</span>
                  )}
                </span>
                <span className="nums shrink-0 text-[11px] text-slate-600">
                  {fmt.time(e.ts)}
                </span>
              </div>
              {detail && (
                <p className="mt-0.5 break-words text-xs leading-relaxed text-slate-500">
                  {detail}
                </p>
              )}
              {e.payload?.pnl !== undefined && e.payload?.pnl !== null && (
                <p
                  className={`nums mt-0.5 text-xs font-medium ${
                    Number(e.payload.pnl) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {fmt.signed(e.payload.pnl)} USDT
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
