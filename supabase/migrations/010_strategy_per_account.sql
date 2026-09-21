-- One strategy per account.
--
-- 006 made the settings a singleton, because there was one worker and one
-- book. That turned out to be the wrong shape: arming the bot armed it
-- everywhere, and an account was only a balance rather than a strategy you
-- could run and judge on its own.
--
-- An account now owns its filters, its own ON/OFF, and the positions the bot
-- opens for it. Running 1:4 on one account and 1:6 on another and comparing
-- them is the point.
--
-- Note the bot's own entries carried no account at all before this, so its
-- P&L moved no balance and its positions never appeared in a panel that
-- filters by account. That is fixed on the worker side.
--
-- The table is published for realtime, and a published table needs a replica
-- identity to delete or update a row. Its identity is the primary key, which
-- this migration replaces - so the table leaves the publication for the
-- duration and rejoins at the end. Doing the surgery with it still attached is
-- what "cannot delete ... does not have a replica identity" means.
--
-- Every step is conditional, so this is safe to run again if an earlier
-- attempt stopped partway.
--
-- Run in the Supabase SQL editor after 006 (and 008, if you ran it).

-- 1. Step out of the publication while the key is being replaced.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'strategy_config'
  ) then
    alter publication supabase_realtime drop table public.strategy_config;
  end if;
end $$;

-- 2. Key the settings on the account.
alter table public.strategy_config
  add column if not exists account_id bigint references public.accounts (id) on delete cascade;

-- The singleton row becomes the first account's.
update public.strategy_config
   set account_id = (select id from public.accounts order by created_at, id limit 1)
 where account_id is null;

-- Anything still unclaimed belonged to no account at all.
delete from public.strategy_config where account_id is null;

-- 3. Retire the old key. `id` stops being meaningful; the account is the key.
alter table public.strategy_config drop constraint if exists strategy_config_singleton;
alter table public.strategy_config drop constraint if exists strategy_config_pkey cascade;
alter table public.strategy_config drop column if exists id cascade;
drop sequence if exists public.strategy_config_id_seq cascade;

alter table public.strategy_config alter column account_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.strategy_config'::regclass and contype = 'p'
  ) then
    alter table public.strategy_config add primary key (account_id);
  end if;
end $$;

-- 4. Every account that predates this gets a row with the defaults.
insert into public.strategy_config (account_id)
select a.id from public.accounts a
where not exists (
  select 1 from public.strategy_config s where s.account_id = a.id
);

-- 5. And every account made from now on gets one without the UI having to
--    remember, so a new account is never a half-configured one.
create or replace function public.seed_strategy_config()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.strategy_config (account_id) values (new.id)
  on conflict (account_id) do nothing;
  return new;
end;
$$;

drop trigger if exists accounts_seed_strategy on public.accounts;
create trigger accounts_seed_strategy after insert on public.accounts
  for each row execute function public.seed_strategy_config();

-- 6. Back into the publication, now that the new primary key is its identity.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'strategy_config'
  ) then
    alter publication supabase_realtime add table public.strategy_config;
  end if;
end $$;
