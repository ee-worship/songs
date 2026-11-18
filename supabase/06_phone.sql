-- =====================================================================
--  Вход по номеру телефона.
--  Ссылка-приглашение ведёт на ввод телефона. Номер из списка команды — сразу доступ
--  (имя берётся из списка); другой номер — заявка, её одобряет админ.
--  Номера видят только админы. Запускать после 1–5. Можно запускать повторно.
-- =====================================================================

-- номер к единому виду: 052-123-4567 / +972 52 123 4567 / 972521234567 -> 972521234567
create or replace function public.norm_phone(p text) returns text
language sql immutable as $$
  select case
    when d like '972%' then d
    when d like '0%' and length(d) between 9 and 10 then '972' || substr(d, 2)
    else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

-- список команды: кто может войти по номеру без одобрения
create table if not exists public.allowed_people (
  phone      text primary key check (phone ~ '^\d{9,15}$'),
  name       text not null check (length(btrim(name)) between 1 and 60),
  added_at   timestamptz not null default now(),
  added_by   text
);
-- номер каждого вошедшего (отдельно, чтобы номера не видели обычные участники)
create table if not exists public.member_phones (
  user_id uuid primary key references public.members (user_id) on delete cascade,
  phone   text not null
);
-- попытки входа (защита от перебора номеров)
create table if not exists public.join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid, at timestamptz not null default now()
);
create index if not exists join_attempts_idx on public.join_attempts (user_id, at desc);

alter table public.allowed_people enable row level security;
alter table public.member_phones  enable row level security;
alter table public.join_attempts  enable row level security;
revoke all on public.allowed_people, public.member_phones, public.join_attempts from anon, authenticated;
grant select, insert, update, delete on public.allowed_people to authenticated;
grant select, delete on public.member_phones to authenticated;

drop policy if exists allowed_admin on public.allowed_people;
create policy allowed_admin on public.allowed_people for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists phones_admin on public.member_phones;
create policy phones_admin on public.member_phones for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- вход по номеру
create or replace function public.join_by_phone(p_code text, p_phone text, p_name text default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  ph text := public.norm_phone(p_phone);
  nm text := left(btrim(coalesce(p_name, '')), 60);
  ap public.allowed_people;
  cur public.members;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.invites where role = 'editor' and code = p_code and active) then
    raise exception 'invalid invite' using errcode = 'P0001';
  end if;
  if (select count(*) from public.join_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 8 then
    raise exception 'too many attempts' using errcode = 'P0001';
  end if;
  insert into public.join_attempts (user_id) values (auth.uid());
  if length(ph) < 11 or length(ph) > 15 then raise exception 'bad phone' using errcode = 'P0001'; end if;

  select * into cur from public.members where user_id = auth.uid();
  select * into ap from public.allowed_people where phone = ph;
  if found then
    insert into public.members (user_id, name, role) values (auth.uid(), ap.name, 'editor')
    on conflict (user_id) do update
      set name = excluded.name,
          role = case when public.members.role = 'admin' then 'admin' else 'editor' end,
          last_seen = now();
  else
    if cur.user_id is not null and cur.role in ('editor', 'admin') then
      return public.whoami(); -- уже в команде на этом устройстве
    end if;
    if nm = '' then return json_build_object('need_name', true); end if;
    insert into public.members (user_id, name, role) values (auth.uid(), nm, 'pending')
    on conflict (user_id) do update set name = excluded.name, last_seen = now();
  end if;
  insert into public.member_phones (user_id, phone) values (auth.uid(), ph)
  on conflict (user_id) do update set phone = excluded.phone;
  update public.invites set uses = uses + 1, last_used_at = now() where role = 'editor';
  return public.whoami();
end $$;
revoke all on function public.join_by_phone(text, text, text) from public, anon;
grant execute on function public.join_by_phone(text, text, text) to authenticated;

-- старый вход «по ссылке и имени» больше не работает
revoke execute on function public.join_team(text, text) from authenticated;
update public.invites set require_approval = false where role = 'editor';

-- ночная чистка старых попыток
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'songs-cleanup-attempts';
  perform cron.schedule('songs-cleanup-attempts', '45 1 * * *', $job$ delete from public.join_attempts where at < now() - interval '2 days'; $job$);
exception when others then null;
end $$;

select 'Вход по телефону готов' as result;
