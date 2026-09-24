import { useCallback, useEffect, useState } from 'react'
import { isConfigured, fetchAccounts, fetchLatestRun } from './lib/supabase'
import TradePanel from './components/TradePanel'
import PortfolioTabs from './components/PortfolioTabs'
import StrategyPanel from './components/StrategyPanel'
import AccountBar from './components/AccountBar'
import Logo from './components/Logo'

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

const LAST_ACCOUNT_KEY = 'predict.accountId'

export default function App() {
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState(null)
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
    if (!isConfigured) return
    try {
      const rows = await fetchAccounts()
      setAccounts(rows)
      setAccountsUnavailable(false)
      setAccountId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev
        const stored = Number(localStorage.getItem(LAST_ACCOUNT_KEY))
        if (stored && rows.some((r) => r.id === stored)) return stored
        return rows[0]?.id ?? null
      })
    } catch (e) {
      const msg = `${e?.message ?? e}`
      if (/accounts|schema cache|does not exist|PGRST205/i.test(msg)) {
        setAccountsUnavailable(true)
      }
    }
  }, [])

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
      try { localStorage.setItem(LAST_ACCOUNT_KEY, String(accountId)) } catch { /* private mode */ }
    }
  }, [accountId])

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

  const account = accounts.find((a) => a.id === accountId) ?? null
  const workerAgeSec = workerSeenAt
    ? (Date.now() - new Date(workerSeenAt).getTime()) / 1000
    : null
  const workerLive = workerAgeSec !== null && workerAgeSec < 30

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <h1 className="text-lg font-semibold italic text-sky-400">Predict</h1>
          </div>

          {/* Grouped right: justify-between would otherwise strand the
              refresh button in the middle of the header. */}
          <div className="flex items-center gap-2">
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
            accounts={accounts}
            unavailable={accountsUnavailable}
            onSelect={setAccountId}
            onAccountsChanged={loadAccounts}
          />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:py-6">
        {/* Filters and the automation switch sit above the ticket: they
            govern what the bot does with every round, so they belong where
            they are read first rather than under the thing they control. */}
        <StrategyPanel account={account} workerLive={workerLive}
                       onSlippageChange={setSlippage}
                       onUnderlyingChange={setBotAsset}
                       onAtrChange={setAtrInfo} />
        <TradePanel
          atrInfo={atrInfo}
          account={account}
          workerLive={workerLive}
          slippage={slippage}
          onSlippageChange={setSlippage}
          botAsset={botAsset}
          accountId={accountId}
          onOrderResolved={() => setTradeTick((n) => n + 1)}
        />
        <PortfolioTabs account={account} accountId={accountId} slippage={slippage}
                       refreshKey={tradeTick} />
      </main>
    </div>
  )
}
