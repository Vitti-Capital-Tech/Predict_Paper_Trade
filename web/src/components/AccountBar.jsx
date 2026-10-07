import { useEffect, useRef, useState } from 'react'
import {
  createAccount, updateAccount, deleteAccount, countOpenPositions,
  saveDeltaCredentials, requestDeltaCheck, fetchDeltaCheck, adoptDeltaCheck,
} from '../lib/supabase'
import { PencilIcon, ResetIcon, TrashIcon } from './icons'

/**
 * Account switcher.
 *
 * Accounts are owned by the UI rather than by a worker session — the worker
 * only touches a balance when a trade settles, so an edited figure is not
 * overwritten a couple of seconds later.
 *
 * The selected account is pinned to the top of the list and is the only row
 * carrying edit, reset and delete. Three icons on every row turned a switcher
 * into a wall of buttons, and made the wrong row's bin easy to hit.
 */

const money = (v) =>
  `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const DEFAULT_BALANCE = 10000

function IconButton({ title, onClick, tone = 'slate', children }) {
  const tones = {
    slate: 'border-white/10 text-slate-400 hover:border-white/30 hover:bg-white/10'
         + ' hover:text-slate-100',
    rose: 'border-white/10 text-slate-400 hover:border-rose-500/50'
        + ' hover:bg-rose-500/15 hover:text-rose-300',
  }
  return (
    <button
      type="button" title={title} aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`rounded-md border p-1.5 transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

/** A field with its name above it, so no box is left to be guessed at. */
function Labelled({ label, children }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  )
}

/**
 * A masked field with a reveal.
 *
 * Masked by default because these get entered with people watching and end up
 * in screen shares. Revealable because they are long random strings, and a
 * mistyped one is indistinguishable from a wrong one until the check fails.
 */
function Secret({ value, onChange, show, onToggle, cls, name }) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value} onChange={onChange} name={name}
        autoComplete="new-password" spellCheck="false"
        className={`${cls} nums pr-8`}
      />
      <button
        type="button" onClick={onToggle} tabIndex={-1}
        aria-label={show ? 'Hide' : 'Show'}
        title={show ? 'Hide' : 'Show'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1
                   text-slate-500 transition-colors hover:text-slate-200"
      >
        {show ? (
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
            <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M6.3 6.4a2 2 0 002.8 2.8M4.3 4.5C2.9 5.4 1.8 6.7 1.3 8c1 2.3 3.6 4 6.7 4 1.2 0 2.3-.3 3.3-.7M12.4 10c.9-.6 1.6-1.3 2.3-2-1-2.3-3.6-4-6.7-4-.5 0-1 .05-1.4.14"
                  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
            <path d="M1.3 8C2.3 5.7 4.9 4 8 4s5.7 1.7 6.7 4c-1 2.3-3.6 4-6.7 4S2.3 10.3 1.3 8z"
                  stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        )}
      </button>
    </div>
  )
}

