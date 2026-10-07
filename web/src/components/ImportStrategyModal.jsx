import { useEffect, useMemo, useState } from 'react'

/**
 * Copy another account's filters into this one.
 *
 * Pull rather than push: the account being changed is the one on screen.
 *
 * Both sides are offered, deliberately. A strategy is tuned on paper and then
 * wanted on live - that is the point of having the two - so a list confined to
 * the side you are on would leave out the only account you had actually
 * tested. Each row says which side it came from.
 *
 * Everything is copied, including the market and the numbers denominated in
 * its points. That is what makes it the same strategy rather than an
 * approximation of one; the confirmation step is where the consequences of
 * that get read, which is why it exists.
 */

// Row plumbing. Not settings, and not copyable in any meaningful sense.
const PLUMBING = ['id', 'account_id', 'updated_at']

// The one carve-out. Copying this would start or stop trading as a side
// effect of copying settings, and on a live account that spends money. It is
// a switch of its own, in the header, and stays where it was set.
const NEVER_COPY = [...PLUMBING, 'enabled']

/** Field names as the filters show them, for the confirmation list. */
const LABELS = {
  underlying: 'Market', atr_resolution: 'ATR chart', atr_period: 'ATR candles',
  atr_min: 'Minimum ATR', session_start: 'Start time', session_end: 'End time',
  session_timezone: 'Timezone', weekdays: 'Days',
  min_seconds_since_launch: 'Min age', max_seconds_since_launch: 'Max age',
  min_seconds_to_expiry: 'Min to expiry', max_seconds_to_expiry: 'Max to expiry',
  odds_convention: 'Convention', wing_odds: 'Odds', trade_wings: 'Wings',
  require_both_wings: 'Both wings', extremes_mode: 'Both extremes',
  trade_middle: 'Middle strike', middle_odds: 'Middle odds',
  middle_needs_both_wings: 'Middle needs wings',
  trade_outside_range: 'Outside the range', outside_odds: 'Outside odds',
  partial_entry: 'Part fills', exit_mode: 'Exit mode', exit_trigger: 'Exit trigger',
  exit_points: 'Exit points', exit_atm_band: 'ATM band',
  take_profit_price: 'Take profit', stop_loss_price: 'Stop loss',
  flatten_before_expiry_sec: 'Flatten before expiry',
  max_slippage: 'Slippage tolerance', max_spread_frac: 'One-sided market',
  size_mode: 'Sizing', size_contracts: 'Contracts',
  investment_per_leg: 'Investment per leg',
  max_concurrent_rounds: 'Max open rounds', max_cost_per_round: 'Max cost per round',
}

const show = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

export default function ImportStrategyModal({
  open, onClose, account, accounts, configs, saved, onCopy, busy,
}) {
  const [picked, setPicked] = useState(null)

  // Cleared when the dialog opens, and only then. This used to sit in the
  // effect below, whose deps include `onClose` - an inline arrow, so a new
  // function on every render of the panel. The panel reloads its settings
  // every eight seconds and the account list every five, so the selection
  // was wiped within a tick or two and the confirmation vanished back to the
  // list while it was being read.
  useEffect(() => {
    if (open) setPicked(null)
  }, [open])

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

  const byAccount = useMemo(() => {
    const m = new Map()
    for (const c of configs ?? []) m.set(c.account_id, c)
    return m
  }, [configs])

  const sources = useMemo(
    () => (accounts ?? []).filter(
      (a) => a.id !== account?.id && byAccount.has(a.id)),
    [accounts, account, byAccount])

  // What would actually change, so the confirmation is about this copy rather
  // than a general warning nobody reads twice.
  const plan = useMemo(() => {
    if (!picked || !saved) return null
    const from = byAccount.get(picked)
    if (!from) return null
    const patch = {}
    const changes = []
    for (const [k, v] of Object.entries(from)) {
      if (NEVER_COPY.includes(k)) continue
      if (!(k in saved)) continue       // column this row does not have
      patch[k] = v
      if (String(saved[k]) !== String(v)) {
        changes.push({ key: k, label: LABELS[k] ?? k, was: saved[k], now: v })
      }
    }
    return {
      patch,
      changes,
      source: accounts.find((a) => a.id === picked),
      marketChange: String(saved.underlying) !== String(from.underlying)
        ? { was: saved.underlying, now: from.underlying } : null,
    }
  }, [picked, saved, byAccount, accounts])

  if (!open) return null

  const here = (saved?.underlying) || 'BTC'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl
                   border border-white/10 bg-ink-900 shadow-2xl shadow-black/60"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-3.5">
          <div>
            <h2 id="import-title" className="text-sm font-semibold text-slate-100">
              {plan ? 'Confirm copy' : 'Copy filters'}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {plan
                ? <>{plan.source?.name} → <span className="text-slate-300">{account?.name}</span></>
                : <>into <span className="text-slate-300">{account?.name ?? 'this account'}</span> · {here}</>}
            </p>
          </div>
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

        {!plan ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            {sources.length === 0 && (
              <p className="py-6 text-center text-xs text-slate-600">
                No other account has settings to copy.
              </p>
            )}
            {sources.map((a) => {
              const asset = byAccount.get(a.id)?.underlying || 'BTC'
              const live = (a.mode ?? 'paper') === 'live'
              return (
                <button
                  key={a.id}
                  onClick={() => setPicked(a.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left
                             transition-colors hover:bg-white/5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                    {a.name}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    live ? 'bg-rose-500/15 text-rose-300' : 'bg-white/5 text-slate-500'}`}>
                    {live ? 'LIVE' : 'PAPER'}
                  </span>
                  <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {asset}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {plan.marketChange && (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="text-[11px] font-semibold text-amber-300">
                    This changes the market to {plan.marketChange.now}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-amber-200/80">
                    {account?.name} currently trades {plan.marketChange.was}. Its ATR
                    threshold and point-based exits come across too, which is what
                    makes it the same strategy — but they are in {plan.marketChange.now}
                    &rsquo;s points, so check them against this account before arming it.
                  </p>
                </div>
              )}

              {plan.changes.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-600">
                  Nothing differs — these accounts already have the same filters.
                </p>
              ) : (
                <>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                    {plan.changes.length} setting{plan.changes.length === 1 ? '' : 's'} change
                  </p>
                  <ul className="divide-y divide-white/5">
                    {plan.changes.map((c) => (
                      <li key={c.key} className="flex items-baseline justify-between gap-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                          {c.label}
                        </span>
                        <span className="nums shrink-0 text-[11px]">
                          <span className="text-slate-600 line-through">{show(c.was)}</span>
                          <span className="mx-1.5 text-slate-600">→</span>
                          <span className="text-slate-200">{show(c.now)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="border-t border-white/5 px-5 py-3">
              <p className="text-[10px] leading-relaxed text-slate-600">
                Saved immediately on confirming. The ON/OFF switch is not copied —
                it stays as you set it here.
              </p>
              <div className="mt-2.5 flex justify-end gap-1.5">
                <button
                  onClick={() => setPicked(null)}
                  className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Back
                </button>
                <button
                  onClick={() => onCopy(plan.patch, plan.source?.name ?? '')}
                  disabled={busy || plan.changes.length === 0}
                  className="rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold
                             text-white transition-colors hover:bg-sky-400
                             disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Copy and save'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
