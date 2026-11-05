-- Pro AI Trainers: candidate profiles, and names in the Google Sheet
-- Run once in Supabase -> SQL Editor AFTER 011_sheet_export.sql.

-- ---------------------------------------------------------------
-- 1. Each person's own profile, filled in from "My account" in the app
-- ---------------------------------------------------------------
create table if not exists public.candidate_profiles (
  user_id     uuid primary key default auth.uid(),
  email       text not null default public.current_email(),
  full_name   text not null check (length(trim(full_name)) between 1 and 120),
  phone       text not null check (phone ~ '^\+?[0-9][0-9 -]{8,16}[0-9]$'),
  outlier_id  text not null check (length(trim(outlier_id)) between 1 and 120),
  referred_by text check (referred_by is null or length(referred_by) <= 120),
  updated_at  timestamptz not null default now()
);
create index if not exists candidate_profiles_email_idx on public.candidate_profiles (email);
alter table public.candidate_profiles enable row level security;

drop policy if exists "read own profile" on public.candidate_profiles;
create policy "read own profile" on public.candidate_profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "create own profile" on public.candidate_profiles;
create policy "create own profile" on public.candidate_profiles for insert to authenticated
  with check (user_id = auth.uid() and email = public.current_email() and public.current_email() <> '' and not public.is_blocked());
drop policy if exists "update own profile" on public.candidate_profiles;
create policy "update own profile" on public.candidate_profiles for update to authenticated
  using (user_id = auth.uid() or public.is_editor())
  with check ((user_id = auth.uid() and email = public.current_email()) or public.is_editor());
drop policy if exists "editors delete profiles" on public.candidate_profiles;
create policy "editors delete profiles" on public.candidate_profiles for delete to authenticated using (public.is_editor());

drop trigger if exists audit_candidate_profiles on public.candidate_profiles;
create trigger audit_candidate_profiles after update or delete on public.candidate_profiles
  for each row execute function public.write_audit();

-- ---------------------------------------------------------------
-- 2. Google Sheet: names per day, and a full payments list
-- ---------------------------------------------------------------
create or replace function public.sheet_token_ok(token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(length(token), 0) >= 32 and exists (
    select 1 from public.app_settings s
     where s.key = 'sheet_token' and s.value ->> 'hash' = encode(sha256(convert_to(token, 'UTF8')), 'hex'));
$$;
revoke all on function public.sheet_token_ok(text) from public;

drop function if exists public.payments_by_day(text, int);
create or replace function public.payments_by_day(token text, days int default 180)
returns table (
  day date, week_ending date, people int, submissions int, earned numeric, paid numeric,
  verified int, pending int, rejected int, who_paid text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare pay_day int;
begin
  if not public.sheet_token_ok(token) then raise exception 'bad_token' using errcode = '42501'; end if;
  select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = 'payment_day'), 3) into pay_day;
  return query
  with p as (
    select (ps.created_at at time zone 'Asia/Kolkata')::date as d, ps.*
      from public.payment_submissions ps
     where ps.created_at > now() - make_interval(days => least(greatest(coalesce(days, 180), 1), 1000))
  )
  select p.d,
         p.d + ((pay_day - extract(dow from p.d)::int + 7) % 7),
         count(distinct p.email) filter (where p.status <> 'rejected')::int,
         count(*)::int,
         coalesce(sum(p.amount_earned) filter (where p.status <> 'rejected'), 0),
         coalesce(sum(p.amount_sent)   filter (where p.status <> 'rejected'), 0),
         count(*) filter (where p.status = 'verified')::int,
         count(*) filter (where p.status = 'pending')::int,
         count(*) filter (where p.status = 'rejected')::int,
         string_agg(distinct p.name, ', ') filter (where p.status <> 'rejected')
    from p
   group by p.d
   order by p.d desc;
end;
$$;

create or replace function public.payments_list(token text, days int default 180)
returns table (
  submitted_at timestamp, payout_date date, week_ending date, name text, email text, phone text,
  outlier_id text, referred_by text, earned numeric, paid numeric, percent numeric,
  paid_via text, utr text, status text, reviewed_by text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare pay_day int;
begin
  if not public.sheet_token_ok(token) then raise exception 'bad_token' using errcode = '42501'; end if;
  select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = 'payment_day'), 3) into pay_day;
  return query
  select (ps.created_at at time zone 'Asia/Kolkata'),
         ps.payout_date,
         (ps.created_at at time zone 'Asia/Kolkata')::date
           + ((pay_day - extract(dow from (ps.created_at at time zone 'Asia/Kolkata'))::int + 7) % 7),
         ps.name, ps.email, cp.phone, ps.outlier_id, ps.referred_by,
         ps.amount_earned, ps.amount_sent,
         case when ps.amount_earned > 0 then round(100 * ps.amount_sent / ps.amount_earned, 1) end,
         ps.paid_via, ps.utr, ps.status, ps.reviewed_by
    from public.payment_submissions ps
    left join public.candidate_profiles cp on cp.user_id = ps.user_id
   where ps.created_at > now() - make_interval(days => least(greatest(coalesce(days, 180), 1), 1000))
   order by ps.created_at desc;
end;
$$;

revoke all on function public.payments_by_day(text, int) from public;
revoke all on function public.payments_list(text, int) from public;
grant execute on function public.payments_by_day(text, int) to anon, authenticated;
grant execute on function public.payments_list(text, int) to anon, authenticated;
