-- =====================================================================
--  Закрытый режим: песни видят только участники команды (вошли по ссылке).
--  Удаляют песни и управляют командой — только админы.
--  Запускать после 1-схема.sql и 2-песни.sql. Можно запускать повторно.
-- =====================================================================

-- песни и сет-листы: только участники
revoke select on public.songs, public.setlists from anon;

drop policy if exists songs_read on public.songs;
create policy songs_read on public.songs for select to authenticated
  using ((select public.is_editor()) and (deleted_at is null or (select public.is_admin())));

-- редакторы добавляют и правят, но не удаляют; удалять и возвращать — админ
drop policy if exists songs_insert on public.songs;
create policy songs_insert on public.songs for insert to authenticated
  with check ((select public.is_editor()) and (deleted_at is null or (select public.is_admin())));
drop policy if exists songs_update on public.songs;
create policy songs_update on public.songs for update to authenticated
  using ((select public.is_editor()) and (deleted_at is null or (select public.is_admin())))
  with check ((select public.is_editor()) and (deleted_at is null or (select public.is_admin())));

drop policy if exists setlists_read on public.setlists;
create policy setlists_read on public.setlists for select to authenticated
  using ((select public.is_editor()));

-- ---------- резервная копия по секретному токену (для GitHub) ----------
create table if not exists public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
insert into public.app_secrets (name, value) values ('backup_token', '__BACKUP_TOKEN__')
on conflict (name) do update set value = excluded.value;

create or replace function public.backup_export(p_token text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_secrets where name = 'backup_token' and value = p_token) then
    perform pg_sleep(1);
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return json_build_object(
    'exported_at', now(),
    'songs',    (select coalesce(json_agg(s order by s.id), '[]'::json) from public.songs s),
    'setlists', (select coalesce(json_agg(t order by t.id), '[]'::json) from public.setlists t));
end $$;
revoke all on function public.backup_export(text) from public;
grant execute on function public.backup_export(text) to anon, authenticated;

-- ---------- ночная чистка: анонимные входы, которые так и не попали в команду ----------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'songs-cleanup-anon';
  perform cron.schedule('songs-cleanup-anon', '40 1 * * *', $job$
    delete from auth.users u
    where u.is_anonymous
      and u.created_at < now() - interval '1 day'
      and not exists (select 1 from public.members m where m.user_id = u.id);
  $job$);
  raise notice 'ночная чистка включена';
exception when others then
  raise notice 'ночную чистку включить не удалось: % — это не страшно, всё остальное работает', sqlerrm;
end $$;

select 'Закрытый режим включён' as result;
