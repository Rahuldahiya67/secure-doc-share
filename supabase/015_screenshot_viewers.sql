-- Pro AI Trainers: people who may only look at payment screenshots
-- Run once in Supabase -> SQL Editor AFTER 014_sheet_single_tab.sql.
-- A screenshot viewer signs in with Google and can open payment screenshots from the
-- Google Sheet links. Nothing else: not the dashboard, people, documents or settings.

create table if not exists public.screenshot_viewers (
  email    text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  added_by text not null default public.current_email(),
  added_at timestamptz not null default now()
);
alter table public.screenshot_viewers enable row level security;
drop policy if exists "admins read screenshot viewers" on public.screenshot_viewers;
create policy "admins read screenshot viewers" on public.screenshot_viewers
  for select to authenticated using (public.is_admin());
drop policy if exists "owner adds screenshot viewers" on public.screenshot_viewers;
create policy "owner adds screenshot viewers" on public.screenshot_viewers
  for insert to authenticated with check (public.is_owner());
drop policy if exists "owner removes screenshot viewers" on public.screenshot_viewers;
create policy "owner removes screenshot viewers" on public.screenshot_viewers
  for delete to authenticated using (public.is_owner());

create or replace function public.is_screenshot_viewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> '' and not public.is_blocked()
     and exists (select 1 from public.screenshot_viewers v where v.email = public.current_email());
$$;
grant execute on function public.is_screenshot_viewer() to authenticated;

-- The three screenshots of one payment (file paths only), for admins and screenshot viewers.
create or replace function public.payment_screenshots(pid uuid)
returns table (name text, submitted_at timestamptz, earnings_path text, referral_path text, payment_path text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_screenshot_viewer()) then
    raise exception 'no_access' using errcode = '42501';
  end if;
  return query
  select ps.name, ps.created_at, ps.earnings_path, ps.referral_path, ps.payment_path
    from public.payment_submissions ps where ps.id = pid;
end;
$$;
revoke all on function public.payment_screenshots(uuid) from public, anon;
grant execute on function public.payment_screenshots(uuid) to authenticated;

-- Screenshot viewers may open (not upload, change or delete) payment screenshots.
drop policy if exists "screenshot viewers read proofs" on storage.objects;
create policy "screenshot viewers read proofs" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and public.is_screenshot_viewer());

drop trigger if exists audit_screenshot_viewers on public.screenshot_viewers;
create trigger audit_screenshot_viewers after insert or delete on public.screenshot_viewers
  for each row execute function public.write_audit();
