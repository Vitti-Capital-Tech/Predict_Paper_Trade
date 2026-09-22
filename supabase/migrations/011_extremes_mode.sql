-- Which side to buy at each extreme strike.
--
-- Until now this was fixed: Put at the lowest strike, Call at the highest - a
-- long strangle, which pays when price moves hard in either direction and is
-- cheap only while spot sits between the two.
--
-- That is one shape, not the only one. Both extremes can also be bought on the
-- same side, which is a directional bet spread across two strikes rather than
-- a bet on movement. The two behave nothing alike, so it is a setting.
--
--   opposite  Put low  + Call high   strangle
--   both_yes  Call low + Call high   directional, up
--   both_no   Put low  + Put high    directional, down
--
-- Also: the middle leg only joins a round already held on both extremes. It
-- was being evaluated on its own, which made it a third independent bet
-- rather than the addition to a pair it was meant to be.
--
-- Run in the Supabase SQL editor after 010.

alter table public.strategy_config
  add column if not exists extremes_mode text not null default 'opposite';

alter table public.strategy_config
  drop constraint if exists strategy_config_extremes_chk;
alter table public.strategy_config
  add  constraint strategy_config_extremes_chk
       check (extremes_mode in ('opposite', 'both_yes', 'both_no'));

alter table public.strategy_config
  add column if not exists middle_needs_both_wings boolean not null default true;
