import { useState } from 'react'
import { signIn } from '../lib/access'
import Logo from './Logo'

/**
 * Email gate shown until a recognised entry is given. This only governs what
 * the UI shows (see lib/access.js) — it is not a security boundary.
 */
export default function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('')
  const [err, setErr] = useState(null)

  const submit = (e) => {
    e.preventDefault()
    const entry = email.trim().toLowerCase()
    if (signIn(entry)) {
      setErr(null)
      onSignedIn(entry)
    } else {
      setErr('This email does not have access to this dashboard.')
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-white/5 bg-ink-900 p-6">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <h1 className="text-lg font-semibold italic text-sky-400">Predict</h1>
        </div>
        <h2 className="mt-5 text-base font-semibold text-slate-100">Sign in</h2>
        <p className="mt-1 text-sm text-slate-400">
          Enter your email to access the dashboard.
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            type="text"
            autoFocus
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErr(null) }}
            placeholder="name@example.com"
            aria-label="Email"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2
                       text-sm text-slate-100 placeholder-slate-600 outline-none
                       focus:border-sky-500/50"
          />
          {err && <p className="text-xs text-rose-400">{err}</p>}
          <button
            type="submit"
            className="w-full rounded-lg bg-sky-500/20 px-3 py-2 text-sm font-semibold
                       text-sky-300 transition-colors hover:bg-sky-500/30"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  )
}
