-- Pro AI Trainers: Google Sheet as one tab, one row per payment (payment details only)
-- Run in Supabase -> SQL Editor AFTER 013_sheet_names_only.sql.
-- Safe to run again.
-- Screenshots stay private: the sheet gets the payment's ID, which the script turns
-- into a "View screenshots" link to the admin dashboard (sign-in required).

drop function if exists public.payments_list(text, int);
create or replace function public.payments_list(token text, days int default 365)
returns table (
  id uuid, submitted_at timestamp, name text, email text, earned numeric, paid numeric,
  percent numeric, paid_via text, utr text, status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.sheet_token_ok(token) then raise exception 'bad_token' using errcode = '42501'; end if;
  return query
  select ps.id,
         (ps.created_at at time zone 'Asia/Kolkata'),
         ps.name, ps.email, ps.amount_earned, ps.amount_sent,
         case when ps.amount_earned > 0 then round(100 * ps.amount_sent / ps.amount_earned, 1) end,
         ps.paid_via, ps.utr, ps.status
    from public.payment_submissions ps
   where ps.created_at > now() - make_interval(days => least(greatest(coalesce(days, 365), 1), 1000))
   order by ps.created_at desc;
end;
$$;
revoke all on function public.payments_list(text, int) from public;
grant execute on function public.payments_list(text, int) to anon, authenticated;
