import { useEffect, useRef, useState } from 'react'
import {
  createAccount, updateAccount, deleteAccount, countOpenPositions,
} from '../lib/supabase'
import { PencilIcon, ResetIcon, TrashIcon } from './icons'

/**
 * Account switcher.
 *
 * Accounts are owned by the UI rather than by a worker session — the worker
 * only touches a balance when a trade settles, so an edited figure is not
 * overwritten a couple of seconds later.
 *
 * Each row carries its own edit, reset and delete, because doing those through
 * a single "current account" menu meant switching to an account before you
 * could act on it.
 */

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const DEFAULT_BALANCE = 10000

function IconButton({ title, onClick, tone = 'slate', children }) {
  const tones = {
    slate: 'text-slate-500 hover:bg-white/10 hover:text-slate-200',
    rose: 'text-slate-500 hover:bg-rose-500/15 hover:text-rose-300',
  }
  return (
    <button
      type="button" title={title} aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`rounded p-1 transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

export default function AccountBar({ account, accounts, onSelect, onAccountsChanged,
                                     unavailable }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // id of the row being renamed / re-balanced, and its draft values
  const [editing, setEditing] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftBalance, setDraftBalance] = useState('')

  // id of the row awaiting delete confirmation
  const [confirming, setConfirming] = useState(null)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBalance, setNewBalance] = useState(String(DEFAULT_BALANCE))

  const wrapRef = useRef(null)

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
        setEditing(null)
        setConfirming(null)
        setCreating(false)
      }
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

  async function run(fn) {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await onAccountsChanged()
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  function startEdit(a) {
    setConfirming(null)
    setEditing(a.id)
    setDraftName(a.name)
    setDraftBalance(String(a.balance))
  }

  async function saveEdit(a) {
    const value = Number(draftBalance)
    const name = draftName.trim()
    if (!name || !Number.isFinite(value) || value < 0) { setEditing(null); return }
    await run(async () => {
      // The starting balance moves with an edited balance, so "reset" keeps
      // meaning "back to what I put in" rather than back to some earlier figure.
      await updateAccount(a.id, { name, balance: value, starting_balance: value })
      setEditing(null)
    })
  }

  async function reset(a) {
    await run(() => updateAccount(a.id, { balance: a.starting_balance }))
  }

  async function remove(a) {
    await run(async () => {
      if (accounts.length <= 1) {
        throw new Error('This is the only account — make another before deleting it.')
      }
      const openCount = await countOpenPositions(a.id)
      if (openCount > 0) {
        throw new Error(
          `${a.name} has ${openCount} open position${openCount > 1 ? 's' : ''}. `
          + 'Close or settle them first.')
      }
      await deleteAccount(a.id)
      setConfirming(null)
      if (a.id === account?.id) {
        const next = accounts.find((x) => x.id !== a.id)
        if (next) onSelect(next.id)
      }
    })
  }

  async function create() {
    const value = Number(newBalance)
    const name = newName.trim() || `Account ${accounts.length + 1}`
    if (!Number.isFinite(value) || value < 0) return
    await run(async () => {
      const made = await createAccount(name, value)
      if (made) onSelect(made.id)
      setCreating(false)
      setNewName('')
      setNewBalance(String(DEFAULT_BALANCE))
      setOpen(false)
    })
  }

  const fieldCls = `nums w-full rounded-md border border-white/10 bg-ink-800 px-2 py-1
                    text-xs text-slate-100 outline-none focus:border-sky-500/50`

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
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

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-xl
                        border border-white/10 bg-ink-900 shadow-xl">
          <ul className="max-h-72 overflow-y-auto py-1">
            {accounts.map((a) => {
              const isCurrent = a.id === account?.id

              if (editing === a.id) {
                return (
                  <li key={a.id} className="space-y-1.5 px-3 py-2">
                    <input
                      autoFocus value={draftName} className={fieldCls}
                      placeholder="Account name"
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit(a)
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2 top-1/2
                                       -translate-y-1/2 text-xs text-slate-500">$</span>
                      <input
                        type="number" min="0" step="100" value={draftBalance}
                        className={`${fieldCls} no-spin pl-5`}
                        onChange={(e) => setDraftBalance(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(a)
                          if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    </div>
                    <div className="flex justify-end gap-1.5 pt-0.5">
                      <button onClick={() => setEditing(null)}
                              className="px-2 py-1 text-[11px] text-slate-500
                                         hover:text-slate-300">
                        Cancel
                      </button>
                      <button onClick={() => saveEdit(a)} disabled={busy}
                              className="rounded-md bg-sky-500 px-2.5 py-1 text-[11px]
                                         font-semibold text-white hover:bg-sky-400
                                         disabled:opacity-50">
                        Save
                      </button>
                    </div>
                  </li>
                )
              }

              if (confirming === a.id) {
                return (
                  <li key={a.id}
                      className="flex items-center justify-between gap-2 bg-rose-500/10
                                 px-3 py-2">
                    <span className="truncate text-[11px] text-rose-200">
                      Delete {a.name}?
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      <button onClick={() => setConfirming(null)}
                              className="px-1.5 py-1 text-[11px] text-slate-400
                                         hover:text-slate-200">
                        No
                      </button>
                      <button onClick={() => remove(a)} disabled={busy}
                              className="rounded-md bg-rose-600 px-2.5 py-1 text-[11px]
                                         font-semibold text-white hover:bg-rose-500
                                         disabled:opacity-50">
                        Delete
                      </button>
                    </span>
                  </li>
                )
              }

              return (
                <li key={a.id}>
                  <div
                    role="button" tabIndex={0}
                    onClick={() => { onSelect(a.id); setOpen(false) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { onSelect(a.id); setOpen(false) }
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2
                                text-left text-xs transition-colors hover:bg-white/5 ${
                      isCurrent ? 'text-sky-300' : 'text-slate-300'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="nums shrink-0 text-slate-500">{money(a.balance)}</span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <IconButton title="Edit name and balance" onClick={() => startEdit(a)}>
                        <PencilIcon />
                      </IconButton>
                      <IconButton title={`Reset to ${money(a.starting_balance)}`}
                                  onClick={() => reset(a)}>
                        <ResetIcon />
                      </IconButton>
                      <IconButton title="Delete account" tone="rose"
                                  onClick={() => { setEditing(null); setConfirming(a.id) }}>
                        <TrashIcon />
                      </IconButton>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="border-t border-white/5 p-1">
            {creating ? (
              <div className="space-y-1.5 p-2">
                <input
                  autoFocus value={newName} className={fieldCls}
                  placeholder={`Account ${accounts.length + 1}`}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') create()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                />
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2
                                   -translate-y-1/2 text-xs text-slate-500">$</span>
                  <input
                    type="number" min="0" step="100" value={newBalance}
                    className={`${fieldCls} no-spin pl-5`}
                    placeholder="Starting balance"
                    onChange={(e) => setNewBalance(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') create()
                      if (e.key === 'Escape') setCreating(false)
                    }}
                  />
                </div>
                <div className="flex justify-end gap-1.5 pt-0.5">
                  <button onClick={() => setCreating(false)}
                          className="px-2 py-1 text-[11px] text-slate-500
                                     hover:text-slate-300">
                    Cancel
                  </button>
                  <button onClick={create} disabled={busy}
                          className="rounded-md bg-sky-500 px-2.5 py-1 text-[11px]
                                     font-semibold text-white hover:bg-sky-400
                                     disabled:opacity-50">
                    Create
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setCreating(true); setEditing(null); setConfirming(null) }}
                disabled={busy}
                className="w-full rounded-md px-3 py-2 text-left text-xs text-sky-300
                           transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                + New account
              </button>
            )}
          </div>
        </div>
      )}

      {err && (
        <span className="absolute right-0 top-full z-40 mt-1 max-w-xs rounded bg-rose-500/15
                         px-2 py-1 text-[10px] leading-snug text-rose-300">
          {err}
        </span>
      )}
    </div>
  )
}
