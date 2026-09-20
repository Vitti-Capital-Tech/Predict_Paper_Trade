import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isConfigured = Boolean(url && anonKey)

// Never throw at import time - the app renders a setup screen instead, so a
// missing .env shows instructions rather than a blank page.
export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null

export async function fetchLatestRun() {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

export async function fetchRuns() {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(25)
  if (error) throw error
  return data ?? []
}

export async function fetchPositions(runId) {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('run_id', runId)
    .order('entry_time', { ascending: false })
    .limit(500)
  if (error) throw error
  return data ?? []
}

export async function fetchLatestSnapshot(runId) {
  const { data, error } = await supabase
    .from('market_snapshots')
    .select('*')
    .eq('run_id', runId)
    .order('ts', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

// ------------------------------------------------------------- accounts ----
// Paper-trading accounts. Unlike `runs.cash` (which a worker rewrites on every
// heartbeat) these are owned by the UI, so an edited balance sticks.

export async function fetchAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function createAccount(name, startingBalance) {
  const { data, error } = await supabase
    .from('accounts')
    .insert({ name, starting_balance: startingBalance, balance: startingBalance })
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

export async function updateAccount(id, patch) {
  const { data, error } = await supabase
    .from('accounts')
    .update(patch)
    .eq('id', id)
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Queue a paper trade. The browser deliberately cannot create a position:
 * RLS allows only a `pending` row with no execution fields, and the worker
 * fills it against the real order book. That keeps a manual paper trade
 * exactly as honest about slippage as a bot entry.
 */
export async function placeManualOrder(order) {
  const { data, error } = await supabase
    .from('manual_orders')
    // `action` is deliberately not sent: the column defaults to 'buy', so a
    // buy keeps working on a database where migration 005 has not been run.
    .insert({
      symbol: order.symbol,
      round_id: order.roundId,
      outcome: order.outcome,
      strike: order.strike,
      investment: order.investment,
      slippage_tolerance: order.slippageTolerance,
      quoted_price: order.quotedPrice,
      account_id: order.accountId ?? null,
    })
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Queue an early exit for an open position.
 *
 * Same reasoning as an entry: the browser names the position and the price it
 * was shown, and the worker sells into real depth. Pricing the sale here would
 * credit proceeds the book never offered.
 */
export async function placeManualClose(close) {
  const { data, error } = await supabase
    .from('manual_orders')
    .insert({
      action: 'close',
      symbol: close.symbol,
      round_id: close.roundId,
      close_position_id: close.positionId,
      slippage_tolerance: close.slippageTolerance ?? 0.05,
      quoted_price: close.quotedPrice ?? null,
      account_id: close.accountId ?? null,
    })
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

/** Recent close orders, newest first — pending ones included, so the card
 *  can show both "closing…" and a rejection reason. */
export async function fetchRecentCloses(accountId = null, limit = 20) {
  let q = supabase.from('manual_orders').select('*').eq('action', 'close')
  if (accountId) q = q.eq('account_id', accountId)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function fetchManualOrders(limit = 20, accountId = null) {
  let q = supabase.from('manual_orders').select('*')
  if (accountId) q = q.eq('account_id', accountId)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

/** Positions belonging to an account, rather than to a worker run. */
export async function fetchAccountPositions(accountId) {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('account_id', accountId)
    .order('entry_time', { ascending: false })
    .limit(500)
  if (error) throw error
  return data ?? []
}

export async function fetchEvents(runId, limit = 60) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('run_id', runId)
    .order('ts', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}
