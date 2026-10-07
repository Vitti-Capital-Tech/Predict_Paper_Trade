-- Delta Exchange API credentials for live accounts.
--
-- SECURITY MODEL
--   * The secret is encrypted at rest with pgcrypto, using a key held in
--     Supabase Vault. The ciphertext never leaves the database.
--   * RLS denies the table outright. Nothing reads or writes it directly;
--     everything goes through the three functions below.
--   * `upsert_delta_credentials` writes. It takes the secret, encrypts it and
--     returns only the last four characters of the key, so the browser has
--     nothing to hand back.
--   * `get_delta_credentials_meta` reads what the dashboard may show: the
--     api key, the status, the last error. Never the secret.
--   * `get_delta_credentials_decrypted` is the ONLY decrypt path and is
--     granted to service_role alone - the worker, placing orders.
--
-- WHY VERIFICATION IS NOT DONE IN THE BROWSER
--   Delta authorises by IP. The whitelisted address is the worker's, not the
--   laptop's, so a check made from the browser would fail even with perfect
--   credentials - and would teach you to distrust a working setup. The browser
--   asks for a check by setting status to 'unverified'; the worker performs it
--   from the whitelisted address and writes the answer back.
--
-- ONE-TIME PREREQUISITE - run this once first, with your own long random
-- string, or the functions below have no key to encrypt with:
--
--   select vault.create_secret(
--     'CHANGE-ME-to-a-long-random-string', 'delta_cred_encryption_key');
--
-- Run in the Supabase SQL editor, after 022.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.delta_credentials (
  account_id     bigint primary key references public.accounts (id) on delete cascade,
  api_key        text not null,
  api_secret_enc bytea not null,          -- pgp_sym_encrypt ciphertext
  key_last4      text,                    -- display only
  -- Predict markets are listed on Delta GLOBAL. Measured 07 Oct 2026:
  -- api.delta.exchange lists the binary products, api.india.delta.exchange
  -- lists none of them, so a key issued on India cannot trade these at all.
  base_url       text not null default 'https://api.delta.exchange',
  status         text not null default 'unverified'
                   check (status in ('unverified', 'verifying', 'verified', 'invalid')),
  last_error     text,
  -- The address Delta reported seeing. It is in the error body on a rejected
  -- call and is the only authoritative answer to "what do I whitelist".
  seen_ip        text,
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.delta_credentials enable row level security;

-- No anon or authenticated policy exists, so RLS denies every direct read and
-- write. service_role bypasses RLS and is what the worker uses.

-- ---------------------------------------------------------------- helpers --
create or replace function public._delta_cred_key()
returns text
language sql stable security definer set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = 'delta_cred_encryption_key' limit 1;
$$;
revoke all on function public._delta_cred_key() from public, anon, authenticated;

-- ------------------------------------------------------------------ write --
create or replace function public.upsert_delta_credentials(
  p_account_id bigint,
  p_api_key    text,
  p_api_secret text,
  p_base_url   text default 'https://api.delta.exchange'
)
-- Output names are prefixed so they cannot collide with the table's own
-- columns. RETURNS TABLE declares them as variables, and an unprefixed
-- `account_id` makes `on conflict (account_id)` below ambiguous.
returns table (out_account_id bigint, out_key_last4 text, out_status text)
language plpgsql security definer set search_path = ''
as $$
declare v_key text;
begin
  v_key := public._delta_cred_key();
  if v_key is null then
    raise exception 'encryption key missing: run vault.create_secret(..., ''delta_cred_encryption_key'') once';
  end if;
  if coalesce(trim(p_api_key), '') = '' or coalesce(trim(p_api_secret), '') = '' then
    raise exception 'api key and secret are both required';
  end if;
  -- Credentials belong to live accounts. Attaching them to a paper account
  -- would be meaningless and is more likely a mistake than an intent.
  if not exists (select 1 from public.accounts a
                  where a.id = p_account_id and a.mode = 'live') then
    raise exception 'account % is not a live account', p_account_id;
  end if;

  insert into public.delta_credentials as c
    (account_id, api_key, api_secret_enc, key_last4, base_url, status, updated_at)
  values (
    p_account_id, trim(p_api_key),
    extensions.pgp_sym_encrypt(trim(p_api_secret), v_key),
    right(trim(p_api_key), 4), p_base_url, 'unverified', now())
  on conflict (account_id) do update set
    api_key        = excluded.api_key,
    api_secret_enc = excluded.api_secret_enc,
    key_last4      = excluded.key_last4,
    base_url       = excluded.base_url,
    -- New credentials are unproven, whatever the old ones were.
    status         = 'unverified',
    last_error     = null,
    seen_ip        = null,
    verified_at    = null,
    updated_at     = now();

  return query
    select c.account_id, c.key_last4, c.status
      from public.delta_credentials c
     where c.account_id = p_account_id;
end $$;

revoke all on function public.upsert_delta_credentials(bigint, text, text, text)
  from public;
-- The dashboard runs on the anon key; it has no login. Same posture as every
-- other write it makes. See the note at the end of this file.
grant execute on function public.upsert_delta_credentials(bigint, text, text, text)
  to anon, authenticated;

-- ------------------------------------------------------- ask for a recheck --
create or replace function public.request_delta_verification(p_account_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  update public.delta_credentials
     set status = 'unverified', last_error = null, updated_at = now()
   where account_id = p_account_id;
  if not found then
    raise exception 'no credentials stored for account %', p_account_id;
  end if;
  return 'unverified';
end $$;
revoke all on function public.request_delta_verification(bigint) from public;
grant execute on function public.request_delta_verification(bigint) to anon, authenticated;

-- ------------------------------------------------------------- read (meta) --
create or replace function public.get_delta_credentials_meta(p_account_id bigint)
returns table (account_id bigint, api_key text, key_last4 text, base_url text,
               status text, last_error text, seen_ip text, verified_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.account_id, c.api_key, c.key_last4, c.base_url,
         c.status, c.last_error, c.seen_ip, c.verified_at
    from public.delta_credentials c
   where c.account_id = p_account_id;
$$;
revoke all on function public.get_delta_credentials_meta(bigint) from public;
grant execute on function public.get_delta_credentials_meta(bigint) to anon, authenticated;

-- ---------------------------------------------------------- read (secret) --
create or replace function public.get_delta_credentials_decrypted(p_account_id bigint)
returns table (api_key text, api_secret text, base_url text)
language plpgsql stable security definer set search_path = ''
as $$
declare v_key text;
begin
  v_key := public._delta_cred_key();
  return query
    select c.api_key,
           extensions.pgp_sym_decrypt(c.api_secret_enc, v_key),
           c.base_url
      from public.delta_credentials c
     where c.account_id = p_account_id;
end $$;
revoke all on function public.get_delta_credentials_decrypted(bigint)
  from public, anon, authenticated;
grant execute on function public.get_delta_credentials_decrypted(bigint) to service_role;

-- --------------------------------------------------------- worker writeback --
create or replace function public.set_delta_verification(
  p_account_id bigint, p_status text, p_error text default null,
  p_seen_ip text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.delta_credentials
     set status      = p_status,
         last_error  = p_error,
         seen_ip     = coalesce(p_seen_ip, seen_ip),
         verified_at = case when p_status = 'verified' then now() else verified_at end,
         updated_at  = now()
   where account_id = p_account_id;
end $$;
revoke all on function public.set_delta_verification(bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_delta_verification(bigint, text, text, text)
  to service_role;

-- NOTE ON ACCESS
-- This dashboard has no login: it talks to Supabase with the anon key, and
-- anyone who can open it can already create accounts and place orders. Storing
-- trading credentials does not change that, but it does raise what it costs.
-- Put the site behind authentication before a live account is funded.

-- Re-runnable: if an earlier copy of this file defaulted to the India entity,
-- correct the default and anything already stored against it. Predict is not
-- listed there, so such a row could never have worked.
alter table public.delta_credentials
  alter column base_url set default 'https://api.delta.exchange';

update public.delta_credentials
   set base_url = 'https://api.delta.exchange', status = 'unverified'
 where base_url <> 'https://api.delta.exchange';
