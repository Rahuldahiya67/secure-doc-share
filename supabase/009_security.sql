-- secure-doc-share: view-only admins, one-phone lock, near-duplicate screenshots
-- Run once in Supabase -> SQL Editor AFTER 008_portal.sql.
-- If you ever re-run 004 to 008, run this file again afterwards.

-- ---------------------------------------------------------------
-- 1. Roles: owner, admin (can change things), viewer (can only look)
-- ---------------------------------------------------------------
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('owner', 'admin', 'viewer'));

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> '' and exists (
    select 1 from public.admins a where a.email = public.current_email() and a.role in ('owner', 'admin')
  );
$$;
grant execute on function public.is_editor() to authenticated;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.role from public.admins a where a.email = public.current_email() and public.current_email() <> '';
$$;
grant execute on function public.my_role() to authenticated;

-- Every write rule that said "any admin" now says "owner or admin".
-- Reading stays open to all three roles.
do $$
declare
  r record;
  q text;
  c text;
  op text;
begin
  for r in
    select p.schemaname, p.tablename, p.policyname, p.cmd as pcmd, p.qual, p.with_check
      from pg_policies p
     where p.schemaname in ('public', 'storage')
       and p.cmd <> 'SELECT'
       and (coalesce(p.qual, '') ~ 'is_admin\(\)' or coalesce(p.with_check, '') ~ 'is_admin\(\)')
  loop
    q := regexp_replace(r.qual, '(public\.)?is_admin\(\)', 'public.is_editor()', 'g');
    c := regexp_replace(r.with_check, '(public\.)?is_admin\(\)', 'public.is_editor()', 'g');
    if r.pcmd = 'ALL' then
      -- Split into a read rule (unchanged) and write rules (editors only).
      execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
      execute format('create policy %I on %I.%I for select to authenticated using (%s)',
                     left(r.policyname || ' (read)', 63), r.schemaname, r.tablename, r.qual);
      foreach op in array array['insert', 'update', 'delete'] loop
        if op = 'insert' then
          execute format('create policy %I on %I.%I for insert to authenticated with check (%s)',
                         left(r.policyname || ' (insert)', 63), r.schemaname, r.tablename, coalesce(c, q));
        elsif op = 'update' then
          execute format('create policy %I on %I.%I for update to authenticated using (%s) with check (%s)',
                         left(r.policyname || ' (update)', 63), r.schemaname, r.tablename, q, coalesce(c, q));
        else
          execute format('create policy %I on %I.%I for delete to authenticated using (%s)',
                         left(r.policyname || ' (delete)', 63), r.schemaname, r.tablename, q);
        end if;
      end loop;
    else
      if r.qual is not null then
        execute format('alter policy %I on %I.%I using (%s)', r.policyname, r.schemaname, r.tablename, q);
      end if;
      if r.with_check is not null then
        execute format('alter policy %I on %I.%I with check (%s)', r.policyname, r.schemaname, r.tablename, c);
      end if;
    end if;
  end loop;
end $$;

-- The owner manages the admin list from the dashboard.
drop policy if exists "owner adds admins" on public.admins;
create policy "owner adds admins" on public.admins for insert to authenticated with check (public.is_owner());
drop policy if exists "owner changes admins" on public.admins;
create policy "owner changes admins" on public.admins for update to authenticated using (public.is_owner()) with check (public.is_owner());
drop policy if exists "owner removes admins" on public.admins;
create policy "owner removes admins" on public.admins for delete to authenticated using (public.is_owner());

-- Never leave the site without an owner, and nobody changes their own role.
create or replace function public.admins_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.email = public.current_email() then
    if tg_op = 'DELETE' or new.role is distinct from old.role then
      raise exception 'cannot_change_self' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.email := lower(trim(new.email));
    if new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and (select count(*) from public.admins where role = 'owner') <= 1 then
    raise exception 'last_owner' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists admins_guard on public.admins;
create trigger admins_guard before insert or update or delete on public.admins
  for each row execute function public.admins_guard();

-- ---------------------------------------------------------------
-- 2. One-phone lock: each person reads on one phone; a new phone needs approval.
-- ---------------------------------------------------------------
create table if not exists public.device_locks (
  email        text primary key check (email = lower(email)),
  device_id    text not null check (length(device_id) between 1 and 200),
  device_label text check (device_label is null or length(device_label) <= 120),
  locked_at    timestamptz not null default now()
);
create table if not exists public.device_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  email        text not null,
  device_id    text not null check (length(device_id) between 1 and 200),
  device_label text check (device_label is null or length(device_label) <= 120),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists device_requests_one_pending on public.device_requests (email) where status = 'pending';
