-- secure-doc-share: quizzes
-- Run once in Supabase -> SQL Editor AFTER 009_security.sql.
-- Correct answers never leave the database: people get questions through
-- get_quiz() and are marked by submit_quiz().

create table if not exists public.quizzes (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(trim(title)) between 1 and 150),
  description  text check (description is null or length(description) <= 1000),
  document_id  uuid references public.documents(id) on delete set null,  -- only people who can open this document
  pass_percent int  not null default 60 check (pass_percent between 0 and 100),
  one_attempt  boolean not null default false,
  show_answers boolean not null default true,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create table if not exists public.quiz_questions (
  id         uuid primary key default gen_random_uuid(),
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  prompt     text not null check (length(trim(prompt)) between 1 and 1000),
  options    text[] not null check (array_length(options, 1) between 2 and 6),
  correct    int  not null check (correct >= 0 and correct < 6),
  explanation text check (explanation is null or length(explanation) <= 1000),
  sort_order int  not null default 0,
  check (correct < array_length(options, 1))
);
create index if not exists quiz_questions_quiz_idx on public.quiz_questions (quiz_id, sort_order);
create table if not exists public.quiz_attempts (
  id         uuid primary key default gen_random_uuid(),
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  user_id    uuid not null,
  email      text not null,
  answers    jsonb not null,
  score      int not null,
  total      int not null,
  passed     boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists quiz_attempts_quiz_idx on public.quiz_attempts (quiz_id, created_at desc);

alter table public.quizzes        enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts  enable row level security;

drop policy if exists "admins read quizzes" on public.quizzes;
create policy "admins read quizzes" on public.quizzes for select to authenticated using (public.is_admin());
drop policy if exists "editors manage quizzes" on public.quizzes;
create policy "editors manage quizzes" on public.quizzes for all to authenticated using (public.is_editor()) with check (public.is_editor());
drop policy if exists "admins read questions" on public.quiz_questions;
create policy "admins read questions" on public.quiz_questions for select to authenticated using (public.is_admin());
drop policy if exists "editors manage questions" on public.quiz_questions;
create policy "editors manage questions" on public.quiz_questions for all to authenticated using (public.is_editor()) with check (public.is_editor());
drop policy if exists "read attempts" on public.quiz_attempts;
create policy "read attempts" on public.quiz_attempts for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "editors delete attempts" on public.quiz_attempts;
create policy "editors delete attempts" on public.quiz_attempts for delete to authenticated using (public.is_editor());
-- Nobody inserts attempts directly; submit_quiz() does.

create or replace function public.can_take_quiz(q uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_email() <> '' and not public.is_blocked() and exists (
    select 1 from public.quizzes z
     where z.id = q and z.is_active
       and (z.document_id is null or public.can_view(z.document_id))
       and exists (select 1 from public.quiz_questions x where x.quiz_id = z.id)
  );
$$;

-- Quizzes this person can take, with their best score.
create or replace function public.list_quizzes()
returns table (id uuid, title text, description text, document_title text, questions int,
               pass_percent int, one_attempt boolean, attempts int, best int, passed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select z.id, z.title, z.description, d.title,
         (select count(*)::int from public.quiz_questions x where x.quiz_id = z.id),
         z.pass_percent, z.one_attempt,
         (select count(*)::int from public.quiz_attempts a where a.quiz_id = z.id and a.user_id = auth.uid()),
         (select max(round(100.0 * a.score / nullif(a.total, 0)))::int from public.quiz_attempts a where a.quiz_id = z.id and a.user_id = auth.uid()),
         coalesce((select bool_or(a.passed) from public.quiz_attempts a where a.quiz_id = z.id and a.user_id = auth.uid()), false)
    from public.quizzes z
    left join public.documents d on d.id = z.document_id
   where public.can_take_quiz(z.id)
   order by z.created_at desc;
$$;

-- Questions without the answers.
create or replace function public.get_quiz(q uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare z public.quizzes%rowtype;
begin
  if not public.can_take_quiz(q) then raise exception 'no_access' using errcode = '42501'; end if;
  select * into z from public.quizzes where id = q;
  return jsonb_build_object(
    'id', z.id, 'title', z.title, 'description', z.description, 'pass_percent', z.pass_percent,
    'one_attempt', z.one_attempt,
    'taken', exists (select 1 from public.quiz_attempts a where a.quiz_id = q and a.user_id = auth.uid()),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'prompt', x.prompt, 'options', to_jsonb(x.options)) order by x.sort_order, x.id)
                             from public.quiz_questions x where x.quiz_id = q), '[]'::jsonb));
end;
$$;

-- Mark an attempt. answers = {"<question id>": <option index>, ...}
create or replace function public.submit_quiz(q uuid, answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  z public.quizzes%rowtype;
  s int := 0; t int := 0;
  review jsonb := '[]'::jsonb;
  x record;
  pick int;
begin
  if not public.can_take_quiz(q) then raise exception 'no_access' using errcode = '42501'; end if;
  if answers is null or jsonb_typeof(answers) <> 'object' then raise exception 'bad_answers'; end if;
  select * into z from public.quizzes where id = q;
  if z.one_attempt and exists (select 1 from public.quiz_attempts a where a.quiz_id = q and a.user_id = auth.uid()) then
    raise exception 'already_taken' using errcode = '42501';
  end if;
  if (select count(*) from public.quiz_attempts a where a.user_id = auth.uid() and a.created_at > now() - interval '1 day') >= 30 then
    raise exception 'too_many_attempts' using errcode = '42501';
  end if;
  for x in select * from public.quiz_questions where quiz_id = q order by sort_order, id loop
    t := t + 1;
    pick := case when jsonb_typeof(answers -> x.id::text) = 'number' then (answers ->> x.id::text)::int else null end;
    if pick is not null and pick = x.correct then s := s + 1; end if;
    review := review || jsonb_build_object('id', x.id, 'chosen', pick, 'right', coalesce(pick = x.correct, false),
      'correct', case when z.show_answers then x.correct end,
      'explanation', case when z.show_answers then x.explanation end);
  end loop;
  insert into public.quiz_attempts (quiz_id, user_id, email, answers, score, total, passed)
  values (q, auth.uid(), public.current_email(), answers, s, t, t > 0 and 100.0 * s / t >= z.pass_percent);
  return jsonb_build_object('score', s, 'total', t, 'passed', t > 0 and 100.0 * s / t >= z.pass_percent,
                            'pass_percent', z.pass_percent, 'review', review);
end;
$$;

revoke all on function public.list_quizzes() from public, anon;
revoke all on function public.get_quiz(uuid) from public, anon;
revoke all on function public.submit_quiz(uuid, jsonb) from public, anon;
grant execute on function public.list_quizzes() to authenticated;
grant execute on function public.get_quiz(uuid) to authenticated;
grant execute on function public.submit_quiz(uuid, jsonb) to authenticated;
grant execute on function public.can_take_quiz(uuid) to authenticated;

drop trigger if exists audit_quizzes on public.quizzes;
create trigger audit_quizzes after insert or update or delete on public.quizzes
  for each row execute function public.write_audit();
drop trigger if exists audit_quiz_questions on public.quiz_questions;
create trigger audit_quiz_questions after insert or update or delete on public.quiz_questions
  for each row execute function public.write_audit();
