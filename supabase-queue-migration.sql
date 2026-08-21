-- Enable the pgmq extension in Supabase before running this migration if needed.
create extension if not exists pgmq;

-- Create this queue once. If it already exists, the dashboard will report it as existing.
select pgmq.create('telegram_messages');

-- The server uses the pgmq_public wrappers through Supabase's Data API.
-- In the Supabase Dashboard, enable:
-- Integrations > Queues > Settings > Expose Queues via PostgREST
-- Then grant the service_role permission to send, read, and delete messages.
