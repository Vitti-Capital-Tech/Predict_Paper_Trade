import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * Transient confirmations.
 *
 * Several things here write to the database and then look identical whether
 * they worked or not - a created account appears in a list you were already
 * looking at, a verification turns a dot a colour you may not be watching. A
 * line that appears and leaves says which of the two happened without putting
 * anything permanent on screen.
 *
 * Errors are kept for longer than successes: a success is a confirmation you
 * already expected, while a failure is something you have to read.
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
    setToasts((t) => [...t.slice(-3), { id, message, tone }])
  }, [])

  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex
                      -translate-x-1/2 flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onDone={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONES = {
  ok:   'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
  err:  'border-rose-500/30 bg-rose-500/15 text-rose-200',
  info: 'border-white/15 bg-ink-800 text-slate-200',
}

function Toast({ message, tone, onDone }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    // An error is something to read; a success is a confirmation of something
    // you already asked for.
    const life = tone === 'err' ? 7000 : 3200
    const go = setTimeout(() => setLeaving(true), life)
    const end = setTimeout(onDone, life + 200)
    return () => { clearTimeout(go); clearTimeout(end) }
  }, [tone, onDone])

  return (
    <div
      role="status"
      className={`pointer-events-auto max-w-md rounded-lg border px-3.5 py-2 text-xs
                  shadow-lg shadow-black/40 transition-all duration-200
                  ${TONES[tone] ?? TONES.info}
                  ${leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'}`}
    >
      {message}
    </div>
  )
}
