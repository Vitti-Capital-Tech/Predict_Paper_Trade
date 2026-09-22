-- Two shapes, not three.
--
-- 011 offered opposite / both_yes / both_no. Choosing the direction by hand is
-- a decision nobody can make usefully: at most one of the two same-side pairs
-- can ever be cheap, because calls at both extremes need spot below them and
-- puts at both need spot above. The market decides which is available, so the
-- setting only has to say "same side" and let the worker take whichever it is.
--
-- Existing rows on either directional mode collapse to 'same'.
--
-- Run in the Supabase SQL editor after 011.

alter table public.strategy_config
  drop constraint if exists strategy_config_extremes_chk;

update public.strategy_config
   set extremes_mode = 'same'
 where extremes_mode in ('both_yes', 'both_no');

alter table public.strategy_config
  add constraint strategy_config_extremes_chk
      check (extremes_mode in ('opposite', 'same'));
