import { useState } from 'react'
import { fetchTradeHistory, fetchAccounts } from '../lib/supabase'
import { toCsv, downloadCsv, csvName } from '../lib/csv'

/**
 * Download the trade history as CSV, for this account or for all of them.
 *
 * One row per leg rather than per round, which is how the Recent Trades table
 * shows it. A round is three legs at most and is rebuilt by grouping on
 * Round in a pivot; going the other way - recovering a leg's strike, side and
 * fill from a round total - is not possible. The round-level columns are
 * carried on every row so that grouping is one step.
 */

const n2 = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2))
const n4 = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(4))
const iso = (t) => (t ? new Date(t).toISOString() : '')

/** DDMMYYHHMM at the tail of a round id → ISO. */
function expiryIso(roundId) {
  const code = String(roundId ?? '').split('-').pop()
  if (!/^\d{10}$/.test(code)) return ''
  const [dd, mm, yy, hh, mi] = [
    code.slice(0, 2), code.slice(2, 4), code.slice(4, 6),
    code.slice(6, 8), code.slice(8, 10)].map(Number)
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi)).toISOString()
}

function outcome(p) {
  // A settled binary pays exactly $1.00 or $0.00, so the midpoint separates
  // them cleanly. A leg sold before expiry never settled at all.
  if (p.status === 'closed') return 'closed early'
  if (p.exit_price === null || p.exit_price === undefined) return ''
  return Number(p.exit_price) >= 0.5 ? 'won' : 'lost'
}

const COLUMNS = [
  ['Account',         (r) => r._account],
  ['Round',           (r) => r.round_id],
  ['Asset',           (r) => String(r.round_id ?? '').split('-')[0]],
  ['Expiry (UTC)',    (r) => expiryIso(r.round_id)],
  ['Symbol',          (r) => r.symbol],
  ['Role',            (r) => r.role],
  ['Side',            (r) => r.side],
  ['Strike',          (r) => r.strike],
  ['Contracts',       (r) => r.qty],
  ['Entry time (UTC)', (r) => iso(r.entry_time)],
  ['Entry price',     (r) => n4(r.entry_price)],
  ['Invested',        (r) => n2(Number(r.entry_price) * Number(r.qty))],
  ['Entry slippage',  (r) => n4(r.entry_slippage)],
  ['Entry spot',      (r) => n2(r.entry_spot)],
  ['Entry ATR',       (r) => n2(r.entry_atr)],
  ['Exit time (UTC)', (r) => iso(r.exit_time)],
  ['Exit price',      (r) => n4(r.exit_price)],
  ['Returned',        (r) => n2(Number(r.exit_price ?? 0) * Number(r.qty))],
  ['Exit reason',     (r) => r.exit_reason],
  ['Exit slippage',   (r) => n4(r.exit_slippage)],
  ['Fees',            (r) => n2(r.fees)],
  ['P&L',             (r) => n2(r.pnl)],
  ['Outcome',         (r) => outcome(r)],
  ['Status',          (r) => r.status],
  ['Settlement spot', (r) => n2(r.settlement_spot)],
]

function Icon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M8 2v8m0 0L5 7m3 3 3-3" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 11.5v1A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-1"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export default function ExportTrades({ accountId, accountName }) {
  const [busy, setBusy] = useState(null)   // 'one' | 'all'
  const [error, setError] = useState(null)

  const run = async (which) => {
    setBusy(which)
    setError(null)
    try {
      const all = which === 'all'
      const [rows, accounts] = await Promise.all([
        fetchTradeHistory(all ? null : accountId),
        all ? fetchAccounts() : Promise.resolve([]),
      ])
      const names = new Map(accounts.map((a) => [a.id, a.name]))
      // Most of the stored history belongs to accounts that have since been
      // deleted, plus a handful of legs from before accounts existed at all.
      // Those are not anybody's trades any more, so the export is the
      // accounts that are actually there.
      const kept = all ? rows.filter((r) => names.has(r.account_id)) : rows
      if (!kept.length) throw new Error('No completed trades to export yet.')
      const tagged = kept.map((r) => ({
        ...r,
        _account: all ? names.get(r.account_id) : accountName ?? '',
      }))
      // Oldest first: a history reads forwards, and it is what a running
      // total in a spreadsheet needs.
      tagged.reverse()
      downloadCsv(csvName(all ? 'all-accounts' : (accountName || 'account')),
                  toCsv(tagged, COLUMNS))
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const cls = `flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1
               text-[11px] text-slate-400 transition-colors hover:border-white/25
               hover:text-slate-200 disabled:opacity-40`

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-[11px] text-rose-400">{error}</span>}
      <button
        onClick={() => run('one')}
        disabled={busy !== null || !accountId}
        title={`Download every completed trade on ${accountName || 'this account'} as CSV`}
        className={cls}
      >
        <Icon />
        {busy === 'one' ? 'Preparing…' : 'This account'}
      </button>
      <button
        onClick={() => run('all')}
        disabled={busy !== null}
        title="Download every completed trade across all accounts as CSV"
        className={cls}
      >
        <Icon />
        {busy === 'all' ? 'Preparing…' : 'All accounts'}
      </button>
    </div>
  )
}
