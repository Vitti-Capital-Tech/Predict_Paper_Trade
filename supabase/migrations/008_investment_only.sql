-- Predict sizes in dollars, so the bot does too.
--
-- 007 offered a choice between a fixed contract count and a fixed dollar
-- amount. The venue offers no such choice: its ticket takes $5, $25, $50 or a
-- typed amount and derives the contracts from the price. A sizing unit the
-- product does not have is a control nobody asked for, so the choice is gone
-- and dollars are the only unit.
--
-- The risk a dollar budget carries has not gone away: the cheapest wings are
-- the thinnest part of the book, and that is exactly where a fixed amount buys
-- the most contracts. `max_slippage` is what holds it in check, which is a
-- better place for the protection than a sizing unit anyway.
--
-- Safe to run whether or not 007 was: every statement is conditional.
--
-- Run in the Supabase SQL editor after 006 (and 007, if you ran it).

alter table public.strategy_config
  add column if not exists investment_per_leg numeric not null default 25;

alter table public.strategy_config
  drop constraint if exists strategy_config_investment_chk;
alter table public.strategy_config
  add  constraint strategy_config_investment_chk
       check (investment_per_leg > 0 and investment_per_leg <= 100000);

alter table public.strategy_config drop constraint if exists strategy_config_sizemode_chk;
alter table public.strategy_config drop column if exists size_mode;
alter table public.strategy_config drop constraint if exists strategy_config_size_chk;
alter table public.strategy_config drop column if exists size_contracts;
