import { useEffect, useRef, useState } from 'react'
import { signIn } from '../lib/access'
import Logo from './Logo'
import SignInVisual from './SignInVisual'

/**
 * Email gate shown until a recognised entry is given. This only governs what
 * the UI shows (see lib/access.js) — it is not a security boundary.
 *
 * Motion: the card scales in on arrival, shakes on a rejected email, and plays
 * a tick before handing off to the dashboard on a good one.
 */
export default function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('')
  const [err, setErr] = useState(null)
  const [errCount, setErrCount] = useState(0)
  const [success, setSuccess] = useState(false)
  const cardRef = useRef(null)

  // Shake on each rejection. Done by restarting the CSS animation off a ref
  // (remove class, force reflow, add it back) rather than through React state,
  // so a repeated bad submit re-triggers it and the entrance animation can't
  // cut it short.
  useEffect(() => {
    if (!errCount) return
    const el = cardRef.current
    if (!el) return
    el.classList.remove('animate-shake')
    void el.offsetWidth
    el.classList.add('animate-shake')
    const done = () => el.classList.remove('animate-shake')
    el.addEventListener('animationend', done, { once: true })
    return () => el.removeEventListener('animationend', done)
  }, [errCount])

  const submit = (e) => {
    e.preventDefault()
    if (success) return
    const entry = email.trim().toLowerCase()
    if (signIn(entry)) {
      setErr(null)
      setSuccess(true)
      // Let the confirmation tick play before the dashboard takes over.
      setTimeout(() => onSignedIn(entry), 1200)
    } else {
      setErr('This email does not have access to this dashboard.')
      setErrCount((c) => c + 1)
    }
  }

  return (
    <main className="relative min-h-dvh lg:flex">
      {/* Market visual: a full-screen backdrop on mobile (so the whole screen is
          used), the left half on desktop. */}
      <div className="absolute inset-0 animate-fade-in lg:static lg:flex-1">
        <SignInVisual />
      </div>

      {/* Sign-in: a glass card centred over the chart on mobile, a solid side
          panel on desktop. Fills the screen height either way. */}
      <div className="relative z-10 flex min-h-dvh items-center justify-center px-5 py-10
                      lg:min-h-dvh lg:w-[480px] lg:flex-none lg:border-l lg:border-white/5 lg:bg-ink-900">
        <div
          ref={cardRef}
          className={`w-full max-w-sm rounded-2xl border border-white/10 bg-ink-900/85 p-6
                      shadow-2xl shadow-black/50 backdrop-blur-xl
                      lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none
                      ${success ? '' : 'animate-scale-in'}`}
        >
          <div className="flex items-center gap-2.5">
            <Logo className="h-8 w-8" />
            <h1 className="text-xl font-semibold italic text-sky-400">Predict</h1>
          </div>

          {success ? (
            <div className="flex flex-col items-center py-14 text-center animate-fade-in">
              <div className="animate-pop-in flex h-16 w-16 items-center justify-center
                              rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/40">
                <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#34d399"
                     strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path className="animate-draw-check" d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <p className="mt-5 text-sm font-medium text-slate-100">Signing you in…</p>
              <p className="mt-1 text-xs text-slate-500">Loading your dashboard</p>
            </div>
          ) : (
            <>
              <h2 className="mt-8 text-xl font-semibold text-slate-100 sm:mt-10 sm:text-2xl">Sign in</h2>
              <p className="mt-1.5 text-sm text-slate-400">
                Enter your email to access the dashboard.
              </p>
              <form onSubmit={submit} className="mt-6 space-y-3">
                <input
                  type="text"
                  autoFocus
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setErr(null) }}
                  placeholder="name@example.com"
                  aria-label="Email"
                  className={`w-full rounded-lg border bg-ink-950 px-3.5 py-2.5 text-sm
                              text-slate-100 placeholder-slate-600 outline-none transition-colors
                              ${err ? 'border-rose-500/50 focus:border-rose-500/70'
                                    : 'border-white/10 focus:border-sky-500/50'}`}
                />
                {err && <p className="text-xs text-rose-400 animate-fade-in">{err}</p>}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-sky-500/20 px-3 py-2.5 text-sm font-semibold
                             text-sky-300 transition-colors hover:bg-sky-500/30"
                >
                  Continue
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
