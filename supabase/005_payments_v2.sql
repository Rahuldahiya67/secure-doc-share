-- secure-doc-share: payments v2 — where to pay, UTR, payout date, flags
-- Run once in Supabase -> SQL Editor AFTER 004_payments.sql.

-- ---------------------------------------------------------------
-- Accounts people pay to (managed by admins, shown in the app)
-- ---------------------------------------------------------------
create table if not exists public.payment_accounts (
  id           uuid primary key default gen_random_uuid(),
  label        text not null check (length(trim(label)) between 1 and 60),
  upi_id       text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,128}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  payee_name   text not null check (length(trim(payee_name)) between 1 and 80),
  qr_path      text,
  instructions text check (instructions is null or length(instructions) <= 400),
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  check (upi_id is not null or qr_path is not null)
);
alter table public.payment_accounts enable row level security;

drop policy if exists "signed-in users read active accounts" on public.payment_accounts;
create policy "signed-in users read active accounts" on public.payment_accounts
  for select to authenticated using ((is_active and public.current_email() <> '') or public.is_admin());

drop policy if exists "admins manage accounts" on public.payment_accounts;
create policy "admins manage accounts" on public.payment_accounts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- QR images: readable by signed-in users, managed by admins.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-qr', 'payment-qr', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "signed-in users read qr" on storage.objects;
create policy "signed-in users read qr" on storage.objects
  for select to authenticated using (bucket_id = 'payment-qr' and public.current_email() <> '');

drop policy if exists "admins manage qr" on storage.objects;
create policy "admins manage qr" on storage.objects
  for all to authenticated
  using (bucket_id = 'payment-qr' and public.is_admin())
  with check (bucket_id = 'payment-qr' and public.is_admin());

-- ---------------------------------------------------------------
-- Admin-only settings (e.g. the expected share of earnings)
-- ---------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "admins manage settings" on public.app_settings;
create policy "admins manage settings" on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into public.app_settings (key, value) values ('expected_percent', '10'::jsonb) on conflict (key) do nothing;

-- ---------------------------------------------------------------
-- New submission fields
-- ---------------------------------------------------------------
alter table public.payment_submissions
  add column if not exists payout_date   date,
  add column if not exists utr           text check (utr is null or utr ~ '^[A-Za-z0-9]{6,35}$'),
  add column if not exists paid_via      text check (paid_via is null or paid_via in ('gpay', 'phonepe', 'paytm', 'upi', 'qr', 'bank', 'other')),
  add column if not exists account_id    uuid references public.payment_accounts(id) on delete set null,
  add column if not exists payment_path  text,
  add column if not exists earnings_hash text,
  add column if not exists referral_hash text,
  add column if not exists payment_hash  text;

-- Share of earnings sent, worked out by the database.
alter table public.payment_submissions
  add column if not exists percent_sent numeric(7, 2)
  generated always as (case when amount_earned > 0 then round(amount_sent * 100 / amount_earned, 2) end) stored;

create index if not exists payment_submissions_utr_idx on public.payment_submissions (utr);

-- Re-create the submit rule so the new optional screenshot must also be in the person's own folder.
drop policy if exists "users submit payments" on public.payment_submissions;
create policy "users submit payments" on public.payment_submissions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.current_email() <> ''
    and email = public.current_email()
    and not public.is_blocked()
    and status = 'pending' and admin_note is null and reviewed_by is null and reviewed_at is null
    and split_part(earnings_path, '/', 1) = auth.uid()::text
    and split_part(referral_path, '/', 1) = auth.uid()::text
    and (payment_path is null or split_part(payment_path, '/', 1) = auth.uid()::text)
  );

-- ===============================================================
-- Security hardening
-- ===============================================================

-- Owner role: only owners can change where money goes.
alter table public.admins add column if not exists role text not null default 'admin';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'admins_role_check') then
    alter table public.admins add constraint admins_role_check check (role in ('owner', 'admin'));
  end if;
end $$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> '' and exists (
    select 1 from public.admins a where a.email = public.current_email() and a.role = 'owner');
