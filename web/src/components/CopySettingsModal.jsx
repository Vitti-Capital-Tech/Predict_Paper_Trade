import { useEffect, useMemo, useState } from 'react'
import { copyStrategyConfigTo } from '../lib/supabase'

/**
 * Roll one account's filters out to the others.
 *
 * With eight accounts, changing one filter everywhere meant switching account
 * and re-typing it eight times. This copies the account you are on to any
 * targets you tick, in one write per group.
 */

// Identity, not settings. `underlying` is which market the account trades and
// `enabled` is whether it is live right now - copying either would quietly
// move an ETH account onto BTC, or arm one that was deliberately switched off.
const NEVER_COPY = ['id', 'account_id', 'updated_at', 'enabled', 'underlying']

// Measured in the underlying's own price points, so they mean different things
// on different assets: the BTC accounts gate on ATR>175 where the ETH ones use
// ATR>7, and 175 copied onto an ETH account would simply never trigger again.
// Everything else - odds, prices, times, dollars - carries across unchanged.
const ASSET_SCALED = ['atr_min', 'exit_points', 'exit_atm_band']

function patchFrom(config, { skipAssetScaled }) {
  const patch = {}
  for (const [k, v] of Object.entries(config)) {
    if (NEVER_COPY.includes(k)) continue
    if (skipAssetScaled && ASSET_SCALED.includes(k)) continue
    patch[k] = v
  }
  return patch
}

export default function CopySettingsModal({
  open, onClose, account, config, accounts, configs, onCopied,
}) {
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (!open) return
    setPicked([])
    setError(null)
    setDone(null)
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  const sourceAsset = config?.underlying || 'BTC'
  const assetOf = useMemo(() => {
    const m = new Map()
    for (const c of configs ?? []) m.set(c.account_id, c.underlying || 'BTC')
    return m
  }, [configs])

  const targets = useMemo(
    () => (accounts ?? []).filter((a) => a.id !== account?.id),
    [accounts, account])

  if (!open) return null

  const toggle = (id) => setPicked((p) =>
    p.includes(id) ? p.filter((x) => x !== id) : [...p, id])

  const crossAsset = picked.filter((id) => assetOf.get(id) !== sourceAsset)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const same = picked.filter((id) => assetOf.get(id) === sourceAsset)
      const cross = picked.filter((id) => assetOf.get(id) !== sourceAsset)
      let changed = 0
      if (same.length) {
        changed += (await copyStrategyConfigTo(
          same, patchFrom(config, { skipAssetScaled: false }))).length
      }
      if (cross.length) {
        changed += (await copyStrategyConfigTo(
          cross, patchFrom(config, { skipAssetScaled: true }))).length
      }
      if (changed === 0) throw new Error('nothing was written — check permissions')
      setDone(changed)
      onCopied?.()
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
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
        aria-labelledby="copy-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl
                   border border-white/10 bg-ink-900 shadow-2xl shadow-black/60"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-3.5">
          <div>
            <h2 id="copy-title" className="text-sm font-semibold text-slate-100">
              Copy settings
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              from <span className="text-slate-300">{account?.name ?? 'this account'}</span>
              {' '}· {sourceAsset}
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

        {done !== null ? (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-emerald-400">
              Copied to {done} account{done === 1 ? '' : 's'}.
            </p>
            <button
              onClick={onClose}
              className="mt-4 rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold
                         text-white transition-colors hover:bg-sky-400"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 pt-3">
              <span className="text-[11px] text-slate-500">
                Copy to · {picked.length} selected
              </span>
              {targets.length > 0 && (
                <button
                  onClick={() => setPicked(
                    picked.length === targets.length ? [] : targets.map((a) => a.id))}
                  className="text-[11px] text-sky-400 transition-colors hover:text-sky-300"
                >
                  {picked.length === targets.length ? 'Clear' : 'Select all'}
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
              {targets.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-600">
                  No other accounts to copy to.
                </p>
              )}
              {targets.map((a) => {
                const asset = assetOf.get(a.id) ?? '—'
                const differs = asset !== sourceAsset
                const on = picked.includes(a.id)
                return (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2
                                transition-colors ${on ? 'bg-sky-500/10' : 'hover:bg-white/5'}`}
                  >
                    <input
                      type="checkbox" checked={on} onChange={() => toggle(a.id)}
                      className="h-3.5 w-3.5 shrink-0 accent-sky-500"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                      {a.name}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      differs ? 'bg-amber-500/15 text-amber-400' : 'bg-white/5 text-slate-500'}`}>
                      {asset}
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="border-t border-white/5 px-5 py-3">
              <p className="text-[10px] leading-relaxed text-slate-600">
                Market and the ON/OFF switch are never copied.
                {crossAsset.length > 0 && (
                  <span className="text-amber-400/90">
                    {' '}ATR minimum and the point-based exit settings are also left alone on
                    the {crossAsset.length} account{crossAsset.length === 1 ? '' : 's'} trading
                    a different market — those numbers are in the underlying&rsquo;s own points.
                  </span>
                )}
              </p>

              {error && (
                <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                              text-[11px] text-rose-300">
                  {error}
                </p>
              )}

              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400
                             transition-colors hover:border-white/25"
                >
                  Cancel
                </button>
                <button
                  onClick={run}
                  disabled={busy || picked.length === 0}
                  className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white
                             transition-colors hover:bg-sky-400 disabled:opacity-40"
                >
                  {busy ? 'Copying…'
                    : picked.length === 0 ? 'Copy'
                      : `Copy to ${picked.length} account${picked.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
