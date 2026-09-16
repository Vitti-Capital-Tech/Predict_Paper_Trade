export function Card({ title, subtitle, right, children, className = '' }) {
  return (
    <section
      className={`rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-sm font-semibold tracking-wide text-slate-200">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="truncate text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Kpi({ label, value, sub, tone = 'neutral' }) {
  const tones = {
    neutral: 'text-slate-100',
    good: 'text-emerald-400',
    bad: 'text-rose-400',
    warn: 'text-amber-400',
  }
  return (
    <div className="rounded-xl border border-white/5 bg-ink-900/80 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`nums mt-1.5 text-2xl font-semibold sm:text-3xl ${tones[tone]}`}>
        {value}
      </p>
      {sub && <p className="nums mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

export function Badge({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
    green: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
    red: 'bg-rose-500/10 text-rose-400 ring-rose-500/30',
    amber: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
    blue: 'bg-sky-500/10 text-sky-400 ring-sky-500/30',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Empty({ children }) {
  return (
    <p className="py-8 text-center text-sm text-slate-600">{children}</p>
  )
}
