-- =====================================================================
--  AI-агент: журнал запросов и дневные лимиты.
--  Запускать после 1–4. Можно запускать повторно.
-- =====================================================================

create table if not exists public.agent_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  user_id       uuid,
  user_name     text,
  action        text,
  input         text,
  ok            boolean,
  error         text,
  input_tokens  int,
  output_tokens int,
  searches      int,
  cost_usd      numeric(10, 4)
);
create index if not exists agent_log_created_idx on public.agent_log (created_at desc);

alter table public.agent_log enable row level security;
revoke all on public.agent_log from anon, authenticated;
grant select on public.agent_log to authenticated;
drop policy if exists agent_log_admin on public.agent_log;
create policy agent_log_admin on public.agent_log for select to authenticated using ((select public.is_admin()));

-- агент (серверная функция) пишет журнал и читает лимиты
grant all on public.agent_log to service_role;
grant select on public.app_secrets to service_role;

-- лимиты запросов в день: на одного человека и на всех вместе
insert into public.app_secrets (name, value) values
  ('agent_daily_user', '30'),
  ('agent_daily_total', '150')
on conflict (name) do nothing;

select 'Журнал агента готов' as result;
