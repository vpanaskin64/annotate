// Background service worker — all Supabase REST calls funnel through here.
// Content script and popup talk to it via chrome.runtime.sendMessage.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// Explicit column lists for bulk reads. The secret `author_token` is
// deliberately excluded so it never leaves the database.
// Base columns that have always existed. ANNOTATION_COLS adds `anchor`, which
// is newer — if the DB hasn't had that column added yet, we transparently fall
// back to the base list so reads/inserts keep working.
const ANNOTATION_COLS_BASE =
  'id,session_id,selector,note,element_tag,element_text_preview,position_x,position_y,author,resolved,breakpoint,screenshot_url,created_at';
// Optional columns added by later migrations; reads fall back to BASE if absent.
const ANNOTATION_COLS = `${ANNOTATION_COLS_BASE},anchor,title`;

// PostgREST reports an absent column as "Could not find the 'X' column ...".
// Returns the column name, or null.
function missingColumn(status, body) {
  if (status !== 400 || typeof body !== 'string') return null;
  const m = body.match(/Could not find the '([^']+)' column/);
  return m ? m[1] : null;
}

// Insert a row, transparently dropping any column the DB doesn't have yet
// (e.g. `anchor` or `author_token` if that migration hasn't been run). Keeps
// the extension working against an older schema instead of hard-failing.
async function insertRow(table, headers, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const payload = { ...body };
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (res.ok) return (await res.json())[0];
    const text = await res.text();
    const col = missingColumn(res.status, text);
    if (col && col in payload) {
      delete payload[col];
      continue;
    }
    throw new Error(`insert ${table} ${res.status}: ${text}`);
  }
  throw new Error(`insert ${table}: unresolved missing columns`);
}
const COMMENT_COLS = 'id,annotation_id,author,body,created_at';

// This project has no real auth, so authorship is proven by possession of a
// per-client secret token. It's generated once, stored locally, written onto
// every row this client creates, and sent as the `x-author-token` header on
// update/delete so RLS can verify ownership.
async function getAuthorToken() {
  const { author_token } = await chrome.storage.local.get('author_token');
  if (author_token) return author_token;
  const token = crypto.randomUUID();
  await chrome.storage.local.set({ author_token: token });
  return token;
}

async function ownedHeaders(extra) {
  const token = await getAuthorToken();
  return { ...HEADERS, 'x-author-token': token, ...(extra || {}) };
}

function isConfigured() {
  return (
    SUPABASE_URL &&
    !SUPABASE_URL.includes('YOUR_PROJECT') &&
    SUPABASE_ANON_KEY &&
    SUPABASE_ANON_KEY !== 'YOUR_ANON_KEY'
  );
}

async function createSession(url) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`createSession ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

// The (canonical) session for a page URL — earliest one, so it's stable.
async function getSessionForUrl(url) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sessions?url=eq.${encodeURIComponent(
      url
    )}&order=created_at.asc&limit=1&select=*`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`getSessionForUrl ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function getSession(sessionId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&select=*`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`getSession ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

// Select annotations for a PostgREST filter, retrying with only the base
// columns if an optional one (anchor/title) doesn't exist in this DB yet.
async function selectAnnotations(filter) {
  const base = `${SUPABASE_URL}/rest/v1/annotations?${filter}&order=created_at.asc`;
  let res = await fetch(`${base}&select=${ANNOTATION_COLS}`, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    if (!missingColumn(res.status, body)) {
      throw new Error(`getAnnotations ${res.status}: ${body}`);
    }
    res = await fetch(`${base}&select=${ANNOTATION_COLS_BASE}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`getAnnotations ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function getAnnotations(sessionId) {
  return selectAnnotations(`session_id=eq.${sessionId}`);
}

async function addAnnotation(payload) {
  const token = await getAuthorToken();
  const headers = { ...HEADERS, 'x-author-token': token, Prefer: 'return=representation' };
  return insertRow('annotations', headers, { ...payload, author_token: token });
}

async function updateAnnotation(annotationId, fields) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/annotations?id=eq.${annotationId}`,
    {
      method: 'PATCH',
      headers: await ownedHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(fields),
    }
  );
  if (!res.ok) throw new Error(`updateAnnotation ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

async function deleteAnnotation(annotationId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/annotations?id=eq.${annotationId}`,
    { method: 'DELETE', headers: await ownedHeaders() }
  );
  if (!res.ok) throw new Error(`deleteAnnotation ${res.status}: ${await res.text()}`);
  return true;
}

