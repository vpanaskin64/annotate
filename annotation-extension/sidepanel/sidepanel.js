// Side panel — the Annotations list + controls. Talks to the active tab's
// content script via chrome.tabs.sendMessage.

const PIN_PARAM = 'annotation_session';
const FOCUS_PARAM = 'annotation_focus';

const el = (id) => document.getElementById(id);
const countEl = el('count');
const toggleBtn = el('toggle-btn');
const controlsBtn = el('controls-btn');
const controls = el('controls');
const sessionUrlInput = el('session-url');
const copyBtn = el('copy-btn');
const exportBtn = el('export-btn');
const cameraBtn = el('camera-btn');
const jiraBtn = el('jira-btn');
const listEl = el('list');
const emptyEl = el('empty');
const warningEl = el('warning');
const resolvedToggle = el('resolved-toggle');
const bpSeg = el('bp-seg');

let tab = null;
let selectedId = null;
let panelBp = 'desktop'; // active breakpoint, used to filter the list

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete(PIN_PARAM);
    u.searchParams.delete(FOCUS_PARAM);
    return u.toString();
  } catch {
    return url;
  }
}
function buildSessionUrl(pageUrl, sid) {
  const u = new URL(pageUrl);
  u.searchParams.set(PIN_PARAM, sid);
  return u.toString();
}
function buildFocusUrl(pageUrl, sid, annId) {
  const u = new URL(pageUrl);
  u.searchParams.set(PIN_PARAM, sid);
  u.searchParams.set(FOCUS_PARAM, annId);
  return u.toString();
}
// A short, readable label for a page group header.
function pageLabel(url) {
  try {
    const u = new URL(url);
    return (u.pathname || '/') + (u.search || '');
  } catch {
    return url;
  }
}
function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
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
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!tab) return resolve({ ok: false, error: 'No active tab' });
    chrome.tabs.sendMessage(tab.id, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: 'No response' });
    });
  });
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: 'No response' });
    });
  });
}

function showWarning(text) {
  warningEl.textContent = text || '';
  warningEl.style.display = text ? 'block' : 'none';
}

function setActiveUi(active) {
  toggleBtn.textContent = active ? 'Stop annotating' : 'Start annotating';
  toggleBtn.classList.toggle('is-active', active);
}

function setSessionLink(sessionId) {
  if (sessionId && tab) {
    sessionUrlInput.value = buildSessionUrl(normalizeUrl(tab.url), sessionId);
  } else {
    sessionUrlInput.value = '';
  }
}

function itemRow(it, page, isCurrentPage, onAfterSelect) {
  const row = document.createElement('div');
  row.dataset.id = it.id;
  row.className =
    'item' + (it.id === selectedId ? ' is-selected' : '') + (it.resolved ? ' is-resolved' : '');

  const badge = document.createElement('div');
  badge.className = 'item__pin';
  badge.textContent = it.number;

  const content = document.createElement('div');
  content.className = 'item__content';

  const head = document.createElement('div');
  head.className = 'item__head';

  const idWrap = document.createElement('div');
  idWrap.className = 'item__id';
  const av = document.createElement('div');
  av.className = 'item__avatar';
  av.style.background = avatarColor(it.author);
  av.textContent = initials(it.author);
  const name = document.createElement('span');
  name.className = 'item__author';
  name.textContent = it.author;
  idWrap.append(av, name);

  const meta = document.createElement('div');
  meta.className = 'item__meta';
  if (it.is_new) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = 'NEW';
    meta.appendChild(b);
  }
  const time = document.createElement('span');
  time.className = 'item__time';
  time.textContent = relTime(it.latest_at || it.created_at);
  meta.appendChild(time);

  head.append(idWrap, meta);

  const preview = document.createElement('div');
  preview.className = 'item__preview';
  preview.textContent = it.preview;

  content.append(head, preview);

  if (it.screenshot_url) {
    const shot = document.createElement('div');
    shot.className = 'item__shot';
    shot.innerHTML = `<img src="${it.screenshot_url}" alt="Screenshot">`;
    shot.title = 'Open full screenshot';
    shot.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Prefer the in-page zoom modal; fall back to a new tab if the content
      // script isn't reachable (e.g. annotation lives on another page).
      const r = isCurrentPage ? await sendToTab({ type: 'OPEN_ZOOM', url: it.screenshot_url }) : { ok: false };
      if (!r.ok) chrome.tabs.create({ url: it.screenshot_url });
    });
    content.appendChild(shot);
  }

  if (it.reply_count > 0) {
    const rc = document.createElement('div');
    rc.className = 'item__replies';
    rc.textContent = `${it.reply_count} repl${it.reply_count === 1 ? 'y' : 'ies'}`;
    content.appendChild(rc);
  }

  row.append(badge, content);
  row.addEventListener('click', async () => {
    selectedId = it.id;
    if (isCurrentPage) {
      // Already on this page — just focus the pin (no navigation/reload).
      await sendToTab({ type: 'FOCUS_PIN', annotation_id: it.id });
      highlightSelected();
    } else if (tab) {
      // Different page — navigate there; the content script auto-opens the pin.
      chrome.tabs.update(tab.id, { url: buildFocusUrl(page.url, page.session_id, it.id) });
      onAfterSelect();
    }
  });
  return row;
}

