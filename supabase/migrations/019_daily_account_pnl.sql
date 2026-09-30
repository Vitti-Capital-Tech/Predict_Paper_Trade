-- Per-account, per-day results.
--
-- A view rather than a table: it is derived entirely from positions, so
-- storing it would only create something that can disagree with them.
--
-- Aggregated here rather than in the browser because the alternative is
-- shipping every settled leg to the client to add up - four thousand rows
-- today and growing by about four hundred a day. This returns one row per
-- account per day.
--
-- Days are IST, not UTC. The team reads these as working days and a UTC
-- boundary would cut each one at 5:30am local, splitting a morning's
-- trading across two rows.
--
-- security_invoker keeps the caller's RLS: the dashboard's anon key sees
-- exactly the positions it can already see, and nothing here widens that.

create or replace view public.daily_account_pnl
with (security_invoker = true) as
select
  p.account_id,
  ((p.exit_time at time zone 'Asia/Kolkata')::date) as day,
  sum((p.exit_price - p.entry_price) * p.qty - coalesce(p.fees, 0)) as pnl,
  sum(p.entry_price * p.qty)                                        as invested,
  count(*)                                                          as legs,
  count(distinct p.round_id)                                        as rounds,
  count(*) filter (where p.exit_price >= 0.5)                       as legs_won
from public.positions p
where p.exit_price is not null
  and p.exit_time is not null
  and p.account_id is not null
group by 1, 2;

grant select on public.daily_account_pnl to anon, authenticated;

comment on view public.daily_account_pnl is
  'One row per account per IST day: realised P&L, capital deployed, leg counts.';