async function getComments(annotationIds) {
  if (!annotationIds.length) return [];
  const list = annotationIds.join(',');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/comments?annotation_id=in.(${list})&order=created_at.asc&select=${COMMENT_COLS}`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`getComments ${res.status}: ${await res.text()}`);
  return res.json();
}

async function addComment(payload) {
  const token = await getAuthorToken();
  const headers = { ...HEADERS, 'x-author-token': token, Prefer: 'return=representation' };
  return insertRow('comments', headers, { ...payload, author_token: token });
}

async function updateComment(commentId, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${commentId}`, {
    method: 'PATCH',
    headers: await ownedHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateComment ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

async function deleteComment(commentId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${commentId}`, {
    method: 'DELETE',
    headers: await ownedHeaders(),
  });
  if (!res.ok) throw new Error(`deleteComment ${res.status}: ${await res.text()}`);
  return true;
}

// Annotations + their comments for a whole session, in one round-trip pair.
// Comments are best-effort: if that table/query fails (e.g. migration-002 not
// run yet) we still return the annotations rather than wiping the whole load.
async function getSessionData(sessionId) {
  const annotations = await getAnnotations(sessionId);
  let comments = [];
  try {
    comments = await getComments(annotations.map((a) => a.id));
  } catch (e) {
    console.warn('[Annotate] comments unavailable, loading annotations only:', e);
  }
  return { annotations, comments };
}

async function updateAnnotationShot(annotationId, url) {
  return updateAnnotation(annotationId, { screenshot_url: url });
}

// Strip the params we add to URLs so pages collapse to one canonical key.
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('annotation_session');
    u.searchParams.delete('annotation_focus');
    return u.toString();
  } catch {
    return url;
  }
}

// Every annotated page on a site (same origin), grouped by page. Powers the
// side panel's cross-page list. Item shape mirrors the content script's
// listPayload so the panel renders both the same way.
async function getSitePages(origin) {
  const NEW_MS = 60 * 60 * 1000;
  const sres = await fetch(
    `${SUPABASE_URL}/rest/v1/sessions?url=like.${encodeURIComponent(origin)}*&order=created_at.asc&select=id,url,created_at`,
    { headers: HEADERS }
  );
  if (!sres.ok) throw new Error(`getSitePages sessions ${sres.status}: ${await sres.text()}`);
  const sessions = await sres.json();
  if (!sessions.length) return { pages: [] };

  // Earliest session per canonical URL is the one annotations live under.
  const canonByUrl = new Map();
  for (const s of sessions) {
    const key = canonicalUrl(s.url);
    if (!canonByUrl.has(key)) canonByUrl.set(key, s);
  }
  const urlBySession = new Map(sessions.map((s) => [s.id, canonicalUrl(s.url)]));
  const ids = sessions.map((s) => s.id);

  const annotations = await selectAnnotations(`session_id=in.(${ids.join(',')})`);

  let comments = [];
  if (annotations.length) {
    try {
      comments = await getComments(annotations.map((a) => a.id));
    } catch (e) {
      console.warn('[Annotate] comments unavailable for site list:', e);
    }
  }
  const commentsByAnn = {};
  comments.forEach((c) => (commentsByAnn[c.annotation_id] ||= []).push(c));

  const reads = (await chrome.storage.local.get('reads')).reads || {};

  // Group annotations by their canonical page URL, numbering within each page.
  const annsByUrl = new Map();
  for (const a of annotations) {
    const key = urlBySession.get(a.session_id);
    if (key == null) continue;
    if (!annsByUrl.has(key)) annsByUrl.set(key, []);
    annsByUrl.get(key).push(a);
  }

  const pages = [];
  for (const [url, anns] of annsByUrl) {
    const items = anns.map((a, i) => {
      const cs = commentsByAnn[a.id] || [];
      const latest_at = [a.created_at, ...cs.map((c) => c.created_at)].sort().pop();
      const read = reads[a.id];
      const is_new =
        Date.now() - new Date(latest_at).getTime() < NEW_MS &&
        (!read || new Date(latest_at).getTime() > new Date(read).getTime());
      return {
        id: a.id,
        number: i + 1,
        author: a.author || 'Anonymous',
        preview: a.note,
        created_at: a.created_at,
        latest_at,
        resolved: !!a.resolved,
        reply_count: cs.length,
        is_new,
        breakpoint: a.breakpoint || null,
        screenshot_url: a.screenshot_url || null,
      };
    });
    const canon = canonByUrl.get(url);
    pages.push({ url, session_id: canon ? canon.id : anns[0].session_id, items });
  }
  pages.sort((a, b) => a.url.localeCompare(b.url));
  return { pages };
}

// Extract the storage object path from a public screenshot URL.
function shotPathFromUrl(url) {
  const m = /\/annotation-shots\/([^?]+)/.exec(url || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Delete a screenshot object from Storage by its object path.
async function deleteShotPath(path) {
  if (!path) return;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/annotation-shots/${path}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  // 404 = already gone; treat as success.
  if (!res.ok && res.status !== 404) throw new Error(`delete shot ${res.status}: ${await res.text()}`);
}

// Crop a PNG data URL to a device-pixel rect using OffscreenCanvas.
async function cropPngDataUrl(dataUrl, crop) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const x = Math.max(0, Math.min(crop.x, bmp.width - 1));
  const y = Math.max(0, Math.min(crop.y, bmp.height - 1));
  const w = Math.max(1, Math.min(crop.w, bmp.width - x));
  const h = Math.max(1, Math.min(crop.h, bmp.height - y));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await out.arrayBuffer());
}

// Capture the visible tab and upload the PNG to Supabase Storage. When `crop`
// (a device-pixel rect) is given, only that region is saved. Each capture goes
// to a UNIQUE path (…-<timestamp>.png) so a re-capture never collides with a
// previously deleted object's CDN-cached path; the previous file (`prevUrl`) is
// deleted afterward so nothing is orphaned.
async function captureAndUpload(windowId, sessionId, annotationId, crop, prevUrl) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  let bytes;
  if (crop) {
    try {
      bytes = await cropPngDataUrl(dataUrl, crop);
    } catch (e) {
      console.warn('[Annotate] crop failed, saving full frame:', e);
    }
  }
  if (!bytes) {
    const base64 = dataUrl.split(',')[1];
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  const path = `${sessionId}/${annotationId}-${Date.now()}.png`;
  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/annotation-shots/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!upRes.ok) throw new Error(`upload ${upRes.status}: ${await upRes.text()}`);
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/annotation-shots/${path}`;
  await updateAnnotationShot(annotationId, publicUrl);
  // Clean up the file we just replaced (best-effort; don't fail the capture).
  const prevPath = shotPathFromUrl(prevUrl);
  if (prevPath && prevPath !== path) deleteShotPath(prevPath).catch(() => {});
  return publicUrl;
}

// ---------- device emulation (DevTools-style, via chrome.debugger) ----------
const PROTOCOL = '1.3';
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const emulated = new Map(); // tabId -> 'mobile' | 'desktop'

function dbg(method, target, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](target, ...(params ? [params] : []), (...args) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(args[0]);
    });
  });
}
const dbgSend = (target, cmd, params) =>
  new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, cmd, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });

