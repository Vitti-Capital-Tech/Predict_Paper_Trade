-- Daily report: balances that are recorded, not worked out afterwards.
--
-- The report used to show each day's balance as starting balance + every
-- trade since. Balances move for reasons trades do not explain - on 24 Oct
-- Prathav's report read $550.82 against $1,128.36 held, a $577.55 deposit into
-- Delta, and paper accounts whose starting balance had been reset counted
-- their earlier trades twice. Any figure rebuilt from today's numbers changes
-- whenever today's numbers do.
--
-- So two things here:
--
--   1. account_balance_daily - each account's real balance, saved once a night
--      at midnight IST and never recalculated. Money in open trades (set aside
--      from the balance until they finish) is saved beside it at cost, so the
--      day-end figure is balance + open stake. Days before this runs show "-".
--
--   2. daily_account_pnl gains rounds_won, so the report can show a round win
--      rate per day. Existing columns keep their names, order and types.
--
-- Run in the Supabase SQL editor of the CURRENT project (sovmhyuogmguxaeoobda).

-- -------------------------------------------------- 1. nightly balances --
create table if not exists public.account_balance_daily (
  account_id  bigint      not null references public.accounts (id) on delete cascade,
  day         date        not null,          -- the IST day that just ended
  balance     numeric     not null,          -- accounts.balance at midnight IST
  open_stake  numeric     not null default 0,-- open trades at cost, same moment
  recorded_at timestamptz not null default now(),
  primary key (account_id, day)
);

alter table public.account_balance_daily enable row level security;
drop policy if exists "anon read balance history" on public.account_balance_daily;
create policy "anon read balance history" on public.account_balance_daily
  for select using (true);

create or replace function public.snapshot_account_balances()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- Runs at 00:00 IST, so the day being closed is yesterday in IST.
  insert into public.account_balance_daily (account_id, day, balance, open_stake)
  select a.id,
         ((now() at time zone 'Asia/Kolkata')::date - 1),
         coalesce(a.balance, 0),
         coalesce((select sum(p.entry_price * p.qty) from public.positions p
                    where p.account_id = a.id and p.status = 'open'), 0)
    from public.accounts a
  on conflict (account_id, day) do nothing;   -- a day, once saved, is final
end $$;
revoke all on function public.snapshot_account_balances() from public, anon, authenticated;

-- 18:30 UTC = 00:00 IST. Re-running this file replaces the job.
select cron.unschedule('predict-daily-balances')
 where exists (select 1 from cron.job where jobname = 'predict-daily-balances');
select cron.schedule('predict-daily-balances', '30 18 * * *',
                     'select public.snapshot_account_balances()');

-- ------------------------------------------- 2. rounds won per day --
create or replace view public.daily_account_pnl
with (security_invoker = true) as
select
  r.account_id,
  r.day,
  sum(r.pnl)                              as pnl,
  sum(r.invested)                         as invested,
  sum(r.legs)::bigint                     as legs,
  count(*)::bigint                        as rounds,
  sum(r.legs_won)::bigint                 as legs_won,
  (count(*) filter (where r.pnl > 0))::bigint as rounds_won
from (
  select
    p.account_id,
    ((p.exit_time at time zone 'Asia/Kolkata')::date)                 as day,
    p.round_id,
    sum((p.exit_price - p.entry_price) * p.qty - coalesce(p.fees, 0)) as pnl,
    sum(p.entry_price * p.qty)                                        as invested,
    count(*)                                                          as legs,
    count(*) filter (where p.exit_price >= 0.5)                       as legs_won
  from public.positions p
  where p.exit_price is not null
    and p.exit_time is not null
    and p.account_id is not null
  group by 1, 2, 3
) r
group by 1, 2;

grant select on public.daily_account_pnl to anon, authenticated;
