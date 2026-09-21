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
-- Run in the Supabase SQL editor after 006 (and 008, if you ran it).

alter table public.strategy_config
  add column if not exists account_id bigint references public.accounts (id) on delete cascade;

-- The singleton row becomes the first account's.
update public.strategy_config
   set account_id = (select id from public.accounts order by created_at, id limit 1)
 where account_id is null;

alter table public.strategy_config drop constraint if exists strategy_config_singleton;
alter table public.strategy_config drop constraint if exists strategy_config_pkey cascade;
alter table public.strategy_config
  alter column id drop default;

-- id stops being meaningful; the account is the key.
drop sequence if exists strategy_config_id_seq cascade;
alter table public.strategy_config drop column if exists id;

delete from public.strategy_config where account_id is null;
alter table public.strategy_config alter column account_id set not null;
alter table public.strategy_config add primary key (account_id);

-- Every account that predates this gets a row with the defaults.
insert into public.strategy_config (account_id)
select a.id from public.accounts a
where not exists (
  select 1 from public.strategy_config s where s.account_id = a.id
);

-- And every account made from now on gets one without the UI having to
-- remember, so a new account is never a half-configured one.
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
