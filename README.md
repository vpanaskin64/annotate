# Annotate — Chrome Extension

**Annotate** is an internal Chrome extension for leaving precise, element-level feedback on any staging or production URL. Drop numbered pins on page elements, discuss them in threads, and share the annotated page with a single link — no setup required for reviewers.

> **[→ Get the extension on GitHub](https://github.com/vpanaskin64/annotate)**

---

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the `annotation-extension/` folder from the repository.
5. The **Annotate** icon will appear in your Chrome toolbar. Pin it for easy access.

> No Chrome Web Store listing — this is a locally loaded extension for internal use only.

---

## How to Use

### Starting annotation mode

1. Open any staging, preview, or production URL.
2. Click the **Annotate** toolbar icon — the side panel opens on the right.
3. Click **Start annotating** in the side panel, or press **Alt+A**.
4. Elements on the page will highlight in pink as you hover over them.

### Adding a pin

1. Hover over the element you want to annotate (button, heading, section, etc.).
2. Click it — a composer popover appears.
3. Type your note. Optionally enable the screenshot toggle to attach a screenshot of the element or full viewport.
4. Click **Add**. A numbered pin appears on the element.

### Viewing and replying

- Click any pin on the page to open its thread card.
- Use the **‹ ›** arrows to navigate between pins.
- Reply directly in the thread. Replies are visible to anyone viewing the session.
- Press **Esc** to close the card or exit annotation mode.

### Sharing annotations

1. Open the side panel controls (sliders icon, top right of the panel).
2. Click **Copy** to copy the session link.
3. Share the link with your team. Anyone with the extension installed can open the link and see all pins and threads.

> The session is tied to the URL — everyone annotating the same page shares one session automatically. No need to manage session IDs.

---

## Key Features

**Threaded discussions** — Each pin supports a full reply thread. The original note plus any number of replies are stored and visible to all collaborators.

**Side panel** — Lists every annotation across the current site, grouped by page. The current page floats to the top. Click any item to navigate to that page and open the pin.

**Desktop / Mobile breakpoints** — Use the segmented toggle in the side panel to switch between Desktop and Mobile views. Mobile mode applies DevTools-style device emulation (390×844 @3x, touch). Pins are tagged by the breakpoint they were created on and filtered accordingly — Desktop pins are hidden in Mobile and vice versa.

**Screenshots** — When adding an annotation, enable the screenshot toggle (framed-image icon). Choose between capturing just the annotated element or the full viewport. The screenshot is shown as a thumbnail in the thread.

**Resolve / Reopen** — Mark a pin as resolved from its card header. Resolved pins turn grey and can be hidden via the **Show resolved** toggle in the side panel.

**Export to Figma** — From the side panel controls, Export to Figma scrolls the full page, stitches a 2× screenshot, bakes the numbered pins on, and adds a legend column with each annotation's title, description, and author. Downloads as a PNG you can drag straight into Figma.

**Export .md** — Downloads all pins and replies for the current page as a Markdown file.

**Live updates** — Open tabs poll the session every ~10 seconds while visible. New pins, replies, resolves, and deletes from teammates appear automatically.

**Keyboard shortcut** — `Alt+A` toggles annotation mode. Rebind it at `chrome://extensions/shortcuts`.

---

> **[→ View the repository on GitHub](https://github.com/vpanaskin64/annotate)**
