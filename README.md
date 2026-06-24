# Annotate — Chrome extension

Drop numbered pins on any live webpage, hold threaded discussions on each, and share the annotated page via a URL param. Built for internal design/QA review. UI follows the "Annotation Ext" Figma design (pink accent, Inter type scale).

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/schema.sql`.
   - **Already had an older schema?** Run the migrations you're missing, in order:
     - `migration-002-comments.sql` — threaded replies (`comments` table).
     - `migration-003-breakpoint-screenshots.sql` — `breakpoint` + `screenshot_url` columns **and** the public `annotation-shots` Storage bucket used for screenshots.
   - (From before resolve existed: `alter table annotations add column resolved boolean default false;` + its update policy.)
3. Go to **Project Settings → API** and copy the **Project URL** and **anon public** key.
4. Paste both into `background/config.js`:

   ```js
   export const SUPABASE_URL = 'https://your-project.supabase.co';
   export const SUPABASE_ANON_KEY = 'your-anon-key';
   ```

### 2. Load the extension

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → select this `annotation-extension/` folder.

## Using it

1. Open any staging/preview/production page.
2. Click the Annotate toolbar icon — the **side panel** opens on the right.
3. Click **Start annotating** (or press **Alt+A**), hover elements (pink outline), click one, type a note, **Add**.
4. A numbered pin drops on the element and a comment card opens. Reply in the thread, resolve the pin, or navigate between pins with the ‹ › arrows.
5. The side panel lists every annotation. Click an item to scroll to and open its pin.
6. Open the side panel controls (sliders icon) → **Copy** the session link and share it. A teammate with the extension installed opens the link and sees every pin and thread.

Each page has one persistent session (created on first annotation, reused on every visit). Everyone annotating the same URL with the extension shares it — no session switching to manage.

Pins re-anchor to their elements on load, scroll, and resize. **Esc** closes the card / exits annotation mode.

### Features

- **Threaded replies** — each pin is a discussion; the first note plus any number of replies.
- **Side panel** — native Chrome side panel listing annotations across every page on the current site, **grouped by page** (the current page floats to the top, tagged "This page"). Clicking an annotation on another page navigates the tab there and auto-opens it. Includes a **Show resolved** toggle.
- **Desktop / Mobile breakpoints** — the segmented toggle applies DevTools-style device emulation (390×844 @3x, touch) via the debugger API, so the page reflows exactly like the dev device emulator — without resizing the window. Each pin is tagged with the breakpoint it was created at. Both the on-page pins and the side-panel list are filtered to the active breakpoint — Desktop pins are hidden in Mobile and vice versa (untagged/older pins always show).
- **Resilient anchoring** — each annotation stores several signals about its element (candidate selectors, stable attributes like `data-testid`/`aria-label`, text content, and tag index), so pins re-find their element even if the markup drifts. If the element truly can't be found, the pin docks in a visible bottom-left tray (dashed) instead of disappearing.
- **Screenshots** — _opt-in per annotation_. The new-annotation composer has a screenshot toggle (framed-image icon, off by default). When enabled, a **Full screen** checkbox appears: leave it off (default) to capture just the annotated element's area, or check it to capture the whole viewport. On **Add** the shot is uploaded to Supabase Storage and attached as a thumbnail you can zoom (shown in the thread card and side-panel list); the zoom has a **Copy image** button and the Jira export embeds it. Requires the `annotation-shots` storage bucket.
- **Resolve / Reopen** — from a pin's card header; resolved pins turn black-checked and can be hidden.
- **Author + avatars** — your name is remembered; avatars are colored initials.
- **Live updates** — open tabs poll the session every ~10s (only while visible), so new pins, replies, edits, resolves, and deletes from other people appear on their own. Updates pause while you're typing or editing so nothing gets clobbered.
- **NEW badges & relative time** — activity within the last hour is flagged NEW.
- **Alt+A** — toggle annotation mode (rebind at `chrome://extensions/shortcuts`).
- **Export .md** — download all pins + replies for the page (controls → Export).
- **Export to Figma** — scrolls the page to load lazy/below-the-fold content, then captures it as a 2× screenshot by stitching viewport-sized tiles (sticky/fixed layers are hidden after the first tile so they don't repeat). Numbered pins are baked on and a right-hand legend column lists each annotation's number, title, description, and author. Downloads as a PNG you can drag straight into Figma. Annotation UI is hidden during capture so only the page + markers show.

## How it fits together

- **`content/content.js`** — annotation mode, pins, the threaded message card, compose flow; runs on every page. Syncs with the side panel via messages.
- **`sidepanel/`** — native side panel UI: annotations list, controls (session link, new session, export), Show-resolved toggle.
- **`background/service-worker.js`** — all Supabase REST calls + Storage uploads; captures the visible tab (`captureVisibleTab`); opens the side panel on action click; handles the Alt+A command. Content and side panel reach it via `chrome.runtime.sendMessage`.
- **`shared/tokens.css`** — design tokens (colors, Inter type scale, radii, shadows) from Figma. Loaded by both the content script and the side panel.
- **`supabase/schema.sql`** — `sessions`, `annotations`, `comments` tables with public RLS policies (no auth in v1). `migration-002-comments.sql` adds replies to an existing install.

## Notes

- Fonts use an `Inter, system-ui` stack — fidelity is exact if Inter is installed locally; otherwise it falls back to the system font. Bundling Inter as a web-accessible `@font-face` is the next step if you want pixel-perfect on every machine.
- On-page pins are 32px (the Figma pin is 40px; scaled down so pins don't obscure page content). Easy to bump in `content.css` if you prefer the full size.
- Pins are tied to a CSS selector, so responsive reflow is handled. If an element no longer exists on reload, its pin is hidden silently.
- No login (intentional for internal use) — anyone with the link + extension can read and reply. Editing/deleting is restricted to the message's author, enforced by the DB via a per-client ownership token (`x-author-token` header). Good enough for a trusted internal audience; if this ever goes external, move to Supabase Auth and key the policies off `auth.uid()`. Sessions never expire — they persist indefinitely (the schema's `expires_at` column is unused/not enforced).
- The old `popup/` folder is unused (replaced by the side panel) and can be deleted.
- Breakpoint toggle resizes the whole browser window (not a DevTools device frame), so the site's media queries reflow. Mobile/desktop is derived from window width (≤768px = mobile).
- Screenshots capture the **visible viewport** at the moment you add an annotation (our own pins/cards are hidden during capture for a clean shot). If the Storage bucket isn't set up, the annotation still saves — just without a screenshot.
- Not yet built (post-MVP): real-time sync, Jira push, @-mentions and emoji in replies.
