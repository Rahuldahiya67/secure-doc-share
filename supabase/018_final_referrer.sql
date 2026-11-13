-- Pro AI Trainers: "Referred by" set by the owner/admin is final for the candidate
-- Run once in Supabase -> SQL Editor AFTER 017_request_onboarding.sql. Safe to run again.
-- When an admin types a referrer on a person's page, the candidate's profile shows it,
-- their payment form uses it, and they can no longer change it themselves.

alter table public.people add column if not exists referred_by_name text
  check (referred_by_name is null or length(trim(referred_by_name)) between 1 and 120);

-- The candidate can read (not change) the referrer set for them.
create or replace function public.my_referrer()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.referred_by_name from public.people p
   where p.email = public.current_email() and public.current_email() <> '';
$$;
revoke all on function public.my_referrer() from public, anon;
grant execute on function public.my_referrer() to authenticated;

-- Whatever the candidate types, a referrer set by an admin wins.
create or replace function public.profile_final_referrer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare fin text;
begin
  select p.referred_by_name into fin from public.people p where p.email = new.email;
  if fin is not null then new.referred_by := fin; end if;
  return new;
end;
$$;
drop trigger if exists profile_final_referrer on public.candidate_profiles;
create trigger profile_final_referrer before insert or update on public.candidate_profiles
  for each row execute function public.profile_final_referrer();

-- Setting it on the person's page updates their profile straight away.
create or replace function public.people_push_referrer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.referred_by_name is not null and new.referred_by_name is distinct from old.referred_by_name then
    update public.candidate_profiles set referred_by = new.referred_by_name where email = new.email;
  end if;
  return new;
end;
$$;
drop trigger if exists people_push_referrer on public.people;
create trigger people_push_referrer after insert or update of referred_by_name on public.people
  for each row execute function public.people_push_referrer();

-- Payments: a candidate with a final referrer always submits that name.
create or replace function public.payment_final_referrer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare fin text;
begin
  select p.referred_by_name into fin from public.people p where p.email = new.email;
  if fin is not null then new.referred_by := fin; end if;
  return new;
end;
$$;
drop trigger if exists payment_final_referrer on public.payment_submissions;
create trigger payment_final_referrer before insert on public.payment_submissions
  for each row execute function public.payment_final_referrer();
