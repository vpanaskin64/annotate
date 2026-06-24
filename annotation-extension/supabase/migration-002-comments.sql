-- Run this once in the Supabase SQL editor if you already set up the
-- original schema. It adds threaded replies (comments).

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid references annotations(id) on delete cascade,
  author text,
  body text not null,
  created_at timestamptz default now()
);

create index if not exists comments_annotation_id_idx on comments(annotation_id);

alter table comments enable row level security;

create policy "Public read comments" on comments for select using (true);
create policy "Public insert comments" on comments for insert with check (true);
create policy "Public update comments" on comments for update using (true) with check (true);
create policy "Public delete comments" on comments for delete using (true);
