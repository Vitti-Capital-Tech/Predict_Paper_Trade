-- Drop trade history that belongs to no current account.
--
-- 009 let the dashboard delete an account but deliberately left its trades
-- behind: `positions.account_id` is a plain bigint with no foreign key, so
-- the rows just stopped pointing anywhere. They are invisible in the
-- portfolio, because every read filters by account - but they are still in
-- the table, still counted by `daily_account_pnl`, and still picked up by a
-- full export. Measured on 2026-10-06: 5,797 finished legs in the table, of
-- which only 2,021 belong to the eight accounts that exist. 3,771 are from
-- deleted accounts and 5 predate accounts entirely.
--
-- THIS CANNOT BE UNDONE. Take the CSV export first if you want a copy.
--
-- Run in the Supabase SQL editor.

-- 1. What is about to go, and what stays. Run this on its own first.
select
  count(*) filter (
    where account_id is not null
      and account_id not in (select id from public.accounts))      as from_deleted_accounts,
  count(*) filter (where account_id is null)                       as never_assigned,
  count(*) filter (
    where account_id in (select id from public.accounts))          as kept
from public.positions;

-- 2. The purge.
delete from public.positions
 where account_id is null
    or account_id not in (select id from public.accounts);

-- 3. Confirm: every remaining row belongs to an account that exists.
select
  count(*)                                                         as remaining,
  count(distinct account_id)                                       as accounts,
  count(*) filter (
    where account_id is null
       or account_id not in (select id from public.accounts))      as still_orphaned
from public.positions;