// Toggle the selected highlight on existing rows without re-rendering the list
// (used for live sync when a pin/card is opened on the page).
function highlightSelected() {
  listEl.querySelectorAll('.item').forEach((r) => {
    const on = r.dataset.id === selectedId;
    r.classList.toggle('is-selected', on);
    if (on) r.scrollIntoView({ block: 'nearest' });
  });
}

function renderPages(pages, showResolved, currentUrl, currentSessionId) {
  listEl.innerHTML = '';

  // Filter items per group; drop empty groups. Keep the stable order the
  // backend returns (by URL) — don't move the current page around.
  const groups = pages
    .map((p) => ({
      ...p,
      items: p.items.filter(
        (it) => (showResolved || !it.resolved) && (!it.breakpoint || it.breakpoint === panelBp)
      ),
    }))
    .filter((p) => p.items.length);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  countEl.textContent = total;
  emptyEl.style.display = total ? 'none' : 'block';

  const rerender = () => renderPages(pages, showResolved, currentUrl, currentSessionId);

  for (const page of groups) {
    // "This page" is matched by session id first (robust across SPA/canonical
    // URL differences), falling back to a URL compare.
    const isCurrentPage =
      (!!currentSessionId && page.session_id === currentSessionId) || page.url === currentUrl;

    const group = document.createElement('div');
    group.className = 'group';

    const head = document.createElement('div');
    head.className = 'group__head';
    const label = document.createElement('span');
    label.className = 'group__label';
    label.textContent = pageLabel(page.url);
    label.title = page.url;
    head.appendChild(label);
    if (isCurrentPage) {
      const here = document.createElement('span');
      here.className = 'group__here';
      here.textContent = 'This page';
      head.appendChild(here);
    }
    const gcount = document.createElement('span');
    gcount.className = 'group__count';
    gcount.textContent = page.items.length;
    head.appendChild(gcount);
    group.appendChild(head);

    for (const it of page.items) group.appendChild(itemRow(it, page, isCurrentPage, rerender));
    listEl.appendChild(group);
  }
}

async function refresh() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;

  if (!tab || /^chrome:|^edge:|^about:|^chrome-extension:|^https:\/\/chrome\.google\.com/.test(tab.url || '')) {
    showWarning('Open a regular web page to annotate.');
    toggleBtn.disabled = exportBtn.disabled = true;
    listEl.innerHTML = '';
    countEl.textContent = '0';
    return;
  }
  toggleBtn.disabled = exportBtn.disabled = false;

  const state = await sendToTab({ type: 'GET_STATE' });
  if (!state.ok) {
    showWarning('Reload the page to use annotations here.');
    listEl.innerHTML = '';
    return;
  }
  showWarning('');
  setActiveUi(state.active);
  setSessionLink(state.session_id);
  resolvedToggle.setAttribute('aria-checked', String(state.show_resolved));
  resolvedToggle.classList.toggle('is-on', state.show_resolved);
  await syncBreakpointUi();

  // List spans every annotated page on this site, grouped by page.
  let origin = '';
  try {
    origin = new URL(tab.url).origin;
  } catch {
    origin = '';
  }
  const res = origin
    ? await sendBg({ type: 'GET_SITE_PAGES', origin })
    : { ok: false };
  if (res.ok) {
    renderPages(res.pages, state.show_resolved, normalizeUrl(tab.url), state.session_id);
  } else {
    // Fall back to the current page's own list if the cross-page query fails.
    const list = await sendToTab({ type: 'GET_LIST' });
    if (list.ok) renderPages([{ url: normalizeUrl(tab.url), session_id: state.session_id, items: list.items }], list.show_resolved, normalizeUrl(tab.url), state.session_id);
  }
}