// Full-page capture is done by stitching viewport-sized tiles as the content
// script scrolls — reliable across SPAs, lazy content, and sticky layers
// (captureBeyondViewport tiles/duplicates on some pages, and a full-height
// viewport makes vh-based sections balloon). These three calls bracket it.
const captureSessions = new Map(); // tabId -> { wasAttached, wasMobile }

async function captureBegin(tabId, scale, width, height) {
  const target = { tabId };
  const wasAttached = emulated.has(tabId);
  const wasMobile = emulated.get(tabId) === 'mobile';
  if (!wasAttached) await dbg('attach', target, PROTOCOL);
  // Fix the rendered viewport to the real size at the requested DPI — same
  // dimensions as the live viewport, so nothing reflows.
  await dbgSend(target, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: wasMobile,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  captureSessions.set(tabId, { wasAttached, wasMobile });
  return { ok: true };
}

async function captureTile(tabId) {
  const shot = await dbgSend({ tabId }, 'Page.captureScreenshot', { format: 'png' });
  return { dataUrl: `data:image/png;base64,${shot.data}` };
}

async function captureEnd(tabId) {
  const target = { tabId };
  const s = captureSessions.get(tabId) || {};
  try {
    if (s.wasMobile) {
      await dbgSend(target, 'Emulation.setDeviceMetricsOverride', {
        ...MOBILE,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      });
    } else {
      await dbgSend(target, 'Emulation.clearDeviceMetricsOverride');
    }
  } catch (e) {
    /* tab may have navigated */
  }
  if (!s.wasAttached) {
    try {
      await dbg('detach', target);
    } catch (e) {
      /* already gone */
    }
  }
  captureSessions.delete(tabId);
  return { ok: true };
}

async function setBreakpoint(tabId, breakpoint) {
  const target = { tabId };
  if (breakpoint === 'mobile') {
    if (!emulated.has(tabId)) await dbg('attach', target, PROTOCOL);
    await dbgSend(target, 'Emulation.setDeviceMetricsOverride', { ...MOBILE, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
    await dbgSend(target, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    emulated.set(tabId, 'mobile');
  } else {
    if (emulated.has(tabId)) {
      try {
        await dbgSend(target, 'Emulation.clearDeviceMetricsOverride');
        await dbgSend(target, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      } catch (e) {
        /* tab may have navigated */
      }
      try {
        await dbg('detach', target);
      } catch (e) {
        /* already detached */
      }
      emulated.delete(tabId);
    }
  }
  return emulated.get(tabId) || 'desktop';
}

// If the user dismisses the debugger banner (or the tab closes), reset state.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) emulated.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => emulated.delete(tabId));

// Clicking the toolbar icon opens the side panel (Annotations).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[Annotate] sidePanel behavior:', e));
});

// Keyboard shortcut → toggle annotation mode on the active tab.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-annotation') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || /^chrome:|^edge:|^about:|^chrome-extension:/.test(tab.url || '')) return;
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_MODE' }, () => {
      void chrome.runtime.lastError; // ignore if content script not present
    });
  });
});

