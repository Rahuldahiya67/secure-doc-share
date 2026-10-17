-- secure-doc-share: reading-time analytics, devices and blocklist
-- Run once in Supabase -> SQL Editor AFTER 002_android_only.sql.
--
-- Reading time is measured by the server, not trusted from the phone: each
-- heartbeat adds the real time since the previous one (capped at 30 s), so a
-- viewer can't inflate their numbers, and idle/background time isn't counted.

-- ---------------------------------------------------------------
-- Blocklist: a blocked email can't open anything, whatever the lists say
-- ---------------------------------------------------------------
create table if not exists public.blocked_emails (
  email      text primary key check (email = lower(email)),
  reason     text,
  blocked_at timestamptz not null default now()
);
alter table public.blocked_emails enable row level security;
drop policy if exists "admins manage blocklist" on public.blocked_emails;
create policy "admins manage blocklist" on public.blocked_emails
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.can_view(doc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> ''
     and not exists (select 1 from public.blocked_emails b where b.email = public.current_email())
     and exists (
       select 1
         from public.documents d
         join public.document_access a on a.document_id = d.id
        where d.id = doc
          and d.is_active
          and (d.expires_at is null or d.expires_at > now())
          and a.email = public.current_email()
     );
$$;

-- ---------------------------------------------------------------
-- Reading sessions
-- ---------------------------------------------------------------
create table if not exists public.view_sessions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id) on delete cascade,
  user_id      uuid not null default auth.uid(),
  email        text not null,
  device_id    text,
  device_label text,
  page_count   int,
  max_page     int not null default 1,
  seconds      int not null default 0,
  page_seconds jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists view_sessions_doc_idx   on public.view_sessions (document_id, started_at desc);
create index if not exists view_sessions_email_idx on public.view_sessions (email, started_at desc);

alter table public.view_sessions enable row level security;
drop policy if exists "admins read sessions" on public.view_sessions;
create policy "admins read sessions" on public.view_sessions
  for select to authenticated using (public.is_admin());

-- Start a reading session (called by the app after the document has loaded).
create or replace function public.begin_session(doc uuid, device text, label text, pages int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  if not public.can_view(doc) then
    raise exception 'no_access' using errcode = '42501';
  end if;
  insert into public.view_sessions (document_id, user_id, email, device_id, device_label, page_count)
  values (doc, auth.uid(), public.current_email(), left(device, 64), left(label, 120), greatest(pages, 1))
  returning id into sid;
  return sid;
end;
$$;

-- Called every ~15 s while the reader is on screen. The server measures the
-- elapsed time itself and credits it to the page being read.
create or replace function public.heartbeat(sid uuid, page int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s     public.view_sessions%rowtype;
  delta int;
  p     text;
begin
  select * into s from public.view_sessions
   where id = sid and user_id = auth.uid()
   for update;
  if not found then return; end if;

  delta := least(greatest(extract(epoch from (now() - s.last_seen_at))::int, 0), 30);
  p := greatest(1, least(coalesce(page, 1), coalesce(s.page_count, 1)))::text;

  update public.view_sessions
     set seconds      = s.seconds + delta,
         last_seen_at = now(),
         max_page     = greatest(s.max_page, p::int),
         page_seconds = jsonb_set(s.page_seconds, array[p],
                          to_jsonb(coalesce((s.page_seconds ->> p)::int, 0) + delta))
   where id = sid;
end;
$$;

-- Restart the clock after the reader was hidden (so background time isn't counted).
create or replace function public.resume_session(sid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.view_sessions set last_seen_at = now()
   where id = sid and user_id = auth.uid();
$$;

revoke all on function public.begin_session(uuid, text, text, int) from public, anon;
revoke all on function public.heartbeat(uuid, int)                 from public, anon;
revoke all on function public.resume_session(uuid)                 from public, anon;
grant execute on function public.begin_session(uuid, text, text, int) to authenticated;
grant execute on function public.heartbeat(uuid, int)                 to authenticated;
grant execute on function public.resume_session(uuid)                 to authenticated;
