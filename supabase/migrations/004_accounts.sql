-- Paper-trading accounts.
--
-- Until now the panel showed `runs.cash`, which belongs to a worker session:
-- the worker rewrites it on every heartbeat, so a balance typed in the browser
-- would be overwritten within seconds. Accounts are separate and the worker
-- never writes `accounts.balance` on a timer — only when a trade settles.
--
-- Run in the Supabase SQL editor after 003.

create table if not exists public.accounts (
  id               bigserial primary key,
  name             text        not null,
  starting_balance numeric     not null default 10000,
  balance          numeric     not null default 10000,
  created_at       timestamptz not null default now(),
  constraint accounts_balance_chk check (balance >= 0)
);

-- Link trades to the account that placed them.
alter table public.manual_orders
  add column if not exists account_id bigint references public.accounts (id) on delete set null;

alter table public.positions
  add column if not exists account_id bigint;

create index if not exists positions_account_idx on public.positions (account_id);

-- Seed a demo account so the panel has something to show on first load.
insert into public.accounts (name, starting_balance, balance)
select 'Demo Account', 10000, 10000
where not exists (select 1 from public.accounts);

-- Atomic balance adjustment, so a debit and a credit arriving together cannot
-- clobber each other the way read-modify-write would.
create or replace function public.adjust_account_balance(
  p_account_id bigint, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance numeric;
begin
  update public.accounts
     set balance = greatest(0, balance + p_delta)
   where id = p_account_id
   returning balance into new_balance;
  return new_balance;
end;
$$;

-- ----------------------------------------------------------------- RLS ----
alter table public.accounts enable row level security;

drop policy if exists "anon read accounts"   on public.accounts;
drop policy if exists "anon create accounts" on public.accounts;
drop policy if exists "anon edit accounts"   on public.accounts;

create policy "anon read accounts"   on public.accounts for select using (true);
create policy "anon create accounts" on public.accounts for insert with check (true);

-- The panel can rename an account and set its balance. This is paper money
-- with no link to real funds, so a writable balance is the point rather than a
-- risk — but it does mean anyone who can open the page can change it.
create policy "anon edit accounts"   on public.accounts for update using (true) with check (true);

alter publication supabase_realtime add table public.accounts;
