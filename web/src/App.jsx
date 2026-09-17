import { useCallback, useEffect, useState } from 'react'
import { supabase, isConfigured, fetchLatestRun, fetchRuns } from './lib/supabase'
import { Badge } from './components/ui'
import TradePanel from './components/TradePanel'
import PortfolioTabs from './components/PortfolioTabs'

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
          is read-only. The service role key belongs only in the Python worker&apos;s
          environment.
        </p>
      </div>
    </main>
  )
}

export default function App() {
  const [runs, setRuns] = useState([])
  const [run, setRun] = useState(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!isConfigured) return
    let cancelled = false
    ;(async () => {
      try {
        const [latest, allRuns] = await Promise.all([fetchLatestRun(), fetchRuns()])
        if (cancelled) return
        setRuns(allRuns)
        setRun(latest)
      } catch {
        /* the trade panel still works on live Delta data without Supabase */
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Keep the heartbeat and cash fresh.
  const refreshRun = useCallback(() => {
    if (!isConfigured || !run?.id) return
    fetchLatestRun().then((r) => r && setRun((prev) =>
      prev && r.id === prev.id ? { ...prev, ...r } : prev)).catch(() => {})
  }, [run?.id])

  useEffect(() => {
    const t = setInterval(refreshRun, 5000)
    return () => clearInterval(t)
  }, [refreshRun])

  useEffect(() => {
    if (!isConfigured || !run?.id) return
    const channel = supabase
      .channel(`run-${run.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'runs', filter: `id=eq.${run.id}` },
        (payload) => setRun((prev) => ({ ...prev, ...payload.new })))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [run?.id])

  if (!isConfigured) return <Setup />

  const heartbeatAge = run?.last_heartbeat
    ? (now - new Date(run.last_heartbeat).getTime()) / 1000
    : null
  const live = heartbeatAge !== null && heartbeatAge < 20

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-slate-100">
              Predict Paper Trading
            </h1>
            <Badge tone={live ? 'green' : 'slate'}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                live ? 'live-dot bg-emerald-400' : 'bg-slate-500'}`} />
              {live ? 'LIVE' : 'OFFLINE'}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            {heartbeatAge !== null && (
              <span className="nums hidden text-xs text-slate-500 sm:inline">
                worker {Math.round(heartbeatAge)}s ago
              </span>
            )}
            {runs.length > 0 && (
              <select
                value={run?.id ?? ''}
                onChange={(e) => {
                  const next = runs.find((r) => String(r.id) === e.target.value)
                  if (next) setRun(next)
                }}
                className="rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-xs
                           text-slate-300 outline-none focus:border-sky-500/50"
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>#{r.id} {r.run_name}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:py-6">
        <TradePanel cash={run?.cash} />
        <PortfolioTabs runId={run?.id} />
      </main>
    </div>
  )
}
