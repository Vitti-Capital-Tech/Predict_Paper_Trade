-- Carry Delta's balance back on every check.
--
-- The balance was read once, when the account was created, and never again -
-- so a live account's figure drifted from the exchange the moment anything
-- settled there. A verification already asks Delta what the account holds;
-- this stores the answer instead of discarding it, and updates the account
-- with it, so "connected" and "correct" stop being separate questions.
--
-- Run in the Supabase SQL editor, after 023.

alter table public.delta_credentials
  add column if not exists balance numeric;

-- Adding a parameter makes a new overload rather than replacing the old one,
-- which would leave two functions of the same name differing by arity.
drop function if exists public.set_delta_verification(bigint, text, text, text);

create or replace function public.set_delta_verification(
  p_account_id bigint, p_status text, p_error text default null,
  p_seen_ip text default null, p_balance numeric default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.delta_credentials
     set status      = p_status,
         last_error  = p_error,
         seen_ip     = coalesce(p_seen_ip, seen_ip),
         balance     = coalesce(p_balance, balance),
         verified_at = case when p_status = 'verified' then now() else verified_at end,
         updated_at  = now()
   where account_id = p_account_id;

  -- Only on a reading that actually came back. A failed check says nothing
  -- about the balance, and writing a zero because the network was down would
  -- be worse than leaving the last known figure in place.
  if p_status = 'verified' and p_balance is not null then
    update public.accounts
       set balance = p_balance
     where id = p_account_id and mode = 'live';
  end if;
end $$;

revoke all on function public.set_delta_verification(bigint, text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.set_delta_verification(bigint, text, text, text, numeric)
  to service_role;

-- The dashboard reads the balance alongside the verdict, so a check can
-- report both in one line without waiting for the account list to refresh.
drop function if exists public.get_delta_credentials_meta(bigint);

create or replace function public.get_delta_credentials_meta(p_account_id bigint)
returns table (account_id bigint, api_key text, key_last4 text, base_url text,
               status text, last_error text, seen_ip text, balance numeric,
               verified_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.account_id, c.api_key, c.key_last4, c.base_url,
         c.status, c.last_error, c.seen_ip, c.balance, c.verified_at
    from public.delta_credentials c
   where c.account_id = p_account_id;
$$;
revoke all on function public.get_delta_credentials_meta(bigint) from public;
grant execute on function public.get_delta_credentials_meta(bigint) to anon, authenticated;
