import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchStrategyConfig, updateStrategyConfig } from '../lib/supabase'
import Dropdown from './Dropdown'

/**
 * The bot's control surface.
 *
 * Every rule here used to live in config.yaml on the worker's host, which made
 * tuning a strategy an SSH session per idea. The worker now polls this row, so
 * a change lands within a few seconds.
 *
 * Arming is deliberately separate from the worker being up: a running worker
 * that is disarmed still settles positions and fills manual orders, it just
 * opens nothing new.
 */

const ATR_RESOLUTIONS = ['1m', '3m', '5m', '15m', '30m', '1h']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const inputCls = `nums mt-1 w-full rounded-lg border border-white/10 bg-ink-800 px-2.5 py-1.5
                  text-sm text-slate-200 outline-none focus:border-sky-500/50`

function Section({ title, hint, children }) {
  return (
    <section className="border-t border-white/5 px-4 py-4">
      <div className="mb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {title}
        </h4>
        {hint && <p className="mt-0.5 text-[11px] text-slate-600">{hint}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </section>
  )
}

function Field({ label, hint, children, wide = false }) {
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="block text-[11px] text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-slate-600">{hint}</span>}
    </label>
  )
}

function Num({ value, onChange, step = 1, min, max }) {
  return (
    <input
      type="number" className={inputCls} value={value ?? ''}
      step={step} min={min} max={max}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button" onClick={() => onChange(!on)}
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-white/10
                 bg-ink-800 px-2.5 py-1.5 text-left"
    >
      <span className={`relative h-3.5 w-7 shrink-0 rounded-full transition-colors ${
        on ? 'bg-sky-500' : 'bg-slate-600'}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white
                          transition-all ${on ? 'left-[16px]' : 'left-0.5'}`} />
      </span>
      <span className="truncate text-xs text-slate-300">{label}</span>
    </button>
  )
}