// ----- breakpoint -----
function markBp(bp) {
  panelBp = bp;
  bpSeg.querySelectorAll('.seg__btn').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.bp === bp)
  );
}
async function syncBreakpointUi() {
  if (!tab) return;
  const r = await sendBg({ type: 'GET_BREAKPOINT', tab_id: tab.id });
  if (r.ok) {
    markBp(r.breakpoint);
    sendToTab({ type: 'SET_VIEW_BREAKPOINT', breakpoint: r.breakpoint });
  }
}
bpSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg__btn');
  if (!btn || !tab) return;
  const bp = btn.dataset.bp;
  markBp(bp);
  const r = await sendBg({ type: 'SET_BREAKPOINT', tab_id: tab.id, breakpoint: bp });
  if (!r.ok) {
    showWarning(r.error || 'Could not switch breakpoint.');
    syncBreakpointUi();
    return;
  }
  markBp(r.breakpoint);
  await sendToTab({ type: 'SET_VIEW_BREAKPOINT', breakpoint: r.breakpoint });
  refresh(); // re-render the list with the new breakpoint filter
});

// ----- actions -----
toggleBtn.addEventListener('click', async () => {
  const r = await sendToTab({ type: 'TOGGLE_MODE' });
  if (!r.ok) return showWarning(r.error || 'Could not toggle mode.');
  setActiveUi(r.active);
  setSessionLink(r.session_id);
});

controlsBtn.addEventListener('click', () => {
  controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
});

copyBtn.addEventListener('click', async () => {
  if (!sessionUrlInput.value) return;
  try {
    await navigator.clipboard.writeText(sessionUrlInput.value);
  } catch {
    sessionUrlInput.select();
    document.execCommand('copy');
  }
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});

resolvedToggle.addEventListener('click', async () => {
  const next = !(resolvedToggle.getAttribute('aria-checked') === 'true');
  resolvedToggle.setAttribute('aria-checked', String(next));
  resolvedToggle.classList.toggle('is-on', next);
  await sendToTab({ type: 'SET_SHOW_RESOLVED', value: next });
  refresh();
});

