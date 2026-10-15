/**
 * The small (i) beside a label.
 *
 * Shown on hover, and on tap: `focus-within` covers touch, where there is no
 * hover state at all and a hover-only tooltip is simply invisible.
 *
 * `side="right"` opens it beside the dot rather than above - inside a table
 * that scrolls sideways, above is clipped by the scroll box on the top rows.
 */
export default function InfoDot({ text, side = 'top' }) {
  const place = side === 'right'
    ? 'left-full top-1/2 ml-1.5 -translate-y-1/2'
    : side === 'bottom'
      ? 'top-full left-0 mt-1.5'
      : 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
  return (
    <span className="group/info relative inline-flex align-middle">
      <button
        type="button" tabIndex={0} aria-label={text}
        onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full border
                   border-slate-600 text-[8px] font-bold leading-none text-slate-500
                   transition-colors hover:border-sky-500 hover:text-sky-400
                   focus:border-sky-500 focus:text-sky-400 focus:outline-none"
      >
        i
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${place} z-30 w-56 rounded-lg border
                    border-white/10 bg-ink-950 px-2.5 py-2 text-[11px] font-normal
                    normal-case leading-snug tracking-normal text-slate-300 opacity-0
                    shadow-xl shadow-black/60 transition-opacity
                    group-hover/info:opacity-100 group-focus-within/info:opacity-100`}
      >
        {text}
      </span>
    </span>
  )
}
