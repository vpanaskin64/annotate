-- migration-004-reference.sql
-- Adds a "reference" to each annotation: an image of how the element SHOULD
-- look, plus a note describing it. Run this in the Supabase SQL editor on an
-- existing install. The reference image is stored in the existing public
-- `annotation-shots` Storage bucket (same one screenshots use), so no new
-- bucket or policy is required.

alter table annotations add column if not exists reference_image_url text;
alter table annotations add column if not exists reference_note text;
