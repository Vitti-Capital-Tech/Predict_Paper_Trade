-- Trading when spot has left the range.
--
-- Inside the strikes the wings are a strangle. Outside them they are not: one
-- is deep in the money and the other is a long shot across the whole range,
-- and the long shot is the one cheap enough to pass the odds test. 101 of the
-- 160 legs bought out of range were that far strike.
--
-- trade_outside_range off (the default, so no account changes behaviour until
-- someone turns it on): nothing is bought while spot is outside the strikes.
-- On: one leg, at the strike nearest spot, on whichever side passes
-- outside_odds, and nothing else in that round afterwards.
--
-- outside_odds is its own setting because the nearest strike sits close to the
-- money and costs far more than the wing odds allow. Default 2: a ceiling of
-- $0.50 under payout multiple, $0.33 under risk:reward.

alter table public.strategy_config
  add column if not exists trade_outside_range boolean not null default false,
  add column if not exists outside_odds numeric not null default 2
    check (outside_odds > 0);

comment on column public.strategy_config.trade_outside_range is
  'With spot outside the strikes, trade one leg at the nearest strike. Off: no trade.';
comment on column public.strategy_config.outside_odds is
  'Odds bar for the out-of-range leg, converted by odds_convention like the others.';
