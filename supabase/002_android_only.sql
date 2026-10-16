-- secure-doc-share: Android-app-only viewing
-- Run this once in Supabase -> SQL Editor AFTER schema.sql.
-- Then run the app_secrets insert (bottom) with the hash you were given.
--
-- How it works: viewers can no longer read a file just because their email is
-- on the list. They must first call start_view() with the app key that only the
-- Android app carries. That creates a 2-minute grant, and only a grant lets the
-- storage bucket hand out the file. Browsers don't have the key, so they get
-- refused by the database itself.

create table if not exists public.app_secrets (
  id           int primary key default 1 check (id = 1),
  app_key_hash text not null
);
alter table public.app_secrets enable row level security;   -- no policies: unreadable via the API

create table if not exists public.view_grants (
  user_id     uuid not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  expires_at  timestamptz not null,
  primary key (user_id, document_id)
);
alter table public.view_grants enable row level security;   -- no policies: only definer functions touch it

alter table public.view_logs add column if not exists platform text;

-- Called by the Android app before it downloads a document.
create or replace function public.start_view(doc uuid, app_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p text;
begin
  if not public.can_view(doc) then
    raise exception 'no_access' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.app_secrets s
     where s.app_key_hash = encode(sha256(convert_to(coalesce(app_key, ''), 'UTF8')), 'hex')
  ) then
    raise exception 'app_required' using errcode = '42501';
  end if;

  insert into public.view_grants (user_id, document_id, expires_at)
  values (auth.uid(), doc, now() + interval '2 minutes')
  on conflict (user_id, document_id) do update set expires_at = excluded.expires_at;

  insert into public.view_logs (document_id, email, user_agent, platform)
  values (doc, public.current_email(), 'Secure Doc Share Android app', 'android-app');

  select d.storage_path into p from public.documents d where d.id = doc;
  return p;
end;
$$;

-- Does the signed-in user hold a live grant for this storage file?
create or replace function public.has_view_grant(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.view_grants g
      join public.documents d on d.id = g.document_id
     where d.storage_path = object_name
       and g.user_id = auth.uid()
       and g.expires_at > now()
       and public.can_view(d.id)
  );
$$;

revoke all on function public.start_view(uuid, text)  from public, anon;
revoke all on function public.has_view_grant(text)    from public, anon;
grant execute on function public.start_view(uuid, text) to authenticated;
grant execute on function public.has_view_grant(text)   to authenticated;

-- Replace the old "email on list = can download" storage rule.
drop policy if exists "allowed viewers read files" on storage.objects;
drop policy if exists "granted viewers read files" on storage.objects;
create policy "granted viewers read files" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and public.has_view_grant(storage.objects.name));

-- ---------------------------------------------------------------
-- Store the app key hash (replace with the hash you were given)
-- ---------------------------------------------------------------
-- insert into public.app_secrets (id, app_key_hash) values (1, 'PASTE_HASH_HERE')
-- on conflict (id) do update set app_key_hash = excluded.app_key_hash;
