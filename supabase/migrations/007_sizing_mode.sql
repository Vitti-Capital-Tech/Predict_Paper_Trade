-- How the bot sizes a leg.
--
-- The ticket has always sized in dollars, the way Delta's panel does: you say
-- $25 and it works out the contracts. The bot sized in contracts. Same book,
-- same fills, two different units - and no way to say "risk $25 a leg" without
-- doing the arithmetic yourself against a price that moves.
--
-- Both are now available, because they are not the same bet:
--
--   contracts  - a fixed count. Slippage stays predictable, because the depth
--                you consume is the same every time. Your dollar risk swings
--                with the price: 100 contracts is $2 on a 0.02 wing and $20 on
--                a 0.20 one.
--   investment - a fixed dollar amount. Risk per leg is constant, but the
--                contract count moves inversely with price, so the cheapest
--                wings - the thinnest part of the book - are exactly where it
--                buys the most. $25 at 0.02 is 1,250 contracts.
--
-- Run in the Supabase SQL editor after 006.

alter table public.strategy_config
  add column if not exists size_mode text not null default 'contracts';

alter table public.strategy_config
  add column if not exists investment_per_leg numeric not null default 25;

alter table public.strategy_config
  drop constraint if exists strategy_config_sizemode_chk;
alter table public.strategy_config
  add  constraint strategy_config_sizemode_chk
       check (size_mode in ('contracts', 'investment'));

alter table public.strategy_config
  drop constraint if exists strategy_config_investment_chk;
alter table public.strategy_config
  add  constraint strategy_config_investment_chk
       check (investment_per_leg > 0 and investment_per_leg <= 100000);
