import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  supabase, isConfigured, fetchLatestRun, fetchRuns, fetchPositions,
  fetchLatestSnapshot, fetchEvents,
} from './lib/supabase'
import { demoRun, demoRuns, demoPositions, demoSnapshot, demoEvents } from './lib/demo'
import { summarise, fmt } from './lib/stats'

// `?demo=1` renders synthetic data so the UI can be reviewed without Supabase.
const DEMO = new URLSearchParams(window.location.search).get('demo') === '1'
import { Card, Kpi, Badge, Empty } from './components/ui'
import AtrGate from './components/AtrGate'
import RoundCard from './components/RoundCard'
import PositionsTable from './components/PositionsTable'
import EquityCurve from './components/EquityCurve'
import EventFeed from './components/EventFeed'
import TradePanel from './components/TradePanel'

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
          Use the <strong className="text-slate-400">anon</strong> key here — the
          dashboard is read-only. The service role key belongs only in the Python
          worker&apos;s environment.
        </p>
      </div>
    </main>
  )
}

export default function App() {
  const [runs, setRuns] = useState([])
  const [run, setRun] = useState(null)
  const [positions, setPositions] = useState([])
  const [snapshot, setSnapshot] = useState(null)
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [view, setView] = useState(
    () => (new URLSearchParams(window.location.search).get('view') === 'trade'
      ? 'trade' : 'dashboard'))
  const runIdRef = useRef(null)

  // Ticking clock so countdowns advance between snapshots.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const loadAll = useCallback(async (runId) => {
    const [p, s, e] = await Promise.all([
      fetchPositions(runId), fetchLatestSnapshot(runId), fetchEvents(runId),
    ])
    setPositions(p)
    setSnapshot(s)
    setEvents(e)
  }, [])

  // Initial load.
  useEffect(() => {
    if (DEMO) {
      setRuns(demoRuns)
      setRun(demoRun)
      setPositions(demoPositions)
      setSnapshot(demoSnapshot)
      setEvents(demoEvents)
      setLoading(false)
      return
    }
    if (!isConfigured) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const [latest, allRuns] = await Promise.all([fetchLatestRun(), fetchRuns()])
        if (cancelled) return
        setRuns(allRuns)
        setRun(latest)
        if (latest) {
          runIdRef.current = latest.id
          await loadAll(latest.id)
        }
      } catch (err) {
        if (!cancelled) setError(err.message ?? String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loadAll])

  // Realtime: the worker writes, this reflects it without polling.
  useEffect(() => {
    if (DEMO || !isConfigured || !run?.id) return
    runIdRef.current = run.id
    const filter = `run_id=eq.${run.id}`

    const channel = supabase
      .channel(`run-${run.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'positions', filter },
        (payload) => {
          const row = payload.new
          if (!row) return
          setPositions((prev) => {
            const i = prev.findIndex((p) => p.position_id === row.position_id)
            if (i === -1) return [row, ...prev]
            const next = [...prev]
            next[i] = { ...next[i], ...row }
            return next
          })
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'market_snapshots', filter },
        (payload) => setSnapshot(payload.new))
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'events', filter },
        (payload) => setEvents((prev) => [payload.new, ...prev].slice(0, 60)))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'runs', filter: `id=eq.${run.id}` },
        (payload) => setRun((prev) => ({ ...prev, ...payload.new })))
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [run?.id])

  // Safety net: if realtime drops, a slow poll keeps the page honest.
  useEffect(() => {
    if (DEMO || !isConfigured || !run?.id) return
    const t = setInterval(() => {
      loadAll(run.id).catch(() => {})
    }, 15000)
    return () => clearInterval(t)
  }, [run?.id, loadAll])

  const stats = useMemo(
    () => summarise(positions, Number(run?.starting_cash ?? 0)),
    [positions, run?.starting_cash])

  const openPositions = useMemo(
    () => positions.filter((p) => p.status === 'open'), [positions])
  const closedPositions = useMemo(
    () => positions.filter((p) => p.status !== 'open'), [positions])

  if (!isConfigured && !DEMO && view !== 'trade') return <Setup />

  const heartbeatAge = run?.last_heartbeat
    ? (now - new Date(run.last_heartbeat).getTime()) / 1000
    : null
  const live = heartbeatAge !== null && heartbeatAge < 20

  // Snapshot countdowns are relative to when the snapshot was written.
  const snapAge = snapshot?.ts ? (now - new Date(snapshot.ts).getTime()) / 1000 : 0
  const rounds = (snapshot?.rounds ?? [])
    .map((r) => ({ ...r, seconds_to_expiry: r.seconds_to_expiry - snapAge }))
    .filter((r) => r.seconds_to_expiry > -30)

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-slate-100">
              Predict Paper Trading
            </h1>
            <Badge tone={live ? 'green' : 'slate'}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  live ? 'live-dot bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              {live ? 'LIVE' : 'OFFLINE'}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex rounded-lg border border-white/10 bg-ink-800 p-0.5">
              {[['dashboard', 'Dashboard'], ['trade', 'Trade']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    view === key
                      ? 'bg-sky-500/15 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
                  if (next) {
                    setRun(next)
                    setLoading(true)
                    loadAll(next.id).finally(() => setLoading(false))
                  }
                }}
                className="rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-xs text-slate-300 outline-none focus:border-sky-500/50"
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} {r.run_name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:py-6">
        {view === 'trade' && <TradePanel cash={run?.cash} />}

        {view === 'dashboard' && error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {view === 'dashboard' && loading && !run && <Empty>Loading…</Empty>}

        {view === 'dashboard' && !loading && !run && (
          <Card title="No runs found">
            <p className="text-sm text-slate-400">
              The schema is connected but no worker has registered a run yet. Start
              it with{' '}
              <code className="rounded bg-ink-700 px-1.5 py-0.5 text-xs">
                python run_live.py
              </code>{' '}
              and this page will populate automatically.
            </p>
          </Card>
        )}

        {view === 'dashboard' && run && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label="Total P&L"
                value={fmt.signed(stats.totalPnl)}
                sub={`${fmt.pct(stats.returnOnCost)} on capital deployed`}
                tone={stats.totalPnl > 0 ? 'good' : stats.totalPnl < 0 ? 'bad' : 'neutral'}
              />
              <Kpi
                label="Round win rate"
                value={fmt.pct(stats.roundWinRate)}
                sub={`${stats.rounds} rounds · ${fmt.signed(stats.avgPerRound)} avg`}
                tone={stats.roundWinRate >= 50 ? 'good' : 'neutral'}
              />
              <Kpi
                label="Open positions"
                value={fmt.int(stats.openCount)}
                sub={`cash ${fmt.usd(run.cash)}`}
              />
              <Kpi
                label="Slippage cost"
                value={fmt.usd(stats.slippageCost)}
                sub="paid above the touch price"
                tone={stats.slippageCost > 0 ? 'warn' : 'neutral'}
              />
            </div>

            <AtrGate
              atr={snapshot?.atr}
              threshold={run.config?.atr?.min_atr ?? 200}
              pass={snapshot?.atr_pass ?? false}
              spot={snapshot?.spot}
            />

            <Card
              title="Live rounds"
              subtitle="Wing legs priced against the odds threshold in real time"
              right={<Badge tone="slate">{rounds.length} live</Badge>}
            >
              {rounds.length ? (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {rounds.map((r) => (
                    <RoundCard key={r.round_id} round={r} />
                  ))}
                </div>
              ) : (
                <Empty>No live rounds in the latest snapshot.</Empty>
              )}
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card title="Cumulative P&L" className="lg:col-span-2">
                <EquityCurve points={stats.equityCurve} />
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/5 pt-3 text-xs">
                  <div>
                    <p className="text-slate-500">Max drawdown</p>
                    <p className="nums mt-0.5 text-rose-400">
                      {fmt.usd(stats.maxDrawdown)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Leg win rate</p>
                    <p className="nums mt-0.5 text-slate-300">
                      {fmt.pct(stats.legWinRate)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Legs filled</p>
                    <p className="nums mt-0.5 text-slate-300">{fmt.int(stats.trades)}</p>
                  </div>
                </div>
              </Card>

              <Card title="Activity" subtitle="Including why rounds were skipped">
                <EventFeed events={events} />
              </Card>
            </div>

            {openPositions.length > 0 && (
              <Card title="Open positions" right={<Badge tone="blue">{openPositions.length}</Badge>}>
                <PositionsTable positions={openPositions} />
              </Card>
            )}

            <Card
              title="Trade history"
              right={<Badge tone="slate">{closedPositions.length}</Badge>}
            >
              <PositionsTable positions={closedPositions} />
            </Card>

            {stats.byRole.length > 0 && (
              <Card title="By leg role" subtitle="Wings lose often by design — judge rounds, not legs">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {stats.byRole.map((r) => (
                    <div key={r.role} className="rounded-lg border border-white/5 bg-ink-800/50 p-3">
                      <p className="text-xs font-medium text-slate-300">{r.role}</p>
                      <p
                        className={`nums mt-1 text-xl font-semibold ${
                          r.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {fmt.signed(r.pnl)}
                      </p>
                      <p className="nums mt-1 text-[11px] text-slate-500">
                        {r.trades} legs · {fmt.pct(r.winRate)} win · avg entry{' '}
                        {r.avgEntry.toFixed(4)}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  )
}
