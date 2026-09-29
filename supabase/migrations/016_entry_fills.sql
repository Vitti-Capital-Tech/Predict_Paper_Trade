-- How many separate fills built a leg.
--
-- With partial entry on, a leg is bought in pieces and the pieces are
-- averaged into one position - which is the right way to hold it, but it
-- leaves no sign that it happened. 77 legs had been built this way before
-- anyone could tell from the dashboard that any had.
--
-- Default 1, which is true of every leg bought in a single go, including
-- every leg that already exists.

alter table public.positions
  add column if not exists entry_fills integer not null default 1;

comment on column public.positions.entry_fills is
  'Number of separate fills that built this leg; >1 means partial entry topped it up.';
