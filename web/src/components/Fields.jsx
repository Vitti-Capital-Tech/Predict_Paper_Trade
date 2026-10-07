

/** A field with its name above it, so no box is left to be guessed at. */
export function Labelled({ label, children }) {
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
export function Secret({ value, onChange, show, onToggle, cls, name }) {
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

