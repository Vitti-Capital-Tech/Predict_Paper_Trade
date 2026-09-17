import { useEffect, useRef, useState } from 'react'
import { fetchAccounts, createAccount, updateAccount } from '../lib/supabase'

/**
 * Account switcher with an editable balance, in place of the old run selector.
 *
 * Accounts are owned by the UI rather than by a worker session — the worker
 * only touches a balance when a trade settles, so an edited figure is not
 * overwritten a couple of seconds later.
 */

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function AccountBar({ account, accounts, onSelect, onAccountsChanged, unavailable }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const wrapRef = useRef(null)

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  if (unavailable) {
    return (
      <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1
                       text-[11px] text-amber-300">
        Run migration 004 for accounts
      </span>
    )
  }

  async function saveBalance() {
    const value = Number(draft)
    if (!Number.isFinite(value) || value < 0) { setEditing(false); return }
    setBusy(true); setErr(null)
    try {
      await updateAccount(account.id, { balance: value, starting_balance: value })
      await onAccountsChanged()
      setEditing(false)
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function addAccount() {
    const name = `Account ${accounts.length + 1}`
    setBusy(true); setErr(null)
    try {
      const created = await createAccount(name, 10000)
      await onAccountsChanged()
      if (created) onSelect(created.id)
      setOpen(false)
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function resetBalance() {
    setBusy(true); setErr(null)
    try {
      await updateAccount(account.id, { balance: account.starting_balance })
      await onAccountsChanged()
      setOpen(false)
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
      {editing ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">$</span>
          <input
            autoFocus
            type="number"
            min="0"
            step="100"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveBalance()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="nums w-28 rounded-md border border-sky-500/50 bg-ink-800 px-2 py-1
                       text-right text-xs text-slate-100 outline-none"
          />
          <button
            onClick={saveBalance}
            disabled={busy}
            className="rounded-md bg-sky-500/20 px-2 py-1 text-xs text-sky-300
                       hover:bg-sky-500/30 disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-1 text-xs text-slate-500 hover:text-slate-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink-800
                     px-3 py-1.5 transition-colors hover:border-white/20"
        >
          <span className="text-xs text-slate-400">{account?.name ?? 'Account'}</span>
          <span className="nums text-xs font-semibold text-slate-100">
            {money(account?.balance)}
          </span>
          <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3 text-slate-500">
            <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {open && !editing && (
        <div className="absolute right-0 top-full z-20 mt-2 w-60 overflow-hidden rounded-xl
                        border border-white/10 bg-ink-900 shadow-xl">
          <ul className="max-h-56 overflow-y-auto py-1">
            {accounts.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => { onSelect(a.id); setOpen(false) }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left
                              text-xs transition-colors hover:bg-white/5 ${
                    a.id === account?.id ? 'text-sky-300' : 'text-slate-300'}`}
                >
                  <span className="truncate">{a.name}</span>
                  <span className="nums text-slate-500">{money(a.balance)}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-white/5 p-1">
            <button
              onClick={() => {
                setDraft(String(account?.balance ?? 0)); setEditing(true); setOpen(false)
              }}
              className="w-full rounded-md px-3 py-2 text-left text-xs text-slate-300
                         transition-colors hover:bg-white/5"
            >
              Edit balance
            </button>
            <button
              onClick={resetBalance}
              disabled={busy}
              className="w-full rounded-md px-3 py-2 text-left text-xs text-slate-300
                         transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              Reset to {money(account?.starting_balance)}
            </button>
            <button
              onClick={addAccount}
              disabled={busy}
              className="w-full rounded-md px-3 py-2 text-left text-xs text-sky-300
                         transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              + New account
            </button>
          </div>
        </div>
      )}

      {err && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap rounded bg-rose-500/15
                         px-2 py-1 text-[10px] text-rose-300">
          {err}
        </span>
      )}
    </div>
  )
}
