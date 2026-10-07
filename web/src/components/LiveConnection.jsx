import { useCallback, useEffect, useState } from 'react'
import {
  fetchDeltaCredentials, verifyDeltaCredentials, saveDeltaCredentials,
} from '../lib/supabase'
import { Labelled, Secret } from './Fields'

const DELTA_GLOBAL = 'https://api.delta.exchange'

/**
 * Whether a live account can actually reach Delta.
 *
 * The check is not made here. Delta authorises by IP and the whitelisted
 * address is the worker's, not this browser's, so a check from this page would
 * fail on credentials that are perfectly good - and teach you to distrust a
 * working setup. Pressing the button marks the credentials unverified; the
 * worker notices within a few seconds, calls the cheapest authenticated
 * endpoint there is, and writes back what happened.
 */

const LOOK = {
  verified:   { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'Connected' },
  verifying:  { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300', label: 'Checking…' },
  unverified: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'Waiting for the worker…' },
  invalid:    { dot: 'bg-rose-500', text: 'text-rose-300', label: 'Not connected' },
  none:       { dot: 'bg-slate-600', text: 'text-slate-400', label: 'No credentials saved' },
}

export default function LiveConnection({ account, workerLive }) {
  const [cred, setCred] = useState(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Keys get rotated, and an account can end up without them if saving failed
  // after it was created - so attaching them later has to be possible here,
  // not only in the form that makes the account.
  const [entering, setEntering] = useState(false)
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  const accountId = account?.id ?? null

  const load = useCallback(() => {
    if (!accountId) return
    fetchDeltaCredentials(accountId)
      .then((row) => { setCred(row); setMissing(false) })
      .catch((e) => {
        // Before migration 023 the function does not exist. Say which one.
        if (/function|does not exist|PGRST202|schema cache/i.test(`${e?.message ?? e}`)) {
          setMissing(true)
        } else setError(e.message ?? String(e))
      })
  }, [accountId])

  useEffect(() => { setCred(null); setError(null); load() }, [load])

  // Only poll while an answer is actually coming, rather than forever.
  const pending = cred?.status === 'unverified' || cred?.status === 'verifying'
  useEffect(() => {
    if (!pending) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [pending, load])

  if (!accountId) return null

  if (missing) {
    return (
      <Shell>
        <p className="text-xs text-amber-300">
          Live credentials need{' '}
          <code className="rounded bg-black/30 px-1">
            supabase/migrations/023_delta_credentials.sql
          </code>{' '}
          run once.
        </p>
      </Shell>
    )
  }

  const status = cred ? cred.status : 'none'
  const look = LOOK[status] ?? LOOK.none

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      await verifyDeltaCredentials(accountId)
      setCred((c) => (c ? { ...c, status: 'unverified', last_error: null } : c))
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveCreds = async () => {
    if (!key.trim() || !secret.trim()) {
      setError('API key and secret are both required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveDeltaCredentials(accountId, key.trim(), secret.trim(), DELTA_GLOBAL)
      setKey(''); setSecret(''); setEntering(false)
      setShowKey(false); setShowSecret(false)
      // Saving marks them unverified; the worker picks that up on its own.
      load()
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${look.dot}`} />
          <div>
            <p className={`text-xs font-semibold ${look.text}`}>{look.label}</p>
            <p className="nums mt-0.5 text-[11px] text-slate-500">
              {cred
                ? <>key ····{cred.key_last4} · {entityName(cred.base_url)}</>
                : 'Add an API key and secret to this account to connect it.'}
            </p>
          </div>
        </div>

        {!entering && (
          <button
            onClick={() => { setEntering(true); setError(null) }}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400
                       transition-colors hover:border-white/25 hover:text-slate-200"
          >
            {cred ? 'Replace key' : 'Add credentials'}
          </button>
        )}

        {cred && (
          <button
            onClick={verify}
            disabled={busy || pending}
            title={workerLive
              ? 'The worker will check these credentials against Delta'
              : 'No worker is running, so nothing will pick this up'}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300
                       transition-colors hover:border-white/25 disabled:opacity-40"
          >
            {pending ? 'Checking…' : 'Verify connection'}
          </button>
        )}
      </div>

      {/* Pending with nothing running is the one case the dot cannot explain:
          it will sit there indefinitely rather than failing. */}
      {pending && !workerLive && (
        <p className="mt-2 text-[11px] text-amber-400">
          No worker is running, so this check will not be picked up.
        </p>
      )}

      {status === 'invalid' && cred?.last_error && (
        <div className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2">
          <p className="text-[11px] text-rose-300">{cred.last_error}</p>
          {cred.seen_ip && (
            <p className="nums mt-1 text-[11px] text-rose-200/80">
              Delta saw this request coming from{' '}
              <strong className="text-rose-200">{cred.seen_ip}</strong> — that is
              the address to whitelist.
            </p>
          )}
        </div>
      )}

      {entering && (
        <div className="mt-3 space-y-1.5 border-t border-white/5 pt-3">
          <Labelled label="API Key">
            <Secret value={key} onChange={(e) => setKey(e.target.value)}
                    show={showKey} onToggle={() => setShowKey((v) => !v)}
                    cls={FIELD} name="live-key" />
          </Labelled>
          <Labelled label="API Secret">
            <Secret value={secret} onChange={(e) => setSecret(e.target.value)}
                    show={showSecret} onToggle={() => setShowSecret((v) => !v)}
                    cls={FIELD} name="live-secret" />
          </Labelled>
          <div className="flex justify-end gap-1.5 pt-0.5">
            <button onClick={() => { setEntering(false); setKey(''); setSecret('') }}
                    className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300">
              Cancel
            </button>
            <button onClick={saveCreds} disabled={busy}
                    className="rounded-md bg-sky-500 px-2.5 py-1 text-[11px] font-semibold
                               text-white hover:bg-sky-400 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save and check'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}

      <p className="mt-2.5 border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
        Connected means the key, the secret, the clock and the IP allowlist all
        check out. It does not mean this account trades: the worker only paper
        trades today and skips live accounts entirely.
      </p>
    </Shell>
  )
}

const FIELD = `nums w-full rounded-md border border-white/10 bg-ink-800 px-2 py-1
                text-xs text-slate-100 outline-none focus:border-sky-500/50`

function Shell({ children }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink-900 px-4 py-3">{children}</div>
  )
}

/**
 * Only flagged when it is wrong. Predict is listed on the global entity, so an
 * India key is not a variant to report neutrally - it is a key that cannot
 * reach these markets, and saying "Delta India" calmly would hide that.
 */
function entityName(url) {
  if (!url) return 'Delta Global'
  return url.includes('india') ? 'Delta India — wrong entity' : 'Delta Global'
}
