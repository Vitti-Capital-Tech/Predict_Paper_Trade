-- Closing a position from the panel.
--
-- Until now `manual_orders` could only express "buy this contract": the panel
-- had no way to exit before expiry, so a hand-placed trade ran to settlement
-- whatever the price did. Delta's own app lets you close early, and the same
-- argument that put entries through the worker applies to exits — a sale
-- priced in the browser would skip the order-book walk and report a fill that
-- the book could not have given.
--
-- So a close is queued exactly like a buy, and the worker sells against real
-- depth. One table, one queue, one execution path.
--
-- Run in the Supabase SQL editor after 004.

alter table public.manual_orders
  add column if not exists action text not null default 'buy';

-- Which open position to close. Named separately from `position_id`, which the
-- worker writes on a *fill* — the browser must not be able to touch that.
alter table public.manual_orders
  add column if not exists close_position_id text;

-- A close carries no outcome, strike or investment; those describe an entry.
alter table public.manual_orders alter column outcome    drop not null;
alter table public.manual_orders alter column strike     drop not null;
alter table public.manual_orders alter column investment drop not null;

alter table public.manual_orders
  drop constraint if exists manual_orders_action_chk;
alter table public.manual_orders
  add  constraint manual_orders_action_chk check (action in ('buy', 'close'));

-- Each action needs its own fields present and the other's absent, so a
-- malformed row is rejected at the door rather than confusing the worker.
alter table public.manual_orders
  drop constraint if exists manual_orders_shape_chk;
alter table public.manual_orders
  add  constraint manual_orders_shape_chk check (
    (action = 'buy'
       and outcome is not null
       and strike is not null
       and investment is not null
       and close_position_id is null)
    or
    (action = 'close'
       and close_position_id is not null)
  );

create index if not exists manual_orders_close_idx
  on public.manual_orders (close_position_id)
  where close_position_id is not null;

-- ----------------------------------------------------------------- RLS ----
-- Same rule as before, widened to the new shape: the browser may queue a
-- pending intent of either kind, and may still never set an execution field.
drop policy if exists "anon queue manual_orders" on public.manual_orders;

create policy "anon queue manual_orders"
  on public.manual_orders for insert
  with check (
    status = 'pending'
    and action in ('buy', 'close')
    and run_id is null
    and position_id is null
    and fill_price is null
    and contracts is null
    and processed_at is null
  );
