-- Annotation Extension — Supabase schema
-- Run this in the Supabase SQL editor for your project.

-- Sessions table
create table sessions (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '30 days')
);

-- Annotations table
create table annotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  selector text not null,
  title text,
  note text not null,
  element_tag text,
  element_text_preview text,
  -- Multi-signal anchor (candidate selectors, attrs, text, tag index) used to
  -- re-find the annotated element if the page markup drifts.
  anchor jsonb,
  position_x float,
  position_y float,
  author text,
  -- Secret per-client ownership token. Required (via the x-author-token header)
  -- to update/delete this row. Never returned to clients.
  author_token text,
  resolved boolean default false,
  breakpoint text,
  screenshot_url text,
  -- Reference: an image of how the element SHOULD look, plus a note describing
  -- it. The image lives in the same `annotation-shots` Storage bucket as
  -- screenshots. Added by migration-004.
  reference_image_url text,
  reference_note text,
  created_at timestamptz default now()
);

-- Comments table (threaded replies on an annotation)
-- The annotation's own `note` is treated as the first message in the thread;
-- everything in this table is a reply that follows it.
create table comments (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid references annotations(id) on delete cascade,
  author text,
  -- Secret per-client ownership token (see annotations.author_token).
  author_token text,
  body text not null,
  created_at timestamptz default now()
);

-- Indexes
create index on annotations(session_id);
create index on sessions(url);
create index on comments(annotation_id);

-- Enable Row Level Security but allow public read/write for v1 (no auth)
alter table sessions enable row level security;
alter table annotations enable row level security;
alter table comments enable row level security;

create policy "Public read sessions" on sessions for select using (true);
create policy "Public insert sessions" on sessions for insert with check (true);

-- The ownership token is a secret: never expose it through the API.
revoke select (author_token) on annotations from anon, authenticated;
revoke select (author_token) on comments    from anon, authenticated;

create policy "Public read annotations" on annotations for select using (true);
create policy "Public insert annotations" on annotations for insert with check (true);

create policy "Public read comments" on comments for select using (true);
create policy "Public insert comments" on comments for insert with check (true);

-- Update/delete are owner-only: the row's author_token must match the
-- x-author-token request header.
create policy "Owner update annotations" on annotations
  for update
  using (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'))
  with check (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'));

create policy "Owner delete annotations" on annotations
  for delete
  using (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'));

create policy "Owner update comments" on comments
  for update
  using (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'))
  with check (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'));

create policy "Owner delete comments" on comments
  for delete
  using (author_token = (current_setting('request.headers', true)::json ->> 'x-author-token'));
