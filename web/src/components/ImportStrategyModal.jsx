import { useEffect, useMemo, useState } from 'react'

/**
 * Take another account's filters.
 *
 * Pull rather than push: you set up one account, then bring those rules into
 * the one you are looking at. The account being changed is the one on screen,
 * which is the one whose Save button and Revert are right there if the result
 * is not what you wanted.
 *
 * Nothing is written here. The settings land in the form as unsaved changes,
 * so they can be read, adjusted and saved - or reverted - like any other edit.
 */

// Identity, not settings. `underlying` is which market the account trades and
// `enabled` is whether it is live right now; importing either would move an
// account onto another's market, or arm one that was deliberately off.
const NEVER_IMPORT = ['id', 'account_id', 'updated_at', 'enabled', 'underlying']

// Denominated in the underlying's own points, so they mean different things on
// different markets: the BTC accounts gate on ATR>175 where the ETH ones use
// ATR>7, and 175 brought onto an ETH account would never pass again.
const ASSET_SCALED = ['atr_min', 'exit_points', 'exit_atm_band']

export default function ImportStrategyModal({
  open, onClose, account, accounts, configs, saved, onImport,
}) {
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    if (!open) return
    setPicked(null)
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

  // Only accounts that have settings to give.
  const sources = useMemo(
    () => (accounts ?? []).filter(
      (a) => a.id !== account?.id && byAccount.has(a.id)),
    [accounts, account, byAccount])

  if (!open) return null

  const here = (saved?.underlying) || 'BTC'

  const take = (sourceId) => {
    const from = byAccount.get(sourceId)
    if (!from || !saved) return
    const cross = (from.underlying || 'BTC') !== here
    const patch = {}
    for (const [k, v] of Object.entries(from)) {
      if (NEVER_IMPORT.includes(k)) continue
      if (cross && ASSET_SCALED.includes(k)) continue
      // Only keys this row actually has: a column from a migration that has
      // not been run would otherwise be carried in and then rejected on save.
      if (!(k in saved)) continue
      patch[k] = v
    }
    onImport(patch, accounts.find((a) => a.id === sourceId)?.name ?? '', cross)
    onClose()
  }

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
              Import filters
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              into <span className="text-slate-300">{account?.name ?? 'this account'}</span>
              {' '}· {here}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {sources.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-600">
              No other account has settings to import.
            </p>
          )}
          {sources.map((a) => {
            const asset = byAccount.get(a.id)?.underlying || 'BTC'
            const differs = asset !== here
            const on = picked === a.id
            return (
              <button
                key={a.id}
                onMouseEnter={() => setPicked(a.id)}
                onFocus={() => setPicked(a.id)}
                onClick={() => take(a.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left
                            transition-colors ${on ? 'bg-sky-500/10' : 'hover:bg-white/5'}`}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                  {a.name}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                  differs ? 'bg-amber-500/15 text-amber-400' : 'bg-white/5 text-slate-500'}`}>
                  {asset}
                </span>
              </button>
            )
          })}
        </div>

        <div className="border-t border-white/5 px-5 py-3">
          <p className="text-[10px] leading-relaxed text-slate-600">
            Market and the ON/OFF switch are never imported.
            {picked && (byAccount.get(picked)?.underlying || 'BTC') !== here && (
              <span className="text-amber-400/90">
                {' '}That account trades a different market, so its ATR minimum and
                point-based exits are left alone too — those numbers are in the
                underlying&rsquo;s own points.
              </span>
            )}
          </p>
          <p className="mt-1.5 text-[10px] text-slate-600">
            Lands as unsaved changes — review them, then Save.
          </p>
        </div>
      </div>
    </div>
  )
}
