-- Delta Predict paper-trading schema.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Security model: the Python worker writes using the service_role key (which
-- bypasses RLS). The browser dashboard reads using the anon key and is
-- read-only, so a leaked anon key cannot corrupt your trade history.

-- ---------------------------------------------------------------- runs ----
create table if not exists public.runs (
  id             bigserial primary key,
  run_name       text        not null,
  started_at     timestamptz not null default now(),
  last_heartbeat timestamptz not null default now(),
  status         text        not null default 'running',
  starting_cash  numeric     not null default 0,
  cash           numeric     not null default 0,
  config         jsonb       not null default '{}'::jsonb
);

create index if not exists runs_started_at_idx on public.runs (started_at desc);

-- ----------------------------------------------------------- positions ----
create table if not exists public.positions (
  id              bigserial primary key,
  run_id          bigint      not null references public.runs (id) on delete cascade,
  position_id     text        not null,
  round_id        text        not null,
  symbol          text        not null,
  role            text        not null,   -- wing_low | wing_high | middle
  side            text        not null,   -- call | put
  strike          numeric     not null,
  qty             numeric     not null,

  entry_price     numeric     not null,
  entry_time      timestamptz not null,
  entry_top_price numeric,
  entry_slippage  numeric     not null default 0,
  entry_levels    integer     not null default 0,
  entry_spot      numeric,
  entry_atr       numeric,

  status          text        not null default 'open',  -- open | closed | settled
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,
  exit_slippage   numeric     not null default 0,
  fees            numeric     not null default 0,

  -- Realised P&L; null while the position is still open.
  pnl numeric generated always as (
    case when exit_price is null then null
         else (exit_price - entry_price) * qty - fees end
  ) stored,

  created_at timestamptz not null default now(),
  unique (run_id, position_id)
);

create index if not exists positions_run_status_idx on public.positions (run_id, status);
create index if not exists positions_entry_time_idx on public.positions (entry_time desc);
create index if not exists positions_round_idx      on public.positions (run_id, round_id);

-- -------------------------------------------------------------- events ----
-- Entries, exits, settlements and - importantly - every skip with its reason,
-- so the dashboard can explain why the bot is sitting on its hands.
create table if not exists public.events (
  id       bigserial primary key,
  run_id   bigint      not null references public.runs (id) on delete cascade,
  ts       timestamptz not null default now(),
  kind     text        not null,   -- entry | exit | settlement | skip | exit_blocked | heartbeat
  round_id text,
  symbol   text,
  reason   text,
  payload  jsonb       not null default '{}'::jsonb
);

create index if not exists events_run_ts_idx on public.events (run_id, ts desc);
create index if not exists events_kind_idx    on public.events (run_id, kind, ts desc);

-- --------------------------------------------------- market_snapshots ----
-- One row per poll: current ATR, spot, and the live rounds with their wing
-- prices. This is what the dashboard's "live market" panel renders.
create table if not exists public.market_snapshots (
  id       bigserial primary key,
  run_id   bigint      not null references public.runs (id) on delete cascade,
  ts       timestamptz not null default now(),
  spot     numeric,
  atr      numeric,
  atr_pass boolean     not null default false,
  rounds   jsonb       not null default '[]'::jsonb
);

create index if not exists snapshots_run_ts_idx on public.market_snapshots (run_id, ts desc);

-- Keep the snapshot table from growing without bound.
create or replace function public.prune_market_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.market_snapshots
   where run_id = new.run_id
     and ts < now() - interval '24 hours';
  return null;
end;
$$;

drop trigger if exists prune_snapshots on public.market_snapshots;
create trigger prune_snapshots
  after insert on public.market_snapshots
  for each row execute function public.prune_market_snapshots();

-- ----------------------------------------------------------------- RLS ----
alter table public.runs             enable row level security;
alter table public.positions        enable row level security;
alter table public.events           enable row level security;
alter table public.market_snapshots enable row level security;

-- Dashboard (anon key) may read everything, and nothing else.
drop policy if exists "anon read runs"      on public.runs;
drop policy if exists "anon read positions" on public.positions;
drop policy if exists "anon read events"    on public.events;
drop policy if exists "anon read snapshots" on public.market_snapshots;

create policy "anon read runs"      on public.runs             for select using (true);
create policy "anon read positions" on public.positions        for select using (true);
create policy "anon read events"    on public.events           for select using (true);
create policy "anon read snapshots" on public.market_snapshots for select using (true);

-- The worker uses service_role, which bypasses RLS, so no write policy exists.

-- ------------------------------------------------------------ realtime ----
-- Lets the dashboard update without polling.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.market_snapshots;
alter publication supabase_realtime add table public.runs;
