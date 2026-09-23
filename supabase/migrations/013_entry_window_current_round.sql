-- Keep entries inside the round that is actually running.
--
-- max_seconds_to_expiry existed but was never surfaced, so every account sat
-- on the 1800s default: half an hour, two full rounds. The bot was therefore
-- free to buy the next round before the current one had expired, which is how
-- a position opened at 14:29 for a 14:45 expiry - sixteen minutes out, on a
-- round that had not started yet.
--
-- Rounds are 15 minutes. 900 means "the current round, and nothing beyond it".

alter table strategy_config
  alter column max_seconds_to_expiry set default 900;

update strategy_config
   set max_seconds_to_expiry = 900
 where max_seconds_to_expiry > 900;
