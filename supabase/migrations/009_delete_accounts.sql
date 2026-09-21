-- Let the dashboard remove a paper account.
--
-- 004 gave the anon key select, insert and update on `accounts` but no delete,
-- so an account made by mistake stayed in the switcher for good.
--
-- `manual_orders.account_id` already nulls itself on delete. `positions` holds
-- a plain bigint with no foreign key, so a deleted account would leave its
-- trades pointing at nothing: they stop appearing under any account, but the
-- ledger keeps them and the P&L they contributed is unchanged. The panel
-- refuses to delete an account that still has an open position, which is the
-- case where that would actually matter.
--
-- Run in the Supabase SQL editor after 004.

drop policy if exists "anon delete accounts" on public.accounts;

create policy "anon delete accounts" on public.accounts
  for delete using (true);
