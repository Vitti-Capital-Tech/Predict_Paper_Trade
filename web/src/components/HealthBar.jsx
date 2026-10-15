import { useEffect, useState } from 'react'

/**
 * One line at the top of the Live tab: is the bot running, and do its books
 * match Delta.
 *
 * Until this, the only way to learn either was a Telegram alert when something
 * had already gone wrong - or asking for a manual check. Both facts already
 * existed: the worker's heartbeat (every few seconds) and its comparison with
 * Delta's positions (every minute, written to the account by migration 029).
 */

const ago = (secs) => {
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`
  return `${Math.round(secs / 3600)} h ago`
}

const TONES = {
  ok: { dot: 'bg-emerald-400', text: 'text-slate-300', pulse: true },
  warn: { dot: 'bg-amber-400', text: 'text-amber-300', pulse: false },
  bad: { dot: 'bg-rose-500', text: 'text-rose-300', pulse: true },
  idle: { dot: 'bg-slate-600', text: 'text-slate-500', pulse: false },
}

function Item({ tone, children, title }) {
  const t = TONES[tone]
  return (
    <span className={`flex min-w-0 items-center gap-2 ${t.text}`} title={title}>
      <span className="relative flex h-2 w-2 shrink-0">
        {t.pulse && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full
                            opacity-60 ${t.dot}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${t.dot}`} />
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  )
}

export default function HealthBar({ workerSeenAt, account }) {
  // The heartbeat is polled every 10s; this only keeps "seen 4s ago" moving.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const botAge = workerSeenAt ? (now - new Date(workerSeenAt).getTime()) / 1000 : null
  const bot = botAge === null
    ? { tone: 'idle', text: 'Bot status unknown' }
    : botAge < 30
      ? { tone: 'ok', text: <>Bot running <span className="text-slate-500">· seen {ago(botAge)}</span></> }
      : botAge < 120
        ? { tone: 'warn', text: `Bot slow to respond · seen ${ago(botAge)}` }
        : { tone: 'bad', text: `Bot OFFLINE · last seen ${ago(botAge)} - nothing is being traded or closed` }

  // Absent (not null) means migration 029 has not run: say nothing rather
  // than a status that cannot be known.
  let delta = null
  if (account && 'delta_checked_at' in account) {
    const checkedAge = account.delta_checked_at
      ? (now - new Date(account.delta_checked_at).getTime()) / 1000 : null
    if (account.delta_issue) {
      delta = { tone: 'bad', text: <>Delta: {account.delta_issue}</>,
                title: 'Found on the last comparison with Delta. A REVIEW alert went to Telegram too.' }
    } else if (checkedAge === null) {
      delta = { tone: 'idle', text: 'Waiting for the first check against Delta' }
    } else if (checkedAge > 180) {
      delta = { tone: 'warn', text: `Delta not checked for ${ago(checkedAge).replace(' ago', '')}`,
                title: 'The bot compares with Delta every minute; it has not managed to lately.' }
    } else {
      delta = { tone: 'ok',
                text: <>Delta connected · books match <span className="text-slate-500">· checked {ago(checkedAge)}</span></>,
                title: 'Every minute the bot reads this account\'s open positions from Delta and '
                       + 'compares them with its own record. They agree.' }
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-xl border
                    border-white/10 bg-ink-900 px-4 py-2.5 text-xs">
      <Item tone={bot.tone}>{bot.text}</Item>
      {delta && <Item tone={delta.tone} title={delta.title}>{delta.text}</Item>}
    </div>
  )
}