alter table public.device_locks enable row level security;
alter table public.device_requests enable row level security;
drop policy if exists "admins read device locks" on public.device_locks;
create policy "admins read device locks" on public.device_locks for select to authenticated using (public.is_admin());
drop policy if exists "editors change device locks" on public.device_locks;
create policy "editors change device locks" on public.device_locks for all to authenticated
  using (public.is_editor()) with check (public.is_editor());
drop policy if exists "read device requests" on public.device_requests;
create policy "read device requests" on public.device_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "editors decide device requests" on public.device_requests;
create policy "editors decide device requests" on public.device_requests for update to authenticated
  using (public.is_editor()) with check (public.is_editor());
-- People only create requests through request_device_change() below.

insert into public.app_settings (key, value) values ('device_lock', 'false'::jsonb) on conflict (key) do nothing;

create or replace function public.request_device_change(device text, label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_email() = '' or public.is_blocked() then raise exception 'no_access' using errcode = '42501'; end if;
  if coalesce(device, '') = '' or length(device) > 200 then raise exception 'bad_device'; end if;
  if exists (select 1 from public.device_locks l where l.email = public.current_email() and l.device_id = device) then return; end if;
  insert into public.device_requests (user_id, email, device_id, device_label)
  values (auth.uid(), public.current_email(), device, left(label, 120))
  on conflict (email) where status = 'pending'
  do update set device_id = excluded.device_id, device_label = excluded.device_label, created_at = now();
end;
$$;
revoke all on function public.request_device_change(text, text) from public, anon;
grant execute on function public.request_device_change(text, text) to authenticated;

-- Approving moves the lock to the new phone.
create or replace function public.device_request_decided()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    insert into public.device_locks (email, device_id, device_label, locked_at)
    values (new.email, new.device_id, new.device_label, now())
    on conflict (email) do update set device_id = excluded.device_id, device_label = excluded.device_label, locked_at = now();
  end if;
  return new;
end;
$$;
drop trigger if exists device_request_decided on public.device_requests;
create trigger device_request_decided after update on public.device_requests
  for each row execute function public.device_request_decided();

-- start_view now also takes the phone's ID.
drop function if exists public.start_view(uuid, text);
create or replace function public.start_view(doc uuid, app_key text, device text default null, label text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p text;
  once boolean;
  v public.document_views%rowtype;
  lock_on boolean;
  locked text;
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

  -- One-phone lock (admins are never locked).
  select coalesce((select value = 'true'::jsonb from public.app_settings where key = 'device_lock'), false) into lock_on;
  if lock_on and not public.is_admin() then
    if coalesce(device, '') = '' or length(device) > 200 then
      raise exception 'app_required' using errcode = '42501';
    end if;
    select l.device_id into locked from public.device_locks l where l.email = public.current_email();
    if locked is null then
      insert into public.device_locks (email, device_id, device_label) values (public.current_email(), device, left(label, 120))
      on conflict (email) do nothing;
    elsif locked <> device then
      raise exception 'device_locked' using errcode = '42501';
    end if;
  end if;

  select d.storage_path, d.one_time into p, once from public.documents d where d.id = doc;

  if once then
    insert into public.document_views (document_id, email) values (doc, public.current_email())
      on conflict do nothing;
    select * into v from public.document_views
     where document_id = doc and email = public.current_email() for update;
    if v.last_opened_at is not null and v.last_opened_at > now() - interval '15 minutes' then
      null;
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
  values (doc, public.current_email(), left(coalesce(label, 'Secure Doc Share Android app'), 120), 'android-app');

  return p;
end;
$$;
revoke all on function public.start_view(uuid, text, text, text) from public, anon;
grant execute on function public.start_view(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------
-- 3. Near-duplicate screenshots: a visual fingerprint of each image
-- ---------------------------------------------------------------
alter table public.payment_submissions add column if not exists earnings_phash text check (earnings_phash is null or earnings_phash ~ '^[0-9a-f]{16}$');
alter table public.payment_submissions add column if not exists referral_phash text check (referral_phash is null or referral_phash ~ '^[0-9a-f]{16}$');
alter table public.payment_submissions add column if not exists payment_phash  text check (payment_phash  is null or payment_phash  ~ '^[0-9a-f]{16}$');

-- Change log for the new tables
drop trigger if exists audit_device_locks on public.device_locks;
create trigger audit_device_locks after update or delete on public.device_locks
  for each row execute function public.write_audit();
drop trigger if exists audit_device_requests on public.device_requests;
create trigger audit_device_requests after update or delete on public.device_requests
  for each row execute function public.write_audit();

-- ---------------------------------------------------------------
-- 4. Weekly payment day (3 = Wednesday). Everyone signed in can read it.
-- ---------------------------------------------------------------
insert into public.app_settings (key, value) values ('payment_day', '3'::jsonb) on conflict (key) do nothing;
drop policy if exists "signed-in users read payment day" on public.app_settings;
create policy "signed-in users read payment day" on public.app_settings
  for select to authenticated using (key = 'payment_day' and public.current_email() <> '');
