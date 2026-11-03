-- secure-doc-share: announcements, Help/FAQ, feedback, "My account"
-- Run once in Supabase -> SQL Editor AFTER 007_documents.sql.

-- ---------------------------------------------------------------
-- Announcements shown on everyone's home screen
-- ---------------------------------------------------------------
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(trim(title)) between 1 and 120),
  body       text check (body is null or length(body) <= 2000),
  pinned     boolean not null default false,
  is_active  boolean not null default true,
  expires_at timestamptz,
  created_by text not null default public.current_email(),
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;
drop policy if exists "admins manage announcements" on public.announcements;
create policy "admins manage announcements" on public.announcements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "signed-in users read announcements" on public.announcements;
create policy "signed-in users read announcements" on public.announcements
  for select to authenticated
  using (is_active and (expires_at is null or expires_at > now())
         and public.current_email() <> '' and not public.is_blocked());

-- ---------------------------------------------------------------
-- Help / FAQ, written by admins
-- ---------------------------------------------------------------
create table if not exists public.faqs (
  id         uuid primary key default gen_random_uuid(),
  question   text not null check (length(trim(question)) between 1 and 300),
  answer     text not null check (length(answer) <= 4000),
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.faqs enable row level security;
drop policy if exists "admins manage faqs" on public.faqs;
create policy "admins manage faqs" on public.faqs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "signed-in users read faqs" on public.faqs;
create policy "signed-in users read faqs" on public.faqs
  for select to authenticated using (is_active and public.current_email() <> '');

-- ---------------------------------------------------------------
-- Feedback from people, with an optional reply
-- ---------------------------------------------------------------
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  email       text not null default public.current_email(),
  kind        text not null default 'idea' check (kind in ('idea', 'problem', 'question', 'other')),
  message     text not null check (length(trim(message)) between 1 and 2000),
  status      text not null default 'new' check (status in ('new', 'seen', 'done')),
  admin_reply text check (admin_reply is null or length(admin_reply) <= 2000),
  replied_by  text,
  replied_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);
alter table public.feedback enable row level security;
drop policy if exists "users send feedback" on public.feedback;
create policy "users send feedback" on public.feedback
  for insert to authenticated
  with check (user_id = auth.uid() and public.current_email() <> '' and email = public.current_email()
              and not public.is_blocked() and status = 'new' and admin_reply is null
              and replied_by is null and replied_at is null);
drop policy if exists "users read own feedback" on public.feedback;
create policy "users read own feedback" on public.feedback
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admins answer feedback" on public.feedback;
create policy "admins answer feedback" on public.feedback
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete feedback" on public.feedback;
create policy "admins delete feedback" on public.feedback
  for delete to authenticated using (public.is_admin());

-- At most 10 messages a day per person.
create or replace function public.feedback_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.feedback f
       where f.user_id = new.user_id and f.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_feedback' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists feedback_guard on public.feedback;
create trigger feedback_guard before insert on public.feedback
  for each row execute function public.feedback_guard();

-- ---------------------------------------------------------------
-- "My account": people can see their own reading sessions
-- ---------------------------------------------------------------
drop policy if exists "users read own sessions" on public.view_sessions;
create policy "users read own sessions" on public.view_sessions
  for select to authenticated using (email = public.current_email());

-- Change log
drop trigger if exists audit_announcements on public.announcements;
create trigger audit_announcements after insert or update or delete on public.announcements
  for each row execute function public.write_audit();
drop trigger if exists audit_faqs on public.faqs;
create trigger audit_faqs after insert or update or delete on public.faqs
  for each row execute function public.write_audit();
drop trigger if exists audit_feedback on public.feedback;
create trigger audit_feedback after update or delete on public.feedback
  for each row execute function public.write_audit();
