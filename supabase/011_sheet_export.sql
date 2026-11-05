-- Pro AI Trainers: day-by-day payment summary for a Google Sheet
-- Run once in Supabase -> SQL Editor AFTER 010_quizzes.sql.
--
-- The owner creates a secret sheet key in the dashboard (Payments -> Settings ->
-- Google Sheet). Only its SHA-256 fingerprint is stored here. A script in the
-- owner's sheet sends the key and gets back totals per day: no names, emails,
-- UTRs or screenshots ever leave through this.

create or replace function public.payments_by_day(token text, days int default 180)
returns table (
  day          date,
  week_ending  date,
  people       int,
  submissions  int,
  earned       numeric,
  paid         numeric,
  verified     int,
  pending      int,
  rejected     int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  want text;
  pay_day int;
begin
  select s.value ->> 'hash' into want from public.app_settings s where s.key = 'sheet_token';
  if want is null or coalesce(length(token), 0) < 32
     or encode(sha256(convert_to(token, 'UTF8')), 'hex') <> want then
    raise exception 'bad_token' using errcode = '42501';
  end if;
  select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = 'payment_day'), 3) into pay_day;

  return query
  with p as (
    select (ps.created_at at time zone 'Asia/Kolkata')::date as d, ps.*
      from public.payment_submissions ps
     where ps.created_at > now() - make_interval(days => least(greatest(coalesce(days, 180), 1), 1000))
  )
  select p.d,
         -- each week runs up to the payment day (Wednesday by default)
         p.d + ((pay_day - extract(dow from p.d)::int + 7) % 7),
         count(distinct p.email) filter (where p.status <> 'rejected')::int,
         count(*)::int,
         coalesce(sum(p.amount_earned) filter (where p.status <> 'rejected'), 0),
         coalesce(sum(p.amount_sent)   filter (where p.status <> 'rejected'), 0),
         count(*) filter (where p.status = 'verified')::int,
         count(*) filter (where p.status = 'pending')::int,
         count(*) filter (where p.status = 'rejected')::int
    from p
   group by p.d
   order by p.d desc;
end;
$$;

revoke all on function public.payments_by_day(text, int) from public;
grant execute on function public.payments_by_day(text, int) to anon, authenticated;
