// Content script — annotation mode, pins, and the threaded message card.
// Restyled to match the Figma "Annotation Ext" design.

(() => {
  if (window.__annotateInjected) return;
  window.__annotateInjected = true;

  const PIN_PARAM = 'annotation_session';
  const FOCUS_PARAM = 'annotation_focus'; // pin to auto-open after navigating from the panel
  const NEW_MS = 60 * 60 * 1000; // "NEW" if activity within the last hour
  const POLL_MS = 10000; // how often to pull others' changes while the tab is visible

  let active = false;
  let sessionId = null;
  let hoverEl = null;
  let currentAuthor = '';
  let showResolved = false;
  let viewBreakpoint = null; // set by the side panel; falls back to derived width
  let readMap = {}; // annotationId -> ISO timestamp it was last read
  // IDs this client authored — used to show edit/delete affordances. Actual
  // permission is enforced by the DB via the ownership token (see service worker).
  let myAnnotationIds = new Set();
  let myCommentIds = new Set();
  let pollTimer = null;
  let lastSig = null; // signature of the last data we rendered, to skip no-op polls
  let watchedUrl = null; // last URL we bound a session to (for SPA route changes)
  let pinsSettled = false; // true once the page has had time to render after a load
  let settleTimer = null;

  // annotationId -> { ...annotation, comments:[], pinEl, number, el }
  const pins = new Map();
  let order = []; // annotationIds in display order (= pin numbers)
  let openCard = null; // { annotationId, el } or { compose:true, el, target }

  // ---------- icons ----------
  const ICON = {
    chevronLeft:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevronRight:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    // Exact Figma assets (assets/Annotation/*.svg)
    resolve:
      '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="18" height="18" rx="9" stroke="black" stroke-opacity="0.9" stroke-width="2"/><path d="M13.333 7.5L8.75012 12.083L6.66699 9.99982" stroke="black" stroke-opacity="0.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more:
      '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    close:
      '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 3.5L16 15.5M16 3.5L4 15.5" stroke="black" stroke-opacity="0.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowUp:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    // assets/Annotation/Annotation/screenshot.svg (framed-image icon)
    screenshot:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6.5H13.01M4 11.5L6.644 8.856a1.4 1.4 0 0 1 1.712 0L12 12.5M11 11.5l1.644-1.644a1.4 1.4 0 0 1 1.712 0L16 11.5M2 6.5V4.5a2 2 0 0 1 2-2H6M2 14.5v2a2 2 0 0 0 2 2H6M14 2.5h2a2 2 0 0 1 2 2V6.5M14 18.5h2a2 2 0 0 0 2-2V14.5"/></svg>',
  };

  // ---------- utilities ----------
  function normalizeUrl(url) {
    const u = new URL(url);
    u.searchParams.delete(PIN_PARAM);
    u.searchParams.delete(FOCUS_PARAM);
    return u.toString();
  }

  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let current = el;
    while (current && current !== document.body && current.nodeType === 1) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = Array.from(current.parentNode?.children || []).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentNode;
    }
    return parts.join(' > ');
  }

  // Safe querySelector — bad/legacy selectors shouldn't throw.
  function q(sel) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  const ANCHOR_ATTRS = [
    'data-testid', 'data-test', 'data-qa', 'data-cy', 'id', 'name',
    'aria-label', 'role', 'href', 'src', 'alt', 'title',
  ];

  // Build a small set of ordered candidate selectors, strongest first.
  function candidateSelectors(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    if (el.id) out.push(`#${CSS.escape(el.id)}`);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) out.push(`${tag}[${a}="${CSS.escape(v)}"]`);
    }
    if (tag === 'a' && el.getAttribute('href')) out.push(`a[href="${CSS.escape(el.getAttribute('href'))}"]`);
    const cls =
      typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) out.push(`${tag}.${CSS.escape(cls[0])}`);
    out.push(getSelector(el)); // structural path (primary, least stable)
    return [...new Set(out)];
  }

  // Capture multiple signals so we can re-find the element even if the page
  // markup drifts. Stored as the annotation's `anchor` (jsonb).
  function buildAnchor(el) {
    const attrs = {};
    for (const k of ANCHOR_ATTRS) {
      const v = el.getAttribute && el.getAttribute(k);
      if (v) attrs[k] = v;
    }
    const tag = el.tagName.toLowerCase();
    return {
      selectors: candidateSelectors(el),
      tag,
      text: (el.textContent || '').trim().slice(0, 120),
      attrs,
      tagIndex: Array.from(document.getElementsByTagName(el.tagName)).indexOf(el),
    };
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return !!(r.width || r.height);
  }

  // Best-effort element lookup: stored selector → candidate selectors →
  // attribute match → tag+text match → tag+index. Returns the element or null.
  function resolveAnchorEl(d) {
    const direct = q(d.selector);
    if (visible(direct)) return direct;

    const a = d.anchor;
    if (a) {
      for (const sel of a.selectors || []) {
        const el = q(sel);
        if (visible(el)) return el;
      }
      // Attribute match (e.g. a moved element that kept its data-testid).
      for (const k of ANCHOR_ATTRS) {
        const v = a.attrs && a.attrs[k];
        if (!v) continue;
        const el = q(`${a.tag || '*'}[${k}="${CSS.escape(v)}"]`);
        if (visible(el)) return el;
      }
      // Tag + text content match.
      const text = (a.text || '').trim();
      if (text.length >= 3 && a.tag) {
        const candidates = Array.from(document.getElementsByTagName(a.tag));
        const hit = candidates.find((el) => {
          if (!visible(el)) return false;
          const t = (el.textContent || '').trim();
          return t === text || t.startsWith(text) || text.startsWith(t.slice(0, 120));
        });
        if (hit) return hit;
      }
      // Last resort: same tag at the same document index.
      if (a.tag && a.tagIndex >= 0) {
        const el = document.getElementsByTagName(a.tag)[a.tagIndex];
        if (visible(el)) return el;
      }
    }
    // Fall back to the direct selector even if not "visible" (zero-box), so a
    // hidden-but-present element still anchors rather than orphaning.
    return direct || null;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) =>
        resolve(resp || { ok: false, error: 'No response from background' })
      );
    });
  }

  function isOwnUi(el) {
    return !!(el && el.closest && el.closest('.ann-ui'));
  }

  // Promote an element into the browser top layer via the Popover API. Top-layer
  // elements render above ALL page content — including site modals/sheets and
  // their transparent overlays — regardless of z-index or DOM order, and they
  // reliably receive pointer events. This is what lets us annotate inside a
  // site's modal without its overlay stealing our clicks. Must be in the DOM.
  function topLayer(el) {
    try {
      el.setAttribute('popover', 'manual');
      el.showPopover();
    } catch {
      /* Popover API unavailable — falls back to the element's CSS z-index. */
    }
  }

  // Toggle a pin into/out of the browser top layer. Pins anchored to elements
  // inside a modal/sheet must sit ABOVE it to stay clickable; pins on the normal
  // page should not (so they scroll naturally with content).
  function setPinTopLayer(el, on) {
    try {
      if (on) {
        if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
        if (!el.matches(':popover-open')) el.showPopover();
      } else if (el.hasAttribute('popover')) {
        if (el.matches(':popover-open')) el.hidePopover();
        el.removeAttribute('popover');
      }
    } catch {
      /* Popover API unavailable — falls back to CSS z-index. */
    }
  }

  // Is this element inside an open modal/sheet?
  function modalAncestor(el) {
    return el && el.closest
      ? el.closest('dialog, [role="dialog"], [aria-modal="true"]')
      : null;
  }

  // Where to mount a card. A native modal <dialog> (showModal) makes everything
  // OUTSIDE it inert, so a card on <body> is unclickable and clicks fall through
  // it — spawning new pins. Mounting the card INSIDE the active modal keeps it
  // interactive and makes the modal's focus trap treat our inputs as "inside".
  function cardHost(anchorEl) {
    const MODAL_SEL = 'dialog, [role="dialog"], [aria-modal="true"]';
    if (anchorEl && anchorEl.closest) {
      const m = anchorEl.closest(MODAL_SEL);
      if (m) return m;
    }
    try {
      const dlgs = document.querySelectorAll('dialog');
      for (let i = dlgs.length - 1; i >= 0; i--) {
        if (dlgs[i].matches(':modal')) return dlgs[i];
      }
    } catch {
      /* :modal unsupported — fall through to body. */
    }
    return document.body;
  }

  function relTime(iso, long) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'Just now';
    let out;
    if (s < 3600) out = `${Math.floor(s / 60)}m`;
    else if (s < 86400) out = `${Math.floor(s / 3600)}h`;
    else if (s < 604800) out = `${Math.floor(s / 86400)}d`;
    else return new Date(iso).toLocaleDateString();
    return long ? `${out} ago` : out;
  }

  function isNew(iso) {
    return iso && Date.now() - new Date(iso).getTime() < NEW_MS;
  }

  // NEW = recent activity that hasn't been read yet (read clears the badge).
  function unread(iso, annId) {
    const r = readMap[annId];
    return !r || new Date(iso).getTime() > new Date(r).getTime();
  }
  function isMsgNew(msg, annId) {
    return isNew(msg.created_at) && unread(msg.created_at, annId);
  }
  function isAnnNew(d) {
    const latest = latestActivity(d);
    return isNew(latest) && unread(latest, d.id);
  }
  async function markRead(annId) {
    readMap[annId] = new Date().toISOString();
    await chrome.storage.local.set({ reads: readMap });
  }

  function currentBreakpoint() {
    return window.innerWidth <= 768 ? 'mobile' : 'desktop';
  }
  function activeBp() {
    return viewBreakpoint || currentBreakpoint();
  }

  function initials(name) {
    if (!name) return '?';
    const p = name.trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
  }

  function avatarColor(name) {
    let h = 0;
    const s = name || 'anon';
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 55%)`;
  }

  function avatarEl(name, size) {
    const a = document.createElement('div');
    a.className = `ann-avatar ann-avatar--${size}`;
    a.style.background = avatarColor(name);
    a.textContent = initials(name);
    return a;
  }

  // thread = original note + comments, normalized
  function threadOf(data) {
    const head = {
      id: `head:${data.id}`,
      author: data.author,
      title: data.title,
      body: data.note,
      created_at: data.created_at,
      isOriginal: true,
    };
    const replies = (data.comments || []).map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      created_at: c.created_at,
      isOriginal: false,
    }));
    return [head, ...replies];
  }

  function latestActivity(data) {
    const times = [data.created_at, ...(data.comments || []).map((c) => c.created_at)];
    return times.sort().pop();
  }

  function notifyPanel() {
    chrome.runtime.sendMessage({ type: 'LIST_CHANGED' }).catch(() => {});
  }

  // Tell the side panel which annotation is currently open so its list can
  // highlight the matching row (and clear it when the card closes).
  function notifyActive(annotationId) {
    chrome.runtime
      .sendMessage({ type: 'ACTIVE_ANNOTATION', annotation_id: annotationId || null })
      .catch(() => {});
  }

  // ---------- toolbar (mode indicator) ----------
  let toolbarEl = null;
  function showToolbar() {
    if (toolbarEl) return;
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'ann-toolbar ann-ui';
    toolbarEl.innerHTML =
      '<span class="ann-toolbar__dot"></span><span>Click an element to annotate · Esc to exit</span>';
    document.body.appendChild(toolbarEl);
  }
  function hideToolbar() {
    toolbarEl?.remove();
    toolbarEl = null;
  }

  // ---------- hover highlight ----------
  function onMouseOver(e) {
    if (!active || isOwnUi(e.target)) return;
    if (hoverEl && hoverEl !== e.target) hoverEl.classList.remove('ann-hover');
    hoverEl = e.target;
    hoverEl.classList.add('ann-hover');
  }
  function onMouseOut(e) {
    if (active && e.target?.classList) e.target.classList.remove('ann-hover');
  }
  function clearHover() {
    hoverEl?.classList.remove('ann-hover');
    hoverEl = null;
  }

  // ---------- pins ----------
  function renderPin(data) {
    if (pins.has(data.id)) return;
    const number = order.length + 1;
    order.push(data.id);

    const pinEl = document.createElement('div');
    pinEl.className = 'ann-pin ann-ui';
    if (data.resolved) pinEl.classList.add('ann-pin--resolved');
    pinEl.innerHTML = `<div class="ann-pin__circle"><span>${number}</span></div>`;
    document.body.appendChild(pinEl);

    pins.set(data.id, { ...data, comments: data.comments || [], pinEl, number });

    pinEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openThreadCard(data.id);
    });

    applyVisibility(data.id);
  }

  function applyVisibility(id) {
    const d = pins.get(id);
    if (!d) return;
    const bpHide = d.breakpoint && d.breakpoint !== activeBp();
    const resolvedHide = d.resolved && !showResolved;
    d.hidden = bpHide || resolvedHide;
    positionPin(id);
  }

  // Resolve a pin's anchor element, treating a zero-size box (e.g. a
  // display:none responsive duplicate) as "not on screen".
  function anchorRectFor(d) {
    const el = resolveAnchorEl(d);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return r;
  }

  // Reveal a pin on the next frame so the opacity 0 → 1 transition plays
  // (rather than appearing instantly). Idempotent.
  function showPin(pinEl) {
    pinEl.style.display = 'flex';
    requestAnimationFrame(() => pinEl.classList.add('is-ready'));
  }
  function hidePin(pinEl) {
    pinEl.style.display = 'none';
    pinEl.classList.remove('is-ready');
  }

  // Move a pin under a new parent. A pin inside a native modal <dialog> must be
  // a DOM descendant of it to stay interactive (everything outside a showModal()
  // dialog is inert). Reparenting an open popover can error, so reset it first.
  function rehostPin(pin, host) {
    if (host && pin.parentElement !== host) {
      setPinTopLayer(pin, false);
      host.appendChild(pin);
    }
  }

  function positionPin(id) {
    const d = pins.get(id);
    if (!d) return;
    const pin = d.pinEl;
    if (d.hidden) {
      d.orphan = false;
      rehostPin(pin, document.body);
      setPinTopLayer(pin, false);
      hidePin(pin);
      return;
    }
    const el = resolveAnchorEl(d);
    const r = el ? anchorRectFor(d) : null;
    if (r) {
      // Anchored to its element: place it first, then fade in.
      d.orphan = false;
      pin.classList.remove('ann-pin--orphan');
      const modal = modalAncestor(el);
      if (modal) {
        // Inside a modal/sheet → host within it (so it isn't inert) and promote
        // to the top layer with viewport (fixed) coords so it sits above the
        // modal and tracks the element on scroll.
        rehostPin(pin, modal);
        setPinTopLayer(pin, true);
        pin.style.position = 'fixed';
        pin.style.top = `${r.top}px`;
        pin.style.left = `${r.left}px`;
      } else {
        rehostPin(pin, document.body);
        setPinTopLayer(pin, false);
        pin.style.position = 'absolute';
        pin.style.top = `${r.top + window.scrollY}px`;
        pin.style.left = `${r.left + window.scrollX}px`;
      }
      pin.style.bottom = '';
      showPin(pin);
      return;
    }
    // Element can't be found. Dock it in the tray so it isn't silently lost —
    // but during the initial load grace period keep it hidden, giving late
    // content time to render so it can anchor properly instead of flashing.
    d.orphan = true;
    pin.classList.add('ann-pin--orphan');
    pin.title = "This annotation's element wasn't found on the page";
    pin.style.position = 'fixed';
    if (pinsSettled) {
      // Host inside an open modal (if any) so the tray stays reachable above it.
      const host = cardHost(null);
      rehostPin(pin, host);
      setPinTopLayer(pin, host !== document.body);
      showPin(pin);
    } else {
      rehostPin(pin, document.body);
      setPinTopLayer(pin, false);
      hidePin(pin);
    }
  }

  // Stack docked (orphaned) pins along the bottom-left so several are usable.
  function layoutOrphans() {
    let i = 0;
    order.forEach((id) => {
      const d = pins.get(id);
      if (!d || !d.orphan || d.hidden || d.pinEl.style.display === 'none') return;
      d.pinEl.style.left = '12px';
      d.pinEl.style.top = 'auto';
      d.pinEl.style.bottom = `${12 + i * 40}px`;
      i++;
    });
  }

  function repositionAll() {
    pins.forEach((_, id) => applyVisibility(id));
    layoutOrphans();
    // Close the card if its pin is now hidden (e.g. breakpoint switched).
    if (openCard && !openCard.compose) {
      const d = pins.get(openCard.annotationId);
      if (!d || d.hidden) closeCard();
    }
    if (openCard) positionCardToPin();
  }

  function setPinSelected(id, on) {
    pins.get(id)?.pinEl.classList.toggle('ann-pin--selected', on);
  }

  // ---------- card positioning ----------
  // Cards live in the top layer (see topLayer()), which is positioned relative
  // to the viewport — so we use fixed/viewport coordinates (no scroll offset).
  // Scroll/resize re-run this against a fresh getBoundingClientRect so the card
  // keeps tracking its element.
  function positionFloating(el, anchorRect) {
    el.style.position = 'fixed';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 360;
    const h = el.offsetHeight || 200;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 10;
    if (anchorRect.left + w > vw - 12) left = anchorRect.right - w;
    if (anchorRect.bottom + h > vh - 12) top = anchorRect.top - h - 10;
    el.style.left = `${Math.max(12, left)}px`;
    el.style.top = `${Math.max(12, top)}px`;
  }

  function positionCardToPin() {
    if (!openCard) return;
    const rect = openCard.compose
      ? openCard.target?.getBoundingClientRect()
      : anchorRectFor(pins.get(openCard.annotationId) || {});
    if (rect) positionFloating(openCard.el, rect);
    else centerCard(openCard.el); // orphaned pin — no anchor to point at
  }

  // Fixed, centered placement for a card whose pin has no element on screen.
  function centerCard(el) {
    const w = el.offsetWidth || 360;
    const h = el.offsetHeight || 200;
    el.style.position = 'fixed';
    el.style.left = `${Math.max(12, (window.innerWidth - w) / 2)}px`;
    el.style.top = `${Math.max(12, (window.innerHeight - h) / 2)}px`;
  }

  function closeCard() {
    if (!openCard) return;
    if (!openCard.compose) setPinSelected(openCard.annotationId, false);
    openCard.el.remove();
    openCard = null;
    notifyActive(null);
  }

  // ---------- message item ----------
  function messageItemEl(msg, annotationId) {
    const item = document.createElement('div');
    item.className = 'ann-msg';
    item.dataset.msgId = String(msg.id);

    const head = document.createElement('div');
    head.className = 'ann-msg__head';

    const left = document.createElement('div');
    left.className = 'ann-msg__id';
    left.appendChild(avatarEl(msg.author || 'Anonymous', 'md'));
    const names = document.createElement('div');
    names.className = 'ann-msg__names';
    names.innerHTML = `<div class="ann-msg__author">${escapeHtml(
      msg.author || 'Anonymous'
    )}</div><div class="ann-msg__time">${relTime(msg.created_at, true)}</div>`;
    left.appendChild(names);
    head.appendChild(left);

    const right = document.createElement('div');
    right.className = 'ann-msg__meta';
    if (isMsgNew(msg, annotationId)) {
      const b = document.createElement('span');
      b.className = 'ann-badge';
      b.textContent = 'NEW';
      right.appendChild(b);
    }
    // Only the author who left this message can edit/delete it.
    if (isOwnMessage(msg, annotationId)) {
      const more = document.createElement('button');
      more.className = 'ann-iconbtn ann-msg__more';
      more.innerHTML = ICON.more;
      more.title = 'More';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        showMoreMenu(more, msg, annotationId);
      });
      right.appendChild(more);
    }
    head.appendChild(right);

    item.appendChild(head);

    if (msg.isOriginal && msg.title) {
      const title = document.createElement('div');
      title.className = 'ann-msg__title';
      title.textContent = msg.title;
      item.appendChild(title);
    }

    const body = document.createElement('div');
    body.className = 'ann-msg__body';
    body.innerHTML = linkify(msg.body);
    item.appendChild(body);

    // Screenshot thumbnail on the original message (shown only when one exists)
    const d = pins.get(annotationId);
    if (msg.isOriginal && d && d.screenshot_url) {
      const thumb = document.createElement('div');
      thumb.className = 'ann-msg__shot';
      thumb.innerHTML = `<img src="${d.screenshot_url}" alt="Screenshot">`;
      thumb.title = 'Click to zoom';
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        openZoom(d.screenshot_url);
      });
      item.appendChild(thumb);
    }
    return item;
  }

  function showMoreMenu(anchor, msg, annotationId) {
    document.querySelector('.ann-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ann-menu ann-ui';

    const edit = document.createElement('button');
    edit.className = 'ann-menu__edit';
    edit.textContent = msg.isOriginal ? 'Edit annotation' : 'Edit reply';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      beginEdit(msg, annotationId);
    });
    menu.appendChild(edit);

    const del = document.createElement('button');
    del.textContent = msg.isOriginal ? 'Delete annotation' : 'Delete reply';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      menu.remove();
      if (msg.isOriginal) {
        const r = await sendMessage({ type: 'DELETE_ANNOTATION', annotation_id: annotationId });
        if (!r.ok) return alert(`Delete failed: ${r.error}`);
        removePin(annotationId);
        closeCard();
      } else {
        const r = await sendMessage({ type: 'DELETE_COMMENT', comment_id: msg.id });
        if (!r.ok) return alert(`Delete failed: ${r.error}`);
        const d = pins.get(annotationId);
        d.comments = d.comments.filter((c) => c.id !== msg.id);
        openThreadCard(annotationId, true);
      }
      notifyPanel();
    });
    menu.appendChild(del);
    (openCard?.el?.isConnected ? openCard.el.parentElement : document.body).appendChild(menu);
    topLayer(menu); // sit above the (top-layer) thread card it's opened from
    menu.style.position = 'fixed';
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${r.right - menu.offsetWidth}px`;
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  function beginEdit(msg, annotationId) {
    if (!openCard || openCard.compose) return;
    const item = openCard.el.querySelector(`.ann-msg[data-msg-id="${CSS.escape(String(msg.id))}"]`);
    if (!item || item.querySelector('.ann-edit')) return;
    const body = item.querySelector('.ann-msg__body');

    const editor = document.createElement('div');
    editor.className = 'ann-edit';
    // Screenshots attach to the annotation, so the capture toggle only shows when
    // editing the original message (not replies). Off by default; enabling it
    // captures (or replaces) the screenshot on save. The existing shot is kept if
    // left off, so plain text edits don't disturb it.
    const hasShot = msg.isOriginal && !!pins.get(annotationId)?.screenshot_url;
    const shotControls = msg.isOriginal
      ? `<div class="ann-shot-controls">
           <button class="ann-iconbtn ann-shot-toggle" type="button" aria-pressed="false" title="${hasShot ? 'Replace screenshot on save' : 'Attach a screenshot'}">${ICON.screenshot}</button>
           <label class="ann-shot-full" hidden><input type="checkbox" class="ann-shot-full__cb" /> Full screen</label>
           ${hasShot ? '<button class="ann-shot-remove" type="button">Remove screenshot</button>' : ''}
         </div>`
      : '';
    editor.innerHTML = `
      <textarea class="ann-edit__input"></textarea>
      <div class="ann-edit__actions">
        ${shotControls}
        <div class="ann-compose-actions__right">
          <button class="ann-btn ann-btn--ghost ann-edit__cancel">Cancel</button>
          <button class="ann-btn ann-btn--primary ann-edit__save">Save</button>
        </div>
      </div>`;
    const ta = editor.querySelector('textarea');
    ta.value = msg.body;
    if (body) {
      body.style.display = 'none';
      body.insertAdjacentElement('afterend', editor);
    } else {
      item.appendChild(editor);
    }
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    // Optional screenshot capture/removal when editing the original message.
    let wantShot = false;
    let wantRemove = false;
    const shotToggle = editor.querySelector('.ann-shot-toggle');
    const fullWrap = editor.querySelector('.ann-shot-full');
    const fullCb = editor.querySelector('.ann-shot-full__cb');
    const removeBtn = editor.querySelector('.ann-shot-remove');
    if (shotToggle) {
      shotToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        wantShot = !wantShot;
        if (wantShot) {
          wantRemove = false; // capturing a new one cancels removal
          removeBtn?.classList.remove('is-armed');
        }
        shotToggle.classList.toggle('is-on', wantShot);
        shotToggle.setAttribute('aria-pressed', String(wantShot));
        shotToggle.title = wantShot ? 'Screenshot will be attached on save' : 'Attach a screenshot';
        fullWrap.hidden = !wantShot;
        if (!wantShot) fullCb.checked = false;
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        wantRemove = !wantRemove;
        removeBtn.classList.toggle('is-armed', wantRemove);
        removeBtn.textContent = wantRemove ? 'Screenshot will be removed' : 'Remove screenshot';
        if (wantRemove && wantShot) {
          // Removing cancels a pending capture.
          wantShot = false;
          shotToggle.classList.remove('is-on');
          shotToggle.setAttribute('aria-pressed', 'false');
          fullWrap.hidden = true;
          fullCb.checked = false;
        }
      });
    }

    editor.querySelector('.ann-edit__cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      editor.remove();
      if (body) body.style.display = '';
    });
    editor.querySelector('.ann-edit__save').addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      if (!text) return ta.focus();
      const save = editor.querySelector('.ann-edit__save');
      save.disabled = true;
      save.textContent = 'Saving…';
      let r;
      if (msg.isOriginal) {
        const fields = { note: text };
        if (wantRemove) fields.screenshot_url = null;
        r = await sendMessage({ type: 'UPDATE_ANNOTATION', annotation_id: annotationId, fields });
        if (r.ok) {
          const anno = pins.get(annotationId);
          anno.note = text;
          if (wantRemove) {
            const oldUrl = anno.screenshot_url;
            anno.screenshot_url = null;
            // Hard-delete the file from Storage so nothing is left orphaned.
            sendMessage({ type: 'DELETE_SHOT', url: oldUrl });
          }
        }
      } else {
        r = await sendMessage({ type: 'UPDATE_COMMENT', comment_id: msg.id, fields: { body: text } });
        if (r.ok) {
          const c = pins.get(annotationId).comments.find((x) => x.id === msg.id);
          if (c) c.body = text;
        }
      }
      if (!r.ok) {
        save.disabled = false;
        save.textContent = 'Save';
        return alert(`Edit failed: ${r.error}`);
      }
      openThreadCard(annotationId, true);
      notifyPanel();
      if (msg.isOriginal && wantShot) captureShot(annotationId, { fullscreen: fullCb.checked });
    });
  }

  function removePin(id) {
    const d = pins.get(id);
    if (!d) return;
    d.pinEl.remove();
    pins.delete(id);
    order = order.filter((x) => x !== id);
    renumberPins();
  }

  function renumberPins() {
    order.forEach((id, i) => {
      const d = pins.get(id);
      if (d) {
        d.number = i + 1;
        const span = d.pinEl.querySelector('span');
        if (span) span.textContent = i + 1;
      }
    });
  }

  // ---------- thread card ----------
  function openThreadCard(annotationId, keepPosition) {
    const data = pins.get(annotationId);
    if (!data) return;
    markRead(annotationId); // reading clears the NEW badge (readMap updates synchronously)
    const prevRect = keepPosition && openCard ? openCard.el.getBoundingClientRect() : null;
    closeCard();

    const card = document.createElement('div');
    card.className = 'ann-card ann-ui';

    // header
    const header = document.createElement('div');
    header.className = 'ann-card__header';
    const total = order.length;
    const idx = order.indexOf(annotationId) + 1;
    header.innerHTML = `
      <div class="ann-nav">
        <button class="ann-iconbtn ann-nav__prev" title="Previous">${ICON.chevronLeft}</button>
        <span class="ann-nav__count">${idx} / ${total}</span>
        <button class="ann-iconbtn ann-nav__next" title="Next">${ICON.chevronRight}</button>
      </div>
      <div class="ann-header__actions">
        <button class="ann-resolve ${data.resolved ? 'is-resolved' : ''}" title="${
      data.resolved ? 'Reopen' : 'Resolve'
    }">${ICON.resolve}</button>
        <span class="ann-header__sep"></span>
        <button class="ann-iconbtn ann-close" title="Close">${ICON.close}</button>
      </div>`;
    card.appendChild(header);
    card.appendChild(divider());

    // thread
    const thread = document.createElement('div');
    thread.className = 'ann-card__thread';
    const msgs = threadOf(data);
    msgs.forEach((m, i) => {
      thread.appendChild(messageItemEl(m, annotationId));
      if (i < msgs.length - 1) thread.appendChild(divider());
    });
    card.appendChild(thread);

    // composer
    card.appendChild(buildComposer(annotationId));

    cardHost(resolveAnchorEl(data)).appendChild(card);
    topLayer(card);
    openCard = { annotationId, el: card };
    setPinSelected(annotationId, true);
    notifyActive(annotationId);

    // header actions
    header.querySelector('.ann-nav__prev').addEventListener('click', (e) => {
      e.stopPropagation();
      navigate(annotationId, -1);
    });
    header.querySelector('.ann-nav__next').addEventListener('click', (e) => {
      e.stopPropagation();
      navigate(annotationId, 1);
    });
    header.querySelector('.ann-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeCard();
    });
    header.querySelector('.ann-resolve').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      const next = !data.resolved;
      const r = await sendMessage({
        type: 'UPDATE_ANNOTATION',
        annotation_id: annotationId,
        fields: { resolved: next },
      });
      btn.disabled = false;
      if (!r.ok) return alert(`Update failed: ${r.error}`);
      data.resolved = next;
      pins.get(annotationId).resolved = next;
      pins.get(annotationId).pinEl.classList.toggle('ann-pin--resolved', next);
      btn.classList.toggle('is-resolved', next);
      applyVisibility(annotationId);
      notifyPanel();
      if (next && !showResolved) closeCard();
    });

    if (prevRect) {
      card.style.position = 'fixed';
      card.style.left = `${prevRect.left}px`;
      card.style.top = `${prevRect.top}px`;
    } else {
      positionCardToPin();
    }
    notifyPanel(); // reflect cleared NEW badge in the side panel
  }

  function navigate(fromId, dir) {
    const i = order.indexOf(fromId);
    let j = i;
    for (let step = 0; step < order.length; step++) {
      j = (j + dir + order.length) % order.length;
      const d = pins.get(order[j]);
      if (d && !d.hidden) break;
    }
    const target = order[j];
    if (target && target !== fromId) {
      scrollToPin(target);
      openThreadCard(target);
    }
  }

  function buildComposer(annotationId) {
    const wrap = document.createElement('div');
    wrap.className = 'ann-composer';

    const ta = document.createElement('textarea');
    ta.className = 'ann-composer__input';
    ta.rows = 1;
    ta.placeholder = 'Write a reply...';
    autoGrow(ta);

    let nameInput = null;
    if (!currentAuthor) {
      nameInput = document.createElement('input');
      nameInput.className = 'ann-composer__name';
      nameInput.placeholder = 'Your name';
      nameInput.required = true;
      nameInput.addEventListener('input', () =>
        nameInput.classList.remove('ann-input--error')
      );
    }

    const row = document.createElement('div');
    row.className = 'ann-composer__row';
    row.innerHTML = `<button class="ann-send" title="Send">${ICON.arrowUp}</button>`;

    if (nameInput) wrap.appendChild(nameInput);
    wrap.appendChild(ta);
    wrap.appendChild(row);

    const submit = async () => {
      const body = ta.value.trim();
      if (!body) return ta.focus();
      if (nameInput) {
        const nm = nameInput.value.trim();
        if (!nm) {
          nameInput.classList.add('ann-input--error');
          return nameInput.focus();
        }
        await setAuthor(nm);
      }
      const send = row.querySelector('.ann-send');
      send.disabled = true;
      const r = await sendMessage({
        type: 'ADD_COMMENT',
        annotation_id: annotationId,
        author: currentAuthor || null,
        body,
      });
      send.disabled = false;
      if (!r.ok) return alert(`Reply failed: ${r.error}`);
      await rememberMine('comment', r.comment.id);
      pins.get(annotationId).comments.push(r.comment);
      openThreadCard(annotationId, true);
      notifyPanel();
    };

    row.querySelector('.ann-send').addEventListener('click', (e) => {
      e.stopPropagation();
      submit();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    return wrap;
  }

  // ---------- compose new annotation ----------
  function showComposeCard(targetEl) {
    closeCard();
    const selector = getSelector(targetEl);
    const card = document.createElement('div');
    card.className = 'ann-card ann-card--compose ann-ui';
    card.innerHTML = `
      <div class="ann-card__header"><span class="ann-card__title">New annotation</span></div>
      ${divider().outerHTML}
      <div class="ann-compose-body">
        <div class="ann-msg__tag">&lt;${targetEl.tagName.toLowerCase()}&gt;</div>
        <input class="ann-composer__title" placeholder="Title">
        <textarea class="ann-composer__input" rows="2" placeholder="Description — what needs to change?"></textarea>
        ${currentAuthor ? '' : '<input class="ann-composer__name" placeholder="Your name" required>'}
        <div class="ann-compose-actions">
          <div class="ann-shot-controls">
            <button class="ann-iconbtn ann-shot-toggle" type="button" aria-pressed="false" title="Attach a screenshot">${ICON.screenshot}</button>
            <label class="ann-shot-full" hidden><input type="checkbox" class="ann-shot-full__cb" /> Full screen</label>
          </div>
          <div class="ann-compose-actions__right">
            <button class="ann-btn ann-btn--ghost ann-cancel">Cancel</button>
            <button class="ann-btn ann-btn--primary ann-add">Add</button>
          </div>
        </div>
      </div>`;
    cardHost(targetEl).appendChild(card);
    topLayer(card);
    openCard = { compose: true, el: card, target: targetEl };
    positionFloating(card, targetEl.getBoundingClientRect());

    const ta = card.querySelector('textarea');
    const titleInput = card.querySelector('.ann-composer__title');
    const nameInput = card.querySelector('.ann-composer__name');
    // Prefill the title with the element's text (or its tag as a fallback).
    titleInput.value =
      (targetEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) ||
      targetEl.tagName.toLowerCase();
    if (nameInput)
      nameInput.addEventListener('input', () =>
        nameInput.classList.remove('ann-input--error')
      );
    ta.focus();

    // Screenshot ON by default (focus mode): captures the annotated element's
    // area. The "Full screen" checkbox (shown while enabled) captures the
    // viewport. User can toggle the screenshot off entirely.
    let wantShot = true;
    const shotToggle = card.querySelector('.ann-shot-toggle');
    const fullWrap = card.querySelector('.ann-shot-full');
    const fullCb = card.querySelector('.ann-shot-full__cb');
    shotToggle.classList.add('is-on');
    shotToggle.setAttribute('aria-pressed', 'true');
    shotToggle.title = 'Screenshot will be attached';
    fullWrap.hidden = false;
    shotToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      wantShot = !wantShot;
      shotToggle.classList.toggle('is-on', wantShot);
      shotToggle.setAttribute('aria-pressed', String(wantShot));
      shotToggle.title = wantShot ? 'Screenshot will be attached' : 'Attach a screenshot';
      fullWrap.hidden = !wantShot;
      if (!wantShot) fullCb.checked = false;
    });

    card.querySelector('.ann-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      closeCard();
    });

    card.querySelector('.ann-add').addEventListener('click', async (e) => {
      e.stopPropagation();
      const note = ta.value.trim();
      if (!note) return ta.focus();
      if (nameInput) {
        const nm = nameInput.value.trim();
        if (!nm) {
          nameInput.classList.add('ann-input--error');
          return nameInput.focus();
        }
        await setAuthor(nm);
      }
      const btn = card.querySelector('.ann-add');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      if (!sessionId && !(await ensureSession())) {
        btn.disabled = false;
        btn.textContent = 'Add';
        return alert('Could not create session. Check Supabase config.');
      }
      const fields = {
        type: 'ADD_ANNOTATION',
        selector,
        title: titleInput.value.trim() || null,
        note,
        element_tag: targetEl.tagName,
        element_text_preview: (targetEl.textContent || '').trim().slice(0, 80),
        anchor: buildAnchor(targetEl),
        position_x: 0,
        position_y: 0,
        author: currentAuthor || null,
        breakpoint: activeBp(),
      };
      let r = await sendMessage({ ...fields, session_id: sessionId });
      // The cached session may have been deleted (e.g. DB wiped). Recreate it
      // and retry once before giving up.
      if (!r.ok && isStaleSessionError(r.error) && (await resetSession())) {
        r = await sendMessage({ ...fields, session_id: sessionId });
      }
      if (!r.ok) {
        btn.disabled = false;
        btn.textContent = 'Add';
        return alert(`Save failed: ${r.error}`);
      }
      await rememberMine('annotation', r.annotation.id);
      closeCard();
      renderPin(r.annotation);
      notifyPanel();
      openThreadCard(r.annotation.id);
      if (wantShot) captureShot(r.annotation.id, { fullscreen: fullCb.checked });
    });
  }

  // ---------- helpers ----------
  function divider() {
    const d = document.createElement('div');
    d.className = 'ann-divider';
    return d;
  }
  function autoGrow(ta) {
    const fn = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    };
    ta.addEventListener('input', fn);
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }
  // Escape, then turn bare URLs into clickable links (opens in a new tab).
  function linkify(text) {
    return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, (m) => {
      const trail = m.match(/[.,;:!?)\]}'"]+$/); // don't swallow trailing punctuation
      const url = trail ? m.slice(0, -trail[0].length) : m;
      const tail = trail ? trail[0] : '';
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ann-link">${url}</a>${tail}`;
    });
  }
  async function setAuthor(name) {
    currentAuthor = name;
    await chrome.storage.local.set({ author: name });
  }

  // True only when this client authored the message (so it can edit/delete it).
  // The DB enforces this for real via the ownership token; this just controls
  // whether the UI affordance is shown.
  function isOwnMessage(msg, annotationId) {
    if (msg.isOriginal) return myAnnotationIds.has(String(annotationId));
    return myCommentIds.has(String(msg.id));
  }

  async function loadOwnership() {
    const s = await chrome.storage.local.get(['my_annotation_ids', 'my_comment_ids']);
    myAnnotationIds = new Set(s.my_annotation_ids || []);
    myCommentIds = new Set(s.my_comment_ids || []);
  }

  async function rememberMine(kind, id) {
    if (kind === 'annotation') {
      myAnnotationIds.add(String(id));
      await chrome.storage.local.set({ my_annotation_ids: [...myAnnotationIds] });
    } else {
      myCommentIds.add(String(id));
      await chrome.storage.local.set({ my_comment_ids: [...myCommentIds] });
    }
  }

  function scrollToPin(id) {
    const d = pins.get(id);
    const el = d && resolveAnchorEl(d);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- export to Figma (flat 2x PNG with baked-in pins) ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  const FONT = '-apple-system, "Segoe UI", Roboto, sans-serif';

  function drawMarker(ctx, cx, cy, num, scale) {
    const r = 16 * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f5407f';
    ctx.fill();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(15 * scale)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), cx, cy);
  }

  function wrapText(ctx, text, maxW) {
    const lines = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > maxW && line) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  // Draw the numbered annotation list down the right-hand column.
  function drawLegend(ctx, items, x, colW, canvasH, S) {
    const pad = 24 * S;
    const badgeR = 13 * S;
    const textX = x + pad + badgeR * 2 + 12 * S;
    const textW = x + colW - pad - textX;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, 0, colW, canvasH);
    ctx.fillStyle = '#ececec';
    ctx.fillRect(x, 0, Math.max(1, Math.round(S)), canvasH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#111111';
    ctx.font = `600 ${Math.round(15 * S)}px ${FONT}`;
    let y = pad + 16 * S;
    ctx.fillText(`Annotations (${items.length})`, x + pad, y);
    y += 18 * S;

    for (const d of items) {
      const title = d.title || `Annotation ${d.number}`;
      const replies = (d.comments || []).length;
      const meta =
        `${d.author || 'Anonymous'}` + (replies ? ` · ${replies} repl${replies === 1 ? 'y' : 'ies'}` : '');

      const top = y;
      // badge
      const by = y + 13 * S;
      ctx.beginPath();
      ctx.arc(x + pad + badgeR, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = '#f5407f';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${Math.round(12 * S)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(d.number), x + pad + badgeR, by + 4 * S);
      ctx.textAlign = 'left';

      // title
      ctx.fillStyle = '#111111';
      ctx.font = `600 ${Math.round(15 * S)}px ${FONT}`;
      for (const ln of wrapText(ctx, title, textW)) {
        y += 19 * S;
        ctx.fillText(ln, textX, y);
      }
      // description
      if (d.note) {
        ctx.fillStyle = '#444444';
        ctx.font = `${Math.round(13.5 * S)}px ${FONT}`;
        y += 4 * S;
        for (const ln of wrapText(ctx, d.note, textW)) {
          y += 18 * S;
          ctx.fillText(ln, textX, y);
        }
      }
      // meta
      ctx.fillStyle = '#999999';
      ctx.font = `${Math.round(12 * S)}px ${FONT}`;
      y += 18 * S;
      ctx.fillText(meta, textX, y);

      y += 18 * S;
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(x + pad, y, colW - pad * 2, Math.max(1, Math.round(S)));
      y += 16 * S;
      void top;
    }
    return y;
  }

  // Measure the legend's total height so the canvas can be sized to fit it.
  function measureLegend(items, colW, S) {
    const measure = document.createElement('canvas').getContext('2d');
    const pad = 24 * S;
    const badgeR = 13 * S;
    const textX = pad + badgeR * 2 + 12 * S;
    const textW = colW - pad - textX;
    let y = pad + 16 * S + 18 * S;
    for (const d of items) {
      measure.font = `600 ${Math.round(15 * S)}px ${FONT}`;
      y += wrapText(measure, d.title || `Annotation ${d.number}`, textW).length * (19 * S);
      if (d.note) {
        measure.font = `${Math.round(13.5 * S)}px ${FONT}`;
        y += 4 * S + wrapText(measure, d.note, textW).length * (18 * S);
      }
      y += 18 * S + 18 * S + 16 * S; // meta + separator + gap
    }
    return y + pad;
  }

  // Collect fixed/sticky elements so we can keep them from repeating across
  // stitched tiles. Fixed overlays (cookie banners, chat bubbles) are hidden in
  // every tile; sticky elements (e.g. a header) are shown only in the first.
  let fixedEls = null;
  let stickyEls = null;
  function collectFixedSticky() {
    fixedEls = [];
    stickyEls = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (const el of all) {
      if (el.closest && el.closest('.ann-ui')) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed') fixedEls.push(el);
      else if (pos === 'sticky') stickyEls.push(el);
    }
  }
  function setHidden(el, hide) {
    if (hide) el.style.setProperty('visibility', 'hidden', 'important');
    else el.style.removeProperty('visibility');
  }
  // tileIndex 0 = top tile. Fixed overlays hidden throughout; sticky hidden
  // after the first tile so it doesn't repeat.
  function maskOverlays(tileIndex) {
    if (!fixedEls) collectFixedSticky();
    for (const el of fixedEls) setHidden(el, true);
    for (const el of stickyEls) setHidden(el, tileIndex > 0);
  }
  function unmaskOverlays() {
    for (const el of fixedEls || []) setHidden(el, false);
    for (const el of stickyEls || []) setHidden(el, false);
  }

  // Scroll through the page so lazy/below-the-fold content (footers, carousels,
  // images) renders before we capture — otherwise those areas come out blank.
  async function primeLazyContent() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const origY = window.scrollY;
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    let y = 0;
    let stable = 0;
    let guard = 0;
    while (guard++ < 200) {
      const h = document.documentElement.scrollHeight;
      if (y < h) {
        window.scrollTo(0, y);
        await wait(250); // let lazy content for this band load
        y += step;
      } else {
        // At the bottom — dwell so async widgets (reviews, footer) finish, then
        // see if the page grew. Stop only after it's been stable twice.
        window.scrollTo(0, h);
        await wait(600);
        const h2 = document.documentElement.scrollHeight;
        if (h2 <= h) {
          if (++stable >= 2) break;
        } else {
          stable = 0;
        }
        y = h;
      }
    }
    window.scrollTo(0, origY);
    await wait(150);
  }

  async function exportToFigma() {
    const items = order.map((id) => pins.get(id)).filter(Boolean);
    if (!items.length) return { ok: false, error: 'No annotations on this page to export.' };

    // Hide all annotation UI (pins + cards) so the screenshot is clean; we bake
    // our own numbered markers on afterward.
    closeCard();
    fixedEls = null; // recollect fresh for this export
    stickyEls = null;
    document.body.classList.add('ann-exporting');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

    // Load everything below the fold first.
    await primeLazyContent();

    // Marker positions in document coordinates (after content has loaded).
    const markers = items.map((d) => {
      const el = resolveAnchorEl(d);
      if (el) {
        const r = el.getBoundingClientRect();
        return { number: d.number, x: r.left + window.scrollX, y: r.top + window.scrollY };
      }
      return { number: d.number, orphan: true };
    });
    // Park unanchored pins in a tidy stack at the top-left so they aren't lost.
    let o = 0;
    for (const m of markers) {
      if (m.orphan) {
        m.x = 28;
        m.y = 28 + o * 44;
        o++;
      }
    }

    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const pageHeight = () =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    // Clamp DPI so the stitched canvas stays under browser limits.
    const MAX = 15000;
    let scale = Math.min(2, MAX / pageHeight(), MAX / vpW);
    if (!isFinite(scale) || scale < 1) scale = 1;

    // Capture viewport-sized tiles while scrolling. Disable smooth scrolling so
    // scrollY lands exactly where we ask (otherwise tiles misalign/gap).
    const htmlEl = document.documentElement;
    const prevScrollBehavior = htmlEl.style.scrollBehavior;
    htmlEl.style.scrollBehavior = 'auto';
    const tiles = [];
    let captureErr = '';
    let bottomY = 0;
    try {
      const begin = await sendMessage({ type: 'CAPTURE_BEGIN', scale, width: vpW, height: vpH });
      if (!begin || !begin.ok) throw new Error(begin?.error || 'capture begin failed');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let y = 0;
      let i = 0;
      // Re-read the page height each step so content that lazy-loads while we
      // scroll (e.g. progressive review widgets) is still captured.
      while (i < 200) {
        maskOverlays(i);
        window.scrollTo(0, y);
        await wait(180);
        const t = await sendMessage({ type: 'CAPTURE_TILE' });
        if (!t || !t.ok) throw new Error(t?.error || 'tile capture failed');
        const sy = window.scrollY;
        tiles.push({ y: sy, dataUrl: t.dataUrl });
        bottomY = Math.max(bottomY, sy + vpH);
        if (sy + vpH >= pageHeight() - 1) break; // reached the bottom
        y += vpH;
        i++;
      }
    } catch (e) {
      captureErr = String(e.message || e);
    } finally {
      unmaskOverlays();
      await sendMessage({ type: 'CAPTURE_END' });
      htmlEl.style.scrollBehavior = prevScrollBehavior;
      window.scrollTo(0, 0);
      document.body.classList.remove('ann-exporting');
    }
    if (!tiles.length) return { ok: false, error: captureErr || 'Screenshot capture failed.' };

    const imgs = await Promise.all(tiles.map((t) => loadImage(t.dataUrl)));
    const realScale = imgs[0].naturalWidth / vpW; // actual device px per CSS px
    const S = realScale;
    const pageW = imgs[0].naturalWidth;
    const pageH = Math.round(bottomY * realScale);

    const colW = Math.round(460 * S);
    const legendH = measureLegend(items, colW, S);
    const canvas = document.createElement('canvas');
    canvas.width = pageW + colW;
    canvas.height = Math.max(pageH, legendH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    tiles.forEach((t, i) => ctx.drawImage(imgs[i], 0, Math.round(t.y * realScale)));
    for (const m of markers) drawMarker(ctx, m.x * realScale, m.y * realScale, m.number, S);
    drawLegend(ctx, items, pageW, colW, canvas.height, S);

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return { ok: false, error: 'Could not build the image.' };
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, count: markers.length };
  }

  // ---------- screenshots ----------
  async function captureShot(annotationId, opts = {}) {
    const d = pins.get(annotationId);
    if (!d || !sessionId) return;
    const fullscreen = !!opts.fullscreen;
    clearHover();

    // Default: crop to the annotated element's area. Bring it into view first,
    // then compute a padded crop rect in device pixels (clamped to the viewport).
    let crop = null;
    if (!fullscreen) {
      const el = resolveAnchorEl(d);
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise((r) => setTimeout(r, 200));
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const pad = 48; // safe area so the pin (at the element's corner) isn't cut off
        const left = Math.max(0, rect.left - pad);
        const top = Math.max(0, rect.top - pad);
        const right = Math.min(window.innerWidth, rect.right + pad);
        const bottom = Math.min(window.innerHeight, rect.bottom + pad);
        if (right > left && bottom > top) {
          crop = {
            x: Math.round(left * dpr),
            y: Math.round(top * dpr),
            w: Math.round((right - left) * dpr),
            h: Math.round((bottom - top) * dpr),
          };
        }
      }
    }

    // Hide all our overlays + pins (including this annotation's) for the capture
    // so no markers are baked into the screenshot.
    document.body.classList.add('ann-capturing');
    if (openCard) openCard.el.style.visibility = 'hidden';
    await new Promise((r) => setTimeout(r, 120));
    const resp = await sendMessage({
      type: 'CAPTURE_SHOT',
      session_id: sessionId,
      annotation_id: annotationId,
      crop,
      prev_url: d.screenshot_url || null, // replace cleanly, no orphaned file
    });
    document.body.classList.remove('ann-capturing');
    if (openCard) openCard.el.style.visibility = '';
    if (resp.ok) {
      d.screenshot_url = resp.screenshot_url;
      if (openCard && openCard.annotationId === annotationId) openThreadCard(annotationId, true);
      notifyPanel();
    } else {
      console.warn('[Annotate] screenshot skipped:', resp.error);
    }
  }

  function openZoom(url) {
    const overlay = document.createElement('div');
    overlay.className = 'ann-zoom ann-ui';
    overlay.innerHTML = `
      <div class="ann-zoom__bar">
        <button class="ann-zoom__copy" type="button" title="Copy image to clipboard">Copy image</button>
        <button class="ann-zoom__close" title="Close">${ICON.close}</button>
      </div>
      <img src="${url}" alt="Annotation screenshot">`;
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.ann-zoom__copy')) return; // handled below
      if (e.target === overlay || e.target.closest('.ann-zoom__close')) overlay.remove();
    });
    const copyBtn = overlay.querySelector('.ann-zoom__copy');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const prev = copyBtn.textContent;
      copyBtn.disabled = true;
      copyBtn.textContent = 'Copying…';
      const ok = await copyImageToClipboard(url);
      copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
      copyBtn.disabled = false;
      setTimeout(() => (copyBtn.textContent = prev), 1400);
    });
    cardHost(null).appendChild(overlay); // inside the open modal (if any) so it isn't inert
    topLayer(overlay); // above the (top-layer) annotation card
  }

  // Copy a hosted screenshot to the clipboard as a PNG so it can be pasted into
  // Jira (or anywhere). The bytes are fetched via the background (host
  // permissions bypass page CORS); a promise-backed ClipboardItem is created
  // synchronously so the user-gesture requirement is preserved. Secure context.
  async function copyImageToClipboard(url) {
    try {
      const blobPromise = (async () => {
        const r = await sendMessage({ type: 'FETCH_IMAGE', url });
        if (!r.ok || !r.base64) throw new Error(r.error || 'fetch failed');
        let blob = b64ToBlob(r.base64, r.type || 'image/png');
        if (blob.type !== 'image/png') blob = await toPngBlob(blob);
        return blob;
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      return true;
    } catch (e) {
      console.warn('[Annotate] copy image failed:', e);
      return false;
    }
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function toPngBlob(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  // ---------- session ----------
  async function rememberSession(pageUrl, sid) {
    const store = (await chrome.storage.local.get('sessions')).sessions || {};
    store[pageUrl] = sid;
    await chrome.storage.local.set({ sessions: store });
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const pageUrl = normalizeUrl(location.href);
    // Reuse the existing session for this URL if there is one (DB is the source
    // of truth — one session per page), otherwise create it.
    const found = await sendMessage({ type: 'GET_SESSION_FOR_URL', url: pageUrl });
    if (found.ok && found.session_id) {
      sessionId = found.session_id;
    } else {
      const r = await sendMessage({ type: 'CREATE_SESSION', url: pageUrl });
      if (!r.ok) return null;
      sessionId = r.session_id;
    }
    await rememberSession(pageUrl, sessionId);
    notifyPanel();
    return sessionId;
  }

  // True when an insert failed because its session row no longer exists
  // (FK violation 23503), e.g. the database was wiped out from under us.
  function isStaleSessionError(err) {
    const s = String(err || '');
    return s.includes('23503') || s.includes('session_id_fkey') || s.includes('sessions');
  }

  // Forget the cached/stored session for this page and create a fresh one.
  async function resetSession() {
    sessionId = null;
    const pageUrl = normalizeUrl(location.href);
    const store = (await chrome.storage.local.get('sessions')).sessions || {};
    delete store[pageUrl];
    await chrome.storage.local.set({ sessions: store });
    return ensureSession();
  }

  async function loadExistingSession() {
    currentAuthor = (await chrome.storage.local.get('author')).author || '';
    readMap = (await chrome.storage.local.get('reads')).reads || {};
    await loadOwnership();
    const pageUrl = normalizeUrl(location.href);
    const params = new URL(location.href).searchParams;
    let sid = params.get(PIN_PARAM);
    if (!sid) {
      const store = (await chrome.storage.local.get('sessions')).sessions || {};
      sid = store[pageUrl] || null;
    }
    // Fall back to the DB: find the session by URL even if local storage lost it.
    if (!sid) {
      const found = await sendMessage({ type: 'GET_SESSION_FOR_URL', url: pageUrl });
      if (found.ok && found.session_id) sid = found.session_id;
    }
    if (!sid) return;
    sessionId = sid;
    await rememberSession(pageUrl, sid);
    await reloadData();
    await focusFromUrl();
  }

  // If the panel sent us here to view a specific annotation, open it (and clear
  // the param so a later reload doesn't keep reopening it).
  async function focusFromUrl() {
    const params = new URL(location.href).searchParams;
    const focusId = params.get(FOCUS_PARAM);
    if (!focusId || !pins.has(focusId)) return;
    const u = new URL(location.href);
    u.searchParams.delete(FOCUS_PARAM);
    history.replaceState(null, '', u.toString());
    openThreadCard(focusId);
    // On a fresh page load the target element often isn't in the DOM yet, so a
    // single scroll no-ops. Retry until it resolves, then scroll + re-anchor.
    tryScrollToFocus(focusId, 0);
  }

  function tryScrollToFocus(id, attempt) {
    const d = pins.get(id);
    if (!d) return;
    const el = resolveAnchorEl(d);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      positionPin(id); // re-anchor the pin now that its element exists
      if (openCard && !openCard.compose && openCard.annotationId === id) positionCardToPin();
      return;
    }
    if (attempt >= 20) return; // give up after ~6s
    setTimeout(() => tryScrollToFocus(id, attempt + 1), 300);
  }

  async function reloadData() {
    if (!sessionId) return;
    const r = await sendMessage({ type: 'GET_SESSION_DATA', session_id: sessionId });
    if (!r.ok) return;
    // Hold unanchored pins back until the page has had time to render, so they
    // anchor-then-fade rather than flashing into the orphan tray.
    pinsSettled = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      pinsSettled = true;
      repositionAll();
    }, 2600);
    pins.forEach((d) => d.pinEl.remove());
    pins.clear();
    order = [];
    const byAnn = {};
    (r.comments || []).forEach((c) => (byAnn[c.annotation_id] ||= []).push(c));
    (r.annotations || []).forEach((a) => renderPin({ ...a, comments: byAnn[a.id] || [] }));
    lastSig = signatureOf(r);
    notifyPanel();
    reanchorPasses();
  }

  // ---------- live sync (polling) ----------
  // A compact fingerprint of the session so we can ignore polls that changed
  // nothing. Covers the fields that affect what's on screen.
  function signatureOf(r) {
    const a = (r.annotations || [])
      .map((x) => `${x.id}:${x.resolved ? 1 : 0}:${x.breakpoint || ''}:${x.screenshot_url || ''}:${x.note}`)
      .join('|');
    const c = (r.comments || []).map((x) => `${x.id}:${x.body}`).join('|');
    return `${a}#${c}`;
  }

  // True while the user is mid-action — we defer remote updates so we never
  // wipe a half-typed reply, an open editor, or the compose card.
  function isBusy() {
    if (openCard && openCard.compose) return true;
    if (document.querySelector('.ann-edit') || document.querySelector('.ann-menu')) return true;
    if (openCard && !openCard.compose) {
      const fields = openCard.el.querySelectorAll('.ann-composer__input, .ann-composer__name');
      for (const f of fields) {
        if (f.value.trim() || document.activeElement === f) return true;
      }
    }
    return false;
  }

  function removePinSilently(id) {
    const d = pins.get(id);
    if (!d) return;
    d.pinEl.remove();
    pins.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
  }

  // Keep pin circle numbers contiguous and in creation order after a removal.
  function renumberPins() {
    order.forEach((id, i) => {
      const d = pins.get(id);
      if (!d) return;
      d.number = i + 1;
      const span = d.pinEl.querySelector('.ann-pin__circle span');
      if (span) span.textContent = String(i + 1);
    });
  }

  // Reconcile in place (no full teardown) so pins don't flicker and an open
  // card survives. Assumes isBusy() was already checked by the caller.
  // Per-thread fingerprint, to detect whether the open card needs re-rendering.
  function annSig(a, comments) {
    return `${a.note}:${a.resolved ? 1 : 0}:${(comments || [])
      .map((c) => `${c.id}:${c.body}`)
      .join(',')}`;
  }

  function applyRemoteData(r) {
    const incoming = new Map((r.annotations || []).map((a) => [a.id, a]));
    const byAnn = {};
    (r.comments || []).forEach((c) => (byAnn[c.annotation_id] ||= []).push(c));

    // Did the currently-open thread itself change? (Only reopen if so.)
    const openId = openCard && !openCard.compose ? openCard.annotationId : null;
    let openChanged = false;
    if (openId) {
      const cur = pins.get(openId);
      const inc = incoming.get(openId);
      const oldS = cur ? annSig(cur, cur.comments) : null;
      const newS = inc ? annSig(inc, byAnn[openId] || []) : null;
      openChanged = oldS !== newS;
    }

    // Removals
    for (const id of [...pins.keys()]) {
      if (!incoming.has(id)) {
        if (openCard && !openCard.compose && openCard.annotationId === id) closeCard();
        removePinSilently(id);
      }
    }
    // Additions + field updates (iterate in created_at order for stable numbering)
    (r.annotations || []).forEach((a) => {
      const comments = byAnn[a.id] || [];
      if (!pins.has(a.id)) {
        renderPin({ ...a, comments });
      } else {
        const d = pins.get(a.id);
        Object.assign(d, {
          note: a.note,
          resolved: a.resolved,
          breakpoint: a.breakpoint,
          screenshot_url: a.screenshot_url,
          author: a.author,
          comments,
        });
        applyVisibility(a.id);
      }
    });
    renumberPins();
    layoutOrphans();

    // Refresh the open thread only if it actually changed, so new replies /
    // edits show up live without flickering on unrelated updates.
    if (openChanged && openCard && !openCard.compose && pins.has(openCard.annotationId)) {
      openThreadCard(openCard.annotationId, true);
    }
    notifyPanel();
  }

  async function pollTick() {
    if (!sessionId || document.hidden) return;
    const r = await sendMessage({ type: 'GET_SESSION_DATA', session_id: sessionId });
    if (!r.ok) return;
    const sig = signatureOf(r);
    if (sig === lastSig || isBusy()) return;
    lastSig = sig;
    applyRemoteData(r);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTick, POLL_MS);
    // Catch up immediately when the tab regains focus.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollTick();
    });
  }

  // ---------- SPA route changes ----------
  // On client-side-routed sites (Next.js, etc.) the page navigates without a
  // reload, so the content script stays alive. Without this, a new pin would be
  // saved under the *first* page's session. We watch for URL changes and rebind
  // to the right session for the new page.
  async function onUrlChanged() {
    closeCard();
    pins.forEach((d) => d.pinEl.remove());
    pins.clear();
    order = [];
    sessionId = null;
    lastSig = null;
    await loadExistingSession(); // re-resolves the session for the new URL, then reloads
  }

  function checkUrlNow() {
    const u = normalizeUrl(location.href);
    if (u === watchedUrl) return;
    watchedUrl = u;
    onUrlChanged();
  }

  function startUrlWatch() {
    watchedUrl = normalizeUrl(location.href);
    // pushState/replaceState don't fire events; a 1s string check is cheap and
    // reliable across isolated-world boundaries. popstate covers back/forward.
    setInterval(checkUrlNow, 1000);
    window.addEventListener('popstate', checkUrlNow);
  }

  // ---------- mode ----------
  function setActive(on) {
    if (active === on) return;
    active = on;
    document.body.classList.toggle('ann-mode', on);
    if (on) showToolbar();
    else {
      clearHover();
      hideToolbar();
    }
    // Broadcast so the side panel's Start/Stop button reflects the change no
    // matter what triggered it (button, Alt+A hotkey, or Esc).
    chrome.runtime.sendMessage({ type: 'MODE_CHANGED', active: on }).catch(() => {});
  }

  // ---------- list payload for the side panel ----------
  function listPayload() {
    return order.map((id) => {
      const d = pins.get(id);
      return {
        id,
        number: d.number,
        author: d.author || 'Anonymous',
        preview: d.note,
        created_at: d.created_at,
        latest_at: latestActivity(d),
        resolved: !!d.resolved,
        reply_count: (d.comments || []).length,
        is_new: isAnnNew(d),
        breakpoint: d.breakpoint || null,
        screenshot_url: d.screenshot_url || null,
      };
    });
  }

  // ---------- global listeners ----------
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);

  // Robustly tell whether an event interacts with our own UI. Uses the full
  // composed path (not just e.target), so focus/retarget shenanigans inside a
  // site modal can't make a click on our card look like a page click.
  function eventOnOwnUi(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) {
      if (n && n.classList && n.classList.contains && n.classList.contains('ann-ui')) return true;
    }
    return isOwnUi(e.target);
  }

  // Shield our cards from the host page's focus traps and outside-click closers,
  // and remember when a pointer interaction starts on our UI — so the resulting
  // click is never mistaken for a page click that should spawn a new pin (even
  // if the site moves focus between mousedown and click). Window-capture runs
  // before the site's own document/window handlers.
  let pointerStartedOnOwnUi = false;
  ['pointerdown', 'mousedown'].forEach((type) =>
    window.addEventListener(
      type,
      (e) => {
        if (eventOnOwnUi(e)) {
          pointerStartedOnOwnUi = true;
          e.stopPropagation();
        } else {
          pointerStartedOnOwnUi = false;
        }
      },
      true
    )
  );
  window.addEventListener(
    'focusin',
    (e) => {
      if (eventOnOwnUi(e)) e.stopPropagation();
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      // Ignore clicks on our own UI, or whose pointer started on it.
      if (eventOnOwnUi(e) || pointerStartedOnOwnUi) {
        pointerStartedOnOwnUi = false;
        return;
      }
      if (active) {
        e.preventDefault();
        e.stopPropagation();
        clearHover();
        showComposeCard(e.target);
      } else if (openCard) {
        closeCard();
      }
    },
    true
  );

  // Capture at the window phase so we get Esc before the host page (SPAs/modals
  // often swallow it). Only consume it when we actually act on it.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const zoom = document.querySelector('.ann-zoom');
      if (zoom) {
        zoom.remove();
        e.stopPropagation();
        e.preventDefault();
      } else if (openCard) {
        closeCard();
        e.stopPropagation();
        e.preventDefault();
      } else if (active) {
        setActive(false); // setActive broadcasts MODE_CHANGED
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );

  window.addEventListener('scroll', repositionAll, true);
  window.addEventListener('resize', repositionAll);

  // Client-rendered (SPA) pages mount content after our script runs, so a pin's
  // target element may not exist yet on load. Re-anchor on DOM changes (debounced)
  // plus a few timed passes, so pins attach as the page fills in.
  let reanchorTimer = null;
  function scheduleReanchor() {
    clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(repositionAll, 250);
  }
  const domObserver = new MutationObserver(scheduleReanchor);
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  function reanchorPasses() {
    [200, 600, 1200, 2500, 4000].forEach((t) => setTimeout(repositionAll, t));
  }

  // ---------- messages from side panel ----------
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'GET_STATE':
          sendResponse({
            ok: true,
            active,
            session_id: sessionId,
            pin_count: pins.size,
            show_resolved: showResolved,
          });
          break;
        case 'GET_LIST':
          sendResponse({ ok: true, items: listPayload(), show_resolved: showResolved });
          break;
        case 'TOGGLE_MODE': {
          const next = !active;
          if (next) await ensureSession();
          setActive(next);
          sendResponse({ ok: true, active, session_id: sessionId, pin_count: pins.size });
          break;
        }
        case 'SET_SHOW_RESOLVED':
          showResolved = !!msg.value;
          pins.forEach((_, id) => applyVisibility(id));
          layoutOrphans();
          sendResponse({ ok: true });
          break;
        case 'SET_VIEW_BREAKPOINT':
          viewBreakpoint = msg.breakpoint || null;
          pins.forEach((_, id) => applyVisibility(id));
          layoutOrphans();
          if (openCard && !openCard.compose) {
            const d = pins.get(openCard.annotationId);
            if (!d || d.hidden) closeCard();
          }
          sendResponse({ ok: true });
          break;
        case 'FOCUS_PIN':
          scrollToPin(msg.annotation_id);
          openThreadCard(msg.annotation_id);
          sendResponse({ ok: true });
          break;
        case 'OPEN_ZOOM':
          openZoom(msg.url);
          sendResponse({ ok: true });
          break;
        case 'GET_EXPORT_DATA':
          sendResponse({
            ok: true,
            page_url: normalizeUrl(location.href),
            session_id: sessionId,
            items: order.map((id) => {
              const d = pins.get(id);
              return {
                number: d.number,
                title: d.title || null,
                author: d.author,
                note: d.note,
                created_at: d.created_at || null,
                element_tag: d.element_tag,
                element_text_preview: d.element_text_preview,
                selector: d.selector,
                resolved: !!d.resolved,
                breakpoint: d.breakpoint || null,
                screenshot_url: d.screenshot_url || null,
                replies: (d.comments || []).map((c) => ({
                  author: c.author,
                  body: c.body,
                  created_at: c.created_at,
                })),
              };
            }),
          });
          break;
        case 'EXPORT_FIGMA': {
          const res = await exportToFigma();
          sendResponse(res);
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown: ${msg.type}` });
      }
    })();
    return true;
  });

  loadExistingSession();
  startPolling();
  startUrlWatch();
})();
