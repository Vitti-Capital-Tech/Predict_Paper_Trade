/**
 * Inline SVG icons.
 *
 * These were emoji and glyphs (⧗ ⏳ 🕐 ⏸) — those render at a different weight,
 * size and even colour on every platform, and on Windows several fall back to
 * a bitmap emoji font that ignores `currentColor`. Drawn shapes sit on the
 * baseline predictably and inherit the surrounding text colour.
 */

export function HourglassIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4.5 2h7M4.5 14h7" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" />
      <path d="M5.2 2.2v2.1c0 1.1.7 2 1.8 2.6.7.4.7 1.8 0 2.2-1.1.6-1.8 1.5-1.8 2.6v2.1"
            stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M10.8 2.2v2.1c0 1.1-.7 2-1.8 2.6-.7.4-.7 1.8 0 2.2 1.1.6 1.8 1.5 1.8 2.6v2.1"
            stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.4 12.3c.4-.7 1-1.1 1.6-1.1s1.2.4 1.6 1.1z" fill="currentColor" />
    </svg>
  )
}

export function ClockIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PauseIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="4.2" y="3.2" width="2.6" height="9.6" rx="1" fill="currentColor" />
      <rect x="9.2" y="3.2" width="2.6" height="9.6" rx="1" fill="currentColor" />
    </svg>
  )
}

export function InfoIcon({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" />
    </svg>
  )
}

export function PencilIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M11.3 2.4a1.4 1.4 0 0 1 2 2l-7.4 7.4-2.7.7.7-2.7z"
            stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10.2 3.5 12.5 5.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function ResetIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" />
      <path d="M12.6 1.9v2.7H9.9" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TrashIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.8 4.3h10.4M6.3 4.3V3.1a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.2"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4.2 4.3l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2"
            stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.8 6.8v4M9.2 6.8v4" stroke="currentColor" strokeWidth="1.2"
            strokeLinecap="round" />
    </svg>
  )
}
