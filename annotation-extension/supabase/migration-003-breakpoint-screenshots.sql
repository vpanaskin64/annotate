-- Run once in the Supabase SQL editor if your project predates these features.
-- Adds breakpoint tagging + screenshot support, and a public Storage bucket.

-- 1. New columns on annotations
alter table annotations add column if not exists breakpoint text;
alter table annotations add column if not exists screenshot_url text;

-- 2. Storage bucket for screenshots (public read)
insert into storage.buckets (id, name, public)
values ('annotation-shots', 'annotation-shots', true)
on conflict (id) do nothing;

-- 3. Public read + upload policies on the bucket (no auth, v1)
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'Public read shots') then
    create policy "Public read shots" on storage.objects
      for select using (bucket_id = 'annotation-shots');
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Public upload shots') then
    create policy "Public upload shots" on storage.objects
      for insert with check (bucket_id = 'annotation-shots');
  end if;
end $$;
