-- Keep the two log tables small.
--
-- On 15 Oct the database was 602 MB against the free plan's 500 MB, and almost
-- none of it was trades (4,000 rows). It was two logs:
--
--   market_snapshots  390,000 rows. A new 4 KB row every ~2.7s, though only the
--                     newest is ever read. The prune trigger deleted old rows
--                     for the *current* run only, so every restart (68 runs so
--                     far) left a day's worth behind for good - and deleting
--                     on every insert left the table full of dead rows.
--   events            355,000 rows, mostly "skip": a reason carrying a live
--                     number read as new every tick. The worker now writes each
--                     kind of reason once per round.
--
-- After this:
--   * market_snapshots holds one row per run, overwritten in place (the worker
--     upserts on run_id - it falls back to inserting until this has run).
--   * events older than 7 days are deleted, and again every night.
--   * Trades (positions), accounts and settings are not touched.
--
-- Run in the Supabase SQL editor. Then, to give the space back to the plan,
-- run the two VACUUM lines at the bottom ON THEIR OWN - see there.

-- --------------------------------------------------------- market_snapshots --
drop trigger if exists prune_snapshots on public.market_snapshots;
drop function if exists public.prune_market_snapshots();

-- Keep only the newest row of each run.
delete from public.market_snapshots s
 using (select run_id, max(id) as keep_id
          from public.market_snapshots group by run_id) k
 where s.run_id = k.run_id
   and s.id <> k.keep_id;

create unique index if not exists market_snapshots_run_key
  on public.market_snapshots (run_id);

-- ------------------------------------------------------------------- events --
delete from public.events where ts < now() - interval '7 days';

-- ------------------------------------------------------------ nightly trim --
-- 02:45 IST, outside the trading sessions. Re-running this file replaces the
-- job rather than adding a second.
select cron.unschedule('predict-trim-logs')
 where exists (select 1 from cron.job where jobname = 'predict-trim-logs');
select cron.schedule('predict-trim-logs', '15 21 * * *', $job$
  delete from public.events where ts < now() - interval '7 days';
  delete from public.market_snapshots
   where run_id not in (select id from public.runs
                         where last_heartbeat > now() - interval '2 days');
$job$);

-- -------------------------------------------------------- give space back --
-- DELETE frees rows for reuse but does not shrink the files, so the plan's
-- "database size" stays at 602 MB until the tables are rewritten. Run these two
-- lines separately, after the part above (VACUUM cannot run inside the same
-- batch). Each locks its table for a moment; the tables are small by then.
--
--   vacuum full public.market_snapshots;
--   vacuum full public.events;
