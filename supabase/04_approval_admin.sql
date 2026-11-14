-- =====================================================================
--  1) Одобрение новых участников вручную (переключатель у админа).
--  2) Админы входят по почте и паролю; админская ссылка-приглашение отключается.
--  Запускать после 1–3. Можно запускать повторно.
-- =====================================================================

-- новая роль «ждёт одобрения»
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('pending', 'editor', 'admin'));
alter table public.invites add column if not exists require_approval boolean not null default false;

-- «участник» — только одобренные
create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role in ('editor', 'admin'));
$$;

create or replace function public.join_team(p_code text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare inv public.invites; r text; nm text := left(btrim(coalesce(p_name, '')), 60);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if nm = '' then raise exception 'name required'; end if;
  select * into inv from public.invites where code = p_code and active;
  if not found then raise exception 'invalid invite' using errcode = 'P0001'; end if;
  r := case when inv.role = 'editor' and inv.require_approval then 'pending' else inv.role end;
  insert into public.members (user_id, name, role) values (auth.uid(), nm, r)
  on conflict (user_id) do update
    set name = excluded.name,
        -- уже одобренного не понижаем
        role = case when public.members.role in ('admin', 'editor') and excluded.role <> 'admin' then public.members.role else excluded.role end,
        last_seen = now();
  update public.invites set uses = uses + 1, last_used_at = now() where role = inv.role;
  return public.whoami();
end $$;

-- админ: включить/выключить ручное одобрение
create or replace function public.set_require_approval(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  update public.invites set require_approval = p_on where role = 'editor';
end $$;
revoke all on function public.set_require_approval(boolean) from public, anon;
grant execute on function public.set_require_approval(boolean) to authenticated;

-- админ видит, сколько ждут одобрения (и кто), остальные — только одобренных
drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using ((select public.is_editor()) and (role <> 'pending' or (select public.is_admin())));

-- админ входит по паролю: этот аккаунт делаем админом
-- (вызывается только из SQL Editor, с сайта недоступно)
create or replace function public.make_admin(p_email text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then
    return 'Пользователь ' || p_email || ' не найден. Сначала создайте его: Authentication → Users → Add user.';
  end if;
  insert into public.members (user_id, name, role) values (uid, left(btrim(p_name), 60), 'admin')
  on conflict (user_id) do update set role = 'admin', name = excluded.name;
  return 'Готово: ' || p_email || ' — админ';
end $$;
revoke all on function public.make_admin(text, text) from public, anon, authenticated;

-- админская ссылка больше не нужна
update public.invites set active = false where role = 'admin';

select 'Одобрение и вход админа по паролю готовы' as result;
