-- The fills that built each leg.
--
-- entry_fills says a leg was bought in three goes. It does not say whether
-- the average was dragged by one bad slice or earned evenly across all
-- three, and on a strategy whose whole thesis is slippage that is the part
-- worth seeing. Each record is {t, qty, price, top, slip, levels}: when it
-- filled, how many contracts, at what average, what the touch was at that
-- moment, and how far down the book it had to reach.
--
-- Defaults to an empty array rather than null, so the dashboard can read it
-- without a null check, and every existing leg is simply "no breakdown
-- recorded" instead of malformed.

alter table public.positions
  add column if not exists fills jsonb not null default '[]'::jsonb;

comment on column public.positions.fills is
  'Execution breakdown: one {t,qty,price,top,slip,levels} per fill that built this leg.';
