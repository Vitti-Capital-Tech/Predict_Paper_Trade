-- Fix: "column reference account_id is ambiguous" when saving credentials.
--
-- `returns table (account_id bigint, ...)` declares account_id as an output
-- variable, and `on conflict (account_id)` in the same function then has two
-- things of that name to choose between. Postgres refuses rather than guess,
-- and only at call time - the function created without complaint.
--
-- The output columns are renamed so nothing collides. Nothing reads them by
-- name; the caller only checks that a row came back.
--
-- Run in the Supabase SQL editor, after 023. Safe to run more than once.

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
grant execute on function public.upsert_delta_credentials(bigint, text, text, text)
  to anon, authenticated;