$$;
grant execute on function public.is_owner() to authenticated;

drop policy if exists "admins manage accounts" on public.payment_accounts;
drop policy if exists "owners manage accounts" on public.payment_accounts;
create policy "owners manage accounts" on public.payment_accounts
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "admins manage qr" on storage.objects;
drop policy if exists "owners manage qr" on storage.objects;
create policy "owners manage qr" on storage.objects
  for all to authenticated
  using (bucket_id = 'payment-qr' and public.is_owner())
  with check (bucket_id = 'payment-qr' and public.is_owner());

drop policy if exists "admins manage settings" on public.app_settings;
drop policy if exists "admins read settings" on public.app_settings;
drop policy if exists "owners change settings" on public.app_settings;
create policy "admins read settings" on public.app_settings
  for select to authenticated using (public.is_admin());
create policy "owners change settings" on public.app_settings
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Amount limits (₹10 lakh).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_amount_cap') then
    alter table public.payment_submissions
      add constraint payment_amount_cap check (amount_earned <= 1000000 and amount_sent <= 1000000);
  end if;
end $$;

-- Checks on every new submission: tidy the UTR, refuse a reused UTR, limit to 10 a day.
create or replace function public.payment_submission_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.utr is not null then
    new.utr := upper(new.utr);
    if exists (select 1 from public.payment_submissions p
                where p.utr = new.utr and p.status <> 'rejected') then
      raise exception 'utr_used' using errcode = '23505';
    end if;
  end if;
  if (select count(*) from public.payment_submissions p
       where p.user_id = new.user_id and p.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_submissions' using errcode = '54000';
  end if;
  return new;
end;
$$;
drop trigger if exists payment_submission_guard on public.payment_submissions;
create trigger payment_submission_guard before insert on public.payment_submissions
  for each row execute function public.payment_submission_guard();

-- Reviews can change status and notes only. Who submitted can never change, and
-- once verified the amounts, UTR and screenshots are locked.
create or replace function public.payment_review_guard()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at then
    raise exception 'submitter_locked';
  end if;
  if old.status = 'verified' and (
       new.amount_earned is distinct from old.amount_earned or new.amount_sent is distinct from old.amount_sent
    or new.utr is distinct from old.utr or new.earnings_path is distinct from old.earnings_path
    or new.referral_path is distinct from old.referral_path or new.payment_path is distinct from old.payment_path) then
    raise exception 'verified_locked';
  end if;
  return new;
end;
$$;
drop trigger if exists payment_review_guard on public.payment_submissions;
create trigger payment_review_guard before update on public.payment_submissions
  for each row execute function public.payment_review_guard();

-- ---------------------------------------------------------------
-- Change log: written by the database itself, readable by admins, never editable.
-- ---------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  action     text not null,
  table_name text not null,
  row_id     text,
  old_data   jsonb,
  new_data   jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
alter table public.audit_log enable row level security;
drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log" on public.audit_log
  for select to authenticated using (public.is_admin());
revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;

create or replace function public.write_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text := coalesce(nullif(public.current_email(), ''), 'database (SQL editor)');
  rid   text;
begin
  rid := coalesce(
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'id',
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'email',
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'key');
  insert into public.audit_log (actor, action, table_name, row_id, old_data, new_data)
  values (actor, lower(tg_op), tg_table_name, rid,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_payment_accounts on public.payment_accounts;
create trigger audit_payment_accounts after insert or update or delete on public.payment_accounts
  for each row execute function public.write_audit();
drop trigger if exists audit_payment_reviews on public.payment_submissions;
create trigger audit_payment_reviews after update or delete on public.payment_submissions
  for each row execute function public.write_audit();
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings after insert or update or delete on public.app_settings
  for each row execute function public.write_audit();
drop trigger if exists audit_admins on public.admins;
create trigger audit_admins after insert or update or delete on public.admins
  for each row execute function public.write_audit();

-- ---------------------------------------------------------------
-- Make yourself the owner (run with your own email):
-- update public.admins set role = 'owner' where email = 'you@gmail.com';
-- ---------------------------------------------------------------
