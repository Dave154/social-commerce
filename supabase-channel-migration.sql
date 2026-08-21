alter table public.bookings
  add column if not exists channel text not null default 'whatsapp';

alter table public.orders
  add column if not exists channel text not null default 'whatsapp';

alter table public.chat_history
  add column if not exists channel text not null default 'whatsapp';

create index if not exists bookings_customer_channel_status_idx
  on public.bookings (vendor_id, channel, customer_id, status);

create index if not exists orders_customer_channel_idx
  on public.orders (vendor_id, channel, customer_phone);

create index if not exists chat_history_customer_channel_idx
  on public.chat_history (vendor_id, channel, customer_id, created_at);
