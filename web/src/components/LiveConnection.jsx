import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDeltaCredentials } from '../lib/supabase'
import { useToast } from './Toasts'

/**
 * Whether a live account can actually reach Delta, and what it holds.
 *
 * The check itself is not made here, and not by the browser at all. Delta
 * authorises by IP and the whitelisted address is the worker's, not this
 * page's, so a check from here would fail on credentials that are perfectly
 * good - and teach you to distrust a working setup. The switcher's button
 * marks the credentials unverified; the worker notices within a few seconds,
 * calls the cheapest authenticated endpoint there is, and writes back what
 * happened. This watches for that answer.
 */

const money = (v) => `$${Number(v ?? 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
  const [error, setError] = useState(null)
  const toast = useToast()

  const accountId = account?.id ?? null
  // What the status was last time, so a verdict is announced once - when it
  // arrives - rather than on every poll that sees the same answer.
  const was = useRef(null)

  const load = useCallback(() => {
    if (!accountId) return
    fetchDeltaCredentials(accountId)
      .then((row) => { setCred(row); setMissing(false) })
      .catch((e) => {
        if (/function|does not exist|PGRST202|schema cache/i.test(`${e?.message ?? e}`)) {
          setMissing(true)
        } else setError(e.message ?? String(e))
      })
  }, [accountId])

  useEffect(() => { setCred(null); setError(null); was.current = null; load() }, [load])

  const status = cred ? cred.status : 'none'
  const pending = status === 'unverified' || status === 'verifying'

  // Polled even when settled, not only while an answer is due. A recheck is
  // started from the switcher, so this panel has no way of knowing one is
  // under way - and gating the poll on `pending` meant a verified account
  // never noticed it had gone back to being checked. Faster while waiting.
  useEffect(() => {
    if (!accountId) return
    const t = setInterval(load, pending ? 1500 : 4000)
    return () => clearInterval(t)
  }, [pending, load, accountId])

  // Announce the verdict as it lands. The dot alone is easy to miss on a
  // screen you are not watching when the worker finally answers.
  useEffect(() => {
    const prev = was.current
    was.current = status
    if (prev === null || prev === status) return
    if (!(prev === 'unverified' || prev === 'verifying')) return
    if (status === 'verified') toast('Connected to Delta', 'ok')
    if (status === 'invalid') toast(cred?.last_error || 'Could not connect to Delta', 'err')
  }, [status, cred?.last_error, toast])

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

  const look = LOOK[status] ?? LOOK.none

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${look.dot}`} />
          <div>
            <p className={`text-xs font-semibold ${look.text}`}>{look.label}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {cred ? entityName(cred.base_url)
                    : 'Add an account with an API key to connect it.'}
            </p>
          </div>
        </div>

        {/* The balance Delta reported. It is the number that says the
            connection is not merely open but reading the right account. */}
        {cred && (
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Balance</p>
            <p className="nums text-sm font-semibold text-slate-100">
              {money(account?.balance)}
            </p>
          </div>
        )}
      </div>

      {/* Nothing else on screen moves while the worker is being waited on, and
          the wait runs to several seconds - long enough to read as nothing
          having happened at all. */}
      {pending && (
        <div className="mt-2.5 h-0.5 w-full overflow-hidden rounded bg-white/5">
          <div className="indeterminate h-full w-1/3 rounded bg-sky-400/70" />
        </div>
      )}

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

      {error && <p className="mt-2 text-[11px] text-rose-300">{error}</p>}

      <p className="mt-2.5 border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
        Connected means the key, the secret, the clock and the IP allowlist all
        check out. It does not mean this account trades: the worker only paper
        trades today and skips live accounts entirely.
      </p>
    </Shell>
  )
}

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
