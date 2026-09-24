-- Partial entry: buy what the book will sell you, instead of all-or-nothing.
--
-- Off (the default, and how every existing account has traded) a leg that
-- cannot be bought in full at an acceptable price is dropped. On, it is
-- bought in the largest size that is acceptable and topped up on later ticks
-- of the same round until it reaches investment_per_leg.
--
-- Default false deliberately: turning this on for accounts already running
-- would change what they are measuring halfway through.

alter table public.strategy_config
  add column if not exists partial_entry boolean not null default false;

comment on column public.strategy_config.partial_entry is
  'Fill what the book allows and top up on later ticks, instead of all-or-nothing.';
