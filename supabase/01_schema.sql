-- =====================================================================
--  Песни команды прославления — схема базы Supabase
--  Запуск: Supabase → SQL Editor → New query → вставить весь файл → Run.
--  Скрипт можно запускать повторно: он ничего не ломает и не удаляет данные.
-- =====================================================================

-- ---------- таблицы ----------

create table if not exists public.songs (
  id              text primary key check (length(id) between 3 and 80),
  title           text not null check (length(title) between 1 and 300),
  title_alt       text not null default '',
  original        text not null default '',
  key             text not null default '',
  play_shift      int  not null default 0 check (play_shift between -11 and 11),
  capo            int  not null default 0 check (capo between 0 and 11),
  notes           text not null default '',
  lang            text not null default 'ru' check (lang in ('ru', 'he')),
  lyrics          text not null default '' check (length(lyrics) < 60000),
  chord_chart     text not null default '' check (length(chord_chart) < 60000),
  translit        jsonb not null default '[]'::jsonb,
  tags            text[] not null default '{}',
  links           jsonb not null default '[]'::jsonb,
  status          text not null default 'proposed' check (status in ('songbook', 'learning', 'proposed')),
  review          jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_by_name text,
  deleted_at      timestamptz
);

create table if not exists public.setlists (
  id              text primary key check (length(id) between 3 and 80),
  name            text not null default '' check (length(name) <= 200),
  date            text not null default '',
  items           jsonb not null default '[]'::jsonb,
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_by_name text
);

-- кто может редактировать (сюда попадают по ссылке-приглашению)
create table if not exists public.members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text not null default '',
  role       text not null default 'editor' check (role in ('editor', 'admin')),
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- ссылки-приглашения: одна для редакторов, одна для админов
create table if not exists public.invites (
  role         text primary key check (role in ('editor', 'admin')),
  code         text not null unique check (length(code) >= 8),
  active       boolean not null default true,
  uses         int not null default 0,
  last_used_at timestamptz
);

-- история: предыдущая версия песни при каждом изменении или удалении
create table if not exists public.song_history (
  id              bigint generated always as identity primary key,
  song_id         text not null,
  op              text not null,
  data            jsonb not null,
  changed_at      timestamptz not null default now(),
  changed_by      uuid,
  changed_by_name text
);
create index if not exists song_history_song_idx on public.song_history (song_id, changed_at desc);

-- ---------- роли ----------

create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'admin');
$$;

-- кто я: роль и имя (null, если не в команде)
create or replace function public.whoami() returns json
language plpgsql security definer set search_path = public as $$
declare m public.members;
begin
  select * into m from public.members where user_id = auth.uid();
  if not found then return null; end if;
  update public.members set last_seen = now() where user_id = m.user_id and last_seen < now() - interval '1 hour';
  return json_build_object('role', m.role, 'name', m.name);
end $$;