export default function AccountBar({ account, accounts, onSelect, onAccountsChanged,
                                     unavailable, mode = 'paper' }) {
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
  // Live only. Held just long enough to hand to the RPC that encrypts the
  // secret; nothing here is kept once the account is made.
  const [newKey, setNewKey] = useState('')
  const [newSecret, setNewSecret] = useState('')
  // Not a choice: Predict's markets are listed on the global entity only.
  const DELTA_GLOBAL = 'https://api.delta.exchange'
  const [showSecrets, setShowSecrets] = useState(false)
  // A live account is not created until its credentials have been proven, so
  // the form holds the verdict - and the balance Delta reported - until then.
  const [check, setCheck] = useState(null)   // { id, status, balance, message, seen_ip }
  const [checking, setChecking] = useState(false)

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

  const live = mode === 'live'
  const verified = check?.status === 'ok'

  // Typing again invalidates a verdict reached on different credentials.
  const onCredChange = (setter) => (e) => {
    setter(e.target.value)
    if (check) setCheck(null)
  }

  async function verify() {
    if (!newKey.trim() || !newSecret.trim()) {
      setErr('API key and secret are both required')
      return
    }
    setChecking(true)
    setErr(null)
    setCheck(null)
    try {
      const id = await requestDeltaCheck(newKey.trim(), newSecret.trim(), DELTA_GLOBAL)
      // The worker answers within about ten seconds. Poll rather than wait on
      // it, so a worker that is down shows as a timeout instead of a hang.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        const row = await fetchDeltaCheck(id)
        if (row && (row.status === 'ok' || row.status === 'failed')) {
          setCheck({ ...row, id })
          if (row.status === 'failed') {
            setErr(row.seen_ip
              ? `${row.message} — Delta saw this coming from ${row.seen_ip}`
              : row.message)
          }
          return
        }
      }
      setErr('No answer from the worker — is it running?')
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setChecking(false)
    }
  }

  async function create() {
    // A live account's balance is the one Delta just reported, not a number
    // anybody typed.
    const value = live ? Number(check?.balance ?? 0) : Number(newBalance)
    const name = newName.trim() || `Account ${accounts.length + 1}`
    if (!Number.isFinite(value) || value < 0) return
    // Create is not offered until the check has passed, so this is a guard
    // against a stale click rather than something a user should ever see.
    if (live && !verified) {
      setErr('Verify the connection first')
      return
    }
    await run(async () => {
      // Created on whichever side the switcher is showing, so a live account
      // cannot be made by accident from the paper tab.
      const made = await createAccount(name, value, mode)
      if (made && live) {
        // The secret goes straight into the RPC that encrypts it. If this
        // fails the account exists without credentials, which the panel shows
        // as "not connected" rather than pretending it is ready.
        await saveDeltaCredentials(made.id, newKey.trim(), newSecret.trim(),
                                   DELTA_GLOBAL)
        // The worker already proved these moments ago; carry that verdict over
        // rather than showing "unverified" while it checks the same key again.
        if (check?.id) await adoptDeltaCheck(made.id, check.id)
      }
      if (made) onSelect(made.id)
      setCreating(false)
      setNewName('')
      setNewBalance(String(DEFAULT_BALANCE))
      setNewKey('')
      setNewSecret('')
      setCheck(null)
      setShowSecrets(false)
      setOpen(false)
    })
  }

  const fieldCls = `nums w-full rounded-md border border-white/10 bg-ink-800 px-2 py-1
                    text-xs text-slate-100 outline-none focus:border-sky-500/50`

  // Current account first. It is the one carrying the actions, so it should not
  // be somewhere down a scrolling list.
  const ordered = account
    ? [account, ...accounts.filter((a) => a.id !== account.id)]
    : accounts

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
            {ordered.map((a) => {
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
                    {/* Only the selected account gets them: three icons on every
                        row turned a switcher into a wall of buttons, and the
                        odds of hitting the wrong row's bin went up with it. */}
                    {isCurrent && (
                      <span className="flex shrink-0 items-center gap-1">
                        <IconButton title="Edit name and balance"
                                    onClick={() => startEdit(a)}>
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
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="border-t border-white/5 p-1">
            {creating ? (
              <div className="space-y-1.5 p-2">
                <Labelled label="Account name">
                  <input
                    autoFocus value={newName} className={fieldCls}
                    placeholder={`Account ${accounts.length + 1}`}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !live) create()
                      if (e.key === 'Escape') setCreating(false)
                    }}
                  />
                </Labelled>
                {/* Paper only. A live account's money is whatever Delta
                    says it is - typing a number here would invent a second
                    balance that the exchange has never heard of. */}
                {!live && (
                  <Labelled label="Starting balance">
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
                  </Labelled>
                )}
                {live && (
                  <>
                    {/* Masked by default, with a reveal: these are long
                        random strings and a typo in one is indistinguishable
                        from a wrong key until the check comes back. */}
                    <Labelled label="API Key">
                      <Secret
                        value={newKey} onChange={onCredChange(setNewKey)}
                        show={showSecrets} onToggle={() => setShowSecrets((v) => !v)}
                        cls={fieldCls} name="delta-key"
                      />
                    </Labelled>
                    <Labelled label="API Secret">
                      <Secret
                        value={newSecret} onChange={onCredChange(setNewSecret)}
                        show={showSecrets} onToggle={() => setShowSecrets((v) => !v)}
                        cls={fieldCls} name="delta-secret"
                      />
                    </Labelled>
                    {/* Read-only on purpose. It is filled by the check, from
                        what Delta reported, and is not ours to edit. */}
                    <Labelled label="Balance">
                      <div className={`${fieldCls} flex items-center justify-between
                                       ${verified ? 'text-slate-100' : 'text-slate-600'}`}>
                        <span className="nums">
                          {verified
                            ? `$${Number(check.balance ?? 0).toLocaleString('en-US',
                                { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : '—'}
                        </span>
                        <span className="text-[10px] text-slate-600">
                          {verified ? 'from Delta' : 'verify to read'}
                        </span>
                      </div>
                    </Labelled>
                  </>
                )}
                <div className="flex justify-end gap-1.5 pt-0.5">
                  <button onClick={() => setCreating(false)}
                          className="px-2 py-1 text-[11px] text-slate-500
                                     hover:text-slate-300">
                    Cancel
                  </button>
                  {/* On a live account Create only appears once the credentials
                      have actually reached Delta, so an account cannot exist in
                      a state where it could never trade. */}
                  {live && !verified ? (
                    <button onClick={verify} disabled={checking || busy}
                            className="rounded-md bg-sky-500 px-2.5 py-1 text-[11px]
                                       font-semibold text-white hover:bg-sky-400
                                       disabled:opacity-50">
                      {checking ? 'Verifying…' : 'Verify'}
                    </button>
                  ) : (
                    <button onClick={create} disabled={busy}
                            className="rounded-md bg-sky-500 px-2.5 py-1 text-[11px]
                                       font-semibold text-white hover:bg-sky-400
                                       disabled:opacity-50">
                      Create
                    </button>
                  )}
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
