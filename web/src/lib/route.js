// Deep links, in Delta's own URL shape.
//
// Delta addresses a market as /app/predict/B-BTC-81100-2009261845 — asset,
// strike and the DDMMYYHHMM expiry code, with no C/P because one Predict
// market is both legs. Matching that shape means a link copied from the app
// opens the same market here.
//
// Written against the History API rather than a router dependency: there is
// exactly one route, and `vercel.json` already rewrites everything to
// index.html so a deep link survives a hard load.

const PATH_RE = /^\/predict\/B-([A-Z0-9]+)-([0-9.]+)-(\d{10})\/?$/i

/** Parse a location into a market, or null when the path names no market. */
export function parseRoute(pathname = window.location.pathname) {
  const m = PATH_RE.exec(pathname || '')
  if (!m) return null
  return {
    asset: m[1].toUpperCase(),
    strike: Number(m[2]),
    expiryCode: m[3],
  }
}

/** The path for a market, or '/' when the panel has not resolved one yet. */
export function formatRoute(market) {
  if (!market?.asset || market.strike === null || market.strike === undefined
      || !market.expiryCode) {
    return '/'
  }
  return `/predict/B-${market.asset}-${market.strike}-${market.expiryCode}`
}

/**
 * Point the address bar at `market`.
 *
 * `replace` for the panel settling on its defaults — those are not navigation
 * and should not litter the back button — and `push` for a deliberate change
 * of strike or expiry, so Back returns to the previous market.
 */
export function writeRoute(market, { replace = false } = {}) {
  const next = formatRoute(market)
  if (next === window.location.pathname) return
  const url = next + window.location.search + window.location.hash
  if (replace) window.history.replaceState({}, '', url)
  else window.history.pushState({}, '', url)
}

/** Call `fn` when the user navigates with Back or Forward. */
export function onRouteChange(fn) {
  const handler = () => fn(parseRoute())
  window.addEventListener('popstate', handler)
  return () => window.removeEventListener('popstate', handler)
}
