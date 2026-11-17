-- Module 4: orders, refunds and settings for the refund agent and the Refund
-- Console. Paste this whole file into Supabase > SQL Editor and click Run.
-- Safe to run more than once. Made-up data only.

create table if not exists orders (
  id text primary key,
  customer_email text not null,
  product text not null,
  amount_usd numeric(10, 2) not null check (amount_usd >= 0),
  kind text not null check (kind in ('device', 'plus_monthly', 'plus_annual')),
  ordered_at timestamptz not null
);

create table if not exists refunds (
  id text primary key,
  order_id text not null references orders (id),
  amount_usd numeric(10, 2) not null check (amount_usd >= 0),
  reason text not null,
  status text not null check (status in ('approved', 'pending', 'rejected')),
  decided_by text check (decided_by in ('auto', 'staff')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- A second guard for the "no double refunds" rule: an order can have at most
-- one refund that is approved or waiting.
create unique index if not exists refunds_one_open_per_order
  on refunds (order_id) where status <> 'rejected';

create table if not exists settings (
  key text primary key,
  value numeric not null
);

-- The limit must stay between $0 and $1000, even if someone edits it directly.
alter table settings drop constraint if exists auto_refund_limit_range;
alter table settings add constraint auto_refund_limit_range
  check (key <> 'auto_refund_limit_usd' or value between 0 and 1000);

-- No login yet (a later module adds it), so the app uses the publishable key.
-- These policies let it read orders, and read and write refunds and settings.
-- Nobody can add, change or delete orders, or delete refunds.
alter table orders enable row level security;
alter table refunds enable row level security;
alter table settings enable row level security;

drop policy if exists "orders are readable" on orders;
create policy "orders are readable" on orders for select using (true);

drop policy if exists "refunds are readable" on refunds;
create policy "refunds are readable" on refunds for select using (true);
drop policy if exists "refunds can be requested" on refunds;
create policy "refunds can be requested" on refunds for insert with check (true);
drop policy if exists "refunds can be decided" on refunds;
create policy "refunds can be decided" on refunds for update using (true) with check (true);

drop policy if exists "settings are readable" on settings;
create policy "settings are readable" on settings for select using (true);
drop policy if exists "settings can be changed" on settings;
create policy "settings can be changed" on settings for update using (true) with check (true);

-- The made-up data (same as lib/copper/data/orders.json). Dates count back
-- from today, so the 30-day and 14-day windows behave the same every time.
insert into settings (key, value) values ('auto_refund_limit_usd', 50)
on conflict (key) do nothing;

insert into orders (id, customer_email, product, amount_usd, kind, ordered_at) values
  ('1001', 'sam@example.com', 'Copper Notes charging puck', 24, 'device', now() - interval '6 days'),
  ('1002', 'sam@example.com', 'Copper Home', 149, 'device', now() - interval '10 days'),
  ('1003', 'jordan@example.com', 'Copper Plus, annual', 79, 'plus_annual', now() - interval '5 days'),
  ('1004', 'jordan@example.com', 'Copper Plus, annual', 79, 'plus_annual', now() - interval '40 days'),
  ('1005', 'riley@example.com', 'Copper Notes', 129, 'device', now() - interval '45 days'),
  ('1006', 'riley@example.com', 'Copper Plus, monthly', 7.99, 'plus_monthly', now() - interval '12 days'),
  ('1007', 'casey@example.com', 'Copper Notes charging puck', 24, 'device', now() - interval '2 days'),
  ('1008', 'casey@example.com', 'Copper Notes', 129, 'device', now() - interval '3 days'),
  ('1009', 'taylor@example.com', 'Copper Notes charging puck', 24, 'device', now() - interval '4 days'),
  ('1010', 'taylor@example.com', 'Copper Home', 149, 'device', now() - interval '7 days'),
  ('1011', 'morgan@example.com', 'Copper Notes', 129, 'device', now() - interval '6 days'),
  ('1012', 'morgan@example.com', 'Copper Notes charging puck', 24, 'device', now() - interval '1 days')
on conflict (id) do nothing;

insert into refunds (id, order_id, amount_usd, reason, status, decided_by, created_at, decided_at) values
  ('r-1', '1007', 24, 'Ordered two by mistake', 'approved', 'auto', now() - interval '1 day', now() - interval '1 day'),
  ('r-2', '1008', 129, 'Changed my mind, I prefer paper notes', 'pending', null, now() - interval '1 day', null)
on conflict (id) do nothing;
