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
