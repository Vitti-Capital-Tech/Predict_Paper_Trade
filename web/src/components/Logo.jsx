/**
 * The Predict mark: price crossing the target threshold, which is the whole
 * question one of these markets asks. Inline rather than an <img> so it takes
 * currentColor-free brand tones without a second network request.
 */
export default function Logo({ className = 'h-7 w-7' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Predict">
      <defs>
        <linearGradient id="predict-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#121a2a" />
          <stop offset="100%" stopColor="#080c14" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#predict-bg)" />
      <line x1="11" y1="38" x2="53" y2="38" stroke="#5d6b82" strokeWidth="3.5"
            strokeLinecap="round" />
      <path d="M12 47 L26 43 L38 25 L52 15" fill="none" stroke="#2f8fef"
            strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="52" cy="15" r="5" fill="#5fb0ff" />
    </svg>
  )
}
