-- Pro AI Trainers: Google Sheet as one tab - who paid what
-- Run once in Supabase -> SQL Editor AFTER 013_sheet_names_only.sql.

drop function if exists public.payments_list(text, int);
create or replace function public.payments_list(token text, days int default 365)
returns table (submitted_at timestamp, name text, email text, paid numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.sheet_token_ok(token) then raise exception 'bad_token' using errcode = '42501'; end if;
  return query
  select (ps.created_at at time zone 'Asia/Kolkata'), ps.name, ps.email, ps.amount_sent
    from public.payment_submissions ps
   where ps.status <> 'rejected'
     and ps.created_at > now() - make_interval(days => least(greatest(coalesce(days, 365), 1), 1000))
   order by ps.created_at desc;
end;
$$;
revoke all on function public.payments_list(text, int) from public;
grant execute on function public.payments_list(text, int) to anon, authenticated;
