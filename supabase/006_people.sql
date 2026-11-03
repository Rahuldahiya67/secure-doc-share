-- secure-doc-share: people profiles, tags and notes, groups, access requests
-- Run once in Supabase -> SQL Editor AFTER 005_payments_v2.sql.

-- ---------------------------------------------------------------
-- Private profile details admins keep about each person
-- ---------------------------------------------------------------
create table if not exists public.people (
  email             text primary key check (email = lower(email)),
  display_name      text check (display_name is null or length(display_name) <= 120),
  referred_by_email text check (referred_by_email is null or referred_by_email = lower(referred_by_email)),
  tags              text[] not null default '{}',
  notes             text check (notes is null or length(notes) <= 5000),
  updated_at        timestamptz not null default now(),
  check (referred_by_email is distinct from email)
);
alter table public.people enable row level security;
drop policy if exists "admins manage people" on public.people;
create policy "admins manage people" on public.people
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------
-- Groups: share documents with a whole group; members get access automatically
-- ---------------------------------------------------------------
create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  created_at  timestamptz not null default now()
);
create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  email    text not null check (email = lower(email)),
  added_at timestamptz not null default now(),
  primary key (group_id, email)
);
create index if not exists group_members_email_idx on public.group_members (email);
create table if not exists public.group_documents (
  group_id    uuid not null references public.groups(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (group_id, document_id)
);

alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.group_documents enable row level security;
drop policy if exists "admins manage groups" on public.groups;
create policy "admins manage groups" on public.groups
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins manage group members" on public.group_members;
create policy "admins manage group members" on public.group_members
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins manage group documents" on public.group_documents;
create policy "admins manage group documents" on public.group_documents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Access now comes from the document's own list OR any group the person is in.
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
       select 1 from public.documents d
        where d.id = doc
          and d.is_active
          and (d.expires_at is null or d.expires_at > now())
          and (
            exists (select 1 from public.document_access a where a.document_id = d.id and a.email = public.current_email())
            or exists (select 1 from public.group_documents gd
                         join public.group_members gm on gm.group_id = gd.group_id
                        where gd.document_id = d.id and gm.email = public.current_email())
          )
     );
$$;

-- ---------------------------------------------------------------
-- Access requests from people who signed in but have nothing shared yet
-- ---------------------------------------------------------------
create table if not exists public.access_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  email      text not null default public.current_email(),
  name       text not null check (length(trim(name)) between 1 and 120),
  message    text check (message is null or length(message) <= 500),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists access_requests_one_pending on public.access_requests (email) where status = 'pending';
alter table public.access_requests enable row level security;

drop policy if exists "users request access" on public.access_requests;
create policy "users request access" on public.access_requests
  for insert to authenticated
  with check (
    user_id = auth.uid() and public.current_email() <> '' and email = public.current_email()
    and not public.is_blocked() and status = 'pending' and decided_by is null and decided_at is null
  );
drop policy if exists "users read own requests" on public.access_requests;
create policy "users read own requests" on public.access_requests
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admins decide requests" on public.access_requests;
create policy "admins decide requests" on public.access_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete requests" on public.access_requests;
create policy "admins delete requests" on public.access_requests
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- Change log now also covers people, groups, document access, documents and the blocklist
-- ---------------------------------------------------------------
drop trigger if exists audit_people on public.people;
create trigger audit_people after insert or update or delete on public.people
  for each row execute function public.write_audit();
drop trigger if exists audit_groups on public.groups;
create trigger audit_groups after insert or update or delete on public.groups
  for each row execute function public.write_audit();
drop trigger if exists audit_group_members on public.group_members;
create trigger audit_group_members after insert or delete on public.group_members
  for each row execute function public.write_audit();
drop trigger if exists audit_group_documents on public.group_documents;
create trigger audit_group_documents after insert or delete on public.group_documents
  for each row execute function public.write_audit();
drop trigger if exists audit_document_access on public.document_access;
create trigger audit_document_access after insert or delete on public.document_access
  for each row execute function public.write_audit();
drop trigger if exists audit_documents on public.documents;
create trigger audit_documents after insert or update or delete on public.documents
  for each row execute function public.write_audit();
drop trigger if exists audit_blocked on public.blocked_emails;
create trigger audit_blocked after insert or delete on public.blocked_emails
  for each row execute function public.write_audit();
drop trigger if exists audit_access_requests on public.access_requests;
create trigger audit_access_requests after update or delete on public.access_requests
  for each row execute function public.write_audit();