export default function StrategyPanel({ workerLive, onSlippageChange }) {
  const [saved, setSaved] = useState(null)   // what the database holds
  const [draft, setDraft] = useState(null)   // what the form shows
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    fetchStrategyConfig()
      .then((row) => {
        if (!row) return
        setSaved(row)
        // Never clobber an edit in progress with a poll.
        setDraft((d) => d ?? row)
        onSlippageChange?.(Number(row.max_slippage))
      })
      .catch((e) => {
        const msg = `${e?.message ?? e}`
        if (/strategy_config|schema cache|does not exist|PGRST205|404/i.test(msg)) {
          setMissing(true)
        } else setError(msg)
      })
  }, [onSlippageChange])

  useEffect(() => {
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [load])

  const dirty = useMemo(() => {
    if (!saved || !draft) return false
    return Object.keys(draft).some(
      (k) => k !== 'updated_at' && String(draft[k]) !== String(saved[k]))
  }, [saved, draft])

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))

  const persist = useCallback(async (patch) => {
    setBusy(true)
    setError(null)
    try {
      const row = await updateStrategyConfig(patch)
      setSaved(row)
      setDraft(row)
      onSlippageChange?.(Number(row.max_slippage))
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [onSlippageChange])

  if (missing) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3
                      text-xs text-amber-300">
        Automation needs{' '}
        <code className="rounded bg-black/30 px-1">
          supabase/migrations/006_strategy_config.sql
        </code>{' '}
        run once.
      </div>
    )
  }

  if (!draft) {
    return (
      <div className="rounded-xl border border-white/10 bg-ink-900 px-4 py-6
                      text-center text-xs text-slate-600">
        Loading strategy…
      </div>
    )
  }

  const armed = Boolean(saved?.enabled)
  const trading = armed && workerLive
  const maxPrice = draft.odds_convention === 'payout_multiple'
    ? 1 / Math.max(Number(draft.wing_odds), 1)
    : 1 / (1 + Math.max(Number(draft.wing_odds), 0))

  return (
    <div className="rounded-xl border border-white/10 bg-ink-900">
      {/* The arm switch saves on click rather than via Save below: a stop
          control that needs a second confirmation is the wrong shape. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${
            trading ? 'bg-emerald-400' : armed ? 'bg-amber-400' : 'bg-slate-600'}`}>
            {trading && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full
                               bg-emerald-400 opacity-60" />
            )}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Automated strategy</h3>
            <p className="text-[11px] text-slate-500">
              {trading
                ? 'Armed — the worker is trading these rules'
                : armed
                  ? 'Armed, but no worker is running to trade it'
                  : 'Disarmed — no new entries. Open positions still settle.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300
                       transition-colors hover:border-white/25"
          >
            {open ? 'Hide filters' : 'Filters'}
          </button>
          <button
            onClick={() => persist({ enabled: !armed })}
            disabled={busy}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold text-white
                        transition-colors disabled:opacity-50 ${
              armed ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
          >
            {armed ? 'Disarm' : 'Arm'}
          </button>
        </div>
      </div>

      {open && (
        <>
          <Section title="ATR gate" hint="Only trade when the underlying is actually moving.">
            <Field label="Enabled">
              <Toggle
                on={Boolean(draft.atr_enabled)}
                onChange={(v) => set('atr_enabled', v)}
                label={draft.atr_enabled ? 'On' : 'Off'}
              />
            </Field>
            <Field label="Chart">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="ATR resolution" value={draft.atr_resolution}
                  onChange={(v) => set('atr_resolution', v)}
                  options={ATR_RESOLUTIONS.map((r) => ({ value: r, label: r }))}
                />
              </div>
            </Field>
            <Field label="Candles" hint="ATR period">
              <Num value={draft.atr_period} min={2} onChange={(v) => set('atr_period', v)} />
            </Field>
            <Field label="Minimum ATR" hint="skip the round below this">
              <Num value={draft.atr_min} step={10} min={0}
                   onChange={(v) => set('atr_min', v)} />
            </Field>
          </Section>

          <Section title="Timing" hint="Wall clock, and where inside the round.">
            <Field label="Start time">
              <input type="time" className={inputCls} value={draft.session_start ?? ''}
                     onChange={(e) => set('session_start', e.target.value || null)} />
            </Field>
            <Field label="End time" hint="both blank = all hours">
              <input type="time" className={inputCls} value={draft.session_end ?? ''}
                     onChange={(e) => set('session_end', e.target.value || null)} />
            </Field>
            <Field label="Timezone">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Session timezone" value={draft.session_timezone}
                  onChange={(v) => set('session_timezone', v)}
                  options={[{ value: 'IST', label: 'IST' }, { value: 'UTC', label: 'UTC' }]}
                />
              </div>
            </Field>
            <Field label="Days" wide>
              <div className="mt-1 flex flex-wrap gap-1">
                {DAYS.map((d, i) => {
                  const on = (draft.weekdays ?? []).includes(i)
                  return (
                    <button
                      key={d} type="button"
                      onClick={() => set('weekdays', on
                        ? draft.weekdays.filter((x) => x !== i)
                        : [...(draft.weekdays ?? []), i].sort((a, b) => a - b))}
                      className={`rounded px-2 py-1 text-[11px] transition-colors ${
                        on ? 'bg-sky-500/20 text-sky-300' : 'bg-ink-800 text-slate-600'}`}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label="Min age" hint="seconds since the round listed">
              <Num value={draft.min_seconds_since_launch}
                   onChange={(v) => set('min_seconds_since_launch', v)} />
            </Field>
            <Field label="Min to expiry" hint="no entries inside this">
              <Num value={draft.min_seconds_to_expiry}
                   onChange={(v) => set('min_seconds_to_expiry', v)} />
            </Field>
          </Section>

          <Section title="Entry" hint="Which legs, and how cheap they have to be.">
            <Field label="Odds (1:N)" hint={`max price $${maxPrice.toFixed(4)}`}>
              <Num value={draft.wing_odds} step={0.5} min={0.5}
                   onChange={(v) => set('wing_odds', v)} />
            </Field>
            <Field label="Convention">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Odds convention" value={draft.odds_convention}
                  onChange={(v) => set('odds_convention', v)}
                  options={[{ value: 'risk_reward', label: 'Risk : reward' },
                            { value: 'payout_multiple', label: 'Payout multiple' }]}
                />
              </div>
            </Field>
            <Field label="Both wings">
              <Toggle
                on={Boolean(draft.require_both_wings)}
                onChange={(v) => set('require_both_wings', v)}
                label={draft.require_both_wings ? 'Required' : 'Either alone'}
              />
            </Field>
            <Field label="Middle strike">
              <Toggle
                on={Boolean(draft.trade_middle)}
                onChange={(v) => set('trade_middle', v)}
                label={draft.trade_middle ? `On at 1:${draft.middle_odds}` : 'Off'}
              />
            </Field>
          </Section>

          <Section title="Exit" hint="Measured on spot against the strike.">
            <Field label="Trigger">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Exit trigger" value={draft.exit_trigger}
                  onChange={(v) => { set('exit_trigger', v); set('exit_mode', 'moneyness') }}
                  options={[{ value: 'itm', label: 'ITM' },
                            { value: 'atm', label: 'ATM' },
                            { value: 'otm', label: 'OTM' }]}
                />
              </div>
            </Field>
            {draft.exit_trigger === 'atm' ? (
              <Field label="ATM band" hint="points either side of the strike">
                <Num value={draft.exit_atm_band} step={5} min={0}
                     onChange={(v) => set('exit_atm_band', v)} />
              </Field>
            ) : (
              <Field
                label="Points"
                hint={draft.exit_trigger === 'itm'
                  ? 'past the strike, your way'
                  : 'against you — a stop'}
              >
                <Num value={draft.exit_points} step={5} min={0}
                     onChange={(v) => set('exit_points', v)} />
              </Field>
            )}
            <Field label="Flatten before expiry" hint="seconds; blank = hold to settlement">
              <Num value={draft.flatten_before_expiry_sec}
                   onChange={(v) => set('flatten_before_expiry_sec', v)} />
            </Field>
            <Field label="Mode" hint="spot vs strike, or the contract's own bid">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Exit mode" value={draft.exit_mode}
                  onChange={(v) => set('exit_mode', v)}
                  options={[{ value: 'moneyness', label: 'Spot vs strike' },
                            { value: 'price', label: `Bid ≥ ${draft.take_profit_price}` }]}
                />
              </div>
            </Field>
          </Section>

          <Section title="Execution and size">
            <Field
              label="Slippage tolerance" wide
              hint={`$${Number(draft.max_slippage).toFixed(2)} — a fill worse than this above the touch is refused`}
            >
              <input
                type="range" min="0.01" max="0.10" step="0.01"
                value={draft.max_slippage}
                onChange={(e) => set('max_slippage', Number(e.target.value))}
                className="mt-2 w-full accent-sky-500"
              />
            </Field>
            <Field label="Contracts per leg">
              <Num value={draft.size_contracts} min={1}
                   onChange={(v) => set('size_contracts', v)} />
            </Field>
            <Field label="Max open rounds">
              <Num value={draft.max_concurrent_rounds} min={1}
                   onChange={(v) => set('max_concurrent_rounds', v)} />
            </Field>
          </Section>

          <div className="flex items-center justify-between gap-3 border-t border-white/5
                          px-4 py-3">
            <p className="text-[11px] text-slate-600">
              {dirty
                ? 'Unsaved changes'
                : 'Saved — the worker reloads within a few seconds.'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDraft(saved)} disabled={!dirty || busy}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs
                           text-slate-400 disabled:opacity-40"
              >
                Revert
              </button>
              <button
                onClick={() => {
                  const { id: _id, updated_at: _u, ...patch } = draft
                  persist(patch)
                }}
                disabled={!dirty || busy}
                className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white
                           transition-colors hover:bg-sky-400 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save filters'}
              </button>
            </div>
          </div>
        </>
      )}

      {error && (
        <p className="mx-4 mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2
                      text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  )
}
