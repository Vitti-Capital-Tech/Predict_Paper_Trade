-- Underlying price when a leg ended, however it ended.
--
-- settlement_spot only covers legs held to expiry. A leg closed early by the
-- exit rule had no spot recorded at all - which is the wrong way round, since
-- that rule is written in spot points ("ITM 50") and the price it fired on is
-- exactly the number worth keeping.
--
-- Backfilled from settlement_spot where there is one, so settled legs are
-- correct immediately. Legs closed early before this migration stay null:
-- the price they closed at was never recorded and cannot be recovered.

alter table public.positions
  add column if not exists exit_spot numeric;

update public.positions
   set exit_spot = settlement_spot
 where exit_spot is null
   and settlement_spot is not null;

comment on column public.positions.exit_spot is
  'Underlying price when the leg ended, whether closed early or settled.';
