-- Separate paper accounts from live ones.
--
-- Everything that exists today is paper, so the column defaults to it and the
-- backfill is a no-op on a fresh database. The dashboard filters on this, and
-- the worker refuses any account that is not paper - see below.
--
-- `live_enabled` is a kill switch, not a status. A live account sends nothing
-- to the exchange until it is explicitly true, so creating one by accident, or
-- flipping an account to live before its credentials are in place, cannot put
-- an order on the book. Nothing reads it yet; live execution is its own stage,
-- and it will read this first.
--
-- Run in the Supabase SQL editor.

alter table public.accounts
  add column if not exists mode text not null default 'paper';

alter table public.accounts
  add column if not exists live_enabled boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_mode_chk') then
    alter table public.accounts
      add constraint accounts_mode_chk check (mode in ('paper', 'live'));
  end if;
end $$;

-- Explicit rather than relying on the default, so a row inserted before this
-- ran cannot sit with a null that the check would not have caught.
update public.accounts set mode = 'paper' where mode is null;

select mode, count(*) as accounts from public.accounts group by mode;
