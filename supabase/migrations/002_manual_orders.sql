-- Manual paper trades placed from the Predict-style trade panel.
--
-- The browser cannot create positions directly: it holds the anon key, and a
-- fill invented client-side would bypass the order-book slippage model that
-- makes these results meaningful. So the UI only *queues an intent* here, and
-- the worker executes it against real depth exactly like a bot entry.
--
-- Run this in the Supabase SQL editor after schema.sql.

create table if not exists public.manual_orders (
  id                 bigserial primary key,
  created_at         timestamptz not null default now(),

  -- What the user clicked
  symbol             text        not null,   -- e.g. B-C-BTC-76300-1709260330
  round_id           text        not null,
  outcome            text        not null,   -- 'yes' (call) | 'no' (put)
  strike             numeric     not null,
  investment         numeric     not null,   -- dollars, as typed in the panel
  slippage_tolerance numeric     not null default 0.05,
  quoted_price       numeric,                -- price displayed at click time

  -- Filled in by the worker
  status             text        not null default 'pending',  -- pending|filled|rejected
  run_id             bigint      references public.runs (id) on delete set null,
  position_id        text,
  fill_price         numeric,
  contracts          numeric,
  reject_reason      text,
  processed_at       timestamptz,

  constraint manual_orders_outcome_chk    check (outcome in ('yes','no')),
  constraint manual_orders_status_chk     check (status in ('pending','filled','rejected')),
  constraint manual_orders_investment_chk check (investment > 0 and investment <= 100000)
);

create index if not exists manual_orders_pending_idx
  on public.manual_orders (status, created_at)
  where status = 'pending';

create index if not exists manual_orders_recent_idx
  on public.manual_orders (created_at desc);

alter table public.manual_orders enable row level security;

drop policy if exists "anon read manual_orders"  on public.manual_orders;
drop policy if exists "anon queue manual_orders" on public.manual_orders;

create policy "anon read manual_orders"
  on public.manual_orders for select using (true);

-- The browser may only queue a *pending* order with no execution fields set.
-- It cannot mark something filled, attach a position, or invent a fill price.
create policy "anon queue manual_orders"
  on public.manual_orders for insert
  with check (
    status = 'pending'
    and run_id is null
    and position_id is null
    and fill_price is null
    and contracts is null
    and processed_at is null
  );

-- No update or delete policy exists, so only the service role can settle an
-- order's outcome.

alter publication supabase_realtime add table public.manual_orders;
