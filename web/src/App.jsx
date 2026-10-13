import { useCallback, useEffect, useState } from 'react'
import { isConfigured, fetchAccounts, fetchLatestRun } from './lib/supabase'
import TradePanel from './components/TradePanel'
import PortfolioTabs from './components/PortfolioTabs'
import StrategyPanel from './components/StrategyPanel'
import AccountBar from './components/AccountBar'
import Logo from './components/Logo'
import SignIn from './components/SignIn'
import { currentAccess, allowedAccounts, isFullAccess, signOut } from './lib/access'

function Setup() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-4">
      <div className="w-full rounded-xl border border-white/5 bg-ink-900 p-6">
        <h1 className="text-lg font-semibold text-slate-100">Connect Supabase</h1>
        <p className="mt-2 text-sm text-slate-400">
          Create <code className="rounded bg-ink-700 px-1.5 py-0.5 text-xs">web/.env</code> with
          your project credentials, then restart the dev server.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-ink-950 p-4 text-xs text-slate-300">
{`VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...`}
        </pre>
        <p className="mt-4 text-xs text-slate-500">
          Both values are in your Supabase dashboard under Project Settings → API.
          Use the <strong className="text-slate-400">anon</strong> key here — this page
          only reads market data and account balances.
        </p>
      </div>
    </main>
  )
}

// Remembered per mode: switching to Live and back should land on the paper
// account you were last on, not reset to the first one.
const LAST_ACCOUNT_KEY = 'predict.accountId'
const MODE_KEY = 'predict.mode'
const modeOf = (a) => a?.mode ?? 'paper'

