-- Make the one-sided-market guard a per-account setting.
--
-- `max_spread_frac` skips a leg whose bid/ask spread is wider than this
-- fraction of mid. It lived in config.yaml, so every account shared it, and it
-- turned out to be the single largest brake on entries: across 12,000 skip
-- events it accounted for 4,055 of them - one in three - against 49 for the
-- slippage cap.
--
-- The rejections cluster between 151% and 194% of mid with a median of 188%,
-- and that band has one cause: a bid resting at the 0.0001 floor while the ask
-- sits wherever the maker put it. In other words it fires on contracts nobody
-- is bidding for, which is exactly the shape of a cheap out-of-the-money wing
-- - the leg the strategy is built to buy.
--
-- Whether that guard is protecting the book from bad prices or simply stopping
-- most of the strategy is not knowable from the logs, because a skipped entry
-- has no outcome. Two accounts differing only in this value settle it.
--
-- The ratio cannot exceed 200% (bid -> 0 makes spread/mid -> 2), so 2.0 turns
-- the guard off. 1.5 is the value that has been in force, so existing accounts
-- keep behaving exactly as they did.
--
-- Run in the Supabase SQL editor after 013.

alter table public.strategy_config
  add column if not exists max_spread_frac numeric not null default 1.5;

alter table public.strategy_config
  drop constraint if exists strategy_config_spread_chk;

alter table public.strategy_config
  add constraint strategy_config_spread_chk
  check (max_spread_frac > 0 and max_spread_frac <= 2);

comment on column public.strategy_config.max_spread_frac is
  'Skip a leg whose (ask-bid)/mid exceeds this. 2.0 disables it, since the '
  'ratio cannot reach 2. Default 1.5 is the historical behaviour.';
