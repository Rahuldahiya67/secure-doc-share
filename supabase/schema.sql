-- secure-doc-share: database + storage setup for Supabase
-- Run this once in Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Then run the last statement (admins insert) with YOUR email.

-- ---------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------

-- Email of the signed-in user, only if that email has been verified
-- (Google sign-in or a clicked magic link). Unverified accounts get ''.
create or replace function public.current_email()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (select lower(u.email)
       from auth.users u
      where u.id = auth.uid()
        and u.email_confirmed_at is not null),
    '');
$$;

create table if not exists public.admins (
  email text primary key check (email = lower(email))
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.email = public.current_email()
                   and public.current_email() <> '');
$$;

-- ---------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  storage_path text not null unique,
  page_count   int,
  is_active    boolean not null default true,
  expires_at   timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

create table if not exists public.document_access (
  document_id uuid not null references public.documents(id) on delete cascade,
  email       text not null check (email = lower(email)),
  added_at    timestamptz not null default now(),
  primary key (document_id, email)
);

create table if not exists public.view_logs (
  id          bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  email       text not null default public.current_email(),
  user_agent  text,
  viewed_at   timestamptz not null default now()
);

create index if not exists view_logs_doc_idx on public.view_logs (document_id, viewed_at desc);

-- Can the signed-in user open this document right now?
create or replace function public.can_view(doc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> '' and exists (
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
-- Row level security
-- ---------------------------------------------------------------

alter table public.admins          enable row level security;
alter table public.documents       enable row level security;
alter table public.document_access enable row level security;
alter table public.view_logs       enable row level security;

drop policy if exists "admins read admins" on public.admins;
create policy "admins read admins" on public.admins
  for select to authenticated using (public.is_admin());

drop policy if exists "admins manage documents" on public.documents;
create policy "admins manage documents" on public.documents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "allowed viewers read documents" on public.documents;
create policy "allowed viewers read documents" on public.documents
  for select to authenticated using (public.can_view(id));

drop policy if exists "admins manage access" on public.document_access;
create policy "admins manage access" on public.document_access
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "viewers log own views" on public.view_logs;
create policy "viewers log own views" on public.view_logs
  for insert to authenticated
  with check (public.can_view(document_id) and email = public.current_email());

drop policy if exists "admins read logs" on public.view_logs;
create policy "admins read logs" on public.view_logs
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- Private storage bucket (PDF only, 50 MB max)
-- ---------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "admins manage files" on storage.objects;
create policy "admins manage files" on storage.objects
  for all to authenticated
  using (bucket_id = 'documents' and public.is_admin())
  with check (bucket_id = 'documents' and public.is_admin());

drop policy if exists "allowed viewers read files" on storage.objects;
create policy "allowed viewers read files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.documents d
       where d.storage_path = storage.objects.name
         and public.can_view(d.id)
    )
  );

grant execute on function public.is_admin()     to authenticated;
grant execute on function public.can_view(uuid) to authenticated;

-- ---------------------------------------------------------------
-- Make yourself the admin (replace with your own email, lowercase)
-- ---------------------------------------------------------------
-- insert into public.admins (email) values ('you@gmail.com') on conflict do nothing;
