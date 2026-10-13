// Soft sign-in gate for the Predict dashboard.
//
// This decides which accounts an entry may SEE in the UI. It is a convenience
// gate, not a security boundary: account rows are still fetched with the anon
// key, so the filtering here only hides them from the screen. A real boundary
// would be RLS keyed to an authenticated user. Keep that in mind before using
// this to withhold anything that must not be seen.

const ACCESS_KEY = 'predict.access'

// Each entry maps to what it may see:
//   '*'            → every account
//   ['JD', ...]    → only accounts whose name matches (case-insensitive)
// 'trade' is the operator keyword that unlocks the whole project.
const RULES = {
  'trade': '*',
  'shahkajal991@gmail.com': ['JD'],
}

const normalise = (entry) => (entry ?? '').trim().toLowerCase()

/** The rule for an entry, or null if it has no access. */
export function accessRule(entry) {
  const key = normalise(entry)
  return key in RULES ? RULES[key] : null
}

/** Store a valid entry and return true; return false for an unknown one. */
export function signIn(entry) {
  const key = normalise(entry)
  if (!(key in RULES)) return false
  try { localStorage.setItem(ACCESS_KEY, key) } catch { /* private mode */ }
  return true
}

/** The currently signed-in entry, or null — ignores a stored value whose
 *  rule has since been removed. */
export function currentAccess() {
  try {
    const key = localStorage.getItem(ACCESS_KEY)
    return key && key in RULES ? key : null
  } catch { return null }
}

export function signOut() {
  try { localStorage.removeItem(ACCESS_KEY) } catch { /* private mode */ }
}

/** True when the entry sees the whole project (so the paper/live switch and
 *  every account stay visible). */
export function isFullAccess(entry) {
  return accessRule(entry) === '*'
}

/** Filter a list of account rows down to what the entry may see. */
export function allowedAccounts(accounts, entry) {
  const rule = accessRule(entry)
  if (rule === '*') return accounts
  if (Array.isArray(rule)) {
    const names = rule.map((n) => n.toLowerCase())
    return accounts.filter((a) => names.includes((a.name ?? '').toLowerCase()))
  }
  return []
}
