import { useEffect, useRef, useState } from 'react'

/**
 * Themed dropdown.
 *
 * A native <select> renders its list with OS chrome — a white menu on a dark
 * page — which is why the controls looked foreign. This keeps the menu inside
 * the page so it can carry the same palette as everything else.
 */
export default function Dropdown({
  value, onChange, options, className = '', align = 'left',
  size = 'md', disabled = false, ariaLabel,
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Keep the selected row in view when the menu opens.
  useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.querySelector('[data-selected="true"]')
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [open])

  const current = options.find((o) => String(o.value) === String(value))
  const pad = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'

  return (
    <div className={`relative ${className}`} ref={wrapRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border
                    bg-ink-800 text-left transition-colors outline-none
                    disabled:cursor-not-allowed disabled:opacity-50 ${pad} ${
                      open
                        ? 'border-sky-500/70 text-slate-100'
                        : 'border-white/10 text-slate-200 hover:border-sky-500/40'
                    }`}
      >
        <span className="truncate">{current?.label ?? '—'}</span>
        <svg viewBox="0 0 20 20" fill="none"
             className={`h-3.5 w-3.5 shrink-0 text-sky-400 transition-transform ${
               open ? 'rotate-180' : ''}`}>
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          className={`absolute z-30 mt-1.5 max-h-64 min-w-full overflow-y-auto rounded-lg
                      border border-sky-500/25 bg-ink-900 py-1 shadow-xl
                      shadow-black/50 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {options.map((o) => {
            const selected = String(o.value) === String(value)
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected}
                  onClick={() => { onChange(o.value); setOpen(false) }}
                  className={`flex w-full items-center justify-between gap-3 whitespace-nowrap
                              px-3 py-2 text-left text-sm transition-colors ${
                                selected
                                  ? 'bg-sky-500/15 text-sky-300'
                                  : 'text-slate-300 hover:bg-sky-500/10 hover:text-slate-100'
                              }`}
                >
                  <span>{o.label}</span>
                  {o.hint && (
                    <span className="nums text-[11px] text-slate-500">{o.hint}</span>
                  )}
                  {selected && (
                    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 text-sky-400">
                      <path d="M4 10.5 8 14.5 16 6" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
