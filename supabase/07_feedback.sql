-- =====================================================================
--  Голоса 👍/👎 (для песен «На рассмотрении») и комментарии к песням.
--  Один человек — один голос, даже с нескольких устройств (по номеру телефона).
--  Запускать после 1–6. Можно запускать повторно.
-- =====================================================================

-- кто голосует: один ключ на человека (хэш номера телефона; без номера — само устройство)
create or replace function public.my_voter() returns text
language sql stable security definer set search_path = public as $$
  select coalesce('p:' || md5((select phone from public.member_phones where user_id = auth.uid())), 'u:' || auth.uid()::text);
$$;
revoke all on function public.my_voter() from public, anon;
grant execute on function public.my_voter() to authenticated;

create table if not exists public.song_votes (
  song_id    text not null references public.songs (id) on delete cascade,
  voter      text not null,
  voter_name text,
  vote       smallint not null check (vote in (-1, 1)),
  updated_at timestamptz not null default now(),
  primary key (song_id, voter)
);
create table if not exists public.song_comments (
  id         bigint generated always as identity primary key,
  song_id    text not null references public.songs (id) on delete cascade,
  voter      text not null,
  author     text,
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists song_comments_song_idx on public.song_comments (song_id, created_at);

alter table public.song_votes    enable row level security;
alter table public.song_comments enable row level security;
revoke all on public.song_votes, public.song_comments from anon, authenticated;
grant select on public.song_votes, public.song_comments to authenticated;
grant delete on public.song_comments to authenticated;

drop policy if exists votes_read on public.song_votes;
create policy votes_read on public.song_votes for select to authenticated using ((select public.is_editor()));
drop policy if exists comments_read on public.song_comments;
create policy comments_read on public.song_comments for select to authenticated using ((select public.is_editor()));
drop policy if exists comments_delete on public.song_comments;
create policy comments_delete on public.song_comments for delete to authenticated
  using ((select public.is_editor()) and (voter = (select public.my_voter()) or (select public.is_admin())));

-- голос: 1 — за, -1 — против, 0 — убрать свой голос
create or replace function public.set_vote(p_song text, p_vote int) returns void
language plpgsql security definer set search_path = public as $$
declare v text := public.my_voter();
begin
  if not public.is_editor() then raise exception 'members only'; end if;
  if p_vote = 0 then delete from public.song_votes where song_id = p_song and voter = v; return; end if;
  if p_vote not in (-1, 1) then raise exception 'bad vote'; end if;
  insert into public.song_votes (song_id, voter, voter_name, vote)
  values (p_song, v, (select name from public.members where user_id = auth.uid()), p_vote)
  on conflict (song_id, voter) do update set vote = excluded.vote, voter_name = excluded.voter_name, updated_at = now();
end $$;

create or replace function public.add_comment(p_song text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_editor() then raise exception 'members only'; end if;
  if (select count(*) from public.song_comments where voter = public.my_voter() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many comments';
  end if;
  insert into public.song_comments (song_id, voter, author, body)
  values (p_song, public.my_voter(), (select name from public.members where user_id = auth.uid()), btrim(p_body));
end $$;
revoke all on function public.set_vote(text, int), public.add_comment(text, text) from public, anon;
grant execute on function public.set_vote(text, int), public.add_comment(text, text) to authenticated;

-- живое обновление
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'song_votes') then
      alter publication supabase_realtime add table public.song_votes;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'song_comments') then
      alter publication supabase_realtime add table public.song_comments;
    end if;
  end if;
end $$;

select 'Голоса и комментарии готовы' as result;
