-- What the worker's last comparison with Delta found, per live account, for
-- the dashboard's health bar.
--
--   delta_checked_at  when the worker last read the account's positions from
--                     Delta and compared them with the table (every minute).
--   delta_issue       what still disagreed after that pass - a contract open
--                     on one side and not the other - or Delta being
--                     unreachable for three checks running. Null when the
--                     books match.
--
-- Written by the worker (service role); read by the dashboard with the rest of
-- the accounts row, so no new policy is needed.
--
-- Run in the Supabase SQL editor of the CURRENT project (sovmhyuogmguxaeoobda).

alter table public.accounts
  add column if not exists delta_checked_at timestamptz,
  add column if not exists delta_issue      text;
