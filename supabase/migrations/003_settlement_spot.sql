-- Records the underlying's price when a position settled, so the trade cards
-- can show a "Settlement Price" the way Delta's app does.
--
-- Delta publishes the option's settlement_price (0 or 1) but not the spot that
-- produced it, so the worker records the last spot it observed before expiry.
-- That is within one poll interval (~2s) of settlement, not the venue's
-- official settlement mark - close enough to explain an outcome, not to
-- reconcile against.
--
-- Run in the Supabase SQL editor after 002.

alter table public.positions
  add column if not exists settlement_spot numeric;

comment on column public.positions.settlement_spot is
  'Last underlying spot observed before expiry. Approximates the settlement '
  'mark; not the venue''s official figure.';