exportBtn.addEventListener('click', async () => {
  const data = await sendToTab({ type: 'GET_EXPORT_DATA' });
  if (!data.ok) return showWarning(data.error || 'Nothing to export.');
  const md = buildMarkdown(data);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `annotations-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// Camera icon → Export the page to Figma (flat 2× PNG capture).
cameraBtn.addEventListener('click', async () => {
  const title = cameraBtn.title;
  cameraBtn.disabled = true;
  cameraBtn.classList.add('is-busy');
  cameraBtn.title = 'Capturing…';
  const res = await sendToTab({ type: 'EXPORT_FIGMA' });
  cameraBtn.disabled = false;
  cameraBtn.classList.remove('is-busy');
  cameraBtn.title = title;
  if (!res || !res.ok) showWarning(res?.error || 'Export failed.');
  else showWarning('');
});

// Jira icon → copy all annotations as Jira-flavored Markdown to the clipboard.
jiraBtn.addEventListener('click', async () => {
  const data = await sendToTab({ type: 'GET_EXPORT_DATA' });
  if (!data.ok) return showWarning(data.error || 'Nothing to copy.');
  if (!data.items.length) return showWarning('No annotations on this page to copy.');
  const md = buildJiraMarkdown(data);
  let copied = false;
  try {
    await navigator.clipboard.writeText(md);
    copied = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = md;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    ta.remove();
  }
  if (copied) {
    showWarning('');
    flashIconbtn(jiraBtn, `Copied ${data.items.length} annotation${data.items.length === 1 ? '' : 's'} for Jira`);
  } else {
    showWarning('Could not copy to clipboard.');
  }
});

// Briefly reflect a success message in the button's tooltip.
function flashIconbtn(btn, msg) {
  const title = btn.dataset.title || btn.title;
  btn.dataset.title = title;
  btn.title = msg;
  btn.classList.add('is-ok');
  setTimeout(() => {
    btn.title = btn.dataset.title;
    btn.classList.remove('is-ok');
  }, 1600);
}

function buildMarkdown(data) {
  const out = ['# Annotations', '', `**Page:** ${data.page_url}`];
  if (data.session_id) out.push(`**Session:** ${buildSessionUrl(data.page_url, data.session_id)}`);
  out.push(`**Exported:** ${new Date().toISOString()}`, '');
  if (!data.items.length) {
    out.push('_No annotations._');
    return out.join('\n');
  }
  for (const it of data.items) {
    out.push(`## ${it.number}.${it.resolved ? ' ✅ Resolved' : ''}`, '');
    out.push(`**${it.author || 'Anonymous'}:** ${it.note}`, '');
    if (it.element_tag) out.push(`- Element: \`<${it.element_tag.toLowerCase()}>\``);
    if (it.element_text_preview) out.push(`- Text: "${it.element_text_preview}"`);
    out.push(`- Selector: \`${it.selector}\``);
    for (const r of it.replies || []) out.push(`  - **${r.author || 'Anonymous'}:** ${r.body}`);
    out.push('');
  }
  return out.join('\n');
}

// Jira Cloud's editor auto-converts pasted Markdown, so we emit clean GFM:
// headings, bold, lists, inline code. Kept compact and paste-friendly.
function buildJiraMarkdown(data) {
  const out = [`# Annotations (${data.items.length})`, ''];
  if (data.session_id) out.push(`**Session:** ${buildSessionUrl(data.page_url, data.session_id)}`);
  out.push('', '---', '');

  const bpBadge = (bp) => {
    if (bp === 'mobile') return ' `📱 Mobile`';
    if (bp === 'desktop') return ' `🖥️ Desktop`';
    return '';
  };

  for (const it of data.items) {
    const heading = it.title ? it.title : (it.note ? it.note.split('\n')[0].slice(0, 80) : `Annotation ${it.number}`);
    out.push(`### ${it.number}. ${heading}${bpBadge(it.breakpoint)}${it.resolved ? '  ✅ Resolved' : ''}`, '');

    if (it.title && it.note) out.push(it.note, '');
    else if (!it.title && it.note) { /* note already used as heading */ }

    if (it.element_tag) {
      let elLine = `**Element:** \`<${it.element_tag.toLowerCase()}>\``;
      if (it.element_text_preview) elLine += ` — "${it.element_text_preview}"`;
      out.push(elLine, '');
    }

    if (it.screenshot_url) out.push(`![Screenshot ${it.number}](${it.screenshot_url})`, '');

    if (it.replies && it.replies.length) {
      out.push(`**Replies (${it.replies.length}):**`);
      for (const r of it.replies) out.push(`- **${r.author || 'Anonymous'}:** ${r.body}`);
      out.push('');
    }
    out.push('---', '');
  }
  return out.join('\n').trim() + '\n';
}

// ----- live updates -----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LIST_CHANGED' || msg.type === 'MODE_CHANGED') refresh();
  // Pin/card opened or closed on the page → sync the list highlight in place.
  if (msg.type === 'ACTIVE_ANNOTATION') {
    selectedId = msg.annotation_id || null;
    highlightSelected();
  }
});
chrome.tabs.onActivated.addListener(() => {
  selectedId = null;
  refresh();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && tab && tabId === tab.id) refresh();
});

refresh();
