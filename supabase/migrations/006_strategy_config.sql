-- Strategy settings the dashboard can edit while the worker runs.
--
-- Until now every rule lived in config.yaml on the worker's host, so changing
-- a threshold meant an SSH session and a restart. That is fine for a strategy
-- you set once and forget, and useless for one you are still tuning.
--
-- One row, id = 1. There is one worker and one book, so a second row would
-- only raise the question of which is in force.
--
-- Run in the Supabase SQL editor after 005.

create table if not exists public.strategy_config (
  id smallint primary key default 1,

  -- The master switch. Off stops NEW entries; open positions are still managed
  -- and settled, because disarming should not strand money in the market.
  enabled boolean not null default false,

  underlying text not null default 'BTC',

  -- ATR gate: "only when BTC ATR is more than 200"
  atr_enabled    boolean not null default true,
  atr_resolution text    not null default '15m',
  atr_period     integer not null default 14,   -- number of candles
  atr_min        numeric not null default 200,

  -- Wall-clock window. Null start/end means all hours.
  session_start    time,
  session_end      time,
  session_timezone text not null default 'IST',
  weekdays         smallint[] not null default '{0,1,2,3,4,5,6}',

  -- Position inside the round, in seconds.
  min_seconds_since_launch numeric not null default 30,
  max_seconds_since_launch numeric not null default 900,
  min_seconds_to_expiry    numeric not null default 180,
  max_seconds_to_expiry    numeric not null default 1800,

  -- Entry. wing_odds 4 under risk_reward caps a wing at 1/(1+4) = 0.20.
  odds_convention    text    not null default 'risk_reward',
  wing_odds          numeric not null default 4,
  trade_wings        boolean not null default true,
  require_both_wings boolean not null default true,
  trade_middle       boolean not null default false,
  middle_odds        numeric not null default 3,

  -- Exit. `moneyness` measures spot against the strike:
  --   itm -> spot is exit_points past the strike in your favour
  --   otm -> spot is exit_points past it against you (a stop)
  --   atm -> spot is within exit_atm_band of the strike
  exit_mode                text    not null default 'moneyness',
  exit_trigger             text    not null default 'itm',
  exit_points              numeric not null default 50,
  exit_atm_band            numeric not null default 25,
  take_profit_price        numeric not null default 0.50,
  stop_loss_price          numeric,
  flatten_before_expiry_sec numeric,

  -- Execution. Doubles as the panel's slider and the bot's own cap: a leg
  -- whose fill slips more than this above the touch is skipped.
  max_slippage numeric not null default 0.05,

  -- Sizing.
  size_contracts        integer not null default 100,
  max_concurrent_rounds integer not null default 2,
  max_cost_per_round    numeric,

  updated_at timestamptz not null default now(),

  constraint strategy_config_singleton  check (id = 1),
  constraint strategy_config_odds_chk   check (odds_convention in ('risk_reward','payout_multiple')),
  constraint strategy_config_exit_chk   check (exit_mode in ('price','spot_points','moneyness')),
  constraint strategy_config_trig_chk   check (exit_trigger in ('itm','atm','otm')),
  constraint strategy_config_slip_chk   check (max_slippage > 0 and max_slippage <= 1),
  constraint strategy_config_atr_chk    check (atr_period >= 2 and atr_min >= 0),
  constraint strategy_config_size_chk   check (size_contracts >= 1)
);

insert into public.strategy_config (id) values (1) on conflict (id) do nothing;

create or replace function public.touch_strategy_config()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists strategy_config_touch on public.strategy_config;
create trigger strategy_config_touch before update on public.strategy_config
  for each row execute function public.touch_strategy_config();

-- ----------------------------------------------------------------- RLS ----
-- Same trust model as `accounts`: this is paper money and the dashboard is the
-- control surface, so the anon key may edit it. That does mean anyone who can
-- open the page can arm the bot or move a threshold.
alter table public.strategy_config enable row level security;

drop policy if exists "anon read strategy_config" on public.strategy_config;
drop policy if exists "anon edit strategy_config" on public.strategy_config;

create policy "anon read strategy_config" on public.strategy_config
  for select using (true);
create policy "anon edit strategy_config" on public.strategy_config
  for update using (true) with check (true);

alter publication supabase_realtime add table public.strategy_config;
