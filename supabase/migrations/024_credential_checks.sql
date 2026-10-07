-- Check Delta credentials before an account exists.
--
-- The form asks you to verify before it will create anything, which means the
-- key and secret have nowhere to live yet: `delta_credentials` is keyed by
-- account_id, and the account is what we are deciding whether to make. So a
-- check is staged here instead, keyed by a token the browser holds.
--
-- It still cannot be done in the browser. Delta authorises by IP and the
-- whitelisted address is the worker's, so the worker performs the call and
-- writes back the balance it saw. That balance is what the form then shows -
-- a live account's money comes from the exchange, never from a typed number.
--
-- The secret is encrypted here exactly as in `delta_credentials`, with the
-- same Vault key, and rows are short-lived: the worker deletes anything over
-- an hour old, so a staging row cannot quietly become a second permanent copy
-- of someone's credentials.
--
-- Run in the Supabase SQL editor, after 023.

create table if not exists public.delta_credential_checks (
  id             uuid primary key default gen_random_uuid(),
  api_key        text not null,
  api_secret_enc bytea not null,
  base_url       text not null default 'https://api.delta.exchange',
  status         text not null default 'pending'
                   check (status in ('pending', 'checking', 'ok', 'failed')),
  balance        numeric,      -- USD available, as Delta reported it
  message        text,
  seen_ip        text,
  created_at     timestamptz not null default now()
);

create index if not exists delta_credential_checks_pending_idx
  on public.delta_credential_checks (status, created_at);

alter table public.delta_credential_checks enable row level security;
-- No anon policy: the ciphertext is reachable only through the functions
-- below, and only service_role (the worker) touches the table directly.

-- ------------------------------------------------------------- ask ---------
create or replace function public.request_delta_check(
  p_api_key text, p_api_secret text,
  p_base_url text default 'https://api.delta.exchange')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_key text; v_id uuid;
begin
  v_key := public._delta_cred_key();
  if v_key is null then
    raise exception 'encryption key missing: run vault.create_secret(..., ''delta_cred_encryption_key'') once';
  end if;
  if coalesce(trim(p_api_key), '') = '' or coalesce(trim(p_api_secret), '') = '' then
    raise exception 'api key and secret are both required';
  end if;

  insert into public.delta_credential_checks (api_key, api_secret_enc, base_url)
  values (trim(p_api_key),
          extensions.pgp_sym_encrypt(trim(p_api_secret), v_key),
          p_base_url)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.request_delta_check(text, text, text) from public;
grant execute on function public.request_delta_check(text, text, text)
  to anon, authenticated;

-- ------------------------------------------------------------ read ---------
-- Returns the verdict only. The key and the ciphertext stay here.
create or replace function public.get_delta_check(p_id uuid)
returns table (status text, balance numeric, message text, seen_ip text)
language sql stable security definer set search_path = ''
as $$
  select c.status, c.balance, c.message, c.seen_ip
    from public.delta_credential_checks c where c.id = p_id;
$$;
revoke all on function public.get_delta_check(uuid) from public;
grant execute on function public.get_delta_check(uuid) to anon, authenticated;

-- ------------------------------------------------------ worker: read -------
create or replace function public.claim_delta_checks()
returns table (id uuid, api_key text, api_secret text, base_url text)
language plpgsql security definer set search_path = ''
as $$
declare v_key text;
begin
  v_key := public._delta_cred_key();
  -- Marked as taken in the same statement that selects them, so two workers
  -- cannot both pick up the same check.
  return query
  with taken as (
    update public.delta_credential_checks c
       set status = 'checking'
     where c.id in (select c2.id from public.delta_credential_checks c2
                     where c2.status = 'pending'
                     order by c2.created_at limit 5)
    returning c.id, c.api_key, c.api_secret_enc, c.base_url
  )
  select t.id, t.api_key,
         extensions.pgp_sym_decrypt(t.api_secret_enc, v_key), t.base_url
    from taken t;
end $$;
revoke all on function public.claim_delta_checks() from public, anon, authenticated;
grant execute on function public.claim_delta_checks() to service_role;

-- ----------------------------------------------------- worker: write -------
create or replace function public.set_delta_check(
  p_id uuid, p_status text, p_balance numeric default null,
  p_message text default null, p_seen_ip text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.delta_credential_checks
     set status = p_status, balance = p_balance,
         message = p_message, seen_ip = p_seen_ip
   where id = p_id;

  -- Staged credentials are not kept. Anything from more than an hour ago has
  -- been answered or abandoned, and holding it only widens what a leak costs.
  delete from public.delta_credential_checks
   where created_at < now() - interval '1 hour';
end $$;
revoke all on function public.set_delta_check(uuid, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.set_delta_check(uuid, text, numeric, text, text)
  to service_role;

-- ------------------------------------------- adopt a passed check ----------
-- Lets the account that gets created carry the verdict the worker already
-- reached, instead of sitting unverified while it is checked a second time.
create or replace function public.adopt_delta_check(
  p_account_id bigint, p_check_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_ok boolean;
begin
  select (c.status = 'ok' and c.api_key = d.api_key)
    into v_ok
    from public.delta_credential_checks c, public.delta_credentials d
   where c.id = p_check_id and d.account_id = p_account_id;

  if coalesce(v_ok, false) then
    update public.delta_credentials
       set status = 'verified', verified_at = now(), last_error = null
     where account_id = p_account_id;
    return 'verified';
  end if;
  return 'unverified';
end $$;
revoke all on function public.adopt_delta_check(bigint, uuid) from public;
grant execute on function public.adopt_delta_check(bigint, uuid) to anon, authenticated;
