-- secure-doc-share: folders, one-time view, opening time window
-- Run once in Supabase -> SQL Editor AFTER 006_people.sql.

alter table public.documents add column if not exists folder text
  check (folder is null or length(trim(folder)) between 1 and 60);
alter table public.documents add column if not exists available_from timestamptz;   -- link opens at
alter table public.documents add column if not exists one_time boolean not null default false;

-- How many times each person may open a one-time document, and how many they've used.
create table if not exists public.document_views (
  document_id    uuid not null references public.documents(id) on delete cascade,
  email          text not null check (email = lower(email)),
  used           int  not null default 0 check (used >= 0),
  allowed        int  not null default 1 check (allowed between 0 and 100),
  last_opened_at timestamptz,
  primary key (document_id, email)
);
alter table public.document_views enable row level security;
drop policy if exists "admins manage document views" on public.document_views;
create policy "admins manage document views" on public.document_views
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "users read own document views" on public.document_views;
create policy "users read own document views" on public.document_views
  for select to authenticated using (email = public.current_email());

-- Access also respects the "opens at" time.
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
          and (d.available_from is null or d.available_from <= now())
          and (d.expires_at is null or d.expires_at > now())
          and (
            exists (select 1 from public.document_access a where a.document_id = d.id and a.email = public.current_email())
            or exists (select 1 from public.group_documents gd
                         join public.group_members gm on gm.group_id = gd.group_id
                        where gd.document_id = d.id and gm.email = public.current_email())
          )
     );
$$;

-- Opening a document: one-time documents count each open. Reopening within
-- 15 minutes of a counted open (app closed, phone locked) is free.
create or replace function public.start_view(doc uuid, app_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p text;
  once boolean;
  v public.document_views%rowtype;
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

  select d.storage_path, d.one_time into p, once from public.documents d where d.id = doc;

  if once then
    insert into public.document_views (document_id, email) values (doc, public.current_email())
      on conflict do nothing;
    select * into v from public.document_views
     where document_id = doc and email = public.current_email() for update;
    if v.last_opened_at is not null and v.last_opened_at > now() - interval '15 minutes' then
      null; -- same sitting
    elsif v.used >= v.allowed then
      raise exception 'view_used' using errcode = '42501';
    else
      update public.document_views set used = used + 1, last_opened_at = now()
       where document_id = doc and email = public.current_email();
    end if;
  end if;

  insert into public.view_grants (user_id, document_id, expires_at)
  values (auth.uid(), doc, now() + interval '2 minutes')
  on conflict (user_id, document_id) do update set expires_at = excluded.expires_at;

  insert into public.view_logs (document_id, email, user_agent, platform)
  values (doc, public.current_email(), 'Secure Doc Share Android app', 'android-app');

  return p;
end;
$$;
revoke all on function public.start_view(uuid, text) from public, anon;
grant execute on function public.start_view(uuid, text) to authenticated;

drop trigger if exists audit_document_views on public.document_views;
create trigger audit_document_views after update of allowed or delete on public.document_views
  for each row execute function public.write_audit();
