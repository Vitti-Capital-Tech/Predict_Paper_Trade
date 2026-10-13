-- Telegram: link an account to a chat, and watch the engine from outside it.
--
-- Two parts.
--
-- 1. LINKING. The dashboard writes a random code to `telegram_link_code` and
--    opens t.me/<bot>?start=<code>. Pressing Start sends `/start <code>` to the
--    worker's bot listener, which stores the chat in `telegram_chat_id` and
--    clears the code, so a link works once. No chat id is ever typed by hand.
--
-- 2. THE WATCHDOG. A crashed worker cannot report its own death, and a stopped
--    server cannot report anything - so "AWS is down" has to be noticed by
--    something that is not on AWS. This runs inside Supabase: every minute it
--    reads the worker's heartbeat (written every few seconds) and, if it has
--    been silent for 3 minutes, messages Telegram directly. When the heartbeat
--    returns it sends an all-clear with the outage length.
--
--    A deploy restarts the worker in ~15 seconds, well inside 3 minutes, so a
--    normal deploy does not alert.
--
-- ONE-TIME SETUP, before running this - store the bot token and the chat the
-- watchdog should alert, with your own values:
--
--   select vault.create_secret('<bot token from @BotFather>', 'telegram_bot_token');
--   select vault.create_secret('<error group chat id>',      'telegram_alert_chat_id');
--
-- Without them the watchdog runs and simply sends nothing.
--
-- If `create extension` below is refused, enable pg_cron and pg_net under
-- Database -> Extensions in the Supabase dashboard, then run this again.
--
-- Run in the Supabase SQL editor.

-- ------------------------------------------------------------------ 1. link --
alter table public.accounts
  add column if not exists telegram_chat_id   text,
  add column if not exists telegram_link_code text;

create index if not exists accounts_telegram_link_code_idx
  on public.accounts (telegram_link_code)
  where telegram_link_code is not null;

-- -------------------------------------------------------------- 2. watchdog --
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One row of state: whether an outage is currently being reported, and since
-- when, so the alert is sent once (plus a reminder) rather than every minute.
create table if not exists public.engine_watch (
  id          smallint primary key default 1 check (id = 1),
  down_since  timestamptz,       -- last heartbeat before the outage
  alerted_at  timestamptz        -- last time an outage message went out
);
insert into public.engine_watch (id) values (1) on conflict (id) do nothing;
alter table public.engine_watch enable row level security;   -- no anon access

create or replace function public._telegram_send(p_text text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_token text; v_chat text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
  select decrypted_secret into v_chat
    from vault.decrypted_secrets where name = 'telegram_alert_chat_id' limit 1;
  if v_token is null or v_chat is null then
    return;                               -- not configured: stay silent
  end if;
  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object('chat_id', v_chat, 'text', p_text,
                                  'parse_mode', 'HTML'),
    headers := '{"Content-Type": "application/json"}'::jsonb);
end $$;
revoke all on function public._telegram_send(text) from public, anon, authenticated;

create or replace function public.check_engine_heartbeat()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_last    timestamptz;
  v_state   public.engine_watch%rowtype;
  v_mins    int;
begin
  select max(last_heartbeat) into v_last from public.runs;
  if v_last is null then return; end if;
  select * into v_state from public.engine_watch where id = 1;

  if now() - v_last > interval '3 minutes' then
    v_mins := floor(extract(epoch from now() - v_last) / 60);
    -- First message at 3 minutes, then a reminder every 30 while it lasts.
    if v_state.alerted_at is null
       or now() - v_state.alerted_at > interval '30 minutes' then
      perform public._telegram_send(
        E'\U0001F6D1 <b>' ||
        case when v_state.alerted_at is null
             then 'PREDICT ENGINE OFFLINE' else 'PREDICT ENGINE STILL OFFLINE' end ||
        E'</b>\nNo heartbeat for ' || v_mins || E' min — the worker is down or ' ||
        E'cannot reach the database. Live accounts are not being managed: no ' ||
        E'entries, no exits.\nCheck the AWS Lightsail instance and ' ||
        E'<code>systemctl status predict-worker</code>.\nLast heartbeat ' ||
        to_char(v_last at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC');
      update public.engine_watch
         set alerted_at = now(),
             down_since = coalesce(v_state.down_since, v_last)
       where id = 1;
    end if;

  elsif v_state.alerted_at is not null then
    -- Back. Reported once, with how long it was gone.
    v_mins := floor(extract(epoch from now() - coalesce(v_state.down_since, v_last)) / 60);
    perform public._telegram_send(
      E'✅ <b>PREDICT ENGINE BACK ONLINE</b>\nHeartbeat restored after about ' ||
      v_mins || E' min offline.\n' ||
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC');
    update public.engine_watch set alerted_at = null, down_since = null where id = 1;
  end if;
end $$;
revoke all on function public.check_engine_heartbeat() from public, anon, authenticated;

-- Every minute. Re-running this file replaces the job rather than adding one.
select cron.unschedule('predict-engine-watchdog')
 where exists (select 1 from cron.job where jobname = 'predict-engine-watchdog');
select cron.schedule('predict-engine-watchdog', '* * * * *',
                     'select public.check_engine_heartbeat()');
