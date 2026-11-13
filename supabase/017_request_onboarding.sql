-- Pro AI Trainers: "Onboarding description" on access requests
-- Run once in Supabase -> SQL Editor AFTER 016_sheet_screenshots_to_drive.sql. Safe to run again.

alter table public.access_requests add column if not exists onboarding text
  check (onboarding is null or length(trim(onboarding)) between 1 and 1000);
