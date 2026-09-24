import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchStrategyConfig, updateStrategyConfig } from '../lib/supabase'
import { fetchCandles, indexSymbolFor } from '../lib/delta'
import { atrSeries, barSeconds } from '../lib/atr'
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

/**
 * What the ATR gate is reading right now, on the settings currently in the
 * form rather than the saved ones.
 *
 * Tuning this blind was the problem: a minimum is only meaningful next to the
 * number it is being compared against, and switching 15m to 5m moves that
 * number a long way — 213 against 110 on the same candles at the time of
 * writing. Reading the draft means changing a field answers "would this gate
 * be open?" before you commit to it.
 *
 * One hook, two views: a chip in the header that is always on screen, and the
 * fuller block beside the fields. Fetching in each would double the requests
 * and let them disagree while one was still in flight.
 */
function useLiveAtr({ underlying, resolution, period }) {
  const [candles, setCandles] = useState([])
  const [state, setState] = useState('loading')

  useEffect(() => {
    if (!underlying || !resolution) return
    let alive = true
    setState((prev) => (prev === 'ok' ? 'ok' : 'loading'))
    // Enough bars to seed Wilder's smoothing and then some, so the reading is
    // settled rather than dominated by its own seed.
    const hours = Math.max(
      1, Math.ceil(barSeconds(resolution) * (Number(period) * 5 + 20) / 3600))
    const load = () => fetchCandles(indexSymbolFor(underlying), resolution, hours)
      .then((rows) => { if (alive) { setCandles(rows); setState('ok') } })
      .catch(() => { if (alive) setState('error') })
    load()
    const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [underlying, resolution, period])

  // Changing only the period is a recompute, not another request.
  return useMemo(() => {
    const series = atrSeries(candles, Number(period) || 14)
    return { atr: series.length ? series[series.length - 1].atr : null, state }
  }, [candles, period, state])
}

/**
  * What the settings in the form would read, beside the fields setting them.
  *
  * A preview, not a status: the header shows what the bot is running on, and
  * this shows what it would run on if you saved. They are the same number
  * until you touch a field, which is exactly when the difference matters.
  *
  * It deliberately does not restate the underlying, resolution and period —
  * those are the three fields immediately to the right of it — nor the
  * open/closed verdict, which belongs to the saved setting rather than to a
  * draft that is not in force yet.
  */
function LiveAtr({ atr, state, unsaved }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border
                    border-white/10 bg-ink-800/60 px-3 py-2">
      <p className="text-[11px] text-slate-500">
        {unsaved ? 'Preview' : 'ATR now'}
      </p>

      <p className="nums text-lg font-semibold leading-none text-slate-100">
        {state === 'error' ? '—'
          : atr == null ? <span className="text-sm text-slate-500">loading…</span>
          : atr.toFixed(1)}
        {atr != null && (
          <span className="ml-1.5 text-[11px] font-normal text-slate-500">pts</span>
        )}
      </p>
    </div>
  )
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// The table stores seconds; the form asks in minutes, which is how anyone
// actually thinks about "stop entering three minutes before expiry".
const toMin = (sec) => (sec === null || sec === undefined ? null : Number(sec) / 60)
const toSec = (min) => (min === null || min === undefined ? null : Math.round(Number(min) * 60))

const inputCls = `field-dark nums mt-1 w-full rounded-lg border border-white/10 bg-ink-800
                  px-2.5 py-1.5 text-sm text-slate-200 outline-none
                  focus:border-sky-500/50`

function Section({ title, children }) {
  return (
    <section className="border-t border-white/5 px-4 py-4">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </section>
  )
}

/**
 * The small (i) beside a label.
 *
 * Shown on hover, and on tap: `focus-within` covers touch, where there is no
 * hover state at all and a hover-only tooltip is simply invisible.
 */
function InfoDot({ text }) {
  return (
    <span className="group/info relative inline-flex">
      <button
        type="button" tabIndex={0} aria-label={text}
        onClick={(e) => e.preventDefault()}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full border
                   border-slate-600 text-[8px] font-bold leading-none text-slate-500
                   transition-colors hover:border-sky-500 hover:text-sky-400
                   focus:border-sky-500 focus:text-sky-400 focus:outline-none"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-56
                   -translate-x-1/2 rounded-lg border border-white/10 bg-ink-950 px-2.5
                   py-2 text-[11px] leading-snug text-slate-300 opacity-0 shadow-xl
                   shadow-black/60 transition-opacity group-hover/info:opacity-100
                   group-focus-within/info:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}

function Field({ label, hint, info, children, wide = false }) {
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
        {label}
        {info && <InfoDot text={info} />}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-slate-600">{hint}</span>}
    </label>
  )
}

/**
 * A number field that wears its unit.
 *
 * The unit sits inside the box rather than in a line underneath, so it is
 * still readable while you are typing into the field it belongs to.
 */
function Num({ value, onChange, step = 1, min, max, unit, prefix }) {
  return (
    <div className="relative mt-1">
      {prefix && (
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                         text-sm text-slate-500">
          {prefix}
        </span>
      )}
      <input
        type="number"
        className={`no-spin nums w-full rounded-lg border border-white/10 bg-ink-800 py-1.5
                    text-sm text-slate-200 outline-none focus:border-sky-500/50
                    ${prefix ? 'pl-6' : 'pl-2.5'} ${unit ? 'pr-9' : 'pr-2.5'}`}
        value={value ?? ''} step={step} min={min} max={max}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      {unit && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2
                         text-[11px] text-slate-500">
          {unit}
        </span>
      )}
    </div>
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

export default function StrategyPanel({ account, workerLive, onSlippageChange,
                                       onUnderlyingChange, onAtrChange }) {
  const [saved, setSaved] = useState(null)   // what the database holds
  const [draft, setDraft] = useState(null)   // what the form shows
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [missing, setMissing] = useState(false)
  const [orphan, setOrphan] = useState(false)
  const [open, setOpen] = useState(false)

  const accountId = account?.id ?? null

  // Switching account swaps the whole strategy, so the form has to let go of
  // the previous account's draft rather than showing it under a new name.
  useEffect(() => { setDraft(null); setSaved(null) }, [accountId])

  const load = useCallback(() => {
    if (!accountId) return
    fetchStrategyConfig(accountId)
      .then((row) => {
        // An account with no settings row. The trigger from migration 010
        // makes this impossible for new accounts, but say so rather than
        // spinning on "Loading" forever if one slips through.
        if (!row) { setOrphan(true); return }
        setOrphan(false)
        setSaved(row)
        // Never clobber an edit in progress with a poll.
        setDraft((d) => d ?? row)
        onSlippageChange?.(Number(row.max_slippage))
        onUnderlyingChange?.(row.underlying || 'BTC')
      })
      .catch((e) => {
        const msg = `${e?.message ?? e}`
        if (/strategy_config|schema cache|does not exist|PGRST205|404/i.test(msg)) {
          setMissing(true)
        } else setError(msg)
      })
  }, [accountId, onSlippageChange, onUnderlyingChange])

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
      const row = await updateStrategyConfig(accountId, patch)
      setSaved(row)
      setDraft(row)
      onSlippageChange?.(Number(row.max_slippage))
      onUnderlyingChange?.(row.underlying || 'BTC')
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [accountId, onSlippageChange, onUnderlyingChange])

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

  if (orphan) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3
                      text-xs text-amber-300">
        {account?.name ?? 'This account'} has no strategy row — run{' '}
        <code className="rounded bg-black/30 px-1">
          supabase/migrations/010_strategy_per_account.sql
        </code>{' '}
        to give every account one.
      </div>
    )
  }

  // Above the early return: hooks must run in the same order on every render,
  // and `draft` is null until the config loads. Optional access keeps it inert
  // until there is something to read.
  const live = useLiveAtr({
    underlying: draft?.underlying,
    resolution: draft?.atr_resolution,
    period: draft?.atr_period,
  })

  // Do the draft's ATR settings still match what is saved? While they do,
  // one reading serves both the preview and the header.
  const atrUnsaved = !!saved && !!draft && (
    saved.underlying !== draft.underlying
    || saved.atr_resolution !== draft.atr_resolution
    || String(saved.atr_period) !== String(draft.atr_period))

  // The header must report what the bot is actually gated on, so it follows
  // the saved row. Passing nulls keeps this inert (and silent) whenever the
  // draft has not diverged.
  const liveSaved = useLiveAtr({
    underlying: atrUnsaved ? saved.underlying : null,
    resolution: atrUnsaved ? saved.atr_resolution : null,
    period: atrUnsaved ? saved.atr_period : null,
  })

  const applied = atrUnsaved ? liveSaved : live

  // The market header shows this, next to the other market stats. Reporting
  // it up keeps the single fetch here, where the settings that define it live.
  useEffect(() => {
    onAtrChange?.({
      atr: applied.atr,
      state: applied.state,
      resolution: (atrUnsaved ? saved?.atr_resolution : draft?.atr_resolution) ?? null,
      minimum: saved?.atr_min ?? draft?.atr_min ?? null,
    })
  }, [applied.atr, applied.state, atrUnsaved, saved?.atr_resolution,
      saved?.atr_min, draft?.atr_resolution, draft?.atr_min, onAtrChange])

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
      {/* Arming is its own switch, not a filter. It saves on flip rather than
          waiting for Save below: a stop control that needs a second
          confirmation is the wrong shape. */}
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
            <h3 className="text-sm font-semibold text-slate-100">
              Automated strategy
              {account?.name && (
                <span className="ml-1.5 font-normal text-slate-500">
                  · {account.name}
                </span>
              )}
            </h3>
            {/* Only the case the toggle cannot show for itself: on, but with
                nothing running to act on it. */}
            {armed && !workerLive && (
              <p className="text-[11px] text-amber-400">No worker is running to trade it</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300
                       transition-colors hover:border-white/25"
          >
            {open ? 'Hide filters' : 'Filters'}
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={armed}
            aria-label="Start automated trading"
            onClick={() => persist({ enabled: !armed })}
            disabled={busy}
            className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-ink-800
                       px-3 py-1.5 transition-colors hover:border-white/25
                       disabled:opacity-50"
          >
            <span className={`text-xs font-semibold ${
              armed ? 'text-emerald-400' : 'text-slate-500'}`}>
              {armed ? 'ON' : 'OFF'}
            </span>
            <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              armed ? 'bg-emerald-500' : 'bg-slate-600'}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow
                                transition-all ${armed ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <>
          {dirty && (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border
                            border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <svg viewBox="0 0 16 16" fill="none"
                   className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true">
                <path d="M8 5.5v3.2M8 11v.1" stroke="currentColor" strokeWidth="1.6"
                      strokeLinecap="round" />
                <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              <p className="text-[11px] text-amber-300">
                There are unsaved changes — save them to apply.
              </p>
            </div>
          )}

          <Section title="Timing">
            <Field label="Start time" info="The bot only opens positions after this time of day, in the timezone below. Leave both blank to trade around the clock.">
              <input type="time" className={inputCls} value={draft.session_start ?? ''}
                     onChange={(e) => set('session_start', e.target.value || null)} />
            </Field>
            <Field label="End time" info="The bot stops opening positions after this. Open positions still exit and settle normally." hint="both blank = all hours">
              <input type="time" className={inputCls} value={draft.session_end ?? ''}
                     onChange={(e) => set('session_end', e.target.value || null)} />
            </Field>
            <Field label="Timezone" info="Which clock the start and end times are read in.">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Session timezone" value={draft.session_timezone}
                  onChange={(v) => set('session_timezone', v)}
                  options={[{ value: 'IST', label: 'IST' }, { value: 'UTC', label: 'UTC' }]}
                />
              </div>
            </Field>
            <Field label="Days" info="Weekdays the bot may open positions on. A greyed day is skipped entirely." wide>
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
            <Field label="Min age" info="How long a round must have been listed before entering. A round lists ~20 minutes before expiry and the book is chaotic for the first seconds, so this waits for quotes to settle." hint="since the round listed">
              <Num value={toMin(draft.min_seconds_since_launch)} unit="min" step={0.5}
                   onChange={(v) => set('min_seconds_since_launch', toSec(v))} />
            </Field>
            <Field label="Min to expiry" info="Do not open anything with less than this left. Near expiry there is no time for the trade to work and the book thins badly. Delta halts trading in the final 60 seconds regardless." hint="no entries inside this">
              <Num value={toMin(draft.min_seconds_to_expiry)} unit="min" step={0.5}
                   onChange={(v) => set('min_seconds_to_expiry', toSec(v))} />
            </Field>
            <Field label="Max to expiry" info="Do not open anything with more than this left. Rounds are 15 minutes, so 15 keeps the bot in the round that is actually running; above that it starts buying the next round before the current one has expired." hint="keeps to the current round">
              <Num value={toMin(draft.max_seconds_to_expiry)} unit="min" step={0.5}
                   onChange={(v) => set('max_seconds_to_expiry', toSec(v))} />
            </Field>

            <Field
              label="Max age"
              info="Stop considering a round once it is this old. Late in a round the remaining time is too short for a move to develop."
              hint="since the round listed"
            >
              <Num value={toMin(draft.max_seconds_since_launch)} unit="min" step={0.5}
                   onChange={(v) => set('max_seconds_since_launch', toSec(v))} />
            </Field>
          </Section>

          <Section title="ATR gate">
            <LiveAtr atr={live.atr} state={live.state} unsaved={atrUnsaved} />
            <Field label="Chart" info="Which candles the ATR is measured on. 15m smooths out noise; 1m reacts faster but fires on moves too small to trade.">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="ATR resolution" value={draft.atr_resolution}
                  onChange={(v) => set('atr_resolution', v)}
                  options={ATR_RESOLUTIONS.map((r) => ({ value: r, label: r }))}
                />
              </div>
            </Field>
            <Field label="Candles" info="How many candles the ATR averages over. 14 is the standard period — more candles means a slower, steadier reading.">
              <Num value={draft.atr_period} min={2} unit="bars"
                   onChange={(v) => set('atr_period', v)} />
            </Field>
            <Field label="Minimum ATR" info="Skip the round unless average true range is above this. It is the &quot;only trade when BTC is actually moving&quot; rule. Set it to 0 to trade regardless." hint="0 = no gate">
              <Num value={draft.atr_min} step={10} min={0} unit="pts"
                   onChange={(v) => set('atr_min', v)} />
            </Field>
          </Section>

          <Section title="Entry">
            {/* The bot's asset, per account. The selector on the chart is a
                view control - it changes what you are looking at and what the
                manual ticket buys, and has never had any say over what the
                strategy trades. */}
            <Field
              label="Underlying"
              info="Which market this account's bot trades. Separate from the asset dropdown on the chart, which only changes what you are viewing and what a manual trade buys. Each account trades its own."
            >
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Bot underlying"
                  value={draft.underlying ?? 'BTC'}
                  onChange={(v) => set('underlying', v)}
                  options={[{ value: 'BTC', label: 'BTC' },
                            { value: 'ETH', label: 'ETH' }]}
                />
              </div>
            </Field>

            <Field label="Odds" info="How cheap a wing must be. 1:4 means risk 1 to win 4, so the contract must cost at most $0.20. A higher number demands a cheaper contract and takes fewer trades." hint={`max price $${maxPrice.toFixed(4)}`}>
              <Num value={draft.wing_odds} step={0.5} min={0.5} prefix="1:"
                   onChange={(v) => set('wing_odds', v)} />
            </Field>
            <Field label="Convention" info="What &quot;1:4&quot; means as a price. Risk:reward gives 1/(1+4) = $0.20. Payout multiple gives 1/4 = $0.25.">
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Odds convention" value={draft.odds_convention}
                  onChange={(v) => set('odds_convention', v)}
                  options={[{ value: 'risk_reward', label: 'Risk : reward' },
                            { value: 'payout_multiple', label: 'Payout multiple' }]}
                />
              </div>
            </Field>
            <Field
              label="Both extremes"
              info="Which side to buy at the two outer strikes. Opposite is a strangle — PUT low and CALL high — which pays on a hard move either way and is only cheap while price sits between them. Same buys one side at both strikes: a directional bet, and the only one on offer once price has run outside the strikes. It picks the side for you, because only one of the two can ever be cheap."
            >
              <div className="mt-1">
                <Dropdown
                  ariaLabel="Extremes mode"
                  value={draft.extremes_mode ?? 'opposite'}
                  onChange={(v) => set('extremes_mode', v)}
                  options={[{ value: 'opposite', label: 'Opposite' },
                            { value: 'same', label: 'Same' }]}
                />
              </div>
            </Field>

            <Field label="Both wings" info="The strategy buys the low-strike Put and the high-strike Call together — a bet that BTC moves hard either way. Required skips the round unless both qualify and both can fill, so you never end up holding one leg as an accidental directional bet.">
              <Toggle
                on={Boolean(draft.require_both_wings)}
                onChange={(v) => set('require_both_wings', v)}
                label={draft.require_both_wings ? 'Required' : 'Either alone'}
              />
            </Field>
            <Field label="Middle strike" info="Each round has 3 strikes. The wings are the outer two. The middle sits nearest spot, so it is far likelier to win and far more expensive — hence its own lower bar. Leave it off until you know what the wings alone earn.">
              <Toggle
                on={Boolean(draft.trade_middle)}
                onChange={(v) => set('trade_middle', v)}
                label={draft.trade_middle ? `On at 1:${draft.middle_odds}` : 'Off'}
              />
            </Field>
          </Section>

          <Section title="Exit">
            <Field label="Trigger" info="What closes the position. ITM: spot moved past your strike the right way. OTM: it moved against you — a stop. ATM: spot came back near the strike.">
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
              <Field label="ATM band" info="How close spot must come to the strike to count as at-the-money." hint="either side of the strike">
                <Num value={draft.exit_atm_band} step={5} min={0} unit="pts"
                     onChange={(v) => set('exit_atm_band', v)} />
              </Field>
            ) : (
              <Field
                label="Points" info="How far past the strike spot must travel before the exit fires."
                hint={draft.exit_trigger === 'itm'
                  ? 'past the strike, your way'
                  : 'against you — a stop'}
              >
                <Num value={draft.exit_points} step={5} min={0} unit="pts"
                     onChange={(v) => set('exit_points', v)} />
              </Field>
            )}
            <Field label="Flatten before expiry" info="Force-close everything this long before settlement instead of letting it settle. Blank means hold, so the contract finishes at exactly $1.00 or $0.00." hint="blank = hold">
              <Num value={toMin(draft.flatten_before_expiry_sec)} unit="min" step={0.5}
                   onChange={(v) => set('flatten_before_expiry_sec', toSec(v))} />
            </Field>
            <Field label="Mode" info="Which yardstick measures the exit. Spot vs strike watches BTC against your strike. Bid watches what the contract itself is worth." hint="spot vs strike, or the contract's own bid">
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
            <div className="col-span-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-slate-500">Slippage tolerance</span>
                <span className="nums text-sm font-semibold text-sky-300">
                  ${Number(draft.max_slippage).toFixed(2)}
                </span>
              </div>
              <input
                type="range" min="0.01" max="0.10" step="0.01"
                aria-label="Slippage tolerance"
                value={draft.max_slippage}
                onChange={(e) => set('max_slippage', Number(e.target.value))}
                className="slider-theme mt-1.5 w-full"
              />
              <div className="nums flex justify-between text-[10px] text-slate-600">
                <span>$0.01</span>
                <span>$0.10</span>
              </div>
            </div>
            <Field
              label="Investment per leg"
             
              info="How much to put on each leg. Contracts follow from the price, the same way the ticket works — $25 at $0.05 is 500 contracts. There is no contract-count option because Predict does not offer one."
            >
              <Num value={draft.investment_per_leg ?? 25} step={5} min={1} prefix="$"
                   onChange={(v) => set('investment_per_leg', v)} />
            </Field>

            <Field label="Max open rounds" info="How many rounds may hold open positions at once. Rounds start every 15 minutes and overlap, so without a cap exposure stacks up across several at a time.">
              <Num value={draft.max_concurrent_rounds} min={1} unit="rounds"
                   onChange={(v) => set('max_concurrent_rounds', v)} />
            </Field>
          </Section>

          <div className="flex items-center justify-between gap-3 border-t border-white/5
                          px-4 py-3">
            <div />
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
                  // The gate has no switch of its own any more: a minimum of
                  // zero is what turns it off.
                  patch.atr_enabled = Number(patch.atr_min) > 0
                  // Only send columns the row actually has. A field from a
                  // migration that has not been run would otherwise 400 the
                  // whole update and take every other edit down with it.
                  for (const k of Object.keys(patch)) {
                    if (!(k in saved)) delete patch[k]
                  }
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
