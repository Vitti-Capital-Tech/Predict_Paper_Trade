import { useEffect } from 'react'

/**
 * Delta's "Predict Rules & Settlement" dialog.
 *
 * The last paragraph is not decoration: trading halts in the final minute, and
 * the worker enforces the same window (see TimingConfig.trading_halt_sec), so
 * the paper book cannot fill at a moment the venue would have refused.
 */
export default function RulesModal({ open, onClose, asset = 'BTC', haltSeconds = 60 }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  const haltLabel = haltSeconds === 60
    ? '1 minute'
    : `${Math.round(haltSeconds)} seconds`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-white/10
                   bg-ink-900 shadow-2xl shadow-black/60"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <h2 id="rules-title" className="text-sm font-semibold text-slate-100">
            Predict Rules &amp; Settlement
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="space-y-5 px-5 py-5">
          <section>
            <h3 className="text-sm font-semibold text-slate-100">How this market works:</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              This market resolves to YES if the {asset} price is greater than or equal to
              the target price when the countdown ends. Otherwise, it resolves to NO.
              Every contract is worth a maximum of $1.00 — if your prediction is correct,
              you receive $1.00 per share; if incorrect, it expires at $0.00.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-100">Protection &amp; Rules:</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              To protect against sudden market manipulation, the final result is decided
              using the Time-Weighted Average Price (TWAP) during the final moments of the
              countdown, rather than a single split-second price. Please note that trading
              pauses during the last {haltLabel}, meaning you cannot open or close positions
              during this final window. All times are shown in your local system timezone.
            </p>
          </section>

          <section className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3.5 py-3">
            <h3 className="text-xs font-semibold text-sky-300">In this paper system:</h3>
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-400">
              <li>
                • Orders are filled against Delta&apos;s real order book, so what you pay
                includes the spread and any depth your size consumes.
              </li>
              <li>
                • The same {haltLabel} halt is enforced, so nothing fills at a moment the
                venue would have refused.
              </li>
              <li>
                • Settlement is read from the venue&apos;s published result rather than
                inferred from the chart.
              </li>
            </ul>
          </section>
        </div>

        <div className="px-5 pb-5">
          <button
            onClick={onClose}
            className="w-full rounded-lg bg-sky-500 py-3 text-sm font-semibold text-white
                       transition-colors hover:bg-sky-400"
          >
            Understand
          </button>
        </div>
      </div>
    </div>
  )
}