-- вступить в команду по коду из ссылки
create or replace function public.join_team(p_code text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare r text; nm text := left(btrim(coalesce(p_name, '')), 60);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if nm = '' then raise exception 'name required'; end if;
  select role into r from public.invites where code = p_code and active;
  if r is null then raise exception 'invalid invite' using errcode = 'P0001'; end if;
  insert into public.members (user_id, name, role) values (auth.uid(), nm, r)
  on conflict (user_id) do update
    set name = excluded.name,
        role = case when public.members.role = 'admin' then 'admin' else excluded.role end,
        last_seen = now();
  update public.invites set uses = uses + 1, last_used_at = now() where role = r;
  return public.whoami();
end $$;

-- поменять своё имя
create or replace function public.set_my_name(p_name text) returns void
language sql security definer set search_path = public as $$
  update public.members set name = left(btrim(p_name), 60)
  where user_id = auth.uid() and btrim(coalesce(p_name, '')) <> '';
$$;

-- админ: новая ссылка-приглашение (старая перестаёт работать)
create or replace function public.rotate_invite(p_role text) returns text
language plpgsql security definer set search_path = public as $$
declare c text := left(replace(gen_random_uuid()::text, '-', ''), 16);
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  update public.invites set code = c, uses = 0, last_used_at = null where role = p_role;
  return c;
end $$;

-- ---------- автоматические поля и история ----------

create or replace function public.tg_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.updated_by_name := (select name from public.members where user_id = auth.uid());
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  return new;
end $$;

create or replace function public.tg_song_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- пропускаем «пустые» сохранения, где по сути ничего не поменялось
  if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at' - 'updated_by' - 'updated_by_name')
                        = (to_jsonb(new) - 'updated_at' - 'updated_by' - 'updated_by_name') then
    return new;
  end if;
  insert into public.song_history (song_id, op, data, changed_by, changed_by_name)
  values (old.id, lower(tg_op), to_jsonb(old), auth.uid(),
          (select name from public.members where user_id = auth.uid()));
  return coalesce(new, old);
end $$;

drop trigger if exists songs_stamp on public.songs;
create trigger songs_stamp before insert or update on public.songs
  for each row execute function public.tg_stamp();
drop trigger if exists songs_history on public.songs;
create trigger songs_history after update or delete on public.songs
  for each row execute function public.tg_song_history();
drop trigger if exists setlists_stamp on public.setlists;
create trigger setlists_stamp before insert or update on public.setlists
  for each row execute function public.tg_stamp();

-- ---------- права доступа (RLS) ----------
-- Смотреть песни и сет-листы может любой, у кого есть ссылка на сайт.
-- Менять — только участники команды (вошли по ссылке-приглашению).

alter table public.songs        enable row level security;
alter table public.setlists     enable row level security;
alter table public.members      enable row level security;
alter table public.invites      enable row level security;
alter table public.song_history enable row level security;

revoke all on public.songs, public.setlists, public.members, public.invites, public.song_history from anon, authenticated;
grant select on public.songs, public.setlists to anon, authenticated;
grant insert, update, delete on public.songs, public.setlists to authenticated;
grant select, update, delete on public.members to authenticated;
grant select on public.invites, public.song_history to authenticated;

revoke all on function public.join_team(text, text), public.set_my_name(text), public.rotate_invite(text), public.whoami() from public, anon;
grant execute on function public.join_team(text, text), public.set_my_name(text), public.rotate_invite(text), public.whoami() to authenticated;
grant execute on function public.is_editor(), public.is_admin() to anon, authenticated;

drop policy if exists songs_read on public.songs;
create policy songs_read on public.songs for select to anon, authenticated
  using (deleted_at is null or public.is_editor());
drop policy if exists songs_insert on public.songs;
create policy songs_insert on public.songs for insert to authenticated
  with check (public.is_editor());
drop policy if exists songs_update on public.songs;
create policy songs_update on public.songs for update to authenticated
  using (public.is_editor()) with check (public.is_editor());
drop policy if exists songs_delete on public.songs;
create policy songs_delete on public.songs for delete to authenticated
  using (public.is_admin());

drop policy if exists setlists_read on public.setlists;
create policy setlists_read on public.setlists for select to anon, authenticated using (true);
drop policy if exists setlists_write on public.setlists;
create policy setlists_write on public.setlists for all to authenticated
  using (public.is_editor()) with check (public.is_editor());

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_editor());
drop policy if exists members_admin_update on public.members;
create policy members_admin_update on public.members for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists members_admin_delete on public.members;
create policy members_admin_delete on public.members for delete to authenticated
  using (public.is_admin() and user_id <> auth.uid());

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for select to authenticated using (public.is_admin());

drop policy if exists history_read on public.song_history;
create policy history_read on public.song_history for select to authenticated using (public.is_editor());

-- ---------- живое обновление у всех открытых страниц ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'songs') then
      alter publication supabase_realtime add table public.songs;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'setlists') then
      alter publication supabase_realtime add table public.setlists;
    end if;
  end if;
end $$;

-- ---------- ссылки-приглашения ----------
-- коды приглашений создаются отдельно и в репозиторий не попадают:
-- insert into public.invites (role, code) values ('editor', '<код>'), ('admin', '<код>') on conflict (role) do nothing;

select 'Схема готова' as result;
