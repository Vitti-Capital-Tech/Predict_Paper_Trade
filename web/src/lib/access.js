// Soft sign-in gate for the Predict dashboard.
//
// This decides which accounts an entry may SEE in the UI. It is a convenience
// gate, not a security boundary: account rows are still fetched with the anon
// key, so the filtering here only hides them from the screen. A real boundary
// would be RLS keyed to an authenticated user. Keep that in mind before using
// this to withhold anything that must not be seen.

const ACCESS_KEY = 'predict.access'

// The operator keyword that unlocks every account. Kept in env (VITE_ACCESS_
// KEYWORD) rather than in source so it is not committed to the repo — set it in
// web/.env. Empty means no keyword is accepted.
const FULL_ACCESS_KEYWORD = (import.meta.env.VITE_ACCESS_KEYWORD ?? '').trim().toLowerCase()

// Per-email restrictions. Each maps to the account names it may see
// (case-insensitive). Full access comes from the env keyword above, not here.
const EMAIL_RULES = {
  'shahkajal991@gmail.com': ['JD'],
}

const normalise = (entry) => (entry ?? '').trim().toLowerCase()

/** The rule for a normalised key: '*' for the keyword, a name list for a known
 *  email, or null. */
function ruleFor(key) {
  if (FULL_ACCESS_KEYWORD && key === FULL_ACCESS_KEYWORD) return '*'
  if (key in EMAIL_RULES) return EMAIL_RULES[key]
  return null
}

/** The rule for an entry, or null if it has no access. */
export function accessRule(entry) {
  return ruleFor(normalise(entry))
}

/** Store a valid entry and return true; return false for an unknown one. */
export function signIn(entry) {
  const key = normalise(entry)
  if (ruleFor(key) === null) return false
  try { localStorage.setItem(ACCESS_KEY, key) } catch { /* private mode */ }
  return true
}

/** The currently signed-in entry, or null — ignores a stored value whose
 *  rule has since been removed. */
export function currentAccess() {
  try {
    const key = localStorage.getItem(ACCESS_KEY)
    return key && ruleFor(key) !== null ? key : null
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
