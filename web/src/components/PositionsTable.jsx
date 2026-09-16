import { Badge } from './ui'
import { fmt, pnlOf } from '../lib/stats'

const ROLE_LABEL = {
  wing_low: '1st strike',
  wing_high: 'Last strike',
  middle: 'Middle',
}

function PnlCell({ p }) {
  if (p.exit_price === null || p.exit_price === undefined) {
    return <span className="text-slate-500">open</span>
  }
  const v = pnlOf(p)
  return (
    <span className={v >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
      {fmt.signed(v)}
    </span>
  )
}

/**
 * Table on desktop, stacked cards on mobile - a 9-column table is unreadable
 * on a phone, and this dashboard is meant to be glanceable on one.
 */
export default function PositionsTable({ positions }) {
  if (!positions.length) {
    return <p className="py-8 text-center text-sm text-slate-600">No positions yet.</p>
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-3 font-medium">Time</th>
              <th className="py-2 pr-3 font-medium">Round</th>
              <th className="py-2 pr-3 font-medium">Leg</th>
              <th className="py-2 pr-3 font-medium">Side</th>
              <th className="py-2 pr-3 text-right font-medium">Qty</th>
              <th className="py-2 pr-3 text-right font-medium">Entry</th>
              <th className="py-2 pr-3 text-right font-medium">Slip</th>
              <th className="py-2 pr-3 text-right font-medium">Exit</th>
              <th className="py-2 pr-3 text-right font-medium">P&L</th>
              <th className="py-2 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody className="nums divide-y divide-white/5">
            {positions.map((p) => (
              <tr key={p.id ?? p.position_id} className="hover:bg-white/[0.02]">
                <td className="py-2 pr-3 text-slate-500">{fmt.time(p.entry_time)}</td>
                <td className="py-2 pr-3 text-slate-400">{p.round_id}</td>
                <td className="py-2 pr-3 text-slate-300">{ROLE_LABEL[p.role] ?? p.role}</td>
                <td className="py-2 pr-3">
                  <Badge tone={p.side === 'call' ? 'blue' : 'amber'}>
                    {String(p.side).toUpperCase()} {Number(p.strike).toLocaleString('en-US')}
                  </Badge>
                </td>
                <td className="py-2 pr-3 text-right text-slate-400">{fmt.int(p.qty)}</td>
                <td className="py-2 pr-3 text-right text-slate-200">
                  {fmt.price(p.entry_price)}
                </td>
                <td
                  className="py-2 pr-3 text-right text-amber-500/80"
                  title="Average fill minus the touch price"
                >
                  {Number(p.entry_slippage) > 0 ? fmt.price(p.entry_slippage) : '—'}
                </td>
                <td className="py-2 pr-3 text-right text-slate-300">
                  {fmt.price(p.exit_price)}
                </td>
                <td className="py-2 pr-3 text-right font-medium">
                  <PnlCell p={p} />
                </td>
                <td className="max-w-[220px] truncate py-2 text-xs text-slate-500">
                  {p.exit_reason || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {positions.map((p) => (
          <li
            key={p.id ?? p.position_id}
            className="rounded-lg border border-white/5 bg-ink-800/50 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <Badge tone={p.side === 'call' ? 'blue' : 'amber'}>
                {String(p.side).toUpperCase()} {Number(p.strike).toLocaleString('en-US')}
              </Badge>
              <span className="nums text-sm font-medium">
                <PnlCell p={p} />
              </span>
            </div>
            <div className="nums mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-slate-500">Entry</p>
                <p className="text-slate-200">{fmt.price(p.entry_price)}</p>
              </div>
              <div>
                <p className="text-slate-500">Exit</p>
                <p className="text-slate-200">{fmt.price(p.exit_price)}</p>
              </div>
              <div>
                <p className="text-slate-500">Qty</p>
                <p className="text-slate-200">{fmt.int(p.qty)}</p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {ROLE_LABEL[p.role] ?? p.role} · {fmt.time(p.entry_time)}
              {p.exit_reason ? ` · ${p.exit_reason}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}
