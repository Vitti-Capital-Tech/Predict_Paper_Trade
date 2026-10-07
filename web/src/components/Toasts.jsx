import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * Transient confirmations.
 *
 * Several things here write to the database and then look identical whether
 * they worked or not - a created account appears in a list you were already
 * looking at, a verdict turns a dot a colour you may not be watching. A line
 * that appears and leaves says which of the two happened without putting
 * anything permanent on screen.
 *
 * Bottom right. Top right is where a notification is normally looked for, but
 * that corner belongs to the account switcher - which is open at exactly the
 * moment creating, renaming or deleting an account reports back, so the toast
 * appeared behind it. Bottom centre sat over the portfolio table instead.
 * This corner is clear of both.
 */

const ToastContext = createContext(() => {})

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 1

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const push = useCallback((message, tone = 'ok') => {
    if (!message) return
    const id = nextId += 1
    // Capped: a run of failures should not become a column of its own.
    setToasts((t) => [...t.slice(-2), { id, message, tone }])
  }, [])

  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80
                   max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onDone={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONES = {
  ok:   { accent: 'bg-emerald-400', icon: 'text-emerald-400' },
  err:  { accent: 'bg-rose-500', icon: 'text-rose-400' },
  info: { accent: 'bg-sky-400', icon: 'text-sky-400' },
}

function Icon({ tone, className }) {
  if (tone === 'ok') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.4 8.2l1.8 1.8 3.4-3.6" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (tone === 'err') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 4.9v3.4M8 10.8v.1" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.2v4M8 4.8v.1" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" />
    </svg>
  )
}

function Toast({ message, tone, onDone }) {
  const [shown, setShown] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const look = TONES[tone] ?? TONES.info

  useEffect(() => {
    // One frame as the off-screen state, so the entrance animates rather than
    // the element simply appearing in place.
    const enter = requestAnimationFrame(() => setShown(true))
    // An error is something to read; a success confirms what you just asked
    // for and should not linger over the screen.
    const life = tone === 'err' ? 7000 : 3200
    const go = setTimeout(() => setLeaving(true), life)
    const end = setTimeout(onDone, life + 220)
    return () => {
      cancelAnimationFrame(enter)
      clearTimeout(go)
      clearTimeout(end)
    }
  }, [tone, onDone])

  return (
    <div
      role="status"
      onClick={() => { setLeaving(true); setTimeout(onDone, 200) }}
      className={`pointer-events-auto flex cursor-pointer items-start gap-2.5
                  overflow-hidden rounded-lg border border-white/10 bg-ink-900/95
                  pr-3 shadow-lg shadow-black/50 backdrop-blur
                  transition-all duration-200 ease-out
                  ${shown && !leaving
                    ? 'translate-x-0 opacity-100'
                    : 'translate-x-3 opacity-0'}`}
    >
      {/* A colour down the edge rather than a wash across the whole card: it
          reads at a glance without making the text harder to read. */}
      <span className={`w-0.5 shrink-0 self-stretch ${look.accent}`} />
      <Icon tone={tone} className={`mt-2 h-3.5 w-3.5 shrink-0 ${look.icon}`} />
      <p className="py-2 text-xs leading-relaxed text-slate-200">{message}</p>
    </div>
  )
}