export default function App() {
  const [access, setAccess] = useState(() => currentAccess())
  const [leaving, setLeaving] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState(null)
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'paper' }
    catch { return 'paper' }
  })
  const [accountsUnavailable, setAccountsUnavailable] = useState(false)
  // Shared with the portfolio, so closing a position honours the same
  // tolerance the ticket was set to rather than a second hidden default.
  const [slippage, setSlippage] = useState(0.05)
  // Bumped when an order resolves, so the portfolio reloads immediately
  // instead of waiting out its own polling interval.
  const [tradeTick, setTradeTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // The asset the selected account's bot trades. The chart and ticket follow
  // it, so switching to an ETH account does not leave a BTC screen underneath
  // a panel that says ETH.
  const [botAsset, setBotAsset] = useState(null)
  // The live ATR reading, computed once in the strategy panel (which owns the
  // settings that define it) and shown in the market header beside the other
  // market stats.
  const [atrInfo, setAtrInfo] = useState(null)
  // Only used to warn when an order is stuck because nothing is filling it.
  const [workerSeenAt, setWorkerSeenAt] = useState(null)

  const loadAccounts = useCallback(async () => {
    if (!isConfigured || !access) return
    try {
      // Filtered to what this entry may see before anything downstream touches
      // it, so the whole app only ever knows about the allowed accounts.
      const rows = allowedAccounts(await fetchAccounts(), access)
      setAccounts(rows)
      setAccountsUnavailable(false)
      // Only the accounts on the side currently being shown are selectable;
      // holding a live account while the paper tab is open would leave the
      // panels below describing something that is not on screen.
      const here = rows.filter((r) => modeOf(r) === mode)
      setAccountId((prev) => {
        if (prev && here.some((r) => r.id === prev)) return prev
        const stored = Number(localStorage.getItem(`${LAST_ACCOUNT_KEY}.${mode}`))
        if (stored && here.some((r) => r.id === stored)) return stored
        return here[0]?.id ?? null
      })
    } catch (e) {
      const msg = `${e?.message ?? e}`
      if (/accounts|schema cache|does not exist|PGRST205/i.test(msg)) {
        setAccountsUnavailable(true)
      }
    }
  }, [mode, access])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  // Everything already polls, but the intervals are seconds apart and after a
  // settlement or a config change you want to see the result now rather than
  // wonder whether the screen is stale. Bumping tradeTick is what a filled
  // order does, so this reuses that path rather than inventing a second one.
  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try {
      await loadAccounts()
      setTradeTick((n) => n + 1)
    } finally {
      // Long enough for the spin to register as a response to the click.
      setTimeout(() => setRefreshing(false), 500)
    }
  }, [loadAccounts])

  useEffect(() => {
    const t = setInterval(loadAccounts, 5000)
    return () => clearInterval(t)
  }, [loadAccounts])

  useEffect(() => {
    if (accountId) {
      try {
        localStorage.setItem(`${LAST_ACCOUNT_KEY}.${mode}`, String(accountId))
      } catch { /* private mode */ }
    }
  }, [accountId, mode])

  // A restricted entry may only have accounts on one side (its live JD account,
  // say). Landing on an empty Paper tab would look broken, so move to whichever
  // side actually holds the accounts this entry can see.
  useEffect(() => {
    if (!accounts.length) return
    const here = accounts.filter((a) => modeOf(a) === mode)
    if (here.length === 0) {
      const next = modeOf(accounts[0])
      if (next !== mode) {
        try { localStorage.setItem(MODE_KEY, next) } catch { /* private mode */ }
        setAccountId(null)
        setMode(next)
      }
    }
  }, [accounts, mode])

  // Worker liveness, kept only so a stuck order can explain itself.
  useEffect(() => {
    if (!isConfigured) return
    const tick = () => fetchLatestRun()
      .then((r) => setWorkerSeenAt(r?.last_heartbeat ?? null))
      .catch(() => {})
    tick()
    const t = setInterval(tick, 10000)
    return () => clearInterval(t)
  }, [])

  if (!isConfigured) return <Setup />
  if (!access) return <SignIn onSignedIn={setAccess} />

  // Fade out before clearing access, so the dashboard dissolves into the gate
  // rather than snapping away.
  const handleSignOut = () => {
    setLeaving(true)
    setTimeout(() => { signOut(); setAccess(null); setLeaving(false) }, 450)
  }

  const fullAccess = isFullAccess(access)
  const visible = accounts.filter((a) => modeOf(a) === mode)
  const account = visible.find((a) => a.id === accountId) ?? null
  const isLive = mode === 'live'

  const switchMode = (next) => {
    if (next === mode) return
    try { localStorage.setItem(MODE_KEY, next) } catch { /* private mode */ }
    setAccountId(null)
    setMode(next)
  }
  const workerAgeSec = workerSeenAt
    ? (Date.now() - new Date(workerSeenAt).getTime()) / 1000
    : null
  const workerLive = workerAgeSec !== null && workerAgeSec < 30

  return (
    <div className={`min-h-screen ${leaving ? 'animate-fade-out' : 'animate-fade-in'}`}>
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3">
          {/* Branding */}
          <div className="flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <h1 className="text-lg font-semibold italic text-sky-400">Predict</h1>
          </div>

          {/* Paper and live are different money, so they are a switch between
              two sets of accounts rather than a filter inside one list. Live is
              red because the cost of mistaking which one you are on is not
              symmetric. Hidden for a restricted entry, which only ever has
              accounts on one side. On mobile it drops to a full-width second
              row; inline on desktop. */}
          {fullAccess && (
            <div role="tablist" aria-label="Account mode"
                 className="order-last flex w-full rounded-lg border border-white/10 bg-ink-900 p-0.5
                            lg:order-none lg:w-auto">
              {[['paper', 'Paper'], ['live', 'Live']].map(([key, label]) => {
                const on = mode === key
                return (
                  <button
                    key={key} role="tab" aria-selected={on}
                    onClick={() => switchMode(key)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors lg:flex-none lg:py-1 ${
                      on
                        ? key === 'live'
                          ? 'bg-rose-500/20 text-rose-300'
                          : 'bg-sky-500/20 text-sky-300'
                        : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Actions — pushed to the right of the top row. */}
          <div className="ml-auto flex items-center gap-2">
          <button
            onClick={refreshNow}
            disabled={refreshing}
            title="Reload accounts, positions and strategy now"
            aria-label="Refresh"
            className="rounded-lg border border-white/10 bg-ink-800 p-2 text-slate-400
                       transition-colors hover:border-white/25 hover:text-slate-100
                       disabled:opacity-50"
          >
            <svg viewBox="0 0 16 16" fill="none"
                 className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}>
              <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" />
              <path d="M12.6 1.9v2.7H9.9" stroke="currentColor" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <AccountBar
            account={account}
            accounts={visible}
            mode={mode}
            totalAccounts={accounts.length}
            unavailable={accountsUnavailable}
            onSelect={setAccountId}
            onAccountsChanged={loadAccounts}
          />

          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg border border-white/10 bg-ink-800 p-2 text-slate-400
                       transition-colors hover:border-white/25 hover:text-slate-100"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
              <path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M10.5 11 14 7.5 10.5 4M14 7.5H6" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:py-6">

        {/* Filters and the automation switch sit above the ticket: they
            govern what the bot does with every round, so they belong where
            they are read first rather than under the thing they control. */}
        <StrategyPanel account={account} accounts={accounts} workerLive={workerLive}
                       onSlippageChange={setSlippage}
                       onUnderlyingChange={setBotAsset}
                       onAtrChange={setAtrInfo}
                       onAccountChanged={loadAccounts} />
        <TradePanel
          atrInfo={atrInfo}
          account={account}
          workerLive={workerLive}
          slippage={slippage}
          onSlippageChange={setSlippage}
          botAsset={botAsset}
          mode={mode}
          accountId={accountId}
          onOrderResolved={() => setTradeTick((n) => n + 1)}
        />
        <PortfolioTabs account={account} accountId={accountId} slippage={slippage}
                       mode={mode}
                       refreshKey={tradeTick} />
      </main>
    </div>
  )
}
