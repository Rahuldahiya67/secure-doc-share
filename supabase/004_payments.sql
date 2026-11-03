-- secure-doc-share: payment submissions with screenshots
-- Run once in Supabase -> SQL Editor AFTER 003_analytics.sql.
--
-- Anyone signed in with a verified email can submit. They see only their own
-- submissions; admins see and review all of them. Screenshots go to a private
-- bucket, in a folder named after the submitter's user id.

-- Is the signed-in user on the blocklist? (security definer: the blocklist itself is admin-only)
create or replace function public.is_blocked()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.blocked_emails b where b.email = public.current_email());
$$;
grant execute on function public.is_blocked() to authenticated;

create table if not exists public.payment_submissions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid(),
  email          text not null default public.current_email(),
  name           text not null check (length(trim(name)) between 1 and 120),
  outlier_id     text not null check (length(trim(outlier_id)) between 1 and 120),
  referred_by    text check (referred_by is null or length(referred_by) <= 120),
  amount_earned  numeric(12, 2) not null check (amount_earned >= 0),
  amount_sent    numeric(12, 2) not null check (amount_sent >= 0),
  earnings_path  text not null,
  referral_path  text not null,
  status         text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  admin_note     text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists payment_submissions_created_idx on public.payment_submissions (created_at desc);
create index if not exists payment_submissions_email_idx   on public.payment_submissions (email);

alter table public.payment_submissions enable row level security;

-- Submit: only as yourself, verified email, not blocked, files in your own folder, always pending.
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
  );

drop policy if exists "users read own payments" on public.payment_submissions;
create policy "users read own payments" on public.payment_submissions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists "admins review payments" on public.payment_submissions;
create policy "admins review payments" on public.payment_submissions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete payments" on public.payment_submissions;
create policy "admins delete payments" on public.payment_submissions
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- Private bucket for screenshots (images only, 10 MB max)
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "users upload own proofs" on storage.objects;
create policy "users upload own proofs" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and public.current_email() <> ''
    and not public.is_blocked()
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "users read own proofs" on storage.objects;
create policy "users read own proofs" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and (split_part(name, '/', 1) = auth.uid()::text or public.is_admin()));

drop policy if exists "admins delete proofs" on storage.objects;
create policy "admins delete proofs" on storage.objects
  for delete to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());