// Messages handled elsewhere (side-panel-bound broadcasts) — ignore in background.
const IGNORED = new Set(['PIN_COUNT', 'MODE_CHANGED', 'LIST_CHANGED']);

// Route messages. Always respond with { ok, ... } or { ok:false, error }.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (IGNORED.has(msg.type)) return false;
  (async () => {
    try {
      const NO_CONFIG = new Set([
        'SET_BREAKPOINT',
        'GET_BREAKPOINT',
        'CAPTURE_BEGIN',
        'CAPTURE_TILE',
        'CAPTURE_END',
      ]);
      if (!NO_CONFIG.has(msg.type) && !isConfigured()) {
        throw new Error(
          'Supabase not configured. Edit background/config.js with your Project URL and anon key.'
        );
      }
      switch (msg.type) {
        case 'CREATE_SESSION': {
          const session = await createSession(msg.url);
          sendResponse({ ok: true, session_id: session.id, url: session.url });
          break;
        }
        case 'GET_SESSION_URL': {
          const session = await getSession(msg.session_id);
          sendResponse({ ok: true, url: session ? session.url : null });
          break;
        }
        case 'GET_SESSION_FOR_URL': {
          const session = await getSessionForUrl(msg.url);
          sendResponse({ ok: true, session_id: session ? session.id : null });
          break;
        }
        case 'GET_ANNOTATIONS': {
          const annotations = await getAnnotations(msg.session_id);
          sendResponse({ ok: true, annotations });
          break;
        }
        case 'ADD_ANNOTATION': {
          const annotation = await addAnnotation({
            session_id: msg.session_id,
            selector: msg.selector,
            title: msg.title || null,
            note: msg.note,
            element_tag: msg.element_tag,
            element_text_preview: msg.element_text_preview,
            anchor: msg.anchor || null,
            position_x: msg.position_x,
            position_y: msg.position_y,
            author: msg.author || null,
            breakpoint: msg.breakpoint || null,
          });
          sendResponse({ ok: true, annotation });
          break;
        }
        case 'UPDATE_ANNOTATION': {
          const annotation = await updateAnnotation(msg.annotation_id, msg.fields);
          sendResponse({ ok: true, annotation });
          break;
        }
        case 'DELETE_ANNOTATION': {
          await deleteAnnotation(msg.annotation_id);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SESSION_DATA': {
          const data = await getSessionData(msg.session_id);
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'GET_SITE_PAGES': {
          const data = await getSitePages(msg.origin);
          sendResponse({ ok: true, ...data });
          break;
        }
        case 'ADD_COMMENT': {
          const comment = await addComment({
            annotation_id: msg.annotation_id,
            author: msg.author || null,
            body: msg.body,
          });
          sendResponse({ ok: true, comment });
          break;
        }
        case 'UPDATE_COMMENT': {
          const comment = await updateComment(msg.comment_id, msg.fields);
          sendResponse({ ok: true, comment });
          break;
        }
        case 'DELETE_COMMENT': {
          await deleteComment(msg.comment_id);
          sendResponse({ ok: true });
          break;
        }
        case 'SET_BREAKPOINT': {
          const bp = await setBreakpoint(msg.tab_id, msg.breakpoint);
          sendResponse({ ok: true, breakpoint: bp });
          break;
        }
        case 'GET_BREAKPOINT': {
          sendResponse({ ok: true, breakpoint: emulated.get(msg.tab_id) || 'desktop' });
          break;
        }
        case 'CAPTURE_SHOT': {
          const windowId = _sender.tab ? _sender.tab.windowId : msg.window_id;
          const url = await captureAndUpload(
            windowId,
            msg.session_id,
            msg.annotation_id,
            msg.crop,
            msg.prev_url
          );
          sendResponse({ ok: true, screenshot_url: url });
          break;
        }
        case 'DELETE_SHOT': {
          await deleteShotPath(shotPathFromUrl(msg.url));
          sendResponse({ ok: true });
          break;
        }
        case 'FETCH_IMAGE': {
          // Fetch an image cross-origin (host permissions bypass page CORS) and
          // return it base64-encoded so the content script can put it on the
          // clipboard. Used by the screenshot "Copy image" action.
          const resp = await fetch(msg.url);
          if (!resp.ok) {
            sendResponse({ ok: false, error: `fetch ${resp.status}` });
            break;
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
          }
          sendResponse({
            ok: true,
            base64: btoa(bin),
            type: resp.headers.get('content-type') || 'image/png',
          });
          break;
        }
        case 'CAPTURE_BEGIN': {
          const tabId = _sender.tab ? _sender.tab.id : msg.tab_id;
          await captureBegin(tabId, msg.scale || 2, msg.width, msg.height);
          sendResponse({ ok: true });
          break;
        }
        case 'CAPTURE_TILE': {
          const tabId = _sender.tab ? _sender.tab.id : msg.tab_id;
          const out = await captureTile(tabId);
          sendResponse({ ok: true, ...out });
          break;
        }
        case 'CAPTURE_END': {
          const tabId = _sender.tab ? _sender.tab.id : msg.tab_id;
          await captureEnd(tabId);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[Annotate] background error:', err);
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
