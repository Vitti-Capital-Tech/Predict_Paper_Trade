-- Which asset's ATR gates an account's entries.
--
--   atr_asset  'BTC' or 'ETH'. Null means the asset the account trades, which
--              is how every account behaved before this column existed.
--
-- An ETH account can now enter on BTC's volatility (or the other way round).
-- atr_min is read in the chosen asset's points: BTC's 15m ATR runs in the
-- hundreds, ETH's around ten, so switching the asset needs a new minimum.
--
-- Read by the worker with the rest of the row; the dashboard's Save only sends
-- columns the row has, so nothing breaks before this runs.
--
-- Run in the Supabase SQL editor of the CURRENT project (sovmhyuogmguxaeoobda).

alter table public.strategy_config
  add column if not exists atr_asset text;

alter table public.strategy_config
  drop constraint if exists strategy_config_atr_asset_chk;
alter table public.strategy_config
  add constraint strategy_config_atr_asset_chk
  check (atr_asset is null or atr_asset in ('BTC', 'ETH'));
