/* dialer-admin/dialer-admin.js
 *
 * v675: Dialer Admin inside the staff portal (Dialer Management sub-tabs).
 * Generated once from dialer/admin.html by tools/convert-dialer-admin.py and
 * now the source. The portal sets window.__dialerAdminCtx, injects
 * dialer-admin.html into #daHost, then loads this; it exposes
 * window.DialerAdmin.showSection(key).
 *
 * Wrapped in one closure so its `$`, `sb`, `esc`, `show` and friends cannot
 * collide with the portal's globals of the same names.
 */
(function () {

'use strict';

const DA = window.__dialerAdminCtx;   // set by the portal before this loads
const SUPABASE_URL = DA.supabaseUrl;
const SUPABASE_ANON_KEY = DA.anonKey;
// MUST match dialer/index.html's client config, and for the same reason: the
// staff portal stores its Supabase session in sessionStorage, NOT the
// supabase-js default of localStorage. A default client here looks in the
// wrong place, finds nothing, and reports "Not signed in" to someone who is
// very much signed in one tab over.
// The portal's own client and session -- no second sign-in.
const sb = DA.sb;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function callFn(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}
function say(el, text, kind) {
  el.className = 'msg ' + (kind || 'ok');
  el.textContent = text;
  el.classList.toggle('hide', !text);
}

// ------------------------------------------------------------------ boot --
let campaigns = [];
let meId = null;            // written into dialer_campaign_agents.assigned_by
let isOwnerAdmin = false;   // may order numbers (spends money)
let canManage = false;      // may change campaigns, lists, DID status
let isDialerAdmin = false;  // v592: may edit the outcome catalogue (its RLS is admin-only)
let canReview = false;      // may look, and nothing else

// Read-only viewers see the same screens with every write control removed
// rather than a stripped-down page: the point of giving Quality access is
// that they see what the floor sees. Ordering is hidden even from managers,
// because it charges a live carrier account.
const DA_WRITE_IDS = {
  numbers: ['searchBtn', 'orderBtn', 'syncBtn', 'searchNpa', 'searchLimit'],
  lists: ['impBtn', 'impCampaign', 'impName', 'impFile', 'impCsv', 'impScrubbed', 'impScrubDate'],
  campaigns: ['cCreate', 'cName', 'cMode', 'cStart', 'cEnd'],
  inbound: ['qCreate', 'qName', 'qOpen', 'qClose'],
  contacts: ['ctAdd', 'ctASave'],
  inbox: ['inboxBody', 'inboxSend'],
};
function applyReadOnly(tab) {
  // Everything back on, then this section's rules.
  Object.values(DA_WRITE_IDS).flat().forEach((id) => { const el = $(id); if (el) { el.disabled = false; el.title = ''; } });
  document.querySelectorAll('#tab-lists .panel:first-child, #tab-campaigns .panel:first-child, #tab-inbound .panel:first-child')
    .forEach((el) => el.classList.remove('hide'));
  const note = $('daReadOnlyNote');
  if (!canManage) {
    (DA_WRITE_IDS[tab] || []).forEach((id) => { const el = $(id); if (el) el.disabled = true; });
    const create = document.querySelector('#tab-' + tab + ' .panel:first-child');
    if (create && ['lists', 'campaigns', 'inbound'].includes(tab)) create.classList.add('hide');
    note.textContent = 'View only. Your role can see this section but not change it.';
    show(note, true);
  } else {
    show(note, false);
    if (!isOwnerAdmin) {
      // Managers run the floor but do not buy.
      const ob = $('orderBtn');
      if (ob) { ob.disabled = true; ob.title = 'Ordering numbers is owner/admin only.'; }
    }
  }
}
// v675: identity and permissions come from the staff portal, which has
// already signed this person in and knows their role.
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  meId = DA.userId;
  isOwnerAdmin = DA.role === 'owner' || DA.role === 'admin';
  isDialerAdmin = isOwnerAdmin;
  canReview = true;                 // the portal only mounts this for a role that may view a section
  canManage = false;
  $('impScrubDate').value = new Date().toISOString().slice(0, 10);
  // v676: only what every screen needs. Coverage, the number pool and the
  // lists table used to load here for every visit; they now load when their
  // own screen is opened.
  await loadCampaigns();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopFloorTimer();
    else if (daPane === 'floor' && !$('tab-floor').classList.contains('hide')) startFloorTimer(true);
  });
}

// v676: eleven sidebar entries became five groups, each with its own tabs
// along the top. Permissions are per GROUP (roles.dialer_admin_sections).
const DA_GROUPS = {
  overview:      [['floor', 'Live floor'], ['reports', 'Performance'], ['pipeline', 'Pipeline']],
  campaigns:     [['campaigns', 'Campaigns'], ['lists', 'Lists'], ['inbound', 'Inbound queues']],
  conversations: [['inbox', 'Inbox'], ['contacts', 'Contacts'], ['calllog', 'Call log']],
  numbers:       [['numbers', 'Numbers'], ['research', 'Research & DNC']],
  team:          [['agents', 'Statuses & availability'], ['settings', 'Settings'], ['history', 'Change history']],
};
const DA_PANES = Object.values(DA_GROUPS).flat().map(([k]) => k);
// Links and bookmarks from before v676 name a section, not a group.
const DA_LEGACY = {
  reports: 'overview', pipeline: 'overview', agents: 'team', settings: 'team',
  lists: 'campaigns', inbound: 'campaigns', inbox: 'conversations', calllog: 'conversations',
  research: 'numbers', contacts: 'conversations', floor: 'overview', history: 'team',
};
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

function daResolve(path) {
  const [a, b] = String(path || '').split('/');
  const group = DA_GROUPS[a] ? a : (DA_LEGACY[a] || 'overview');
  const panes = DA_GROUPS[group].map(([k]) => k);
  let pane = panes.includes(b) ? b : (!DA_GROUPS[a] && panes.includes(a) ? a : null);
  if (!pane) pane = lsGet('da.pane.' + group);
  if (!panes.includes(pane)) pane = panes[0];
  return { group, pane };
}

let daGroup = null;
let daPane = null;
const daLoadedOnce = new Set();
let inboxBadge = 0;

function renderInnerNav() {
  const nav = $('daInner');
  nav.innerHTML = DA_GROUPS[daGroup].map(([k, label]) => `<button type="button" data-pane="${k}"
      class="${k === daPane ? 'active' : ''}">${esc(label)}${k === 'inbox' && inboxBadge
        ? `<span class="badge">${inboxBadge}</span>` : ''}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) => {
    b.onclick = () => showSection(daGroup + '/' + b.dataset.pane);
  });
  $('daTopNote').textContent = canManage ? '' : 'View only';
}

// The portal's sidebar calls this with a group ("conversations"), a group and
// tab ("conversations/contacts"), or a pre-v676 section key ("inbox").
async function showSection(path) {
  const { group, pane } = daResolve(path);
  await boot();
  daGroup = group;
  daPane = pane;
  canManage = DA.canEdit(group);
  lsSet('da.pane.' + group, pane);
  renderInnerNav();
  DA_PANES.forEach((t) => $('tab-' + t).classList.toggle('hide', t !== pane));
  closeContactDrawer();
  applyReadOnly(pane);
  if (typeof DA.onNavigate === 'function') DA.onNavigate(group + '/' + pane);

  if (pane === 'floor') startFloorTimer(true); else { stopFloorTimer(); setWall(false); }
  const first = !daLoadedOnce.has(pane);
  daLoadedOnce.add(pane);

  // Loaded on first open rather than at boot: most sessions never look at
  // the call log, and the query reads the whole CDR table.
  if (pane === 'calllog' && !callLogLoaded) initCallLog();
  if (pane === 'inbox') { loadInbox(); if (first) loadEmailStatus(); }
  if (pane === 'contacts') initContacts();
  if (pane === 'agents') { loadStatusEditor(); loadCalendarAdmin(); }
  if (pane === 'inbound') loadQueues();
  if (pane === 'pipeline') loadPipeline();    // v595: fresh each time it is opened
  if (pane === 'settings') loadSettingsTab(); // v648
  if (pane === 'history') initHistory();      // v677
  // v679: boot() draws this table before the section's edit permission is
  // known, so it came up with no Edit/Pause buttons for anyone.
  if (pane === 'campaigns') loadCampaigns();
  if (pane === 'lists') { if (first) loadLists(); else renderLists(); }   // v836: redraw keeps buttons in step with edit rights
  if (pane === 'numbers' && first) { loadCoverage(); loadPool(); }
}

// ------------------------------------------------------------ live floor --
// v676. One screen for "what is happening right now". Polls every 15 s, but
// only while it is the screen on show AND the browser tab is visible -- a
// manager who leaves it open in a background tab costs nothing.
let floorTimer = null;
let floorThreadsAt = 0;
function startFloorTimer(now) {
  stopFloorTimer();
  if (now) loadFloor();
  floorTimer = setInterval(() => { if (!document.hidden) loadFloor(); }, 15000);
  fmStartTick();   // v688: the floor map's per-second status timers
}
function stopFloorTimer() {
  if (floorTimer) { clearInterval(floorTimer); floorTimer = null; }
  if (fmTick) { clearInterval(fmTick); fmTick = null; }
}

async function loadFloor() {
  const nowIso = new Date().toISOString();
  const fresh = new Date(Date.now() - 120000).toISOString();
  const [sessions, overdue] = await Promise.all([
    sb.from('dialer_agent_sessions').select('agent_id, status, agent_status')
      .is('ended_at', null).gt('last_heartbeat_at', fresh),
    sb.from('dialer_follow_ups').select('id', { count: 'exact', head: true })
      .eq('status', 'open').lt('due_at', nowIso),
  ]);
  const ss = sessions.data || [];
  const kpi = (id, n, cls) => {
    const el = $(id);
    el.textContent = n === null || n === undefined ? '–' : n;
    el.parentElement.classList.remove('warn', 'bad');
    if (cls) el.parentElement.classList.add(cls);
  };
  kpi('kOnShift', new Set(ss.map((s) => s.agent_id)).size);
  kpi('kOnCall', ss.filter((s) => s.status === 'on_call').length);
  kpi('kReady', ss.filter((s) => s.agent_status === 'ready' && s.status !== 'on_call').length);
  kpi('kOverdue', overdue.count ?? null, overdue.count ? 'bad' : '');

  // The conversations read is the heaviest of these; once a minute is plenty.
  if (Date.now() - floorThreadsAt > 60000) {
    floorThreadsAt = Date.now();
    const { data } = await sb.rpc('dialer_admin_conversations');
    if (data) { cvRows = data; updateInboxBadge(); }
  }
  kpi('kReply', cvRows.filter((r) => r.last_direction === 'inbound').length,
    cvRows.some((r) => r.last_direction === 'inbound') ? 'warn' : '');

  await Promise.all([loadFloorMap(ss), loadWaiting()]);
  const waiting = $('waitingRows').querySelectorAll('tr td[class="mono"]').length;
  kpi('kWaiting', waiting, waiting ? 'bad' : '');
  $('floorUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + ' · refreshes every 15 seconds while this screen is open';
}
$('floorKpis').querySelectorAll('[data-go]').forEach((b) => {
  b.onclick = () => { if (!$('tab-floor').classList.contains('da-wall')) showSection(b.dataset.go); };
});

// v677: wall screen -- the Live floor, big, for a TV on the floor.
let wallClockTimer = null;
function setWall(on) {
  const el = $('tab-floor');
  if (on === el.classList.contains('da-wall')) return;
  el.classList.toggle('da-wall', on);
  $('floorWall').textContent = on ? 'Exit wall screen' : 'Wall screen';
  if (on) {
    const tick = () => { $('floorClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick();
    wallClockTimer = setInterval(tick, 15000);
    if (el.requestFullscreen) el.requestFullscreen().catch(() => { /* the overlay alone is fine */ });
  } else {
    clearInterval(wallClockTimer);
    if (document.fullscreenElement === el && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
}
$('floorWall').onclick = () => setWall(!$('tab-floor').classList.contains('da-wall'));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && $('tab-floor').classList.contains('da-wall')) setWall(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setWall(false); });

// ------------------------------------------------------------- settings --
// v648. Number assignment and console access, both of which used to require
// a deploy to change.
const DIALER_SECTIONS = [
  { key: 'calls',         label: 'Calls' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'session',       label: 'Shift analysis' },
  { key: 'followups',     label: 'Follow-ups' },
  { key: 'opps',          label: 'Opportunities' },
  { key: 'contacts',      label: 'Contacts' },
  { key: 'appts',         label: 'Appointments' },
  { key: 'tasks',         label: 'Tasks' },
];
let setRoles = [];
let setAccess = {};

async function loadSettingsTab() {
  await Promise.all([loadSettingsNumbers(), loadSettingsAccess(), loadSettingsWhatsapp(),
                     loadTemplates(), loadHandoffs()]);
}

// ------------------------------------------------ v669: message templates --
// v737: email templates are FORMATTED. The body is edited as rich text --
// bold, italic, colors, bullets, links, or pasted straight from Gmail with its
// formatting -- and saved twice: body_html, what the email shows, and body, a
// plain-text copy derived from it for mail apps that show text only (and for
// the inbox snippet). dialer-outcome-rules sends both. Texts stay plain.
const TPL_FIELDS = ['first_name', 'last_name', 'full_name', 'agent', 'agent_first_name',
  'agent_full_name', 'agent_phone', 'agent_email',   // v741
  'address', 'city', 'state', 'phone'];
const TPL_OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'A', 'SPAN',
  'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'HR']);
const TPL_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'IFRAME', 'OBJECT', 'EMBED',
  'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IMG', 'SVG', 'VIDEO', 'AUDIO']);

// Near-black grey is the email's own text color already, so an explicit one
// (Gmail pastes rgb(34,34,34) on everything) is dropped rather than stored.
function tplGreyDark(color) {
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  if (!m) return false;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
}

// Keeps what an email can carry -- structure, bold/italic/underline, colors,
// links to web/mail/phone -- and drops the rest: fonts, sizes, classes,
// images, scripts, comments.
function tplCleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const unwrap = (node) => {
    const frag = doc.createDocumentFragment();
    while (node.firstChild) frag.appendChild(node.firstChild);
    node.replaceWith(frag);
  };
  const walk = (parent) => {
    [...parent.childNodes].forEach((ch) => {
      if (ch.nodeType === 8) { ch.remove(); return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName;
      if (TPL_DROP_TAGS.has(tag)) { ch.remove(); return; }
      walk(ch);
      let el = ch;
      if (tag === 'FONT') {
        const span = doc.createElement('span');
        if (ch.getAttribute('color')) span.style.color = ch.getAttribute('color');
        while (ch.firstChild) span.appendChild(ch.firstChild);
        ch.replaceWith(span);
        el = span;
      } else if (!TPL_OK_TAGS.has(tag)) { unwrap(ch); return; }
      // Google Docs wraps whole pastes in <b style="font-weight:normal">.
      if ((tag === 'B' || tag === 'STRONG') && /^(normal|[1-4]00)$/.test(el.style.fontWeight)) { unwrap(el); return; }
      const keep = {};
      const st = el.style;
      if (st.color && !tplGreyDark(st.color)) keep.color = st.color;
      if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) keep['font-weight'] = 'bold';
      if (st.fontStyle === 'italic') keep['font-style'] = 'italic';
      const deco = st.textDecorationLine || st.textDecoration || '';
      if (/underline/.test(deco)) keep['text-decoration'] = 'underline';
      else if (/line-through/.test(deco)) keep['text-decoration'] = 'line-through';
      const href = el.tagName === 'A' ? String(el.getAttribute('href') || '').trim() : '';
      [...el.attributes].forEach((a) => el.removeAttribute(a.name));
      const css = Object.entries(keep).map(([k, v]) => `${k}:${v}`).join(';');
      if (css) el.setAttribute('style', css);
      if (el.tagName === 'A') {
        if (/^(https?:|mailto:|tel:)/i.test(href) || /^\{\{\s*\w+\s*\}\}$/.test(href)) el.setAttribute('href', href);
        else { unwrap(el); return; }
      }
      if (el.tagName === 'SPAN' && !css) unwrap(el);   // a span that carries nothing is noise
    });
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML.trim();
}

// The plain-text copy: paragraphs as blank lines, list items as bullets, and
// a link's address after its words when they differ.
function tplHtmlToText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'HR']);
  let out = '';
  const gap = () => { if (out && !/\n\n$/.test(out)) out += /\n$/.test(out) ? '\n' : '\n\n'; };
  const walk = (node) => {
    node.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) { out += ch.nodeValue.replace(/\s+/g, ' '); return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName;
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'LI') {
        out = out.replace(/[ \t]+$/, '');
        if (out && !/\n$/.test(out)) out += '\n';
        out += '• ';
        walk(ch);
        out += '\n';
        return;
      }
      if (BLOCK.has(tag)) gap();
      walk(ch);
      if (tag === 'A') {
        const href = String(ch.getAttribute('href') || '').replace(/^(tel:|mailto:)/i, '');
        if (href && href !== ch.textContent.trim()) out += ` (${href})`;
      }
      if (BLOCK.has(tag)) gap();
    });
  };
  walk(doc.body.firstChild);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A template saved before v737 has only text: shown as paragraphs.
function tplTextToHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function wireTplEditor(editor, card, t) {
  editor.innerHTML = t.body_html ? tplCleanHtml(t.body_html) : tplTextToHtml(t.body);
  // The toolbar's color picker and field list take focus, so the selection
  // is remembered and put back before each command.
  let saved = null;
  const remember = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && editor.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    editor.focus();
    if (saved) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
  };
  ['keyup', 'mouseup', 'input'].forEach((ev) => editor.addEventListener(ev, remember));
  card.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => { restore(); document.execCommand(b.dataset.cmd, false, null); remember(); };
  });
  const color = card.querySelector('[data-color]');
  color.onchange = () => {
    restore();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, color.value);
    document.execCommand('styleWithCSS', false, false);
    remember();
  };
  const link = card.querySelector('[data-link]');
  link.addEventListener('mousedown', (e) => e.preventDefault());
  link.onclick = () => {
    remember();
    const url = (prompt('Link address: https://…, mailto:… or tel:…') || '').trim();
    if (!url) return;
    if (!/^(https?:|mailto:|tel:)/i.test(url)) { alert('Start the link with https://, mailto: or tel:'); return; }
    restore();
    if (window.getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
    else document.execCommand('createLink', false, url);
    remember();
  };
  const field = card.querySelector('[data-field]');
  field.onchange = () => {
    if (!field.value) return;
    restore();
    document.execCommand('insertText', false, `{{${field.value}}}`);
    field.value = '';
    remember();
  };
  // Pasting from Gmail or Docs keeps the formatting (bold, colors, bullets,
  // links) but not the sender's fonts, sizes, images or scripts.
  editor.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const html = cd.getData('text/html');
    if (html) document.execCommand('insertHTML', false, tplCleanHtml(html));
    else document.execCommand('insertText', false, cd.getData('text/plain'));
  });
}

function tplCard(t) {
  const el = document.createElement('div');
  el.className = 'tpl-card';
  el.dataset.tpl = t.id || '';
  const sms = t.channel === 'sms';
  el.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <div class="field" style="flex:1;min-width:240px"><label>${sms ? 'Text' : 'Email'} template name</label>
        <input data-t="name" value="${esc(t.name || '')}" style="width:100%"></div>
      ${sms ? '' : `<div class="field"><label>Sent from</label><select data-t="sender">
        <option value="shared"${t.sender !== 'rep' ? ' selected' : ''}>Shared sender</option>
        <option value="rep"${t.sender === 'rep' ? ' selected' : ''}>The rep's own Gmail</option></select></div>`}
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:9px">
        <input type="checkbox" data-t="is_active"${t.is_active !== false ? ' checked' : ''}> On</label>
    </div>
    ${sms ? '' : `<input data-t="subject" placeholder="Subject" style="width:100%;margin-bottom:8px" value="${esc(t.subject || '')}">`}
    ${sms ? `<textarea data-t="body" rows="3" placeholder="Hi {{first_name}}, ...">${esc(t.body || '')}</textarea>`
      : `<div class="tpl-tools" role="toolbar" aria-label="Formatting">
          <button type="button" class="sm" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" class="sm" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" class="sm" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button type="button" class="sm" data-cmd="insertUnorderedList" title="Bulleted list">&bull; Bullets</button>
          <button type="button" class="sm" data-cmd="insertOrderedList" title="Numbered list">1. Numbers</button>
          <label class="tpl-color" title="Color for the selected text">Color <input type="color" data-color value="#9900ff"></label>
          <button type="button" class="sm" data-link title="Make the selected text a link">Link</button>
          <button type="button" class="sm" data-cmd="removeFormat" title="Remove formatting from the selected text">Clear</button>
          <select data-field title="Insert a merge field"><option value="">Insert field…</option>${
            TPL_FIELDS.map((f) => `<option value="${f}">{{${f}}}</option>`).join('')}</select>
        </div>
        <div class="tpl-editor" data-t="html" contenteditable="true" spellcheck="true"></div>`}
    <div class="hint" data-t-len style="margin:4px 0 8px"></div>
    <div class="row" style="margin-bottom:0;align-items:center">
      <button class="sm primary" data-t-save>Save</button>
      <button class="sm" data-t-del>Delete</button>
      <span style="flex:1"></span>
      <input data-t-to placeholder="${sms ? 'Test to a 10-digit mobile' : 'Test to an email address'}" style="min-width:220px">
      <button class="sm" data-t-test${t.id ? '' : ' disabled'}>Send a test</button>
    </div>
    <div data-t-msg class="msg hide" style="margin-top:8px"></div>`;
  const msg = el.querySelector('[data-t-msg]');
  const bodyBox = el.querySelector('[data-t="body"]');   // texts
  const editor = el.querySelector('[data-t="html"]');    // emails (v737)
  const len = () => {
    el.querySelector('[data-t-len]').textContent = sms
      ? `${bodyBox.value.length} characters. One text is 160 — merge fields change the length, and one emoji drops it to 70.`
      : 'Select text and use the buttons, or paste from Gmail. A plain-text copy is saved with it for mail apps that only show text.';
  };
  if (bodyBox) bodyBox.oninput = len;
  if (editor) wireTplEditor(editor, el, t);
  len();
  el.querySelector('[data-t-save]').onclick = async () => {
    const html = editor ? tplCleanHtml(editor.innerHTML) : null;
    const row = {
      name: el.querySelector('[data-t="name"]').value.trim(),
      channel: t.channel,
      sender: sms ? 'rep' : el.querySelector('[data-t="sender"]').value,
      subject: sms ? null : (el.querySelector('[data-t="subject"]').value.trim() || null),
      body: sms ? bodyBox.value.trim() : tplHtmlToText(html),
      body_html: sms ? null : (html || null),
      is_active: el.querySelector('[data-t="is_active"]').checked,
      updated_by: meId, updated_at: new Date().toISOString(),
    };
    if (!row.name || !row.body) { say(msg, 'A template needs a name and a message.', 'err'); return; }
    if (!sms && !row.subject) { say(msg, 'An email needs a subject.', 'err'); return; }
    const res = el.dataset.tpl
      ? await sb.from('dialer_message_templates').update(row).eq('id', el.dataset.tpl).select('id')
      : await sb.from('dialer_message_templates').insert(row).select('id');
    if (res.error) { say(msg, 'Could not save: ' + res.error.message, 'err'); return; }
    if (!res.data?.length) { say(msg, 'Not saved — your role cannot change templates.', 'err'); return; }
    el.dataset.tpl = res.data[0].id;
    el.querySelector('[data-t-test]').disabled = false;
    say(msg, 'Saved. Rules using it send the new wording from the next outcome.', 'ok');
  };
  el.querySelector('[data-t-del]').onclick = async () => {
    if (!el.dataset.tpl) { el.remove(); return; }
    if (!confirm('Delete this template? Any rule using it stops sending that message.')) return;
    const { error } = await sb.from('dialer_message_templates').delete().eq('id', el.dataset.tpl);
    if (error) { say(msg, 'Could not delete: ' + error.message, 'err'); return; }
    el.remove();
  };
  el.querySelector('[data-t-test]').onclick = async () => {
    const to = el.querySelector('[data-t-to]').value.trim();
    if (!to) { say(msg, sms ? 'Enter a mobile number to test.' : 'Enter an email address to test.', 'err'); return; }
    const toVal = sms ? '+1' + to.replace(/\D/g, '').slice(-10) : to;
    say(msg, 'Sending the saved version…', 'ok');
    const r = await callFn('dialer-outcome-rules', { action: 'test_template', template_id: el.dataset.tpl, to: toVal })
      .catch((e) => ({ ok: false, error: e.message }));
    say(msg, r?.ok ? (r.detail || 'Sent.') : (r?.detail || r?.error || 'Not sent.'), r?.ok ? 'ok' : 'err');
  };
  return el;
}

async function loadTemplates() {
  const box = $('tplList');
  const { data, error } = await sb.from('dialer_message_templates').select('*').order('channel').order('name');
  if (error) { box.innerHTML = `<p class="hint">${esc(error.message)}</p>`; return; }
  box.innerHTML = (data || []).length ? '' : '<p class="hint">No templates yet.</p>';
  (data || []).forEach((t) => box.appendChild(tplCard(t)));
  $('tplAddEmail').disabled = $('tplAddSms').disabled = !canManage;
  $('tplAddEmail').onclick = () => box.prepend(tplCard({ channel: 'email', sender: 'shared', is_active: true }));
  $('tplAddSms').onclick = () => box.prepend(tplCard({ channel: 'sms', sender: 'rep', is_active: true }));
}

// ---------------------------------------------- v669: hand-offs & sender --
async function loadHandoffs() {
  const [{ data: rows }, { data: roles }, { data: people }, { data: camps }] = await Promise.all([
    sb.from('dialer_settings').select('key, value'),
    sb.from('roles').select('name, can_use_dialer'),
    sb.from('profiles').select('id, full_name, role').order('full_name'),
    sb.from('dialer_campaigns').select('id, name, status').order('name'),
  ]);
  const s = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  const dialerRoles = new Set((roles || []).filter((r) => r.can_use_dialer).map((r) => r.name));
  const owner = s.sales_handoff_owner || '';
  $('setSalesOwner').innerHTML = '<option value="">Nobody — keep it with the agent</option>' + (people || [])
    .filter((p) => dialerRoles.has(p.role) || p.id === owner || p.role === 'owner' || p.role === 'admin')
    .map((p) => `<option value="${esc(p.id)}"${p.id === owner ? ' selected' : ''}>${esc(p.full_name || p.id)} (${esc(p.role)})</option>`).join('');
  const sp = s.spanish_campaign_id || '';
  $('setSpanishQueue').innerHTML = '<option value="">No Spanish queue — retire the contact</option>' + (camps || [])
    .map((c) => `<option value="${esc(c.id)}"${c.id === sp ? ' selected' : ''}>${esc(c.name)}${c.status === 'active' ? '' : ' (' + esc(c.status) + ')'}</option>`).join('');
  $('setCbHold').value = s.callback_reserve_hours ?? 24;
  const se = s.shared_email || {};
  $('setFromName').value = se.from_name || '';
  $('setFromAddr').value = se.from_address || '';
  $('setHandoffSave').disabled = !canManage;
}

$('setHandoffSave').onclick = async () => {
  const msg = $('setHandoffMsg');
  const hold = Number($('setCbHold').value);
  const addr = $('setFromAddr').value.trim();
  if (!(hold >= 1 && hold <= 720)) { msg.textContent = 'Callback hold must be between 1 and 720 hours.'; return; }
  if (addr && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { msg.textContent = 'The from address is not an email address.'; return; }
  const { data: cur } = await sb.from('dialer_settings').select('value').eq('key', 'shared_email').maybeSingle();
  const rows = [
    { key: 'sales_handoff_owner', value: $('setSalesOwner').value || null },
    { key: 'spanish_campaign_id', value: $('setSpanishQueue').value || null },
    { key: 'callback_reserve_hours', value: hold },
    { key: 'shared_email', value: { ...(cur?.value || {}), from_name: $('setFromName').value.trim(), from_address: addr } },
  ].map((r) => ({ ...r, updated_by: meId, updated_at: new Date().toISOString() }));
  const { data, error } = await sb.from('dialer_settings').upsert(rows, { onConflict: 'key' }).select('key');
  msg.textContent = error ? 'Could not save: ' + error.message
    : (data?.length || 0) < rows.length ? 'Not saved — your role cannot change these settings.' : 'Saved.';
};

// v650: WhatsApp sender.
async function loadSettingsWhatsapp() {
  const { data } = await sb.from('app_settings')
    .select('value').eq('key', 'whatsapp_from_number').maybeSingle();
  $('setWaNumber').value = data?.value || '';
}
function setWaSay(text, kind) {
  const el = $('setWaMsg');
  el.classList.remove('hide');
  el.className = 'msg ' + (kind || 'info');
  el.textContent = text;
}
$('setWaSave').onclick = async () => {
  const value = $('setWaNumber').value.trim();
  if (!value) { setWaSay('Enter the number first.', 'err'); return; }
  // upsert: the row may not exist yet on a fresh environment, and an update
  // that matches nothing looks identical to a permissions refusal otherwise.
  const { error } = await sb.from('app_settings')
    .upsert({ key: 'whatsapp_from_number', value }, { onConflict: 'key' });
  setWaSay(error ? `Could not save: ${error.message}` : 'Saved. Check status to confirm Telnyx accepts it.', error ? 'err' : 'ok');
};
// Asks the function itself rather than guessing from the number's shape --
// it is the thing that knows whether TELNYX_API_KEY is set and whether the
// sender resolves.
$('setWaTest').onclick = async () => {
  setWaSay('Checking…', 'info');
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dialer-whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action: 'status' }),
    });
    const b = await res.json().catch(() => ({}));
    if (!b?.ok) { setWaSay(b?.error || `Status check failed (${res.status}).`, 'err'); return; }
    setWaSay(
      b.configured
        ? `Configured. Sending as ${b.from}. WhatsApp is reply-only, so a send still needs the contact to have messaged within 24 hours.`
        : 'Not configured: either no number is set or TELNYX_API_KEY is missing on the server.',
      b.configured ? 'ok' : 'err');
  } catch (e) {
    setWaSay(`Could not reach the function: ${e.message}`, 'err');
  }
};

async function loadSettingsNumbers() {
  const body = $('setNumbersBody');
  // Only staff who can actually use the dialer are offered -- assigning a
  // number to somebody who never signs into the console would quietly take
  // it out of rotation for no one's benefit.
  const [{ data: dids, error: didErr }, { data: people }] = await Promise.all([
    sb.from('dialer_dids').select('id, phone_e164, area_code, status, assigned_to').order('phone_e164'),
    sb.rpc('dialer_assignable_staff'),
  ]);
  if (didErr) { body.innerHTML = `<tr><td colspan="4">Could not load numbers: ${esc(didErr.message)}</td></tr>`; return; }
  const staff = people || [];
  if (!(dids || []).length) { body.innerHTML = '<tr><td colspan="4">No numbers yet.</td></tr>'; return; }
  body.innerHTML = (dids || []).map((d) => {
    const opts = ['<option value="">— unassigned —</option>'].concat(
      staff.map((p) => `<option value="${p.id}"${p.id === d.assigned_to ? ' selected' : ''}>${esc(p.full_name || p.email || p.id)}</option>`)
    ).join('');
    return `<tr>
      <td class="mono">${esc(d.phone_e164)}</td>
      <td>${esc(d.area_code || '—')}</td>
      <td>${esc(d.status || '—')}</td>
      <td><select class="set-assign" data-did="${d.id}" style="min-width:180px">${opts}</select></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('.set-assign').forEach((sel) => {
    sel.onchange = async () => {
      const msg = $('setNumbersMsg');
      const value = sel.value || null;
      // One number per rep is a UNIQUE INDEX, so handing somebody a second
      // number errors rather than silently splitting their identity. Clear
      // their old one first, which is what "assign" is understood to mean.
      if (value) await sb.from('dialer_dids').update({ assigned_to: null }).eq('assigned_to', value);
      const { error } = await sb.from('dialer_dids').update({ assigned_to: value }).eq('id', sel.dataset.did);
      msg.classList.remove('hide');
      msg.className = 'msg ' + (error ? 'err' : 'ok');
      msg.textContent = error ? `Could not save: ${error.message}` : 'Saved.';
      await loadSettingsNumbers();
    };
  });
}

async function loadSettingsAccess() {
  const head = $('setAccessHead');
  const body = $('setAccessBody');
  head.innerHTML = '<th>Role</th>' + DIALER_SECTIONS.map((s) => `<th class="num">${esc(s.label)}</th>`).join('');
  const [{ data: roles, error: rErr }, { data: access }] = await Promise.all([
    sb.from('roles').select('name').order('name'),
    sb.from('dialer_role_access').select('role_name, sections'),
  ]);
  if (rErr) { body.innerHTML = `<tr><td colspan="9">Could not load roles: ${esc(rErr.message)}</td></tr>`; return; }
  // Owner and Admin are deliberately absent: they always see everything, and
  // a screen that lets you untick your own access is a way to lock the floor
  // out of its own console.
  setRoles = (roles || []).map((r) => r.name).filter((n) => n !== 'owner' && n !== 'admin');
  setAccess = {};
  (access || []).forEach((a) => { setAccess[a.role_name] = a.sections || {}; });
  body.innerHTML = setRoles.map((name) => {
    const cfg = setAccess[name];
    const configured = cfg && Object.keys(cfg).length;
    const cells = DIALER_SECTIONS.map((s) => {
      const on = configured ? cfg[s.key] === true : false;
      return `<td class="num"><input type="checkbox" class="set-acc" data-role="${esc(name)}" data-key="${s.key}"${on ? ' checked' : ''}></td>`;
    }).join('');
    return `<tr><td>${esc(name)}${configured ? '' : ' <span class="muted">(not configured)</span>'}</td>${cells}</tr>`;
  }).join('');
}

$('setAccessSave').onclick = async () => {
  const msg = $('setAccessMsg');
  msg.textContent = 'Saving…';
  const byRole = {};
  setRoles.forEach((r) => { byRole[r] = {}; });
  document.querySelectorAll('.set-acc').forEach((cb) => {
    byRole[cb.dataset.role][cb.dataset.key] = cb.checked;
  });
  const rows = Object.keys(byRole).map((r) => ({ role_name: r, sections: byRole[r], updated_at: new Date().toISOString() }));
  const { error } = await sb.from('dialer_role_access').upsert(rows, { onConflict: 'role_name' });
  msg.textContent = error ? `Could not save: ${error.message}` : 'Saved. Reps see this next time they load the console.';
  if (!error) await loadSettingsAccess();
};

// -------------------------------------------------------------- call log --
// Everything on this screen comes from the dialer_call_log /
// dialer_call_log_summary RPCs rather than from table reads. The rows need
// campaign and list names beside each call, and those tables are gated on
// role_can_use_dialer() -- which Quality deliberately does not hold, since
// they review calls rather than place them. Reading them directly would hand
// a reviewer a table with the name columns silently blank. The functions
// apply one visibility rule (own calls, unless admin or reviewer) and return
// the joined shape.
//
// The stored dialer_attempts.recording_path is NOT used for playback. Telnyx
// hands out recording links as presigned S3 urls with X-Amz-Expires=600, so
// every one of them is a 403 within ten minutes of the call ending. Playback
// goes through dialer-recording, which asks the carrier for a fresh url (and
// re-checks that this person may hear that particular call).
let callLogLoaded = false;
let callLogRows = [];        // last fetched page, reused by Export

function mmss(total) {
  const s = Math.max(0, Math.floor(Number(total) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
// "217 hours 28 min" reads better than 782880 for a period total.
function humanSeconds(total) {
  const s = Math.max(0, Math.floor(Number(total) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} hour${h === 1 ? '' : 's'} ${m} min`;
  if (m) return `${m} min ${s % 60}s`;
  return `${s}s`;
}
function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function prettyPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

// Reads every filter control into the argument object both RPCs take. Empty
// string means "All …" and is sent as null so the SQL skips that predicate.
function callLogFilters() {
  const from = $('recFrom').value, to = $('recTo').value;
  return {
    p_from: from ? new Date(from + 'T00:00:00').toISOString() : null,
    // Inclusive end date: the SQL compares with < p_to, so push to midnight
    // after the chosen day or "to = today" would hide today's calls.
    p_to: to ? new Date(new Date(to + 'T00:00:00').getTime() + 86400000).toISOString() : null,
    p_agent: $('recAgent').value || null,
    p_campaign: $('recCampaign').value || null,
    p_list: $('recList').value || null,
    p_source: $('recSource').value || null,
    p_duration: $('recDuration').value || null,
    p_status: $('recStatus').value || null,
    p_disp: dispSelection(),
    p_recorded: $('recRecorded').checked ? true : null,
  };
}

async function initCallLog() {
  callLogLoaded = true;
  // Default to the last 30 days rather than all history, so the first open is
  // a small query.
  const d = new Date();
  $('recTo').value = d.toISOString().slice(0, 10);
  d.setDate(d.getDate() - 30);
  $('recFrom').value = d.toISOString().slice(0, 10);

  // Filter options come from the same tables the admin screens already load,
  // plus the agents who actually appear in the CDR.
  $('recCampaign').innerHTML = '<option value="">All campaigns</option>'
    + campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  const [{ data: lists }, { data: disps }] = await Promise.all([
    sb.from('dialer_lists').select('id, name').order('created_at', { ascending: false }),
    sb.from('dialer_dispositions').select('code, label, group_name').eq('is_active', true).order('sort_order'),
  ]);
  // A reviewer without can_use_dialer cannot read these two, which is fine --
  // the selects just stay at "All …" rather than the screen failing.
  if (lists) {
    $('recList').innerHTML = '<option value="">All files</option>'
      + lists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  }
  buildDispMenu(disps || []);

  await loadCallLog();
}

async function loadCallLog() {
  const summary = $('recSummary').checked;
  show($('recSummaryPanel'), summary);
  show($('recListPanel'), !summary);
  $('recMsg').textContent = 'Loading…';

  const f = callLogFilters();
  if (summary) await loadCallLogSummary(f);
  else await loadCallLogRows(f);
}

async function loadCallLogRows(f) {
  const tbody = $('recRows');
  const { data, error } = await sb.rpc('dialer_call_log', { ...f, p_limit: 200, p_offset: 0 });
  if (error) {
    $('recMsg').textContent = '';
    tbody.innerHTML = `<tr><td colspan="7">Could not load the call log: ${esc(error.message)}</td></tr>`;
    return;
  }
  callLogRows = data || [];
  const total = callLogRows.length ? Number(callLogRows[0].total_count) : 0;
  // The count lives in the status line rather than the filter bar: the bar's
  // leftmost control is the call-results multi-select, and two different
  // "N call results" readings side by side would be read as the same number.
  $('recMsg').textContent = total > callLogRows.length
    ? `${total} calls match — showing the newest ${callLogRows.length}. Narrow the range to see the rest.`
    : `${total} call${total === 1 ? '' : 's'}.`;

  // Agent list is built from whoever actually appears in the CDR, so it never
  // offers a name with no calls behind it.
  const seen = new Map();
  callLogRows.forEach((r) => { if (r.agent_id) seen.set(r.agent_id, r.agent_name || r.agent_id); });
  if (seen.size) {
    const keep = $('recAgent').value;
    $('recAgent').innerHTML = '<option value="">All users</option>'
      + [...seen.entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
        .map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    $('recAgent').value = keep;
  }

  if (!callLogRows.length) {
    tbody.innerHTML = '<tr><td colspan="7">No calls match these filters.</td></tr>';
    return;
  }

  tbody.innerHTML = callLogRows.map((r) => {
    const who = r.contact_name
      ? `${esc(r.contact_name)}${r.contact_state ? ' ' + esc(r.contact_state) : ''} <span class="mono">${esc(prettyPhone(r.to_number))}</span>`
      : `<span class="mono">${esc(prettyPhone(r.to_number))}</span>`;
    const result = r.disposition_label
      ? esc(r.disposition_label)
      : `<span style="color:var(--text-dim)">${esc(r.status || '')}</span>`;
    const src = r.is_manual ? 'Manual' : (esc(r.campaign_name || '—'));
    const rec = r.has_recording
      ? `<button class="sm" data-play="${esc(r.id)}">Play</button>
         <button class="sm" data-dl="${esc(r.id)}" title="Download">↓</button>`
      : '<span style="color:var(--text-dim)">—</span>';
    return `<tr>
      <td>${esc(r.agent_name || '—')}</td>
      <td style="white-space:nowrap">${esc(fmtWhen(r.initiated_at))}</td>
      <td>${result}</td>
      <td style="white-space:nowrap">${rec}</td>
      <td class="num mono">${r.talk_seconds == null ? '—' : mmss(r.talk_seconds)}</td>
      <td>${who}</td>
      <td>${src}${r.list_name ? ` <span style="color:var(--text-dim)">· ${esc(r.list_name)}</span>` : ''}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-play]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.play, false);
  });
  tbody.querySelectorAll('button[data-dl]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.dl, true);
  });
}

async function loadCallLogSummary(f) {
  const tbody = $('sumRows');
  const { data, error } = await sb.rpc('dialer_call_log_summary', f);
  if (error) {
    $('recMsg').textContent = '';
    tbody.innerHTML = `<tr><td colspan="3">Could not load the summary: ${esc(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  const total = rows.length ? Number(rows[0].total_calls) : 0;
  const talk = rows.length ? Number(rows[0].total_talk_seconds) : 0;
  const avg = rows.length ? Number(rows[0].avg_talk_seconds) : 0;

  $('sumTotal').textContent = total.toLocaleString();
  $('sumTime').textContent = humanSeconds(talk);
  $('sumAvg').textContent = `${Math.round(avg)}s`;
  $('recMsg').textContent = `${total} call${total === 1 ? '' : 's'} in range.`;

  tbody.innerHTML = rows.length
    ? rows.map((r) => `<tr class="d-${esc(r.category || 'none')}">
        <td>${esc(r.label || r.disposition)}</td>
        <td class="num mono">${Number(r.calls).toLocaleString()}</td>
        <td class="num mono">${r.pct}%</td>
      </tr>`).join('')
    : '<tr><td colspan="3">No calls match these filters.</td></tr>';
}

// Export is of the rows currently loaded, not a second server query, so what
// lands in the file is exactly what is on screen.
function exportCallLog() {
  if (!callLogRows.length) { $('recMsg').textContent = 'Nothing to export.'; return; }
  const cols = ['initiated_at', 'agent_name', 'to_number', 'contact_name', 'contact_state',
    'campaign_name', 'list_name', 'direction', 'is_manual', 'status', 'disposition_label',
    'talk_seconds', 'billed_seconds', 'has_recording', 'cost_usd'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(',')]
    .concat(callLogRows.map((r) => cols.map((c) => cell(r[c])).join(',')))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `call-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  $('recMsg').textContent = `Exported ${callLogRows.length} rows.`;
}

async function playRecording(btn, attemptId, download) {
  const label = btn.textContent;
  const msg = $(btn.closest('#tab-research') ? 'resMsg' : 'recMsg');
  // Snapshot the cell BEFORE the button is put into its loading state.
  // Taking it afterwards captured the disabled "…" button, so closing the
  // player restored a Play button that was permanently stuck mid-load.
  const cell = btn.closest('td');
  const cellHtml = cell ? cell.innerHTML : null;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await callFn('dialer-recording', { attempt_id: attemptId });
    if (!res?.ok || !res.url) {
      msg.textContent = res?.error || res?.detail || 'No recording available for that call.';
      return;
    }
    if (download) {
      // The signed url is short-lived, so the download has to start now
      // rather than being handed to the person as a link to keep.
      const a = document.createElement('a');
      a.href = res.url;
      a.download = `call-${attemptId}.mp3`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
      msg.textContent = 'Download started.';
      return;
    }
    // Playback happens INSIDE the row, replacing that row's Recording cell,
    // rather than in a panel under the table. With fifty rows on screen a
    // player parked at the bottom loses which call it belongs to the moment
    // you scroll; in the row it cannot be misread. Only one plays at a time.
    closeInlinePlayer();
    if (!cell) return;
    openPlayer = { cell, html: cellHtml };
    cell.innerHTML =
      '<div class="inline-player">'
      + '<button type="button" class="ip-close" title="Close player">&times;</button>'
      + '<audio controls autoplay preload="none"></audio>'
      + '</div>';
    cell.querySelector('audio').src = res.url;
    cell.querySelector('.ip-close').onclick = closeInlinePlayer;
    msg.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// The open player, so a second Play (or the row being re-rendered by a
// filter change) restores the buttons rather than leaving a stranded widget.
let openPlayer = null;
function closeInlinePlayer() {
  if (!openPlayer) return;
  const a = openPlayer.cell.querySelector('audio');
  if (a) { a.pause(); a.src = ''; }
  openPlayer.cell.innerHTML = openPlayer.html;
  // The restored markup is a fresh set of buttons, so re-bind them.
  openPlayer.cell.querySelectorAll('button[data-play]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.play, false);
  });
  openPlayer.cell.querySelectorAll('button[data-dl]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.dl, true);
  });
  openPlayer = null;
}

function show(el, on) { el.classList.toggle('hide', !on); }

$('recRefresh').onclick = () => loadCallLog();
$('recExport').onclick = () => exportCallLog();
$('recSummary').onchange = () => loadCallLog();
// Changing any filter re-runs whichever view is showing. Re-running on change
// rather than behind an Apply button keeps the summary honest: it can never
// be describing a different filter set than the one on screen.
['recFrom', 'recTo', 'recAgent', 'recCampaign', 'recList', 'recSource',
 'recDuration', 'recStatus', 'recRecorded'].forEach((id) => {
  $(id).onchange = () => loadCallLog();
});


// ------------------------------------------------- call results multi-select
// Mirrors the control the floor already uses: every result checked by
// default, Check all / Uncheck all, grouped, and the button reporting how
// many are selected. "Not logged" is the '(none)' sentinel the RPCs
// understand -- calls that were never dispositioned at all.
let dispAll = [];   // [{code, label, group_name}], plus the Not logged entry

function buildDispMenu(rows) {
  dispAll = rows.map((r) => ({ code: r.code, label: r.label, group: r.group_name || 'Call results' }));
  dispAll.push({ code: '(none)', label: 'Not logged', group: 'Other' });

  const groups = [...new Set(dispAll.map((d) => d.group))];
  $('recDispList').innerHTML = groups.map((g) => {
    const items = dispAll.filter((d) => d.group === g).map((d) => `
      <label class="ms-item">
        <input type="checkbox" value="${esc(d.code)}" checked>
        <span>${esc(d.label)}</span>
      </label>`).join('');
    return `<div class="ms-group">${esc(g)}</div>${items}`;
  }).join('');

  $('recDispList').querySelectorAll('input').forEach((cb) => {
    cb.onchange = () => { syncDispLabel(); loadCallLog(); };
  });
  syncDispLabel();
}

// null when everything is checked: the RPCs read that as "no filter", which
// is cheaper than passing every code and means the untouched state and the
// all-checked state behave identically.
function dispSelection() {
  const boxes = [...$('recDispList').querySelectorAll('input')];
  if (!boxes.length) return null;
  const on = boxes.filter((b) => b.checked).map((b) => b.value);
  return on.length === boxes.length ? null : on;
}

function syncDispLabel() {
  const boxes = [...$('recDispList').querySelectorAll('input')];
  const on = boxes.filter((b) => b.checked).length;
  $('recDispBtn').textContent = on === boxes.length
    ? 'All call results'
    : `${on} call result${on === 1 ? '' : 's'}`;
}

function setAllDisp(on) {
  $('recDispList').querySelectorAll('input').forEach((cb) => { cb.checked = on; });
  syncDispLabel();
  loadCallLog();
}

$('recDispBtn').onclick = (e) => {
  e.stopPropagation();
  show($('recDispPanel'), $('recDispPanel').classList.contains('hide'));
};
$('recDispAll').onclick = () => setAllDisp(true);
$('recDispNone').onclick = () => setAllDisp(false);
// Clicks inside the panel must not close it, or ticking a box would shut the
// menu after every single change.
$('recDispPanel').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => show($('recDispPanel'), false));

// -------------------------------------------------------------- research --
// One RPC round trip returns the contact rows, the internal DNC history and
// every call to the number. Phone normalisation happens in SQL so that
// "(815) 822-5358", "8158225358" and "+18158225358" all resolve to the same
// number rather than each needing its own client-side guess.
async function researchNumber() {
  const raw = $('resNum').value.trim();
  if (!raw) { $('resMsg').textContent = 'Enter a number to research.'; return; }
  $('resMsg').textContent = 'Searching…';
  show($('resResults'), false);

  const { data, error } = await sb.rpc('dialer_research_number', { p_phone: raw });
  if (error) { $('resMsg').textContent = 'Search failed: ' + error.message; return; }
  if (!data?.ok) { $('resMsg').textContent = data?.error || 'Nothing found.'; return; }

  $('resNumEcho').textContent = prettyPhone(data.phone_e164);
  $('resMsg').textContent = '';
  show($('resResults'), true);

  const contacts = data.contacts || [], dnc = data.dnc || [], calls = data.calls || [];

  $('resContacts').innerHTML = contacts.length ? contacts.map((c) => `<tr>
      <td>${esc(c.contact_name || '—')}</td>
      <td>${esc(c.list_name || '—')}</td>
      <td>${esc(c.campaign_name || '—')}</td>
      <td style="white-space:nowrap">${esc(fmtWhen(c.created_at))}</td>
      <td class="num mono">${c.attempt_count ?? 0}</td>
      <td>${esc(c.status || '')}${c.retired_reason ? ` <span style="color:var(--text-dim)">(${esc(c.retired_reason)})</span>` : ''}</td>
      <td>${esc(c.last_outcome || '—')}</td>
      <td style="white-space:nowrap">${c.next_attempt_at ? esc(fmtWhen(c.next_attempt_at)) : '—'}</td>
    </tr>`).join('')
    : '<tr><td colspan="8">No contact rows found — this number is not on any loaded list.</td></tr>';

  // Suppression is the one thing on this screen worth being unmissable.
  $('resDnc').innerHTML = dnc.length ? dnc.map((d) => `<tr class="d-dnc">
      <td style="white-space:nowrap">${esc(fmtWhen(d.created_at))}</td>
      <td>${esc(d.source || '')}</td>
      <td>${esc(d.reason || '—')}</td>
      <td>${esc(d.added_by || '—')}</td>
      <td>${d.synced_to_readymode_at ? esc(fmtWhen(d.synced_to_readymode_at))
            : '<span style="color:var(--away)">Not yet exported</span>'}</td>
    </tr>`).join('')
    : '<tr><td colspan="5">No internal DNC entries — this number is not suppressed.</td></tr>';

  $('resCalls').innerHTML = calls.length ? calls.map((c) => `<tr>
      <td style="white-space:nowrap">${esc(fmtWhen(c.initiated_at))}</td>
      <td class="num mono">${c.talk_seconds == null ? '—' : mmss(c.talk_seconds)}</td>
      <td>${esc(c.agent_name || '—')}</td>
      <td>${c.is_manual ? 'Manual' : esc(c.campaign_name || c.direction || '—')}</td>
      <td>${c.disposition_label ? esc(c.disposition_label)
            : `<span style="color:var(--text-dim)">${esc(c.status || '')}</span>`}</td>
      <td>${c.has_recording
            ? `<button class="sm" data-play="${esc(c.id)}">Play</button>
               <button class="sm" data-dl="${esc(c.id)}" title="Download">&darr;</button>`
            : '<span style="color:var(--text-dim)">—</span>'}</td>
    </tr>`).join('')
    : '<tr><td colspan="6">No calls to this number.</td></tr>';

  // The research tab reuses the call log's single player, so playback behaves
  // identically on both screens.
  $('resCalls').querySelectorAll('button[data-play]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.play, false);
  });
  $('resCalls').querySelectorAll('button[data-dl]').forEach((b) => {
    b.onclick = () => playRecording(b, b.dataset.dl, true);
  });
}

$('resGo').onclick = researchNumber;
$('resNum').addEventListener('keydown', (e) => { if (e.key === 'Enter') researchNumber(); });

// -------------------------------------------------------------- coverage --
// v679: how many numbers the floor actually needs. Reps dialing x dials per
// rep per day / dials allowed per number per day. A rep with a number of their
// own (a sales number) dials from it, so that rep and that number are both
// left out of the shared pool on either side of the sum.
const COV_DEFAULTS = { dials_per_rep: 350, dials_per_number: 80 };
let covFacts = null;
let covPlanLoaded = false;
let covSaveTimer = null;

let npaGeo = null;   // v691: area code -> { lat, lon }, loaded once

async function loadCoverageFacts() {
  const [agentsRes, didsRes, settingRes, geoRes] = await Promise.all([
    sb.from('dialer_campaign_agents').select('agent_id, campaign_id').eq('is_active', true),
    sb.from('dialer_dids').select('status, assigned_to, area_code').neq('status', 'retired'),
    covPlanLoaded ? Promise.resolve({ data: null })
      : sb.from('dialer_settings').select('value').eq('key', 'coverage_plan').maybeSingle(),
    npaGeo ? Promise.resolve({ data: null }) : sb.from('dialer_npa_geo').select('npa, lat, lon'),
  ]);
  if (geoRes.data) {
    npaGeo = {};
    geoRes.data.forEach((g) => { npaGeo[g.npa] = { lat: Number(g.lat), lon: Number(g.lon) }; });
  }
  if (agentsRes.error || didsRes.error) {
    covFacts = { error: (agentsRes.error || didsRes.error).message };
    return;
  }
  if (!covPlanLoaded) {
    const v = settingRes.data?.value || {};
    $('covDials').value = Number(v.dials_per_rep) || COV_DEFAULTS.dials_per_rep;
    $('covCap').value = Number(v.dials_per_number) || COV_DEFAULTS.dials_per_number;
    covPlanLoaded = true;
  }
  // v697: a test campaign (tsr_exempt -- test numbers only) is not a floor
  // that needs numbers either; counting it planned "9 numbers, buy 7 in 312"
  // off nine test contacts.
  const live = new Set(campaigns.filter((c) => c.status === 'active' && !c.tsr_exempt).map((c) => c.id));
  const dids = didsRes.data || [];
  const salesReps = new Set(dids.filter((d) => d.assigned_to).map((d) => d.assigned_to));
  const dialing = new Set((agentsRes.data || []).filter((a) => live.has(a.campaign_id)).map((a) => a.agent_id));
  // v697: and SAY which active campaigns are out of the plan and why -- an
  // empty table with no reason reads as missing data.
  const leftOut = campaigns.filter((c) => c.status === 'active').map((c) => {
    if (c.tsr_exempt) return { name: c.name, why: 'test campaign, test numbers only' };
    const reps = (agentsRes.data || []).filter((a) => a.campaign_id === c.id).map((a) => a.agent_id);
    if (!reps.length) return { name: c.name, why: 'no reps assigned yet' };
    if (reps.every((id) => salesReps.has(id))) return { name: c.name, why: 'its reps dial from their own number' };
    return null;
  }).filter(Boolean);
  covFacts = {
    reps: [...dialing].filter((id) => !salesReps.has(id)).length,
    salesRepsLeftOut: [...dialing].filter((id) => salesReps.has(id)).length,
    active: dids.filter((d) => !d.assigned_to && d.status === 'active').length,
    resting: dids.filter((d) => !d.assigned_to && d.status === 'resting').length,
    salesNumbers: dids.filter((d) => d.assigned_to).length,
    poolNpas: dids.filter((d) => !d.assigned_to && d.status === 'active' && d.area_code).map((d) => d.area_code),
    leftOut,
  };
}

function coveragePlan() {
  if (!covFacts || covFacts.error) return null;
  const perRep = Math.max(1, Number($('covDials').value) || COV_DEFAULTS.dials_per_rep);
  const perNumber = Math.max(1, Number($('covCap').value) || COV_DEFAULTS.dials_per_number);
  const dialsPerDay = covFacts.reps * perRep;
  const needed = Math.ceil(dialsPerDay / perNumber);
  return { ...covFacts, perRep, perNumber, dialsPerDay, needed, short: Math.max(0, needed - covFacts.active) };
}

function renderCoveragePlan() {
  if (covFacts?.error) { $('covPlan').innerHTML = `<p class="hint">${esc(covFacts.error)}</p>`; return; }
  const p = coveragePlan();
  if (!p) return;
  const stat = (v, label, gap) => `<div class="stat"><b class="${gap ? 'gap' : ''}">${Number(v).toLocaleString()}</b><span>${label}</span></div>`;
  $('covPlan').innerHTML =
    stat(p.reps, 'Reps dialing')
    + stat(p.dialsPerDay, 'Dials per day')
    + stat(p.needed, 'Numbers needed')
    + stat(p.active, 'Active numbers you have')
    + stat(p.resting, 'Resting')
    + stat(p.short, 'Short by', p.short > 0)
    + `<p class="hint" style="margin:8px 0 0">${p.reps.toLocaleString()} rep${p.reps === 1 ? '' : 's'} on active campaigns
      &times; ${p.perRep.toLocaleString()} dials &divide; ${p.perNumber.toLocaleString()} per number
      = <strong>${p.needed.toLocaleString()} numbers</strong>.
      Left out: ${p.salesNumbers} sales number${p.salesNumbers === 1 ? '' : 's'}
      and ${p.salesRepsLeftOut} rep${p.salesRepsLeftOut === 1 ? '' : 's'} who dial${p.salesRepsLeftOut === 1 ? 's' : ''} from their own.
      ${p.short > 0 ? `Buy about <strong>${p.short}</strong> more &mdash; the table below says which area codes, nearest to the queue first.` : 'The pool covers this volume.'}
      Resting numbers are not counted: they are off so they can recover.</p>`;
}

function saveCoveragePlan() {
  renderCoveragePlan();
  renderCoverageRows();
  if (!canManage) return;
  clearTimeout(covSaveTimer);
  covSaveTimer = setTimeout(async () => {
    const p = coveragePlan();
    if (!p) return;
    const { error } = await sb.from('dialer_settings').upsert({
      key: 'coverage_plan', value: { dials_per_rep: p.perRep, dials_per_number: p.perNumber },
      updated_by: meId, updated_at: new Date().toISOString(),
    });
    $('covPlanMsg').textContent = error ? `Not saved: ${error.message}` : 'Saved.';
  }, 600);
}
$('covDials').addEventListener('input', saveCoveragePlan);
$('covCap').addEventListener('input', saveCoveragePlan);

// v691: WHERE to put the numbers the plan says to buy. Each number goes, in
// turn, to the area code with the most queued contacts per number there --
// numbers already owned count as placed -- so numbers follow dial volume and
// an area code with a handful of contacts is not given one of its own. (A
// pure nearest-distance placement was tried first and spent three of seven
// numbers on area codes holding one contact each: one far contact outweighed
// ten near ones.) Every area code left without a number dials from the
// nearest one that has one -- autopilot's same-area-code-else-closest rule --
// with straight-line miles between area-code centres (dialer_npa_geo).
function covMiles(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function covRecommend(rows, toBuy) {
  const geo = npaGeo || {};
  const have = {};
  (covFacts?.poolNpas || []).forEach((npa) => { have[npa] = (have[npa] || 0) + 1; });
  const buy = {};
  for (let i = 0; i < Math.max(0, toBuy) && rows.length; i++) {
    let best = null;
    rows.forEach((x) => {
      const w = Number(x.contacts) / ((have[x.area_code] || 0) + (buy[x.area_code] || 0) + 1);
      if (!best || w > best.w) best = { npa: x.area_code, w };
    });
    buy[best.npa] = (buy[best.npa] || 0) + 1;
  }
  const placed = [...new Set([...Object.keys(have), ...Object.keys(buy)])].filter((npa) => geo[npa]);
  const byNpa = {};
  rows.forEach((x) => {
    if (have[x.area_code] || buy[x.area_code]) return;
    const g = geo[x.area_code];
    if (!g) return;
    let near = null;
    placed.forEach((npa) => {
      const d = covMiles(g, geo[npa]);
      if (!near || d < near.d) near = { npa, d, toBuy: !have[npa] };
    });
    byNpa[x.area_code] = near;
  });
  return { buy, have, byNpa };
}

let covRowsData = [];
function renderCoverageRows() {
  const p = coveragePlan();
  const rec = p && covRowsData.length ? covRecommend(covRowsData, p.short) : null;
  $('covRows').innerHTML = covRowsData.length
    ? covRowsData.map((x) => {
      const buy = rec?.buy[x.area_code] || 0;
      const have = rec?.have[x.area_code] || 0;
      const near = rec?.byNpa[x.area_code];
      let cell = '—';
      if (buy) cell = `<b style="color:var(--good)">Buy ${buy} here</b>${have ? ` <span class="muted">(you have ${have})</span>` : ''}`;
      else if (have) cell = `Covered — you have ${have} here`;
      else if (near) {
        cell = `Dials from ${esc(near.npa)}${near.toBuy ? ' (to buy)' : ''} &middot; `
          + (near.d < 1 ? 'same area' : `${Math.round(near.d).toLocaleString()} mi`);
      }
      return `<tr>
        <td class="mono">${esc(x.area_code)}</td>
        <td class="num">${Number(x.contacts).toLocaleString()}</td>
        <td class="num ${Number(x.active_dids) === 0 ? 'gap' : ''}">${x.active_dids}</td>
        <td>${cell}</td>
        <td><button class="sm" data-npa="${esc(x.area_code)}">Find numbers</button></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5">No dialable contacts queued on campaigns that dial from the shared pool.</td></tr>';
  renderCoverageRec(p, rec);

  document.querySelectorAll('#covRows button[data-npa], #covRec button[data-npa]').forEach((b) => {
    b.onclick = () => { $('searchNpa').value = b.dataset.npa; $('searchBtn').click(); };
  });
}

function renderCoverageRec(p, rec) {
  const el = $('covRec');
  const left = (covFacts?.leftOut || []);
  const leftHtml = left.length
    ? `<p class="hint" style="margin:0 0 8px"><strong>Not in this plan:</strong> ${left.map((x) =>
        `${esc(x.name)} <span class="muted">(${esc(x.why)})</span>`).join(' &middot; ')}.</p>`
    : '';
  if (!p || !rec) {
    el.innerHTML = leftHtml + (p && !covRowsData.length
      ? '<p class="hint" style="margin:0 0 8px">No live campaign that dials from the shared pool has contacts waiting, '
        + 'so there is nothing to place yet. Load a list on one and this fills in.</p>' : '');
    return;
  }
  const owned = covFacts.poolNpas || [];
  const picks = Object.entries(rec.buy).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  el.innerHTML = `<p class="hint" style="margin:0 0 8px">
      <strong>${p.needed} number${p.needed === 1 ? '' : 's'}</strong>: the ${owned.length} you have${owned.length
        ? ` (${owned.map(esc).join(', ')})` : ''}${picks.length
        ? `, plus ${p.short} to buy in these area codes &mdash; where the queue is biggest; smaller area codes dial from the nearest one:`
        : '. Nothing to buy.'}
    </p>
    ${picks.length ? `<div class="row" style="gap:6px;margin-bottom:12px">${picks.map(([npa, n]) =>
      `<button class="sm" data-npa="${esc(npa)}" title="Search Telnyx for numbers in ${esc(npa)}">${esc(npa)}${n > 1 ? ` &times;${n}` : ''}</button>`).join('')}</div>` : ''}${leftHtml}`;
}

async function loadCoverage() {
  const [r] = await Promise.all([callFn('dialer-pool', { action: 'coverage_gaps' }), loadCoverageFacts()]);
  renderCoveragePlan();
  if (!r?.ok) { $('covRows').innerHTML = `<tr><td colspan="5">${esc(r?.error || 'Failed')}</td></tr>`; return; }
  const s = r.summary || {};
  $('covSummary').innerHTML =
    `<div class="stat"><b>${s.area_codes ?? 0}</b><span>Area codes in queue</span></div>` +
    `<div class="stat"><b>${s.covered ?? 0}</b><span>Covered</span></div>` +
    `<div class="stat"><b class="${s.uncovered ? 'gap' : ''}">${s.uncovered ?? 0}</b><span>No local DID</span></div>` +
    `<div class="stat"><b class="${s.contacts_without_local_did ? 'gap' : ''}">${(s.contacts_without_local_did ?? 0).toLocaleString()}</b><span>Contacts affected</span></div>`;

  covRowsData = r.rows || [];
  renderCoverageRows();
}

// ---------------------------------------------------------------- search --
$('searchBtn').onclick = async () => {
  const npa = $('searchNpa').value.replace(/\D/g, '');
  if (npa.length !== 3) { say($('searchMsg'), 'Enter a 3-digit area code.', 'err'); return; }
  say($('searchMsg'), 'Searching…', 'ok');
  const r = await callFn('dialer-pool', {
    action: 'search_numbers', area_code: npa, limit: Number($('searchLimit').value) || 10,
  });
  if (!r?.ok) { say($('searchMsg'), r?.error || 'Search failed', 'err'); return; }
  if (!r.numbers?.length) { say($('searchMsg'), `No numbers available in ${npa}.`, 'warn'); return; }

  say($('searchMsg'), '', null);
  $('searchWrap').classList.remove('hide');
  $('searchRows').innerHTML = r.numbers.map((n) => `<tr>
      <td><input type="checkbox" class="pick" value="${esc(n.phone_number)}"
                 data-state="${esc(n.state || '')}"></td>
      <td class="mono">${esc(n.phone_number)}</td>
      <td>${esc(n.state || '—')}</td>
      <td>${esc(n.rate_center || '—')}</td>
      <td class="num">${n.monthly_cost != null ? '$' + n.monthly_cost : '—'}</td>
    </tr>`).join('');
  // Ticking a box must not re-enable ordering for someone who may not order.
  // applyReadOnly() disabled it once at boot; this is the path that would
  // silently undo that.
  $('searchRows').querySelectorAll('.pick').forEach((c) => {
    c.onchange = () => {
      $('orderBtn').disabled = !isOwnerAdmin
        || !$('searchRows').querySelectorAll('.pick:checked').length;
    };
  });
  $('orderBtn').disabled = true;
};

$('orderBtn').onclick = async () => {
  const picked = [...$('searchRows').querySelectorAll('.pick:checked')];
  if (!picked.length) return;
  const nums = picked.map((c) => c.value);
  if (!confirm(`Buy ${nums.length} number(s)? This charges your Telnyx account.\n\n${nums.join('\n')}`)) return;

  $('orderBtn').disabled = true;
  say($('searchMsg'), 'Ordering…', 'ok');
  const r = await callFn('dialer-pool', {
    action: 'order_numbers', phone_numbers: nums, state: picked[0].dataset.state || null,
  });
  if (!r?.ok) { say($('searchMsg'), r?.error || 'Order failed', 'err'); return; }
  say($('searchMsg'), `Ordered ${r.ordered}. Added as resting — activate them below when ready to warm them in.`, 'ok');
  loadPool(); loadCoverage();
};

// ------------------------------------------------------------------ pool --
async function loadPool() {
  const r = await callFn('dialer-pool', { action: 'list_dids' });
  if (!r?.ok) { $('poolRows').innerHTML = `<tr><td colspan="8">${esc(r?.error || 'Failed')}</td></tr>`; return; }
  const today = new Date().toISOString().slice(0, 10);
  $('poolRows').innerHTML = (r.dids || []).length
    ? r.dids.map((d) => {
      const used = d.dials_today_date === today ? (d.dials_today ?? 0) : 0;
      const next = d.status === 'active' ? 'resting' : 'active';
      return `<tr>
        <td class="mono">${esc(d.phone_e164)}</td>
        <td class="mono">${esc(d.area_code || '—')}</td>
        <td>${esc(d.state || '—')}</td>
        <td><span class="tag t-${esc(d.status)}">${esc(d.status)}</span></td>
        <td class="num">${used}</td>
        <td class="num">${d.daily_cap ?? 80}</td>
        <td>${repCell(d)}</td>
        <td>${canManage ? `<button class="sm" data-did="${esc(d.id)}" data-next="${next}">
          ${next === 'active' ? 'Activate' : 'Rest'}</button>` : ''}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8">No numbers in the pool yet.</td></tr>';
  poolDids = r.dids || [];

  $('poolRows').querySelectorAll('button[data-did]').forEach((b) => {
    b.onclick = async () => {
      const d = poolDids.find((x) => x.id === b.dataset.did);
      if (b.dataset.next === 'active' && d && ['flagged', 'remediating'].includes(d.reputation_status)
          && !confirm(`${d.phone_e164} is marked ${d.reputation_status}. Put it back into rotation anyway?\n\n`
                    + 'Mark it Clean instead once the label is gone -- that records the dispute as cleared.')) return;
      b.disabled = true;
      await callFn('dialer-pool', { action: 'set_did_status', did_id: b.dataset.did, status: b.dataset.next });
      loadPool(); loadCoverage();
    };
  });

  // v594: reputation. Changing the select is the whole workflow -- flagged or
  // remediating takes the number out of rotation, clean puts it back.
  $('poolRows').querySelectorAll('select[data-rep]').forEach((sel) => {
    sel.onchange = async () => {
      const d = poolDids.find((x) => x.id === sel.dataset.rep);
      const to = sel.value;
      if (!d) return;
      if (['flagged', 'remediating'].includes(to) && d.status === 'active') {
        const othersActive = poolDids.filter((x) => x.status === 'active' && x.id !== d.id).length;
        const msg = othersActive
          ? `Take ${d.phone_e164} out of rotation? Agents stop calling from it until you mark it Clean.`
          : `${d.phone_e164} is the LAST active number. Taking it out means agents cannot place calls `
            + 'until another number is active. Continue?';
        if (!confirm(msg)) { sel.value = d.reputation_status || 'unknown'; return; }
      }
      sel.disabled = true;
      const res = await callFn('dialer-pool', { action: 'set_did_reputation', did_id: d.id, reputation_status: to });
      if (!res?.ok) { $('poolMsg').textContent = res?.error || 'Could not save.'; sel.disabled = false; return; }
      $('poolMsg').textContent = res.active_remaining === 0
        ? 'Saved. No active numbers are left -- agents cannot dial until one is activated.'
        : `Saved. ${res.active_remaining} active number${res.active_remaining === 1 ? '' : 's'} in rotation.`;
      loadPool(); loadCoverage();
    };
  });
  $('poolRows').querySelectorAll('input[data-repflag]').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      const res = await callFn('dialer-pool', { action: 'set_did_reputation', did_id: cb.dataset.id,
        [cb.dataset.repflag]: cb.checked });
      if (!res?.ok) { $('poolMsg').textContent = res?.error || 'Could not save.'; cb.checked = !cb.checked; }
      cb.disabled = false;
    };
  });
}

let poolDids = [];
const REP_LABELS = { unknown: 'Not checked', clean: 'Clean', flagged: 'Flagged (spam label)',
                     remediating: 'Dispute filed' };
const shortDate = (t) => t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;

function repCell(d) {
  const rep = d.reputation_status || 'unknown';
  const lines = [];
  if (d.remediation_filed_at) {
    lines.push(`Disputed ${shortDate(d.remediation_filed_at)}`
      + (d.remediation_cleared_at ? ` · cleared ${shortDate(d.remediation_cleared_at)}`
         : ` · open ${Math.max(0, Math.round((Date.now() - new Date(d.remediation_filed_at)) / 86400000))}d`));
  }
  if (d.last_reputation_check_at) lines.push(`Checked ${shortDate(d.last_reputation_check_at)}`);
  const meta = lines.length ? `<div class="hint" style="margin:3px 0 0">${esc(lines.join(' · '))}</div>` : '';
  if (!canManage) {
    return `${esc(REP_LABELS[rep] || rep)}${meta}`
      + `<div class="hint" style="margin:2px 0 0">CNAM ${d.cnam_registered ? 'yes' : 'no'}`
      + ` · Registry ${d.caller_registry_registered ? 'yes' : 'no'}</div>`;
  }
  return `<select class="sm" data-rep="${esc(d.id)}" style="padding:4px 8px;font-size:12px">`
    + Object.entries(REP_LABELS).map(([v, l]) =>
        `<option value="${v}"${v === rep ? ' selected' : ''}>${esc(l)}</option>`).join('')
    + `</select>${meta}
    <div style="display:flex;gap:10px;margin-top:4px;font-size:11.5px">
      <label style="display:flex;align-items:center;gap:4px" title="Caller ID name set on this number in Telnyx">
        <input type="checkbox" data-repflag="cnam_registered" data-id="${esc(d.id)}"${d.cnam_registered ? ' checked' : ''}> CNAM</label>
      <label style="display:flex;align-items:center;gap:4px" title="Registered at freecallerregistry.com">
        <input type="checkbox" data-repflag="caller_registry_registered" data-id="${esc(d.id)}"${d.caller_registry_registered ? ' checked' : ''}> Registry</label>
    </div>`;
}

$('syncBtn').onclick = async () => {
  $('syncBtn').disabled = true;
  $('poolMsg').textContent = 'Syncing…';
  const r = await callFn('dialer-pool', { action: 'sync_dids' });
  $('syncBtn').disabled = false;
  $('poolMsg').textContent = r?.ok
    ? `${r.telnyx_numbers} at Telnyx · ${r.retired_orphans} retired as no longer owned`
    : (r?.error || 'Sync failed');
  loadPool();
};

// v835. Free Caller Registry (Hiya, First Orion, TNS) has no API. Its upload
// takes a .txt of 10-digit numbers, one per line, no header. Downloading
// ticks nothing: the Registry boxes are ticked only when someone says the
// upload went through, because a file nobody uploaded registers nothing.
$('fcrBtn').onclick = () => {
  const msg = $('poolMsg');
  if (!poolDids.length) { msg.textContent = 'The pool has not loaded yet.'; return; }
  const todo = poolDids.filter((d) => d.status !== 'retired' && !d.caller_registry_registered
    && /^\+1\d{10}$/.test(d.phone_e164 || ''));
  if (!todo.length) { msg.textContent = 'Every number in the pool is already ticked Registry.'; return; }
  const text = todo.map((d) => d.phone_e164.slice(2)).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `free-caller-registry-${new Date().toLocaleDateString('en-CA')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  const n = todo.length, s = n === 1 ? '' : 's';
  msg.innerHTML = `Downloaded ${n} number${s}. Upload the file at `
    + '<a href="https://www.freecallerregistry.com" target="_blank" rel="noopener" style="color:#4EA8FF">freecallerregistry.com</a>'
    + ' under "Upload Additional Numbers".'
    + (canManage ? ` <button class="sm" id="fcrDone">Uploaded: tick these ${n} as Registry</button>` : '');
  if (!canManage) return;
  $('fcrDone').onclick = async () => {
    $('fcrDone').disabled = true;
    let failed = 0;
    for (const d of todo) {
      const res = await callFn('dialer-pool', { action: 'set_did_reputation', did_id: d.id,
        caller_registry_registered: true });
      if (!res?.ok) failed++;
    }
    msg.textContent = failed
      ? `${n - failed} of ${n} ticked Registry; ${failed} could not be saved. Registry file again lists only those.`
      : `${n} number${s} ticked Registry.`;
    loadPool();
  };
};

// ------------------------------------------------------------- campaigns --
async function loadCampaigns() {
  const { data } = await sb.from('dialer_campaigns')
    .select('id, name, dial_mode, status, calling_window_start, calling_window_end, autopilot_enabled, tsr_exempt')
    .neq('status', 'archived').order('name');
  campaigns = data || [];
  $('impCampaign').innerHTML = campaigns.map((c) =>
    `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
    || '<option value="">No campaigns yet</option>';

  const counts = {};
  for (const c of campaigns) {
    const { count } = await sb.from('dialer_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id).in('status', ['new', 'queued']);
    counts[c.id] = count ?? 0;
  }
  // Assigned-agent counts, so the table shows at a glance which queues have
  // nobody on them -- a queue with zero agents is silently dead work.
  const { data: assigns } = await sb.from('dialer_campaign_agents')
    .select('campaign_id, agent_id, is_active');
  const agentCounts = {};
  (assigns || []).forEach((a) => {
    if (a.is_active) agentCounts[a.campaign_id] = (agentCounts[a.campaign_id] || 0) + 1;
  });

  $('campRows').innerHTML = campaigns.length
    ? campaigns.map((c) => `<tr data-row="${esc(c.id)}">
        <td>${esc(c.name)}</td>
        <td>${esc(c.dial_mode)}</td>
        <td class="mono">${esc(c.calling_window_start)}–${esc(c.calling_window_end)}</td>
        <td><span class="tag ${c.status === 'active' ? 't-active' : 't-resting'}">${esc(c.status)}</span></td>
        <td><span class="tag ${c.autopilot_enabled ? 't-active' : 't-resting'}">${c.autopilot_enabled ? 'on' : 'off'}</span></td>
        <td class="num">${counts[c.id].toLocaleString()}</td>
        <td class="num">${agentCounts[c.id] ? agentCounts[c.id]
            : '<span style="color:var(--away)">0</span>'}</td>
        <td>${canManage ? `
          <button class="sm" data-edit="${esc(c.id)}">Edit</button>
          <button class="sm" data-camp="${esc(c.id)}" data-to="${c.status === 'active' ? 'paused' : 'active'}">
          ${c.status === 'active' ? 'Pause' : 'Activate'}</button>
          <button class="sm" data-cdel="${esc(c.id)}" data-cname="${esc(c.name)}" data-left="${counts[c.id]}">Delete</button>` : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="8">No campaigns yet.</td></tr>';

  $('campRows').querySelectorAll('button[data-camp]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      // v660: .select() so a refusal is VISIBLE. An RLS refusal is not an
      // error -- it matches zero rows -- so without this the button redrew
      // the table unchanged and said nothing, and somebody who believed they
      // had paused a campaign watched it keep dialing. That is how this was
      // missed: silence looked exactly like success.
      const { data: changed, error } = await sb.from('dialer_campaigns')
        .update({ status: b.dataset.to }).eq('id', b.dataset.camp).select('id');
      b.disabled = false;
      if (error || !changed || !changed.length) {
        alert(error
          ? `Could not change the campaign: ${error.message}`
          : 'That campaign was not changed — your role may not be allowed to change campaigns. Nothing was paused or resumed.');
        return;
      }
      loadCampaigns();
    };
  });
  $('campRows').querySelectorAll('button[data-edit]').forEach((b) => {
    b.onclick = () => toggleCampaignEditor(b.dataset.edit);
  });
  // v837 (the owner: "make an option to delete campaign"). Delete ARCHIVES:
  // status 'archived' is already refused everywhere a call can start (the
  // agent console lists active campaigns only, dialer-call-control refuses
  // anything not active, autopilot and email list imports skip archived),
  // and every campaign picker hides it. Nothing cascades: a real DELETE would
  // take the campaign's lists and contacts with it and orphan its call
  // history, so that is not offered. Restore brings it back paused.
  $('campRows').querySelectorAll('button[data-cdel]').forEach((b) => {
    b.onclick = async () => {
      const left = Number(b.dataset.left || 0);
      if (!confirm(`Delete the campaign "${b.dataset.cname}"?\n\n`
          + 'It stops dialing at once and disappears from every screen.'
          + (left ? ` ${left.toLocaleString()} contact${left === 1 ? ' is' : 's are'} still waiting to be called.` : '')
          + '\n\nIts lists, contacts, call history and recordings are kept, and you can restore it '
          + 'from "Deleted campaigns" under this table.')) return;
      await setCampaignArchived(b.dataset.cdel, true, b);
    };
  });
  loadDeletedCampaigns();
  loadDispoCatPanel();   // v592
}

// v837: delete (archive) and restore a campaign. .select() so an RLS refusal
// is visible, for the same reason as Pause (v660).
async function setCampaignArchived(id, archive, btn) {
  if (btn) btn.disabled = true;
  const { data: changed, error } = await sb.from('dialer_campaigns')
    .update({ status: archive ? 'archived' : 'paused' }).eq('id', id).select('id');
  if (btn) btn.disabled = false;
  if (error || !changed || !changed.length) {
    alert(error
      ? `Could not ${archive ? 'delete' : 'restore'} the campaign: ${error.message}`
      : `That campaign was not changed. Your role may not be allowed to change campaigns.`);
    return;
  }
  if (!archive) lsSet('da.lists.camp', id);
  loadCampaigns();
  if (daLoadedOnce.has('lists')) loadLists();
}
async function loadDeletedCampaigns() {
  const box = $('campDeleted');
  const { data } = await sb.from('dialer_campaigns').select('id, name, updated_at')
    .eq('status', 'archived').order('name');
  const rows = data || [];
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<details class="ls-help"><summary>Deleted campaigns (${rows.length})</summary>
    <div style="margin-top:8px">${rows.map((c) => `<div class="ls-row" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="ls-lname">${esc(c.name)}</div>
        ${c.updated_at ? `<div class="ls-count">Last changed ${esc(listDateMdy(c.updated_at))}</div>` : ''}</div>
      <div>${canManage ? `<button class="sm" data-crestore="${esc(c.id)}">Restore</button>` : ''}</div>
    </div>`).join('')}</div>
    <p class="hint" style="margin:8px 0 0">Restored campaigns come back <b>paused</b>; press Activate when you want them dialing.</p>
  </details>`;
  box.querySelectorAll('button[data-crestore]').forEach((b) => {
    b.onclick = () => setCampaignArchived(b.dataset.crestore, false, b);
  });
}

// ------------------------------------------------- campaign limits editor --
// These columns existed since v524 but were fixed at creation: nothing in the
// product could change a calling window or an attempt cap once a campaign was
// made. The constraints below mirror the CHECKs in the database exactly, so a
// bad number is refused here with a sentence instead of a Postgres error.
const CAMP_LIMITS = [
  { key: 'max_attempts',              label: 'Max attempts per contact', min: 1,  max: 30 },
  { key: 'min_hours_between_attempts', label: 'Hours between tries on one number', min: 1, max: 720 },
  // v562. Three trials on a line before the next one opens, then the whole
  // contact rests and comes back. The two numbers interact and the pairing
  // is the thing worth getting right: attempts_per_number x
  // min_hours_between_attempts is how long a single number occupies the
  // contact. 3 x 4h works a number out in a day; 3 x 24h takes three days
  // and a ten-number contact then takes a month to reach the end of.
  { key: 'attempts_per_number', label: 'Tries per number before the next', min: 1, max: 10 },
  { key: 'recycle_after_days',  label: 'Recycle after (days)', min: 1, max: 365 },
  { key: 'max_recycles',        label: 'Max recycles', min: 0, max: 10 },
  // v691: dialing speed. ring_seconds used to be hidden because nothing read
  // it; the agent console now hangs up an unanswered queued dial after this
  // long and records No answer itself. power_pause_seconds is the countdown
  // between power calls (it was a hardcoded 5).
  { key: 'ring_seconds',        label: 'Ring time before giving up (s)', min: 15, max: 60 },
  { key: 'power_pause_seconds', label: 'Pause between power calls (s)', min: 2, max: 30 },
];
// calling_days holds ISO weekdays -- Monday is 1 and SUNDAY IS 7, not 0.
// dialer-call-control's gate 3 compares against Intl's weekday mapped the
// same way, so a JS getDay()-style 0 for Sunday would silently mean "never
// Sunday" while the box looked ticked. Values are explicit here for that
// reason, and the week starts on Monday to match the default {1,2,3,4,5}.
const CALLING_DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'],
                      [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

// v564 fallback zones. US only, and deliberately narrower than QUEUE_ZONES
// below: that list is where an OFFICE sits, which can be Cairo or Manila.
// This is where a SELLER might be, and every number in these lists is a NANP
// number, so an office zone would be a category error here. Ordered west to
// east because west is the safe end -- see the note under the picker.
const FALLBACK_ZONES = [
  ['America/Los_Angeles', 'US Pacific — safest for a nationwide list'],
  ['America/Denver', 'US Mountain'],
  ['America/Phoenix', 'US Arizona (no DST)'],
  ['America/Chicago', 'US Central'],
  ['America/New_York', 'US Eastern'],
  ['America/Anchorage', 'Alaska'],
  ['Pacific/Honolulu', 'Hawaii'],
];

async function toggleCampaignEditor(id) {
  const existing = document.querySelector(`tr[data-editor="${id}"]`);
  if (existing) { existing.remove(); return; }
  document.querySelectorAll('tr[data-editor]').forEach((r) => r.remove());

  const row = document.querySelector(`tr[data-row="${id}"]`);
  if (!row) return;

  const { data: c } = await sb.from('dialer_campaigns')
    .select('id, name, dial_mode, status, calling_window_start, calling_window_end, '
          + 'calling_days, max_attempts, min_hours_between_attempts, ring_seconds, '
          + 'attempts_per_number, recycle_enabled, recycle_after_days, max_recycles, '
          + 'fallback_timezone, autopilot_enabled, tsr_exempt, '
          + 'amd_enabled, recording_enabled, script, sms_fallback_enabled, sms_fallback_template, power_pause_seconds')
    .eq('id', id).maybeSingle();
  if (!c) return;

  const tr = document.createElement('tr');
  tr.dataset.editor = id;
  const td = document.createElement('td');
  td.colSpan = 8;
  td.style.cssText = 'background:var(--inset);padding:18px';
  td.dataset.tsrExempt = c.tsr_exempt ? '1' : '';   // v690: read by saveCampaign
  td.innerHTML = `
    <div class="row" style="align-items:flex-end">
      <label style="display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:9px">
        <input type="checkbox" data-f="autopilot_enabled"${c.autopilot_enabled ? ' checked' : ''}> Autopilot</label>
    </div>
    <p class="hint" style="margin:0 0 14px">
      <strong>Autopilot</strong>: every dial goes out from the number in your inventory nearest to the
      number being called &mdash; the same area code first, otherwise the closest one &mdash; spread across
      equally close numbers. Each morning it also looks after the numbers this campaign dials from: a number
      whose answer rate collapses is taken out, one that has worked 21 days is rested, and rested numbers come
      back when the pool runs thin. A rep's own (sales) number is never touched.
    </p>
    <p class="hint" style="margin:0 0 10px">${c.tsr_exempt
      ? '<strong>Test campaign</strong>: no legal calling-hours limit, so it can dial around the clock. '
        + 'Load only test numbers and your own here &mdash; never a real lead list.'
      : '<strong>Calling window</strong>: between 08:00 and 21:00 in the called person&rsquo;s local time '
        + '&mdash; the legal limit for telemarketing calls. A narrower window is fine.'}</p>
    <div class="row">
      <div class="field"><label>Dial mode</label>
        <select data-f="dial_mode">
          <option value="preview"${c.dial_mode === 'preview' ? ' selected' : ''}>Preview</option>
          <option value="power"${c.dial_mode === 'power' ? ' selected' : ''}>Power</option>
        </select></div>
      <div class="field"><label>Window opens</label>
        <input type="time" data-f="calling_window_start"${c.tsr_exempt ? '' : ' min="08:00" max="21:00"'}
               value="${esc((c.calling_window_start || '').slice(0, 5))}"></div>
      <div class="field"><label>Window closes</label>
        <input type="time" data-f="calling_window_end"${c.tsr_exempt ? '' : ' min="08:00" max="21:00"'}
               value="${esc((c.calling_window_end || '').slice(0, 5))}"></div>
      ${CAMP_LIMITS.map((f) => `
      <div class="field"><label>${esc(f.label)}</label>
        <input type="number" data-f="${f.key}" min="${f.min}" max="${f.max}"
               value="${c[f.key] ?? ''}"></div>`).join('')}
    </div>
    <div class="row" style="margin-top:10px;align-items:center">
      <span class="fb-label">Calling days</span>
      ${CALLING_DAYS.map(([v, d]) => `<label style="display:flex;align-items:center;gap:5px">
        <input type="checkbox" data-day="${v}"${(c.calling_days || []).includes(v) ? ' checked' : ''}>${d}</label>`).join('')}
      <label style="display:flex;align-items:center;gap:5px;margin-left:14px;opacity:.55" title="Needs background dialing. Telnyx, like ReadyMode, only detects machines on calls the SERVER places; this dialer's calls are placed by the agent's browser. Available once background dialing is built.">
        <input type="checkbox" data-f="amd_enabled" disabled${c.amd_enabled ? ' checked' : ''}>Answering-machine detection <span style="font-size:11px">(needs background dialing)</span></label>
      <label style="display:flex;align-items:center;gap:5px;opacity:.55" title="Recording is enabled per connection in the Telnyx portal (Outbound &rarr; Record All Outbound Calls), not per campaign. This checkbox does not control it.">
        <input type="checkbox" data-f="recording_enabled" disabled${c.recording_enabled ? ' checked' : ''}>Record calls <span style="font-size:11px">(set in Telnyx)</span></label>
    </div>
    <p class="hint" style="margin:12px 0 0">
      The window is in each contact's own local time, not yours.
      <strong>Dialing speed</strong>: an unanswered call rings for the ring time, then the console hangs up
      and records <em>No answer</em> by itself; on a power campaign the next call starts after the pause.
      One line per agent &mdash; dialing several lines at once needs background dialing.
    </p>

    <!-- v562. How a contact's numbers are worked, and what happens when they
         run out. The two numbers above interact and the pairing is the thing
         worth getting right, so it is spelled out rather than left to be
         inferred from two fields sitting side by side. -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:6px">Working a contact's numbers</div>
      <p class="hint" style="margin:0 0 10px">
        A number is tried <strong>${Number(c.attempts_per_number ?? 3)}</strong> times,
        <strong>${Number(c.min_hours_between_attempts ?? 24)}h</strong> apart, before the
        next one opens &mdash; so one number occupies a contact for about
        <strong>${(((c.attempts_per_number ?? 3) - 1) * (c.min_hours_between_attempts ?? 24) / 24).toFixed(1)} days</strong>.
        Only silence counts: no answer, busy, voicemail, a dead call. Being told
        no, a wrong number, a disconnected line or reaching the wrong person
        retires that number immediately and it never comes back.
        <br><br>
        Max attempts per contact is <strong>${Number(c.max_attempts ?? 6)}</strong>, which
        caps the whole contact
        ${(c.max_attempts ?? 6) < (c.attempts_per_number ?? 3) * 2
          ? '&mdash; <strong>lower than two numbers’ worth of tries</strong>, so the '
            + 'contact stops before its alternates are reached. Raise it to at least '
            + ((c.attempts_per_number ?? 3) * 3) + ' to work three numbers.'
          : 'across all of its numbers.'}
      </p>
      <!-- v564. The last link of the calling-hours chain: this line's zone,
           then the contact's, then this. Only reached by a number whose area
           code the table cannot place, and left unset it refuses the dial,
           which is the conservative default it has always been. -->
      <div class="row" style="margin:0 0 12px">
        <div class="field" style="min-width:260px">
          <label>Fallback time zone <span class="muted">(numbers with no zone)</span></label>
          <select data-f="fallback_timezone">
            <option value="">Do not dial them (default)</option>
            ${FALLBACK_ZONES.map(([v, d]) =>
              `<option value="${esc(v)}"${c.fallback_timezone === v ? ' selected' : ''}>${esc(d)}</option>`).join('')}
            ${c.fallback_timezone && !FALLBACK_ZONES.some(([v]) => v === c.fallback_timezone)
              ? `<option value="${esc(c.fallback_timezone)}" selected>${esc(c.fallback_timezone)}</option>` : ''}
          </select>
        </div>
      </div>
      <p class="hint" style="margin:0 0 12px">
        Used only when the area code is not one this build knows &mdash; the
        <strong>No time zone</strong> count in Lists. <strong>Pick the westernmost zone
        you call.</strong> Gating an unknown number on a zone west of its real one opens
        the window late (Pacific 9am is Eastern noon &mdash; harmless); gating it on a
        zone east of its real one opens it early (Eastern 9am is Pacific 6am &mdash; a
        complaint). It is never written onto the contact, so a real zone resolved later
        still wins.
      </p>

      <label style="display:flex;align-items:center;gap:6px;font-weight:600">
        <input type="checkbox" data-f="recycle_enabled"${c.recycle_enabled !== false ? ' checked' : ''}>
        Recycle a contact once every number is spent</label>
      <p class="hint" style="margin:8px 0 0">
        It rests for the recycle interval above, then reopens at Ph#1 with the
        counters cleared, up to the recycle cap. Numbers retired as DNC, wrong
        number or disconnected are never reopened by a recycle. After the last
        recycle the contact is retired as <span class="mono">all_numbers_exhausted</span>.
      </p>
    </div>

    <!-- v595. The script agents read beside the contact. Merge fields fill
         from the contact on screen; one with no value shows as a highlighted
         blank, so the agent can see what is missing and ask. -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:6px">Call script</div>
      <p class="hint" style="margin:0 0 8px">
        Shown to agents beside the contact. Merge fields:
        <span class="mono">{{first_name}}</span> <span class="mono">{{last_name}}</span>
        <span class="mono">{{full_name}}</span> <span class="mono">{{address}}</span>
        <span class="mono">{{city}}</span> <span class="mono">{{state}}</span>
        <span class="mono">{{zip}}</span> <span class="mono">{{phone}}</span>
        <span class="mono">{{agent_first_name}}</span> <span class="mono">{{agent}}</span>
        <span class="mono">{{campaign}}</span>, and any field mapped at import by its key.
      </p>
      <textarea data-f="script" rows="7" style="width:100%"
        placeholder="Hi {{first_name}}, this is {{agent_first_name}} with PrimeHome Buyers. I'm calling about {{address}} in {{city}}...">${esc(c.script || '')}</textarea>
    </div>

    <!-- SMS fallback. Manual dials only, by decision: an automatic text after
         queued cold traffic is a different consent posture from following up
         with one specific person an agent just chose to call. The wording is
         editable here rather than constant in code because it is the part
         that gets tuned, and it lands from a number the recipient does not
         recognise -- so it has to say who is texting and why. -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <label style="display:flex;align-items:center;gap:6px;font-weight:600">
        <input type="checkbox" data-f="sms_fallback_enabled"${c.sms_fallback_enabled ? ' checked' : ''}>
        Text after an unanswered <em>manual</em> dial</label>
      <p class="hint" style="margin:8px 0">
        Sent from +1 312-638-0895. Merge fields: <span class="mono">{{first_name}}</span>,
        <span class="mono">{{agent}}</span>. Never sent to a number on the internal
        do-not-call list. One segment is 160 characters &mdash; a single emoji drops that to 70.
      </p>
      <textarea data-f="sms_fallback_template" rows="3" style="width:100%"
        placeholder="Hi {{first_name}}, this is {{agent}} at ...">${esc(c.sms_fallback_template || '')}</textarea>
      <div class="hint" id="smsLen_${c.id}" style="margin-top:4px"></div>
    </div>

    <!-- v592. What agents on THIS queue are offered at wrap-up, and what is
         sent automatically on some outcomes. A queue with no list of its own
         offers the default list, exactly as before. -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:8px">Wrap-up outcomes</div>
      <div class="row" style="margin:0 0 8px;gap:18px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="dmode_${esc(c.id)}" value="default" data-dmode> The default list</label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="dmode_${esc(c.id)}" value="custom" data-dmode> This queue's own list</label>
      </div>
      <p class="hint" style="margin:0 0 10px" data-dhint></p>
      <div class="scroll"><table><thead><tr>
        <th>Offer</th><th>Outcome</th><th>What it does</th><th class="num">Order</th>
      </tr></thead><tbody data-dset><tr><td colspan="4">Loading…</td></tr></tbody></table></div>
    </div>

    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:6px">Automatic messages</div>
      <p class="hint" style="margin:0 0 10px">
        Sent the moment an agent saves the outcome, with no click from them. Email goes from the
        agent's own connected Gmail. A text goes from +1 312-638-0895, and only to someone who
        agreed to receive texts and is not on the do-not-call list. Merge fields:
        <span class="mono">{{first_name}}</span> <span class="mono">{{last_name}}</span>
        <span class="mono">{{full_name}}</span> <span class="mono">{{agent}}</span>
        <span class="mono">{{agent_first_name}}</span> <span class="mono">{{address}}</span>
        <span class="mono">{{city}}</span> <span class="mono">{{state}}</span>
        <span class="mono">{{phone}}</span>.
      </p>
      <div data-actions></div>
      <button class="sm" data-add-action style="margin-top:4px">Add a message</button>
    </div>

    <!-- v667/v669. The lead form this queue files leads under, and what each
         outcome DOES here: retry timing, messages, callbacks, hand-offs. Both
         save on their own buttons -- they are live the moment they are saved,
         and should not wait on an unrelated edit to the queue above. -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:6px">Lead form</div>
      <p class="hint" style="margin:0 0 8px">
        The submission form an agent fills in from the call screen on this queue. Leads land in
        Queue Review under this form. No form = no Start lead button.
      </p>
      <div class="row" style="margin-bottom:0">
        <select data-leadform style="min-width:260px"></select>
        <button class="sm" data-leadform-save>Save lead form</button>
        <span data-leadform-msg class="muted"></span>
      </div>
    </div>

    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="fb-label" style="margin-bottom:6px">Outcome rules</div>
      <p class="hint" style="margin:0 0 10px">
        What each outcome does on this queue. An outcome with no rule keeps the queue's normal
        timing above. Leave a box blank for "no limit"; a blank retry means no retry. Working days
        are this queue's calling days. Messages are written in Settings &rarr; Message templates.
      </p>
      <div data-rules><p class="hint">Loading…</p></div>
      <div class="row" style="margin-top:6px">
        <button class="sm" data-add-rule>Add a rule</button>
        <button class="sm primary" data-save-rules>Save rules</button>
        <span data-rules-msg class="muted"></span>
      </div>
    </div>

    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="fb-label" style="margin-bottom:8px">Assigned agents &amp; their caps on this queue</div>
      <div class="scroll"><table><thead><tr>
        <th>Agent</th><th>Assigned</th>
        <th class="num">Max calls / day</th><th class="num">Max contacts</th>
      </tr></thead><tbody data-assign></tbody></table></div>
      <p class="hint" style="margin:10px 0 0">Leave a cap blank for no limit.</p>
    </div>

    <div class="row" style="margin-top:16px">
      <button class="primary" data-save>Save queue</button>
      <button data-cancel>Cancel</button>
      <span data-msg></span>
    </div>`;
  tr.appendChild(td);
  row.after(tr);

  // Only people who can actually use the dialer can be assigned to a queue.
  const { data: roles } = await sb.from('roles').select('name, can_use_dialer');
  const dialerRoles = new Set((roles || []).filter((r) => r.can_use_dialer).map((r) => r.name));
  const { data: people } = await sb.from('profiles').select('id, full_name, role').order('full_name');
  const eligible = (people || []).filter((p) => dialerRoles.has(p.role));

  const { data: rows } = await sb.from('dialer_campaign_agents')
    .select('agent_id, is_active, max_calls_per_day, max_contacts').eq('campaign_id', id);
  const byAgent = {};
  (rows || []).forEach((r) => { byAgent[r.agent_id] = r; });

  td.querySelector('[data-assign]').innerHTML = eligible.length
    ? eligible.map((p) => {
        const a = byAgent[p.id];
        return `<tr>
          <td>${esc(p.full_name || p.id)} <span class="muted">${esc(p.role)}</span></td>
          <td><input type="checkbox" data-a="${esc(p.id)}"${a && a.is_active ? ' checked' : ''}></td>
          <td class="num"><input type="number" min="1" style="width:90px"
              data-cap="${esc(p.id)}" value="${a?.max_calls_per_day ?? ''}"></td>
          <td class="num"><input type="number" min="1" style="width:90px"
              data-cont="${esc(p.id)}" value="${a?.max_contacts ?? ''}"></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4">No profiles hold a role with dialer access.</td></tr>';

  // v592. The catalogue first: the message editor's outcome lists read it.
  await renderDispoEditor(td, id);
  await renderActionsEditor(td, id);
  await renderLeadFormPicker(td, id);
  await renderRulesEditor(td, id);

  td.querySelector('[data-cancel]').onclick = () => tr.remove();
  td.querySelector('[data-save]').onclick = () => saveCampaign(id, td, tr);
}

// v690: the calling-window rule in words, shared by the editor and Create.
// The database enforces the same thing (dialer_campaigns_calling_window_
// within_tsr) and would otherwise answer with its constraint name. tsr_exempt
// (test campaigns dialling only test numbers) is set by migration, never here.
const WINDOW_LAW_MSG = 'Calls are only allowed between 08:00 and 21:00 in the called person’s local time '
  + '(the legal limit for telemarketing). Pick a window inside those hours.';
function windowError(start, end, exempt) {
  const s = String(start || '').slice(0, 5);
  const e = String(end || '').slice(0, 5);
  if (!s || !e) return 'Both ends of the calling window are required.';
  if (s >= e) return 'The calling window must close after it opens.';
  if (!exempt && (s < '08:00' || e > '21:00')) return WINDOW_LAW_MSG;
  return '';
}
const campaignDbError = (error) =>
  (/calling_window_within_tsr/.test(error?.message || '') ? WINDOW_LAW_MSG : (error?.message || String(error)));

async function saveCampaign(id, td, tr) {
  const msg = td.querySelector('[data-msg]');
  const val = (k) => td.querySelector(`[data-f="${k}"]`);

  const patch = {
    autopilot_enabled: val('autopilot_enabled').checked, // v679
    dial_mode: val('dial_mode').value,
    calling_window_start: val('calling_window_start').value,
    calling_window_end: val('calling_window_end').value,
    sms_fallback_enabled: val('sms_fallback_enabled').checked,
    recycle_enabled: val('recycle_enabled').checked,
    // Empty means "refuse the dial", which is null in the column, not ''.
    // The check constraint rejects '' outright, so this must not send it.
    fallback_timezone: val('fallback_timezone').value || null,
    sms_fallback_template: val('sms_fallback_template').value.trim() || null,
    script: val('script').value.trim() || null,   // v595
    // amd_enabled / recording_enabled are intentionally NOT sent: their
    // controls are disabled above because nothing reads either column,
    // and writing whatever a disabled checkbox happens to show would
    // quietly rewrite the stored value on every save.
    calling_days: [...td.querySelectorAll('[data-day]')]
      .filter((c) => c.checked).map((c) => Number(c.dataset.day)),
  };

  // Checked here rather than letting Postgres reject it, so the admin gets
  // the field name and the allowed range instead of a constraint name.
  for (const f of CAMP_LIMITS) {
    const n = Number(val(f.key).value);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      say(msg, `${f.label} must be a whole number between ${f.min} and ${f.max}.`, 'err');
      return;
    }
    patch[f.key] = n;
  }
  const winErr = windowError(patch.calling_window_start, patch.calling_window_end, td.dataset.tsrExempt === '1');
  if (winErr) { say(msg, winErr, 'err'); return; }
  if (!patch.calling_days.length) {
    say(msg, 'Pick at least one calling day, or the queue can never dial.', 'err'); return;
  }
  // v592: checked before anything is written, like the fields above.
  const v592Err = validateDispoSet(td) || validateActions(td);
  if (v592Err) { say(msg, v592Err, 'err'); return; }

  td.querySelector('[data-save]').disabled = true;
  say(msg, 'Saving…', 'ok');

  const { error } = await sb.from('dialer_campaigns').update(patch).eq('id', id);
  if (error) { say(msg, campaignDbError(error), 'err'); td.querySelector('[data-save]').disabled = false; return; }

  // Assignment rows: upsert the ones that are ticked, and mark the rest
  // inactive rather than deleting them -- assigned_by/assigned_at is a record
  // of who put an agent on a queue, and deleting the row destroys it.
  const ups = [];
  const off = [];
  td.querySelectorAll('[data-a]').forEach((cb) => {
    const aid = cb.dataset.a;
    const cap = td.querySelector(`[data-cap="${aid}"]`).value;
    const cont = td.querySelector(`[data-cont="${aid}"]`).value;
    if (cb.checked) {
      ups.push({
        campaign_id: id, agent_id: aid, is_active: true,
        max_calls_per_day: cap === '' ? null : Number(cap),
        max_contacts: cont === '' ? null : Number(cont),
        assigned_by: meId,
      });
    } else off.push(aid);
  });

  if (ups.length) {
    const { error: e2 } = await sb.from('dialer_campaign_agents')
      .upsert(ups, { onConflict: 'campaign_id,agent_id' });
    if (e2) { say(msg, e2.message, 'err'); td.querySelector('[data-save]').disabled = false; return; }
  }
  if (off.length) {
    // v660: checked. The upsert above is; this was not, so an agent you
    // UNTICKED could stay assigned while the screen said "Saved." -- and an
    // agent still on a campaign keeps being handed its contacts.
    const { error: offErr } = await sb.from('dialer_campaign_agents').update({ is_active: false })
      .eq('campaign_id', id).in('agent_id', off);
    if (offErr) { say(msg, `Could not remove the unticked agents: ${offErr.message}`, 'err');
      td.querySelector('[data-save]').disabled = false; return; }
  }

  // v592: the outcome list and the automatic messages.
  const e3 = (await saveDispoSet(td, id)) || (await saveActions(td, id));
  if (e3) { say(msg, e3, 'err'); td.querySelector('[data-save]').disabled = false; return; }

  say(msg, 'Saved.', 'ok');
  tr.remove();
  loadCampaigns();
}

// ------------------------------------------------------ v595: pipeline --
let pipeNames = {};
let pipeReps = [];      // people who can use the dialer, for "hand to"
let pipeOppsShown = [];

function pipeAgo(t) {
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  return m < 60 ? `${Math.max(m, 0)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
function pipeDue(t) {
  const ms = new Date(t) - Date.now();
  const m = Math.round(Math.abs(ms) / 60000);
  const rel = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms < 0 ? `<span class="gap">${rel} overdue</span>` : `in ${rel}`;
}
function pipeRepSelect(kind, id, owner) {
  if (!canManage) return esc(pipeNames[owner] || '—');
  return `<select data-${kind}="${esc(id)}" data-owner="${esc(owner)}" style="padding:4px 8px;font-size:12px">`
    + pipeReps.map((p) => `<option value="${esc(p.id)}"${p.id === owner ? ' selected' : ''}>${esc(p.full_name || p.id)}</option>`).join('')
    + (pipeReps.some((p) => p.id === owner) ? '' : `<option value="${esc(owner)}" selected>${esc(pipeNames[owner] || 'unknown')}</option>`)
    + '</select>';
}

async function loadPipeline() {
  const days = Number($('pipeDays').value) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  $('pipeMsg').textContent = 'Loading…';
  const [opps, closed, fus, people, roles] = await Promise.all([
    sb.from('dialer_opportunities')
      .select('id, owner_id, phone_e164, contact_name, address, city, state, last_activity_at')
      .eq('status', 'open').order('last_activity_at', { ascending: false }).limit(1000),
    sb.from('dialer_opportunities').select('owner_id, status')
      .in('status', ['converted', 'lost']).gte('closed_at', since).limit(5000),
    sb.from('dialer_follow_ups').select('id, owner_id, phone_e164, contact_name, due_at, note')
      .eq('status', 'open').order('due_at', { ascending: true, nullsFirst: false }).limit(2000),   // v702: undated last
    sb.from('profiles').select('id, full_name, role'),
    sb.from('roles').select('name, can_use_dialer'),
  ]);
  const failed = [opps, closed, fus].find((r) => r.error);
  if (failed) { $('pipeMsg').textContent = failed.error.message; return; }

  pipeNames = {};
  (people.data || []).forEach((p) => { pipeNames[p.id] = p.full_name || p.id.slice(0, 8); });
  const dialerRoles = new Set((roles.data || []).filter((r) => r.can_use_dialer).map((r) => r.name));
  pipeReps = (people.data || [])
    .filter((p) => dialerRoles.has(p.role) || p.role === 'owner' || p.role === 'admin')
    .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));

  // ---- by rep ----
  const now = Date.now();
  const byRep = {};
  const rep = (id) => (byRep[id] ||= { open: 0, converted: 0, lost: 0, fu: 0, overdue: 0 });
  (opps.data || []).forEach((o) => { rep(o.owner_id).open++; });
  (closed.data || []).forEach((o) => { rep(o.owner_id)[o.status]++; });
  (fus.data || []).forEach((f) => {
    const r = rep(f.owner_id);
    r.fu++;
    if (f.due_at && new Date(f.due_at).getTime() < now) r.overdue++;   // v702: an undated one is never overdue
  });
  const ids = Object.keys(byRep).sort((a, b) => String(pipeNames[a] || '').localeCompare(String(pipeNames[b] || '')));
  $('pipeReps').innerHTML = ids.length ? ids.map((id) => {
    const r = byRep[id];
    const decided = r.converted + r.lost;
    return `<tr><td>${esc(pipeNames[id] || id)}</td>
      <td class="num">${r.open}</td><td class="num">${r.converted}</td><td class="num">${r.lost}</td>
      <td class="num">${decided ? Math.round((100 * r.converted) / decided) + '%' : '—'}</td>
      <td class="num">${r.fu}</td>
      <td class="num">${r.overdue ? `<span class="gap">${r.overdue}</span>` : 0}</td></tr>`;
  }).join('') : '<tr><td colspan="7">No follow-ups or opportunities yet.</td></tr>';

  // ---- follow-ups due within 24h, overdue first (already in due order) ----
  const horizon = now + 86400000;
  const due = (fus.data || []).filter((f) => !f.due_at || new Date(f.due_at).getTime() <= horizon);   // v702: undated ones listed too, last
  $('pipeFollowUps').innerHTML = due.length ? due.map((f) => `<tr>
      <td>${f.due_at ? `${pipeDue(f.due_at)}<div class="hint" style="margin:2px 0 0">${esc(new Date(f.due_at).toLocaleString())}</div>` : '<span class="hint">No date set</span>'}</td>
      <td>${esc(f.contact_name || '—')}<div class="mono" style="font-size:11px">${esc(f.phone_e164)}</div></td>
      <td>${pipeRepSelect('fu', f.id, f.owner_id)}</td>
      <td style="max-width:320px">${esc(f.note || '')}</td></tr>`).join('')
    : '<tr><td colspan="4">Nothing due in the next 24 hours.</td></tr>';

  // ---- open opportunities, with note counts ----
  pipeOppsShown = (opps.data || []).slice(0, 300);
  const counts = {};
  if (pipeOppsShown.length) {
    const { data: notes } = await sb.from('dialer_opportunity_notes')
      .select('opportunity_id').in('opportunity_id', pipeOppsShown.map((o) => o.id)).limit(10000);
    (notes || []).forEach((n) => { counts[n.opportunity_id] = (counts[n.opportunity_id] || 0) + 1; });
  }
  $('pipeOpps').innerHTML = pipeOppsShown.length ? pipeOppsShown.map((o) => `<tr>
      <td>${esc(o.contact_name || '—')}<div class="mono" style="font-size:11px">${esc(o.phone_e164)}</div></td>
      <td>${esc([o.address, o.city, o.state].filter(Boolean).join(', ') || '—')}</td>
      <td>${pipeRepSelect('opp', o.id, o.owner_id)}</td>
      <td>${esc(pipeAgo(o.last_activity_at))}</td>
      <td class="num">${counts[o.id] || 0}</td>
      <td><button class="sm" data-oppnotes="${esc(o.id)}">Notes</button></td></tr>`).join('')
    : '<tr><td colspan="6">No open opportunities.</td></tr>';
  $('pipeOppNotes').classList.add('hide');

  $('pipeMsg').textContent = `${(opps.data || []).length} open opportunities · ${(fus.data || []).length} open follow-ups`
    + ((opps.data || []).length > pipeOppsShown.length ? ` (showing the ${pipeOppsShown.length} most recent)` : '');

  // ---- hand to another rep ----
  document.querySelectorAll('#pipeFollowUps select[data-fu]').forEach((sel) => {
    sel.onchange = async () => {
      const to = sel.value;
      if (!confirm(`Hand this follow-up from ${pipeNames[sel.dataset.owner] || 'its rep'} to ${pipeNames[to] || 'this rep'}?`)) {
        sel.value = sel.dataset.owner; return;
      }
      sel.disabled = true;
      // reminded_at cleared so the new owner is reminded -- within a minute
      // if it is already due. The old owner's reminder has already fired.
      const { error } = await sb.from('dialer_follow_ups')
        .update({ owner_id: to, reminded_at: null, updated_at: new Date().toISOString() })
        .eq('id', sel.dataset.fu);
      if (error) { $('pipeMsg').textContent = error.message; sel.value = sel.dataset.owner; sel.disabled = false; return; }
      loadPipeline();
    };
  });
  document.querySelectorAll('#pipeOpps select[data-opp]').forEach((sel) => {
    sel.onchange = async () => {
      const to = sel.value;
      if (!confirm(`Hand this opportunity from ${pipeNames[sel.dataset.owner] || 'its rep'} to ${pipeNames[to] || 'this rep'}? `
                 + 'Its open follow-ups go with it.')) {
        sel.value = sel.dataset.owner; return;
      }
      sel.disabled = true;
      const nowIso = new Date().toISOString();
      const { error } = await sb.from('dialer_opportunities')
        .update({ owner_id: to, updated_at: nowIso }).eq('id', sel.dataset.opp);
      if (error) { $('pipeMsg').textContent = error.message; sel.value = sel.dataset.owner; sel.disabled = false; return; }
      await sb.from('dialer_follow_ups')
        .update({ owner_id: to, reminded_at: null, updated_at: nowIso })
        .eq('opportunity_id', sel.dataset.opp).eq('status', 'open');
      await sb.from('dialer_opportunity_notes').insert({
        opportunity_id: sel.dataset.opp, author_id: meId,
        body: `Handed from ${pipeNames[sel.dataset.owner] || 'another rep'} to ${pipeNames[to] || 'another rep'}.`,
      });
      loadPipeline();
    };
  });
  document.querySelectorAll('#pipeOpps button[data-oppnotes]').forEach((b) => {
    b.onclick = () => showPipeNotes(b.dataset.oppnotes);
  });
}

async function showPipeNotes(id) {
  const o = pipeOppsShown.find((x) => x.id === id);
  const box = $('pipeOppNotes');
  box.classList.remove('hide');
  box.innerHTML = '<div class="hint">Loading…</div>';
  const { data, error } = await sb.from('dialer_opportunity_notes')
    .select('body, created_at, author_id').eq('opportunity_id', id).order('created_at', { ascending: false });
  if (error) { box.innerHTML = `<div class="hint">${esc(error.message)}</div>`; return; }
  box.innerHTML = `<div class="fb-label" style="margin-bottom:8px">Notes — ${esc(o?.contact_name || o?.phone_e164 || '')}</div>`
    + ((data || []).map((n) => `<div style="border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:8px;
          white-space:pre-wrap;font-size:13px"><div class="hint" style="margin:0 0 3px">
          ${esc(new Date(n.created_at).toLocaleString())} · ${esc(pipeNames[n.author_id] || '')}</div>${esc(n.body)}</div>`).join('')
       || '<div class="hint">No notes yet.</div>');
  box.scrollIntoView({ block: 'nearest' });
}

$('pipeDays').onchange = () => loadPipeline();
$('pipeRefresh').onclick = () => loadPipeline();

// ------------------------------------------------ v592: wrap-up outcomes --
// What an outcome DOES is a set of consequence columns that dialer-call-control
// acts on. A new outcome is made from one of these presets rather than from
// free-form flags: ticking adds_to_dnc by accident would suppress a seller for
// good.
const DISPO_PRESETS = [
  { key: 'retry', label: 'No contact -- try again later', category: 'no_contact' },
  { key: 'retire', label: 'Spoke to them -- stop calling', category: 'contacted', retires_contact: true },
  { key: 'callback', label: 'Callback -- back in the queue at a set time', category: 'callback',
    schedules_callback: true },
  { key: 'follow_up', label: "Follow up -- reminds the agent at a set time", category: 'callback',
    retires_contact: true, creates_follow_up: true },
  { key: 'opportunity', label: "Opportunity -- goes to the agent's Opportunities", category: 'contacted',
    retires_contact: true, creates_opportunity: true },
  { key: 'lead', label: 'Lead -- creates a lead straight away', category: 'converted',
    retires_contact: true, creates_lead: true },
  { key: 'dnc', label: 'Do not call -- suppressed for good', category: 'dnc',
    retires_contact: true, adds_to_dnc: true },
  { key: 'invalid', label: 'Bad number -- that line is retired', category: 'invalid',
    retires_contact: true, marks_invalid: true },
];

function dispoEffect(d) {
  if (d.adds_to_dnc) return 'Do not call';
  if (d.marks_invalid) return 'Bad number';
  if (d.creates_lead) return 'Creates a lead';
  if (d.creates_opportunity) return 'Opportunity';
  if (d.creates_follow_up) return 'Follow-up reminder';
  if (d.schedules_callback) return 'Callback at a set time';
  if (d.retires_contact) return 'Stops calling';
  return 'Tries again later';
}

let dispoCatalog = [];
async function loadDispoCatalog() {
  const { data, error } = await sb.from('dialer_dispositions')
    .select('id, code, label, category, retires_contact, schedules_callback, creates_lead, adds_to_dnc, '
          + 'marks_invalid, creates_follow_up, creates_opportunity, in_default_set, is_active, sort_order')
    .order('sort_order');
  if (error) throw new Error(error.message);
  dispoCatalog = data || [];
  return dispoCatalog;
}

// ---- a queue's own list ----
async function renderDispoEditor(td, id) {
  let cat;
  try { cat = await loadDispoCatalog(); }
  catch (e) { td.querySelector('[data-dset]').innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; return; }
  const { data: rows } = await sb.from('dialer_campaign_dispositions')
    .select('disposition_id, sort_order').eq('campaign_id', id);
  const own = new Map((rows || []).map((r) => [r.disposition_id, r.sort_order]));
  const custom = own.size > 0;
  // The queue's own outcomes first, in its order; then the rest.
  const active = cat.filter((d) => d.is_active).sort((a, b) =>
    (Number(own.has(b.id)) - Number(own.has(a.id)))
    || ((own.get(a.id) ?? a.sort_order) - (own.get(b.id) ?? b.sort_order)));
  td.querySelector('[data-dset]').innerHTML = active.map((d, i) => `<tr>
      <td><input type="checkbox" data-d="${esc(d.id)}"${(custom ? own.has(d.id) : d.in_default_set) ? ' checked' : ''}></td>
      <td>${esc(d.label)}${d.in_default_set ? '' : ' <span class="muted">(not in the default list)</span>'}</td>
      <td class="muted">${esc(dispoEffect(d))}</td>
      <td class="num"><input type="number" min="1" max="99" style="width:64px" data-dord="${esc(d.id)}"
          value="${own.has(d.id) ? own.get(d.id) : i + 1}"></td>
    </tr>`).join('') || '<tr><td colspan="4">No outcomes are switched on.</td></tr>';
  td.querySelectorAll('[data-dmode]').forEach((r) => {
    r.checked = r.value === (custom ? 'custom' : 'default');
    r.onchange = () => syncDispoMode(td);
  });
  syncDispoMode(td);
}

function syncDispoMode(td) {
  const custom = td.querySelector('[data-dmode][value="custom"]').checked;
  td.querySelectorAll('[data-d],[data-dord]').forEach((el) => { el.disabled = !custom; });
  td.querySelector('[data-dhint]').textContent = custom
    ? 'Tick what agents on this queue are offered and set the order -- the first nine get keys 1 to 9. '
      + 'Agents pick up a change the next time they open the dialer.'
    : 'This queue offers every outcome in the default list (ticked below). Choose its own list to change that.';
}

function dispoSetChoice(td) {
  const custom = Boolean(td.querySelector('[data-dmode][value="custom"]')?.checked);
  if (!custom) return { custom, rows: [] };
  const rows = [...td.querySelectorAll('[data-d]')].filter((cb) => cb.checked).map((cb) => ({
    disposition_id: cb.dataset.d,
    sort_order: Math.min(Math.max(Number(td.querySelector(`[data-dord="${cb.dataset.d}"]`).value) || 99, 1), 99),
  }));
  return { custom, rows };
}

function validateDispoSet(td) {
  const c = dispoSetChoice(td);
  if (c.custom && !c.rows.length) {
    return 'Tick at least one outcome, or use the default list -- an agent cannot wrap up a call with none.';
  }
  return null;
}

async function saveDispoSet(td, id) {
  const c = dispoSetChoice(td);
  if (!c.custom) {
    const { error } = await sb.from('dialer_campaign_dispositions').delete().eq('campaign_id', id);
    return error ? error.message : null;
  }
  // Upsert the chosen rows first, then remove the rest, so the queue is never
  // briefly without a list -- which would mean the default one.
  const { error } = await sb.from('dialer_campaign_dispositions')
    .upsert(c.rows.map((r) => ({ campaign_id: id, ...r })), { onConflict: 'campaign_id,disposition_id' });
  if (error) return error.message;
  const keep = c.rows.map((r) => r.disposition_id);
  const { error: e2 } = await sb.from('dialer_campaign_dispositions').delete()
    .eq('campaign_id', id).not('disposition_id', 'in', `(${keep.join(',')})`);
  return e2 ? e2.message : null;
}

// ---- automatic messages ----
async function renderActionsEditor(td, id) {
  const box = td.querySelector('[data-actions]');
  const { data, error } = await sb.from('dialer_disposition_actions')
    .select('id, disposition_code, channel, subject, body, is_active')
    .eq('campaign_id', id).order('disposition_code');
  if (error) { box.innerHTML = `<p class="hint">${esc(error.message)}</p>`; return; }
  box.innerHTML = (data || []).length ? '' : '<p class="hint" data-noact>No automatic messages on this queue.</p>';
  (data || []).forEach((a) => box.appendChild(actionRow(a)));
  td.querySelector('[data-add-action]').onclick = () => {
    box.querySelector('[data-noact]')?.remove();
    box.appendChild(actionRow({ channel: 'email', is_active: true }));
  };
}

function actionRow(a) {
  const el = document.createElement('div');
  el.dataset.action = a.id || '';
  el.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--card)';
  const opts = dispoCatalog.filter((d) => d.is_active || d.code === a.disposition_code)
    .map((d) => `<option value="${esc(d.code)}"${d.code === a.disposition_code ? ' selected' : ''}>${esc(d.label)}</option>`)
    .join('');
  el.innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <div class="field"><label>When the outcome is</label><select data-a-code>${opts}</select></div>
      <div class="field"><label>Send</label><select data-a-ch>
        <option value="email"${a.channel === 'email' ? ' selected' : ''}>Email</option>
        <option value="sms"${a.channel === 'sms' ? ' selected' : ''}>Text</option></select></div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:9px">
        <input type="checkbox" data-a-on${a.is_active !== false ? ' checked' : ''}> On</label>
      <button class="sm" data-a-del style="margin-bottom:6px">Remove</button>
    </div>
    <input data-a-subj placeholder="Subject" style="width:100%;margin-bottom:8px" value="${esc(a.subject || '')}">
    <textarea data-a-body rows="4" style="width:100%" placeholder="Hi {{first_name}}, this is {{agent_first_name}} ...">${esc(a.body || '')}</textarea>
    <div class="hint" data-a-len style="margin-top:4px"></div>`;
  const sync = () => {
    const sms = el.querySelector('[data-a-ch]').value === 'sms';
    el.querySelector('[data-a-subj]').style.display = sms ? 'none' : '';
    const n = el.querySelector('[data-a-body]').value.length;
    el.querySelector('[data-a-len]').textContent = sms
      ? `${n} characters. One text is 160 -- merge fields change the length, and a single emoji drops it to 70.`
      : '';
  };
  el.querySelector('[data-a-ch]').onchange = sync;
  el.querySelector('[data-a-body]').oninput = sync;
  el.querySelector('[data-a-del]').onclick = () => { el.dataset.removed = '1'; el.style.display = 'none'; };
  sync();
  return el;
}

function actionChoice(td) {
  return [...td.querySelectorAll('[data-actions] [data-action]')].map((el) => ({
    id: el.dataset.action || null,
    removed: el.dataset.removed === '1',
    disposition_code: el.querySelector('[data-a-code]').value,
    channel: el.querySelector('[data-a-ch]').value,
    subject: el.querySelector('[data-a-subj]').value.trim() || null,
    body: el.querySelector('[data-a-body]').value.trim(),
    is_active: el.querySelector('[data-a-on]').checked,
  }));
}

function validateActions(td) {
  const seen = new Set();
  for (const a of actionChoice(td).filter((x) => !x.removed)) {
    if (!a.disposition_code) return 'Pick the outcome each automatic message is for.';
    if (!a.body) return 'An automatic message needs a message.';
    if (a.channel === 'email' && !a.subject) return 'An automatic email needs a subject.';
    const k = a.disposition_code + '|' + a.channel;
    if (seen.has(k)) return 'Two automatic messages for the same outcome and channel -- keep one.';
    seen.add(k);
  }
  return null;
}

async function saveActions(td, id) {
  const all = actionChoice(td);
  // Removals first: (queue, outcome, channel) is unique, and a removed row
  // must not block a new one for the same pair.
  const del = all.filter((a) => a.id && a.removed).map((a) => a.id);
  if (del.length) {
    const { error } = await sb.from('dialer_disposition_actions').delete().in('id', del);
    if (error) return error.message;
  }
  for (const a of all.filter((x) => !x.removed)) {
    const row = {
      campaign_id: id, disposition_code: a.disposition_code, channel: a.channel,
      subject: a.channel === 'email' ? a.subject : null, body: a.body, is_active: a.is_active,
      updated_by: meId, updated_at: new Date().toISOString(),
    };
    const { error } = a.id
      ? await sb.from('dialer_disposition_actions').update(row).eq('id', a.id)
      : await sb.from('dialer_disposition_actions').insert(row);
    if (error) {
      return /duplicate|unique/i.test(error.message)
        ? 'Two automatic messages for the same outcome and channel -- keep one.' : error.message;
    }
  }
  return null;
}

// ---------------------------------------------------- v667: lead form --
async function renderLeadFormPicker(td, id) {
  const sel = td.querySelector('[data-leadform]');
  const msg = td.querySelector('[data-leadform-msg]');
  const [{ data: forms, error: fe }, { data: camp, error: ce }] = await Promise.all([
    sb.from('lead_submission_forms').select('id, name, is_active').order('name'),
    sb.from('dialer_campaigns').select('submission_form_id').eq('id', id).maybeSingle(),
  ]);
  if (fe || ce) { msg.textContent = (fe || ce).message; return; }
  const current = camp?.submission_form_id || '';
  sel.innerHTML = '<option value="">No lead form</option>' + (forms || [])
    .filter((f) => f.is_active || f.id === current)
    .map((f) => `<option value="${esc(f.id)}"${f.id === current ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  const btn = td.querySelector('[data-leadform-save]');
  btn.disabled = !canManage;
  btn.onclick = async () => {
    btn.disabled = true;
    // .select() so a policy refusal shows as a refusal, not as a silent success.
    const { data, error } = await sb.from('dialer_campaigns')
      .update({ submission_form_id: sel.value || null }).eq('id', id).select('id');
    btn.disabled = false;
    msg.textContent = error ? 'Could not save: ' + error.message
      : !data?.length ? 'Not saved — your role cannot change this queue.' : 'Saved.';
  };
}

// ------------------------------------------------- v669: outcome rules --
let ruleTemplates = [];
async function loadRuleTemplates() {
  const { data, error } = await sb.from('dialer_message_templates')
    .select('id, name, channel, sender, is_active').order('name');
  if (error) throw new Error(error.message);
  ruleTemplates = data || [];
  return ruleTemplates;
}

const RULE_ACTIONS = [
  ['', 'nothing else'],
  ['owned_follow_up', 'make it a callback owned by whoever set it (shows in their Follow-ups)'],
  ['park_number', 'park this number and try the contact\'s next one now'],
  ['handoff_to_sales', 'hand it to Sales as an opportunity'],
  ['move_to_spanish', 'move the contact to the Spanish queue (Settings)'],
];
const RULE_STAGES = [['', 'leave the stage'], ['appointment', 'Appointment'], ['offer', 'Offer'],
  ['negotiation', 'Negotiation'], ['contacted', 'Contacted'], ['new', 'New']];

function tplLabel(t) {
  return `${t.name} — ${t.channel === 'sms' ? 'text' : (t.sender === 'shared' ? 'email, shared sender' : 'email, rep\'s Gmail')}${t.is_active ? '' : ' (off)'}`;
}

function ruleCard(r) {
  const el = document.createElement('div');
  el.className = 'rule-card';
  el.dataset.rule = r.id || '';
  const codes = new Set(r.disposition_codes || []);
  const action = r.owned_follow_up ? 'owned_follow_up' : r.park_number ? 'park_number'
    : r.handoff_to_sales ? 'handoff_to_sales' : r.move_to_spanish ? 'move_to_spanish' : '';
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}"${String(cur ?? '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const tpls = (cur, only) => '<option value="">no message</option>' + ruleTemplates
    .filter((t) => (!only || t.channel === only) && (t.is_active || t.id === cur))
    .map((t) => `<option value="${esc(t.id)}"${t.id === cur ? ' selected' : ''}>${esc(tplLabel(t))}</option>`).join('');
  const num = (k) => (r[k] ?? '') === null ? '' : esc(r[k] ?? '');
  el.innerHTML = `
    <div class="rule-top">
      <input data-r="name" value="${esc(r.name || '')}" placeholder="Rule name, e.g. Voicemail / No answer" style="flex:1">
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px">
        <input type="checkbox" data-r="is_active"${r.is_active !== false ? ' checked' : ''}> On</label>
      <button class="sm" data-del>Remove</button>
    </div>
    <details class="rule-codes"${codes.size ? '' : ' open'}>
      <summary>When the outcome is: <b data-codes-label></b></summary>
      <div class="rule-codegrid">${dispoCatalog.filter((d) => d.is_active || codes.has(d.code)).map((d) =>
        `<label><input type="checkbox" data-code value="${esc(d.code)}"${codes.has(d.code) ? ' checked' : ''}> ${esc(d.label)}</label>`).join('')}</div>
    </details>
    <div class="rule-line">
      Retry every <input type="number" min="0.25" step="0.25" data-r="retry_every_hours" value="${num('retry_every_hours')}"> hours,
      up to <input type="number" min="1" data-r="retry_max_calls" value="${num('retry_max_calls')}"> calls,
      within <input type="number" min="1" data-r="retry_window_days" value="${num('retry_window_days')}"> working days.
      When that runs out, call again after <input type="number" min="1" data-r="after_retries_days" value="${num('after_retries_days')}"> days.
    </div>
    <div class="rule-line">
      Also <select data-r="action">${opt(RULE_ACTIONS, action)}</select>
      and <select data-r="opportunity_stage">${opt(RULE_STAGES, r.opportunity_stage || '')}</select>
    </div>
    <div class="rule-line">
      Send <select data-r="message_template_id">${tpls(r.message_template_id)}</select>
      <select data-r="message_trigger">${opt([['immediate', 'every time'], ['nth', 'on this contact\'s call number'],
        ['retry_failed', 'when the retry after it also reaches nobody']], r.message_trigger || 'immediate')}</select>
      <input type="number" min="1" data-r="message_trigger_n" value="${esc(r.message_trigger_n ?? 1)}">
    </div>
    <div class="rule-line" data-fallback-line>
      If the text is not allowed (no consent, or a landline), email instead:
      <select data-r="fallback_template_id">${tpls(r.fallback_template_id, 'email')}</select>
    </div>`;
  const sync = () => {
    const picked = [...el.querySelectorAll('[data-code]:checked')].map((c) => c.parentElement.textContent.trim());
    el.querySelector('[data-codes-label]').textContent = picked.length ? picked.join(', ') : 'nothing picked yet';
    const trig = el.querySelector('[data-r="message_trigger"]').value;
    el.querySelector('[data-r="message_trigger_n"]').style.display = trig === 'nth' ? '' : 'none';
    const t = ruleTemplates.find((x) => x.id === el.querySelector('[data-r="message_template_id"]').value);
    el.querySelector('[data-fallback-line]').style.display = t && t.channel === 'sms' ? '' : 'none';
    el.classList.toggle('off', !el.querySelector('[data-r="is_active"]').checked);
  };
  el.addEventListener('change', sync);
  el.querySelector('[data-del]').onclick = () => { el.dataset.removed = '1'; el.style.display = 'none'; };
  sync();
  return el;
}

async function renderRulesEditor(td, id) {
  const box = td.querySelector('[data-rules]');
  const msg = td.querySelector('[data-rules-msg]');
  try { await loadRuleTemplates(); } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  const { data, error } = await sb.from('dialer_outcome_rules').select('*')
    .eq('campaign_id', id).order('sort_order');
  if (error) { box.innerHTML = `<p class="hint">${esc(error.message)}</p>`; return; }
  box.innerHTML = (data || []).length ? '' : '<p class="hint" data-norule>No rules yet — every outcome uses the queue\'s normal timing.</p>';
  (data || []).forEach((r) => box.appendChild(ruleCard(r)));
  const add = td.querySelector('[data-add-rule]');
  const save = td.querySelector('[data-save-rules]');
  add.disabled = save.disabled = !canManage;
  add.onclick = () => { box.querySelector('[data-norule]')?.remove(); box.appendChild(ruleCard({ is_active: true, message_trigger: 'immediate', message_trigger_n: 1 })); };
  save.onclick = async () => {
    save.disabled = true;
    msg.textContent = 'Saving…';
    const err = await saveRules(td, id);
    save.disabled = false;
    msg.textContent = err ? err : 'Saved. The next outcome on this queue follows these rules.';
    if (!err) await renderRulesEditor(td, id);
  };
}

function ruleChoice(td) {
  const n = (el, k) => { const v = el.querySelector(`[data-r="${k}"]`).value.trim(); return v === '' ? null : Number(v); };
  return [...td.querySelectorAll('[data-rules] [data-rule]')].map((el, i) => {
    const action = el.querySelector('[data-r="action"]').value;
    const trig = el.querySelector('[data-r="message_trigger"]').value;
    const tplId = el.querySelector('[data-r="message_template_id"]').value || null;
    const tpl = ruleTemplates.find((t) => t.id === tplId);
    return {
      id: el.dataset.rule || null,
      removed: el.dataset.removed === '1',
      row: {
        name: el.querySelector('[data-r="name"]').value.trim(),
        disposition_codes: [...el.querySelectorAll('[data-code]:checked')].map((c) => c.value),
        retry_every_hours: n(el, 'retry_every_hours'),
        retry_max_calls: n(el, 'retry_max_calls'),
        retry_window_days: n(el, 'retry_window_days'),
        after_retries_days: n(el, 'after_retries_days'),
        owned_follow_up: action === 'owned_follow_up',
        park_number: action === 'park_number',
        handoff_to_sales: action === 'handoff_to_sales',
        move_to_spanish: action === 'move_to_spanish',
        opportunity_stage: el.querySelector('[data-r="opportunity_stage"]').value || null,
        message_template_id: tplId,
        message_trigger: trig,
        message_trigger_n: trig === 'nth' ? (n(el, 'message_trigger_n') || 1) : 1,
        fallback_template_id: tpl && tpl.channel === 'sms' ? (el.querySelector('[data-r="fallback_template_id"]').value || null) : null,
        is_active: el.querySelector('[data-r="is_active"]').checked,
        sort_order: i + 1,
      },
    };
  });
}

async function saveRules(td, id) {
  const all = ruleChoice(td);
  const live = all.filter((x) => !x.removed);
  const seen = new Map();
  for (const { row } of live) {
    if (!row.name) return 'Every rule needs a name.';
    if (!row.disposition_codes.length) return `"${row.name}" has no outcomes ticked.`;
    for (const k of ['retry_every_hours', 'retry_max_calls', 'retry_window_days', 'after_retries_days']) {
      if (row[k] !== null && !(row[k] > 0)) return `"${row.name}": numbers must be above zero, or blank.`;
    }
    if (row.is_active) {
      for (const c of row.disposition_codes) {
        if (seen.has(c)) {
          const label = dispoCatalog.find((d) => d.code === c)?.label || c;
          return `"${label}" is in two rules ("${seen.get(c)}" and "${row.name}"). One outcome, one rule.`;
        }
        seen.set(c, row.name);
      }
    }
  }
  const stamp = { updated_by: meId };
  // 1. removals. 2. everything switched OFF (so moving an outcome from one
  // rule to another cannot trip the one-rule-per-outcome check halfway).
  // 3. switched back on as chosen. The window between 2 and 3 is one round
  // trip; an outcome saved in it simply gets the queue's normal timing.
  const del = all.filter((x) => x.id && x.removed).map((x) => x.id);
  if (del.length) {
    const { error } = await sb.from('dialer_outcome_rules').delete().in('id', del);
    if (error) return 'Could not remove a rule: ' + error.message;
  }
  const ids = [];
  for (const x of live) {
    const row = { ...x.row, ...stamp, campaign_id: id, is_active: false };
    const res = x.id
      ? await sb.from('dialer_outcome_rules').update(row).eq('id', x.id).select('id')
      : await sb.from('dialer_outcome_rules').insert(row).select('id');
    if (res.error) return `Could not save "${x.row.name}": ${res.error.message}`;
    if (!res.data?.length) return 'Not saved — your role cannot change outcome rules.';
    ids.push([res.data[0].id, x.row.is_active]);
  }
  for (const [rid, on] of ids.filter(([, on]) => on)) {
    const { error } = await sb.from('dialer_outcome_rules').update({ is_active: on }).eq('id', rid);
    if (error) return 'Could not switch a rule on: ' + error.message;
  }
  return null;
}

// ---- the catalogue ----
async function loadDispoCatPanel() {
  const panel = $('dispoCatPanel');
  panel.classList.toggle('hide', !isDialerAdmin);
  if (!isDialerAdmin) return;
  let cat;
  try { cat = await loadDispoCatalog(); }
  catch (e) { $('dispoCatRows').innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`; return; }
  $('dispoCatRows').innerHTML = cat.map((d) => `<tr data-dc="${esc(d.id)}">
      <td><input data-dl value="${esc(d.label)}" style="width:230px"></td>
      <td class="muted">${esc(dispoEffect(d))}</td>
      <td><input type="checkbox" data-ddef${d.in_default_set ? ' checked' : ''}></td>
      <td><input type="checkbox" data-don${d.is_active ? ' checked' : ''}></td>
      <td class="num"><input type="number" data-dso min="0" max="999" style="width:70px" value="${Number(d.sort_order) || 0}"></td>
      <td><button class="sm" data-dsave>Save</button></td>
    </tr>`).join('');
  $('dispoCatRows').querySelectorAll('[data-dsave]').forEach((b) => {
    b.onclick = () => saveCatRow(b.closest('tr'), b);
  });
  if (!$('newDispoPreset').options.length) {
    $('newDispoPreset').innerHTML = DISPO_PRESETS.map((p) =>
      `<option value="${p.key}">${esc(p.label)}</option>`).join('');
  }
}

async function saveCatRow(row, btn) {
  const label = row.querySelector('[data-dl]').value.trim();
  if (!label) { say($('dispoCatMsg'), 'An outcome needs a name.', 'err'); return; }
  btn.disabled = true;
  const { error } = await sb.from('dialer_dispositions').update({
    label,
    in_default_set: row.querySelector('[data-ddef]').checked,
    is_active: row.querySelector('[data-don]').checked,
    sort_order: Math.min(Math.max(Number(row.querySelector('[data-dso]').value) || 0, 0), 999),
  }).eq('id', row.dataset.dc);
  btn.disabled = false;
  say($('dispoCatMsg'), error ? error.message : `Saved "${label}".`, error ? 'err' : 'ok');
  if (!error) loadDispoCatalog().catch(() => {});
}

$('newDispoAdd').onclick = async () => {
  const label = $('newDispoLabel').value.trim();
  const p = DISPO_PRESETS.find((x) => x.key === $('newDispoPreset').value);
  if (!label || !p) { say($('dispoCatMsg'), 'Name the outcome and pick what it behaves like.', 'err'); return; }
  const code = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'outcome';
  if (dispoCatalog.some((d) => d.code === code || d.label.toLowerCase() === label.toLowerCase())) {
    say($('dispoCatMsg'), 'There is already an outcome with that name.', 'err'); return;
  }
  const { key, label: presetLabel, ...consequences } = p;
  const maxSort = Math.max(0, ...dispoCatalog.map((d) => Number(d.sort_order) || 0));
  $('newDispoAdd').disabled = true;
  const { error } = await sb.from('dialer_dispositions').insert({
    code, label, group_name: 'Call results', is_active: true,
    in_default_set: $('newDispoDefault').checked,
    sort_order: Math.min(maxSort + 1, 999),
    retires_contact: false, schedules_callback: false, creates_lead: false, adds_to_dnc: false,
    marks_invalid: false, creates_follow_up: false, creates_opportunity: false,
    ...consequences,
  });
  $('newDispoAdd').disabled = false;
  if (error) { say($('dispoCatMsg'), error.message, 'err'); return; }
  $('newDispoLabel').value = '';
  $('newDispoDefault').checked = false;
  say($('dispoCatMsg'), `Added "${label}". Offer it on a queue from that queue's Edit.`, 'ok');
  loadDispoCatPanel();
};

// ------------------------------------------------------- inbound queues --
// Numeric queue settings, with the same ranges the database CHECKs enforce, so
// a bad value is refused here with a sentence instead of a constraint name.
const QUEUE_LIMITS = [
  { key: 'ring_timeout_seconds',  label: 'Ring each agent (s)', min: 5,  max: 120 },
  { key: 'queue_timeout_seconds', label: 'Wait before voicemail (s)', min: 10, max: 900 },
];

async function loadQueues() {
  const { data } = await sb.from('dialer_inbound_queues').select('*').order('name');
  const queues = data || [];

  // Counts in one pass rather than a query per queue.
  const { data: members } = await sb.from('dialer_queue_agents')
    .select('queue_id, is_active');
  const { data: numbers } = await sb.from('dialer_dids')
    .select('id, phone_e164, status, inbound_queue_id');
  const agentCount = {}; const numCount = {};
  (members || []).forEach((m) => { if (m.is_active) agentCount[m.queue_id] = (agentCount[m.queue_id] || 0) + 1; });
  (numbers || []).forEach((n) => { if (n.inbound_queue_id) numCount[n.inbound_queue_id] = (numCount[n.inbound_queue_id] || 0) + 1; });

  $('queueRows').innerHTML = queues.length
    ? queues.map((q) => `<tr data-qrow="${esc(q.id)}">
        <td>${esc(q.name)}</td>
        <td class="mono">${esc((q.open_time || '').slice(0, 5))}–${esc((q.close_time || '').slice(0, 5))}
            <span class="muted">${(q.open_days || []).map((d) => DAY_LABEL[d] || d).join(' ')}</span>
            <span class="${q.timezone === 'UTC' ? 'tag t-resting' : 'muted'}"
                  title="The zone these hours are read in">${esc(q.timezone || 'UTC')}</span></td>
        <td>${q.strategy === 'rank' ? 'By rank' : 'Longest idle'}</td>
        <td class="num">${q.ring_timeout_seconds}</td>
        <td class="num">${q.queue_timeout_seconds}</td>
        <td class="num">${agentCount[q.id] ? agentCount[q.id]
            : '<span style="color:var(--away)">0</span>'}</td>
        <td class="num">${numCount[q.id] ? numCount[q.id]
            : '<span style="color:var(--away)">0</span>'}</td>
        <td><span class="tag ${q.is_active ? 't-active' : 't-resting'}">${q.is_active ? 'active' : 'off'}</span></td>
        <td>${canManage ? `<button class="sm" data-qedit="${esc(q.id)}">Edit</button>` : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="9">No queues yet. Create one above.</td></tr>';

  $('queueRows').querySelectorAll('button[data-qedit]').forEach((b) => {
    b.onclick = () => toggleQueueEditor(b.dataset.qedit, numbers || []);
  });

  loadWaiting();
}

// calling_days / open_days are ISO: Monday is 1 and SUNDAY IS 7, never 0.
// Same convention as dialer_campaigns, and the same trap -- a getDay()-style 0
// silently means "never Sunday".
const QUEUE_DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'],
                    [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

// The office's own zone. UTC is the column default only so v552 changed no
// behaviour on the way in -- it is the right answer for nobody, which is why
// this is a visible field rather than an assumption. Whatever is stored is
// appended if it is not on this list, so an unusual zone set by hand survives
// a save instead of being quietly rewritten to the first option.
const QUEUE_ZONES = [
  ['UTC', 'UTC — not a real office'],
  ['America/New_York', 'US Eastern'],
  ['America/Chicago', 'US Central'],
  ['America/Denver', 'US Mountain'],
  ['America/Phoenix', 'US Arizona (no DST)'],
  ['America/Los_Angeles', 'US Pacific'],
  ['Africa/Cairo', 'Cairo'],
  ['Europe/London', 'London'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Karachi', 'Karachi'],
  ['Asia/Manila', 'Manila'],
];
const DAY_LABEL = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

async function toggleQueueEditor(id, allNumbers) {
  const existing = document.querySelector(`tr[data-qeditor="${id}"]`);
  if (existing) { existing.remove(); return; }
  document.querySelectorAll('tr[data-qeditor]').forEach((r) => r.remove());

  const row = document.querySelector(`tr[data-qrow="${id}"]`);
  if (!row) return;
  const { data: q } = await sb.from('dialer_inbound_queues')
    .select('*').eq('id', id).maybeSingle();
  if (!q) return;

  const tr = document.createElement('tr');
  tr.dataset.qeditor = id;
  const td = document.createElement('td');
  td.colSpan = 9;
  td.style.cssText = 'background:var(--inset);padding:18px';
  td.innerHTML = `
    <div class="row">
      <div class="field" style="min-width:220px"><label>Name</label>
        <input data-q="name" value="${esc(q.name)}"></div>
      <div class="field"><label>Strategy</label>
        <select data-q="strategy">
          <option value="longest_idle"${q.strategy === 'longest_idle' ? ' selected' : ''}>Longest idle</option>
          <option value="rank"${q.strategy === 'rank' ? ' selected' : ''}>By rank</option>
        </select></div>
      <div class="field"><label>Opens</label>
        <input type="time" data-q="open_time" value="${esc((q.open_time || '').slice(0, 5))}"></div>
      <div class="field"><label>Closes</label>
        <input type="time" data-q="close_time" value="${esc((q.close_time || '').slice(0, 5))}"></div>
      <div class="field" style="min-width:190px"><label>Hours are in</label>
        <select data-q="timezone">${QUEUE_ZONES.concat(
            QUEUE_ZONES.some(([v]) => v === q.timezone) ? [] : [[q.timezone, q.timezone]])
          .map(([v, l]) => `<option value="${esc(v)}"${q.timezone === v ? ' selected' : ''}>${esc(l)}</option>`)
          .join('')}</select></div>
      ${QUEUE_LIMITS.map((f) => `
      <div class="field"><label>${esc(f.label)}</label>
        <input type="number" data-q="${f.key}" min="${f.min}" max="${f.max}" value="${q[f.key]}"></div>`).join('')}
    </div>

    <div class="row" style="margin-top:10px;align-items:center">
      <span class="fb-label">Open days</span>
      ${QUEUE_DAYS.map(([v, d]) => `<label style="display:flex;align-items:center;gap:5px">
        <input type="checkbox" data-qday="${v}"${(q.open_days || []).includes(v) ? ' checked' : ''}>${d}</label>`).join('')}
      <label style="display:flex;align-items:center;gap:5px;margin-left:14px">
        <input type="checkbox" data-q="is_active"${q.is_active ? ' checked' : ''}>Active</label>
    </div>

    <div class="row" style="margin-top:12px">
      <div class="field" style="flex:1;min-width:280px"><label>Greeting</label>
        <input data-q="greeting_text" value="${esc(q.greeting_text)}"></div>
      <div class="field" style="flex:1;min-width:280px"><label>Voicemail prompt</label>
        <input data-q="voicemail_prompt_text" value="${esc(q.voicemail_prompt_text)}"></div>
    </div>
    <div class="row">
      <div class="field" style="flex:1;min-width:280px"><label>Closed message</label>
        <input data-q="closed_message" value="${esc(q.closed_message)}"></div>
      <div class="field" style="flex:1;min-width:280px"><label>Hold music URL (optional)</label>
        <input data-q="hold_music_url" placeholder="https://…mp3" value="${esc(q.hold_music_url || '')}"></div>
    </div>
    <p class="hint" style="margin:10px 0 0">
      Hours are this office's clock, not the caller's — inbound is the reverse
      of outbound calling hours, because the caller chose when to ring.
      With no hold music the caller hears a short spoken line on the same loop.
    </p>

    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="fb-label" style="margin-bottom:8px">Agents who answer this queue</div>
      <div class="scroll"><table><thead><tr>
        <th>Agent</th><th>Answers</th><th class="num">Rank</th><th>Takes inbound now</th>
      </tr></thead><tbody data-qassign></tbody></table></div>
      <p class="hint" style="margin:10px 0 0">Rank is only used when the strategy is “By rank”; lower goes first.</p>
    </div>

    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="fb-label" style="margin-bottom:8px">Numbers that reach this queue</div>
      <div id="qNums-${esc(id)}" class="row" style="gap:14px"></div>
      <p class="hint" style="margin:10px 0 0">
        Point the number at the Call Control application in Telnyx as well —
        ticking it here only tells us which queue it belongs to.
      </p>
    </div>

    <div class="row" style="margin-top:16px">
      <button class="primary" data-qsave>Save queue</button>
      <button data-qcancel>Cancel</button>
      <span data-qmsg></span>
    </div>`;
  tr.appendChild(td);
  row.after(tr);

  // ---- agents ------------------------------------------------------------
  const { data: roles } = await sb.from('roles').select('name, can_use_dialer');
  const dialerRoles = new Set((roles || []).filter((r) => r.can_use_dialer).map((r) => r.name));
  const { data: people } = await sb.from('profiles').select('id, full_name, role').order('full_name');
  const eligible = (people || []).filter((p) => dialerRoles.has(p.role));

  const { data: assigned } = await sb.from('dialer_queue_agents')
    .select('agent_id, priority, is_active').eq('queue_id', id);
  const byAgent = {}; (assigned || []).forEach((a) => { byAgent[a.agent_id] = a; });

  // Who could actually take a call right now, so a queue with three names but
  // nobody on shift is visible as such rather than looking staffed.
  const { data: sessions } = await sb.from('dialer_agent_sessions')
    .select('agent_id, agent_status, status, last_heartbeat_at, ended_at');
  const { data: statuses } = await sb.from('dialer_agent_statuses')
    .select('code, takes_inbound, label');
  const inboundOk = new Set((statuses || []).filter((s) => s.takes_inbound).map((s) => s.code));
  const liveNow = {};
  (sessions || []).forEach((s) => {
    if (s.ended_at) return;
    if (new Date(s.last_heartbeat_at).getTime() < Date.now() - 120000) return;
    liveNow[s.agent_id] = { ok: inboundOk.has(s.agent_status) && s.status !== 'on_call', st: s.agent_status };
  });

  // A SIP identity is created lazily, the first time an agent opens the
  // console. dialer_available_agents requires one, so an agent without it is
  // skipped silently no matter what their status says -- which is exactly the
  // "looks staffed but nobody rings" failure this column exists to prevent.
  const { data: creds } = await sb.from('dialer_agent_credentials')
    .select('agent_id, sip_username, revoked_at');
  const hasSip = new Set((creds || [])
    .filter((c) => c.sip_username && !c.revoked_at).map((c) => c.agent_id));

  td.querySelector('[data-qassign]').innerHTML = eligible.length
    ? eligible.map((p) => {
        const a = byAgent[p.id];
        const live = liveNow[p.id];
        return `<tr>
          <td>${esc(p.full_name || p.id)} <span class="muted">${esc(p.role)}</span></td>
          <td><input type="checkbox" data-qa="${esc(p.id)}"${a && a.is_active ? ' checked' : ''}></td>
          <td class="num"><input type="number" min="1" style="width:80px"
              data-qp="${esc(p.id)}" value="${a?.priority ?? 100}"></td>
          <td>${!hasSip.has(p.id)
            ? '<span class="tag t-resting">no softphone yet</span>'
            : (live
                ? (live.ok ? '<span class="tag t-active">yes</span>'
                           : `<span class="tag t-resting">${esc(live.st)}</span>`)
                : '<span class="muted">not signed in</span>')}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4">No profiles hold a role with dialer access.</td></tr>';

  // ---- numbers -----------------------------------------------------------
  const usable = (allNumbers || []).filter((n) => n.status === 'active' || n.inbound_queue_id === id);
  document.getElementById(`qNums-${id}`).innerHTML = usable.length
    ? usable.map((n) => `<label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-qnum="${esc(n.id)}"${n.inbound_queue_id === id ? ' checked' : ''}>
        <span class="mono">${esc(n.phone_e164)}</span></label>`).join('')
    : '<span class="muted">No active numbers in the pool.</span>';

  td.querySelector('[data-qcancel]').onclick = () => tr.remove();
  td.querySelector('[data-qsave]').onclick = () => saveQueue(id, td, tr);
}

async function saveQueue(id, td, tr) {
  const msg = td.querySelector('[data-qmsg]');
  const val = (k) => td.querySelector(`[data-q="${k}"]`);

  const patch = {
    name: val('name').value.trim(),
    strategy: val('strategy').value,
    open_time: val('open_time').value,
    close_time: val('close_time').value,
    timezone: val('timezone').value,
    is_active: val('is_active').checked,
    greeting_text: val('greeting_text').value.trim(),
    voicemail_prompt_text: val('voicemail_prompt_text').value.trim(),
    closed_message: val('closed_message').value.trim(),
    hold_music_url: val('hold_music_url').value.trim() || null,
    open_days: [...td.querySelectorAll('[data-qday]')]
      .filter((c) => c.checked).map((c) => Number(c.dataset.qday)),
    updated_at: new Date().toISOString(),
  };

  if (!patch.name) { say(msg, 'Give the queue a name.', 'err'); return; }
  for (const f of QUEUE_LIMITS) {
    const n = Number(val(f.key).value);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      say(msg, `${f.label} must be a whole number between ${f.min} and ${f.max}.`, 'err'); return;
    }
    patch[f.key] = n;
  }
  if (!patch.open_days.length) {
    say(msg, 'Pick at least one open day, or the queue is closed every day.', 'err'); return;
  }
  if (!patch.greeting_text || !patch.voicemail_prompt_text || !patch.closed_message) {
    say(msg, 'The greeting, voicemail prompt and closed message are all spoken to callers — none can be blank.', 'err');
    return;
  }

  td.querySelector('[data-qsave]').disabled = true;
  say(msg, 'Saving…', 'ok');

  const { error } = await sb.from('dialer_inbound_queues').update(patch).eq('id', id);
  if (error) { say(msg, error.message, 'err'); td.querySelector('[data-qsave]').disabled = false; return; }

  // Membership: upsert the ticked ones, deactivate the rest rather than
  // deleting, so assigned_by/assigned_at survives as a record of who staffed
  // the queue.
  const ups = []; const off = [];
  td.querySelectorAll('[data-qa]').forEach((cb) => {
    const aid = cb.dataset.qa;
    const pr = Number(td.querySelector(`[data-qp="${aid}"]`).value) || 100;
    if (cb.checked) ups.push({ queue_id: id, agent_id: aid, priority: pr, is_active: true, assigned_by: meId });
    else off.push(aid);
  });
  if (ups.length) {
    const { error: e2 } = await sb.from('dialer_queue_agents')
      .upsert(ups, { onConflict: 'queue_id,agent_id' });
    if (e2) { say(msg, e2.message, 'err'); td.querySelector('[data-qsave]').disabled = false; return; }
  }
  if (off.length) {
    // v660: checked, same reason as the campaign version -- an agent left on
    // an inbound queue keeps being offered its callers.
    const { error: offErr } = await sb.from('dialer_queue_agents').update({ is_active: false })
      .eq('queue_id', id).in('agent_id', off);
    if (offErr) { say(msg, `Could not remove the unticked agents: ${offErr.message}`, 'err');
      td.querySelector('[data-qsave]').disabled = false; return; }
  }

  // Numbers: a DID belongs to at most one queue, so ticking here clears it
  // from wherever it was.
  const on = []; const clear = [];
  td.querySelectorAll('[data-qnum]').forEach((cb) => {
    (cb.checked ? on : clear).push(cb.dataset.qnum);
  });
  // v660: both writes are checked now. This said "Saved." unconditionally,
  // so a refusal left the admin believing inbound calls were routed to this
  // queue when they were not -- and a misrouted inbound number is a caller
  // who reaches nobody.
  let routeErr = null;
  if (on.length) {
    const { error } = await sb.from('dialer_dids').update({ inbound_queue_id: id }).in('id', on);
    routeErr = routeErr || error;
  }
  if (clear.length) {
    const { error } = await sb.from('dialer_dids').update({ inbound_queue_id: null })
      .in('id', clear).eq('inbound_queue_id', id);
    routeErr = routeErr || error;
  }
  if (routeErr) { say(msg, `Could not update the numbers on this queue: ${routeErr.message}`, 'err'); return; }

  say(msg, 'Saved.', 'ok');
  tr.remove();
  loadQueues();
}

$('qCreate').onclick = async () => {
  const name = $('qName').value.trim();
  if (!name) { say($('qMsg'), 'Give the queue a name.', 'err'); return; }
  const { error } = await sb.from('dialer_inbound_queues').insert({
    name, open_time: $('qOpen').value, close_time: $('qClose').value,
  });
  if (error) { say($('qMsg'), error.message, 'err'); return; }
  say($('qMsg'), 'Created. Open Edit to add agents and a number — it cannot take calls until it has both.', 'ok');
  $('qName').value = '';
  loadQueues();
};

// Who is waiting right now, and who could take them.
async function loadWaiting() {
  const { data: waiting } = await sb.from('dialer_attempts')
    .select('id, queue_id, from_number, enqueued_at')
    .eq('direction', 'inbound').is('answered_at', null).is('ended_at', null)
    .not('enqueued_at', 'is', null).order('enqueued_at');
  const rows = waiting || [];

  if (!rows.length) {
    $('waitingRows').innerHTML = '<tr><td colspan="4">Nobody waiting.</td></tr>';
  } else {
    const { data: queues } = await sb.from('dialer_inbound_queues').select('id, name');
    const qName = {}; (queues || []).forEach((q) => { qName[q.id] = q.name; });
    const { data: offers } = await sb.from('dialer_inbound_offers')
      .select('attempt_id, agent_id, result')
      .in('attempt_id', rows.map((r) => r.id));
    const { data: people } = await sb.from('profiles').select('id, full_name');
    const pName = {}; (people || []).forEach((p) => { pName[p.id] = p.full_name; });

    $('waitingRows').innerHTML = rows.map((r) => {
      const secs = Math.round((Date.now() - new Date(r.enqueued_at).getTime()) / 1000);
      const tried = (offers || []).filter((o) => o.attempt_id === r.id)
        .map((o) => `${esc(pName[o.agent_id] || o.agent_id)}${o.result ? ' (' + esc(o.result) + ')' : ''}`);
      return `<tr>
        <td>${esc(qName[r.queue_id] || '—')}</td>
        <td class="mono">${esc(r.from_number)}</td>
        <td>${Math.floor(secs / 60)}m ${secs % 60}s</td>
        <td>${tried.length ? tried.join(', ') : '<span class="muted">nobody yet</span>'}</td>
      </tr>`;
    }).join('');
  }

  const { data: sessions } = await sb.from('dialer_agent_sessions')
    .select('agent_id, agent_status, status, last_heartbeat_at, ended_at');
  const { data: statuses } = await sb.from('dialer_agent_statuses').select('code, takes_inbound');
  const ok = new Set((statuses || []).filter((s) => s.takes_inbound).map((s) => s.code));
  const free = (sessions || []).filter((s) => !s.ended_at
    && new Date(s.last_heartbeat_at).getTime() > Date.now() - 120000
    && ok.has(s.agent_status) && s.status !== 'on_call').length;
  $('availableNow').textContent = free === 1
    ? '1 agent is free to take an inbound call.'
    : `${free} agents are free to take an inbound call.`;
}

// ------------------------------------------------ booking availability ----
// v610. Moved here from the rep's own console: when somebody can be booked is
// a rostering decision. dialer_calendars' write policy already allows the
// floor (is_admin or role_can_manage_dialer) to write anyone's row, so this
// needs no new permission -- only a screen.
const CAL_DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
                  [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']];
let calReps = [];

async function loadCalendarAdmin() {
  // Anyone who can actually be booked: the roles that hold the contacts
  // capability, which is the same gate the Appointments screen uses.
  const { data: roles } = await sb.from('roles')
    .select('name').or('can_manage_contacts.eq.true,can_manage_dialer.eq.true');
  const names = (roles || []).map((r) => r.name);
  const { data: people } = await sb.from('profiles')
    .select('id, full_name, role').order('full_name');
  calReps = (people || []).filter((p) =>
    names.includes(p.role) || p.role === 'owner' || p.role === 'admin');

  $('calRep').innerHTML = '<option value="">Pick a rep…</option>'
    + calReps.map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.id)} — ${esc(p.role)}</option>`).join('');
  $('calRep').onchange = () => renderCalendarEditor($('calRep').value);
}

async function renderCalendarEditor(ownerId) {
  const box = $('calEditor');
  if (!ownerId) { box.innerHTML = '<p class="muted">Pick a rep.</p>'; return; }
  box.innerHTML = '<p class="muted">Loading…</p>';
  const { data: cal } = await sb.from('dialer_calendars')
    .select('*').eq('owner_id', ownerId).maybeSingle();
  const hours = cal?.hours || [];
  const forDay = (d) => hours.find((h) => Number(h.dow) === d) || null;

  box.innerHTML = `
    ${cal ? '' : '<p class="muted">No availability set for this rep yet — nobody can be booked with them until there is.</p>'}
    <div class="row">
      <div class="field" style="min-width:200px"><label for="cTz">Timezone</label>
        <input id="cTz" value="${esc(cal?.timezone || 'America/Chicago')}"></div>
      <div class="field" style="min-width:130px"><label for="cSlot">Slot (min)</label>
        <input id="cSlot" type="number" min="10" step="5" value="${cal?.slot_minutes ?? 30}"></div>
      <div class="field" style="min-width:130px"><label for="cBuf">Buffer (min)</label>
        <input id="cBuf" type="number" min="0" step="5" value="${cal?.buffer_minutes ?? 0}"></div>
      <div class="field" style="min-width:150px"><label for="cLead">Notice (hours)</label>
        <input id="cLead" type="number" min="0" step="1" value="${cal?.lead_time_hours ?? 2}"></div>
      <div class="field" style="min-width:160px"><label for="cHorizon">Bookable ahead (days)</label>
        <input id="cHorizon" type="number" min="1" step="1" value="${cal?.horizon_days ?? 21}"></div>
    </div>
    <div class="scroll" style="margin-top:10px">
      <table>
        <thead><tr><th>Day</th><th>Bookable</th><th>From</th><th>To</th></tr></thead>
        <tbody>${CAL_DAYS.map(([d, label]) => {
          const h = forDay(d);
          return `<tr>
            <td>${label}</td>
            <td><input type="checkbox" data-cd="${d}"${h ? ' checked' : ''}${canManage ? '' : ' disabled'}></td>
            <td><input type="time" data-cf="${d}" value="${esc(h?.from || '09:00')}"${canManage ? '' : ' disabled'}></td>
            <td><input type="time" data-ct="${d}" value="${esc(h?.to || '17:00')}"${canManage ? '' : ' disabled'}></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="row" style="margin-top:12px">
      <label class="check"><input type="checkbox" id="cActive"${(cal?.active ?? true) ? ' checked' : ''}${canManage ? '' : ' disabled'}> Bookable at all</label>
      <button id="cSave" class="primary"${canManage ? '' : ' disabled'}>Save availability</button>
      <span id="cMsg"></span>
    </div>`;
  if (canManage) $('cSave').onclick = () => saveCalendarAdmin(ownerId);
}

async function saveCalendarAdmin(ownerId) {
  const hours = [];
  document.querySelectorAll('#calEditor [data-cd]').forEach((cb) => {
    if (!cb.checked) return;
    const d = cb.dataset.cd;
    hours.push({
      dow: Number(d),
      from: document.querySelector(`#calEditor [data-cf="${d}"]`).value || '09:00',
      to: document.querySelector(`#calEditor [data-ct="${d}"]`).value || '17:00',
    });
  });
  // A day that ends before it starts generates no slots at all and looks like
  // a broken calendar rather than a typo, so it is refused here.
  if (hours.some((h) => h.to <= h.from)) {
    say($('cMsg'), 'A day ends before it starts.', 'err'); return;
  }
  $('cSave').disabled = true;
  const { error } = await sb.from('dialer_calendars').upsert({
    owner_id: ownerId,
    timezone: ($('cTz').value || 'America/Chicago').trim(),
    slot_minutes: Number($('cSlot').value) || 30,
    buffer_minutes: Number($('cBuf').value) || 0,
    lead_time_hours: Number($('cLead').value) || 0,
    horizon_days: Number($('cHorizon').value) || 21,
    hours,
    active: $('cActive').checked,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_id' });
  $('cSave').disabled = false;
  say($('cMsg'), error ? 'Could not save: ' + error.message : 'Saved.', error ? 'err' : 'ok');
}

// ------------------------------------------------------- status catalogue --
let statusCatalogue = [];
async function loadStatusEditor() {
  const { data } = await sb.from('dialer_agent_statuses')
    .select('code, label, allows_dialing, counts_as, daily_limit_minutes, is_active, sort_order')
    .order('sort_order');
  statusCatalogue = data || [];

  $('statusRows').innerHTML = statusCatalogue.map((s) => `<tr>
    <td>${esc(s.label)} <span class="muted mono">${esc(s.code)}</span></td>
    <td><input type="checkbox" data-s="${esc(s.code)}" data-k="allows_dialing"${s.allows_dialing ? ' checked' : ''}${canManage ? '' : ' disabled'}></td>
    <td><select data-s="${esc(s.code)}" data-k="counts_as"${canManage ? '' : ' disabled'}>
      ${['available', 'paused', 'busy'].map((v) =>
        `<option value="${v}"${s.counts_as === v ? ' selected' : ''}>${v}</option>`).join('')}
    </select></td>
    <td class="num"><input type="number" min="1" style="width:90px" data-s="${esc(s.code)}"
        data-k="daily_limit_minutes" value="${s.daily_limit_minutes ?? ''}"${canManage ? '' : ' disabled'}></td>
    <td><input type="checkbox" data-s="${esc(s.code)}" data-k="is_active"${s.is_active ? ' checked' : ''}${canManage ? '' : ' disabled'}></td>
  </tr>`).join('') || '<tr><td colspan="5">No statuses defined.</td></tr>';

  $('statusSave').disabled = !canManage;
}

$('statusSave').onclick = async () => {
  $('statusSave').disabled = true;
  say($('statusMsg'), 'Saving…', 'ok');

  const read = (code, k) => document.querySelector(`[data-s="${code}"][data-k="${k}"]`);
  for (const s of statusCatalogue) {
    const limRaw = read(s.code, 'daily_limit_minutes').value;
    if (limRaw !== '' && (!Number.isInteger(Number(limRaw)) || Number(limRaw) < 1)) {
      say($('statusMsg'), `${s.label}: a limit must be a whole number of minutes, or blank.`, 'err');
      $('statusSave').disabled = false; return;
    }
    const { error } = await sb.from('dialer_agent_statuses').update({
      allows_dialing: read(s.code, 'allows_dialing').checked,
      counts_as: read(s.code, 'counts_as').value,
      daily_limit_minutes: limRaw === '' ? null : Number(limRaw),
      is_active: read(s.code, 'is_active').checked,
    }).eq('code', s.code);
    if (error) { say($('statusMsg'), error.message, 'err'); $('statusSave').disabled = false; return; }
  }
  say($('statusMsg'), 'Saved. Agents pick it up on their next reload.', 'ok');
  $('statusSave').disabled = false;
  loadStatusEditor();
};

// Who is on the floor right now. One RPC rather than three reads: it resolves
// the name, the status label and the campaign server-side, and it decides
// what counts as "on the floor" in one place instead of here.
//
// That last part is why this was rewritten. It used to select every session
// with no ended_at, newest 50 first -- and sessions are ended by a sendBeacon
// on tab close, which is best-effort and never fires on a crash or a closed
// laptop. They accumulate: at the 2026-09-07 audit there were 133 open, ALL
// with a dead heartbeat and 100 of them over a day old, from three agents. So
// this table showed fifty dead tabs and called them live sessions.
// dialer_live_floor() excludes anything with no heartbeat for 15 minutes, and
// v566 closed the day-old backlog.
//
// A stale heartbeat inside that window still means a crashed tab rather than
// a logout, so it is flagged rather than hidden.
// ---------------------------------------------------------- v688: floor map --
// Replaces the "Who is on shift" table: every dialer agent sits where a
// manager put them, coloured by what they are doing now (the ReadyMode floor
// map). The layout -- floor name and each agent's spot -- is ONE
// dialer_settings row, 'floor_map', so every screen shows the same map.
// "Managing"/"Managed" from ReadyMode's legend are left out: nothing in this
// dialer lets a supervisor listen in, so those states could never occur.
const FM_STATES = [
  ['off', 'Offline — not signed in'],
  ['ready', 'Ready — waiting for a call'],
  ['call', 'On a call'],
  ['wrap', 'Wrap-up'],
  ['prep', 'Preparation — prep work or a lead'],
  ['paused', 'Paused — break, meeting, coaching'],
  ['alert1', 'Alert — 15+ minutes in a paused or prep status'],
  ['alert2', 'Alert — no heartbeat (tab closed or crashed)'],
];
const FM_ALERT_MIN = { prep: 15, paused: 15 };
const FM_TILE_W = 150, FM_TILE_H = 64, FM_GRID = 10;
let fmLayout = { name: 'Office floor', spots: {} };
let fmRoster = [];          // { id, name, role }
let fmRosterAt = 0;
let fmLive = {};            // agent_id -> { state, label, since, queue, heartbeat }
let fmDragging = null;
let fmSaveTimer = null;
let fmTick = null;

const fmPreviewOn = () => lsGet('da.fm.preview') !== '0';
const fmRoleLabel = (r) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Agent');
function fmDur(since) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
function fmStartTick() {
  if (fmTick) clearInterval(fmTick);
  fmTick = setInterval(() => {
    document.querySelectorAll('#fmCanvas [data-since]').forEach((el) => { el.textContent = fmDur(el.dataset.since); });
  }, 1000);
}

// A pending save wins over a re-read, or a refresh mid-drag would snap a tile back.
async function fmLoadLayout() {
  if (fmSaveTimer || fmDragging) return;
  const { data } = await sb.from('dialer_settings').select('value').eq('key', 'floor_map').maybeSingle();
  const v = data?.value || {};
  fmLayout = { name: v.name || 'Office floor', spots: v.spots && typeof v.spots === 'object' ? v.spots : {} };
}
async function fmLoadRoster() {
  if (fmRoster.length && Date.now() - fmRosterAt < 300000) return;
  const [{ data: roles }, { data: people }] = await Promise.all([
    sb.from('roles').select('name, can_use_dialer'),
    sb.from('profiles').select('id, full_name, role').order('full_name'),
  ]);
  const dialerRoles = new Set((roles || []).filter((r) => r.can_use_dialer).map((r) => r.name));
  fmRoster = (people || []).filter((p) => dialerRoles.has(p.role))
    .map((p) => ({ id: p.id, name: p.full_name || 'Agent', role: p.role || '' }));
  fmRosterAt = Date.now();
}

function fmClassify(r, sessionStatus) {
  if (r.is_stale) return 'alert2';
  let base;
  if (sessionStatus === 'on_call') base = 'call';
  else if (sessionStatus === 'wrap_up') base = 'wrap';
  else if (r.agent_status === 'ready' || r.agent_status === 'inbound_only') base = 'ready';
  else if (r.agent_status === 'prep_work' || r.agent_status === 'lead') base = 'prep';
  else base = 'paused';
  if (FM_ALERT_MIN[base] && (r.seconds_in_state || 0) >= FM_ALERT_MIN[base] * 60) return 'alert1';
  return base;
}

async function loadFloorMap(sessions) {
  const [{ data, error }] = await Promise.all([sb.rpc('dialer_live_floor'), fmLoadLayout(), fmLoadRoster()]);
  if (error) {
    $('fmCanvas').innerHTML = `<div class="fm-empty">Could not load the floor: ${esc(error.message)}</div>`;
    return;
  }
  // An agent can have two tabs open; a call on either one is what counts.
  // v689: the RPC carries each session's own status and when it last changed
  // (status_since, stamped by a trigger), so a call is timed from the dial or
  // the answer instead of from the agent's last Ready/Break change. The direct
  // session read is only a fallback for the pre-v689 RPC shape.
  const sess = {};
  (sessions || []).forEach((s) => { if (!sess[s.agent_id] || s.status === 'on_call') sess[s.agent_id] = s.status; });
  const rows = {};
  (data || []).forEach((r) => {   // the RPC lists the freshest session first
    const cur = rows[r.agent_id];
    if (!cur || (r.session_status === 'on_call' && cur.session_status !== 'on_call')) rows[r.agent_id] = r;
  });
  fmLive = {};
  Object.values(rows).forEach((r) => {
    const state = fmClassify(r, r.session_status || sess[r.agent_id]);
    const callTimed = (state === 'call' || state === 'wrap') && r.status_since;
    fmLive[r.agent_id] = {
      state,
      label: state === 'call' ? 'On a call' : state === 'wrap' ? 'Wrap-up'
        : state === 'alert2' ? 'No heartbeat' : (r.status_label || r.agent_status || 'Signed in'),
      since: callTimed ? r.status_since : r.since, queue: r.campaign_name, heartbeat: r.heartbeat_age_seconds,
    };
    if (!fmRoster.some((p) => p.id === r.agent_id)) {
      fmRoster.push({ id: r.agent_id, name: r.agent_name || 'Agent', role: '' });
    }
  });
  if (document.activeElement !== $('fmName')) $('fmName').value = fmLayout.name;
  fmRender();
}

function fmTileHtml(p) {
  const spot = fmLayout.spots[p.id];
  const L = fmLive[p.id];
  const st = L ? L.state : 'off';
  return `<div class="fm-tile fms-${st}${canManage ? ' movable' : ''}" data-agent="${esc(p.id)}"
      style="left:${Number(spot.x) || 0}px;top:${Number(spot.y) || 0}px">
    <div class="fm-top">${esc((L && L.queue) || fmRoleLabel(p.role))}</div>
    <div class="fm-name">${esc(p.name)}</div>
    <div class="fm-st"><span>${esc(L ? L.label : 'Offline')}</span>${L && L.since
      ? `<span class="fm-timer" data-since="${esc(L.since)}" title="${st === 'call' ? 'Time on this call'
        : st === 'wrap' ? 'Time in wrap-up' : 'Time in this status'}">${fmDur(L.since)}</span>` : ''}</div>
    ${canManage ? '<button type="button" class="fm-x" data-fmx="1" title="Take off the map">×</button>' : ''}
  </div>`;
}

function fmRender() {
  const canvas = $('fmCanvas');
  if (!canvas || fmDragging) return;
  $('fmTitle').textContent = `Floor map — ${fmLayout.name}`;
  const placed = fmRoster.filter((p) => fmLayout.spots[p.id]);
  canvas.innerHTML = placed.map(fmTileHtml).join('')
    + (placed.length ? '' : `<div class="fm-empty">${canManage
      ? 'Nobody is on this map yet. Pick an agent on the right, then drag them to where they sit.'
      : 'Nobody has been placed on this map yet.'}</div>`)
    + '<div class="fm-pop hide" id="fmPop"></div>';
  fmWire(canvas);

  const un = fmRoster.filter((p) => !fmLayout.spots[p.id]);
  const unLive = un.filter((p) => fmLive[p.id]).length;
  $('fmUnCount').textContent = `${un.length} agent${un.length === 1 ? ' is' : 's are'} not on this map`
    + (unLive ? ` (${unLive} on shift now)` : '') + ':';
  $('fmPick').innerHTML = '<option value="">Pick one</option>' + un.map((p) =>
    `<option value="${esc(p.id)}">${esc(p.name)}${fmLive[p.id] ? ' — on shift' : ''}</option>`).join('');
  $('fmPick').disabled = !canManage;
  show($('fmUnassigned'), un.length > 0);
}

function fmWire(canvas) {
  canvas.querySelectorAll('.fm-tile').forEach((t) => {
    const id = t.dataset.agent;
    t.addEventListener('mouseenter', () => fmShowPop(t, id));
    t.addEventListener('mouseleave', () => show($('fmPop'), false));
    const x = t.querySelector('[data-fmx]');
    if (x) x.onclick = (e) => { e.stopPropagation(); delete fmLayout.spots[id]; fmSave(); fmRender(); };
    if (!canManage) return;
    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('[data-fmx]')) return;
      e.preventDefault();
      show($('fmPop'), false);
      const r = t.getBoundingClientRect();
      fmDragging = { t, dx: e.clientX - r.left, dy: e.clientY - r.top };
      t.setPointerCapture(e.pointerId);
      t.classList.add('dragging');
    });
    t.addEventListener('pointermove', (e) => {
      if (!fmDragging || fmDragging.t !== t) return;
      const c = canvas.getBoundingClientRect();
      const nx = e.clientX - c.left + canvas.scrollLeft - fmDragging.dx;
      const ny = e.clientY - c.top + canvas.scrollTop - fmDragging.dy;
      t.style.left = Math.max(0, Math.min(canvas.clientWidth - FM_TILE_W, nx)) + 'px';
      t.style.top = Math.max(0, Math.min(Math.max(canvas.clientHeight, canvas.scrollHeight) - FM_TILE_H, ny)) + 'px';
    });
    const drop = () => {
      if (!fmDragging || fmDragging.t !== t) return;
      const snap = (v) => Math.round(parseFloat(v) / FM_GRID) * FM_GRID;
      fmLayout.spots[id] = { x: snap(t.style.left), y: snap(t.style.top) };
      t.style.left = fmLayout.spots[id].x + 'px';
      t.style.top = fmLayout.spots[id].y + 'px';
      t.classList.remove('dragging');
      fmDragging = null;
      fmSave();
    };
    t.addEventListener('pointerup', drop);
    t.addEventListener('pointercancel', drop);
  });
}

function fmShowPop(t, id) {
  if (!fmPreviewOn() || fmDragging) return;
  const p = fmRoster.find((x) => x.id === id) || {};
  const L = fmLive[id];
  const pop = $('fmPop');
  pop.innerHTML = `<b>${esc(p.name || 'Agent')}</b> <span class="muted">${esc(fmRoleLabel(p.role))}</span>
    <div>${esc(L ? L.label : 'Offline')}${L && L.since
      ? ` · since ${esc(new Date(L.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}</div>
    ${L && L.queue ? `<div>Queue: ${esc(L.queue)}</div>` : ''}
    ${L ? `<div class="muted">Last heartbeat ${Number(L.heartbeat) || 0}s ago</div>` : ''}
    <div class="muted">${esc((FM_STATES.find((s) => s[0] === (L ? L.state : 'off')) || [])[1] || '')}</div>`;
  const left = t.offsetLeft + FM_TILE_W + 8;
  pop.style.left = (left + 250 > $('fmCanvas').scrollWidth ? Math.max(0, t.offsetLeft - 258) : left) + 'px';
  pop.style.top = t.offsetTop + 'px';
  show(pop, true);
}

// First free cell in a grid, left to right, for an agent picked from the list.
function fmFreeSpot() {
  const cols = Math.max(1, Math.floor(($('fmCanvas').clientWidth - 20) / (FM_TILE_W + 20)));
  const taken = Object.values(fmLayout.spots);
  for (let i = 0; i < 300; i++) {
    const x = 20 + (i % cols) * (FM_TILE_W + 20);
    const y = 20 + Math.floor(i / cols) * (FM_TILE_H + 20);
    if (!taken.some((s) => Math.abs(s.x - x) < FM_TILE_W && Math.abs(s.y - y) < FM_TILE_H)) return { x, y };
  }
  return { x: 20, y: 20 };
}

function fmSave() {
  if (!canManage) return;
  clearTimeout(fmSaveTimer);
  fmSaveTimer = setTimeout(async () => {
    const { error } = await sb.from('dialer_settings').upsert({
      key: 'floor_map', value: { name: fmLayout.name, spots: fmLayout.spots },
      updated_by: meId, updated_at: new Date().toISOString(),
    });
    fmSaveTimer = null;
    $('fmMsg').textContent = error ? `Not saved: ${error.message}` : '';
  }, 700);
}

$('fmLegend').innerHTML = FM_STATES.map(([k, label]) =>
  `<div class="fm-leg"><span class="fm-sw fms-${k}"></span>${esc(label)}</div>`).join('');
$('fmPreview').checked = fmPreviewOn();
$('fmPreview').onchange = () => lsSet('da.fm.preview', $('fmPreview').checked ? '1' : '0');
$('fmPick').onchange = () => {
  const id = $('fmPick').value;
  if (!id || !canManage) return;
  fmLayout.spots[id] = fmFreeSpot();
  fmSave();
  fmRender();
};
$('fmName').onchange = () => {
  if (!canManage) { $('fmName').value = fmLayout.name; return; }
  fmLayout.name = $('fmName').value.trim().slice(0, 60) || 'Office floor';
  $('fmTitle').textContent = `Floor map — ${fmLayout.name}`;
  fmSave();
};

$('cCreate').onclick = async () => {
  const name = $('cName').value.trim();
  if (!name) { say($('cMsg'), 'Give the campaign a name.', 'err'); return; }
  const winErr = windowError($('cStart').value, $('cEnd').value, false);
  if (winErr) { say($('cMsg'), winErr, 'err'); return; }
  const { error } = await sb.from('dialer_campaigns').insert({
    name, dial_mode: $('cMode').value, status: 'active',
    calling_window_start: $('cStart').value, calling_window_end: $('cEnd').value,
  });
  if (error) { say($('cMsg'), campaignDbError(error), 'err'); return; }
  say($('cMsg'), 'Created.', 'ok');
  $('cName').value = '';
  loadCampaigns();
};

// ----------------------------------------------------------------- lists --
// v836. Campaign first (the owner, 2026-09-24: "the structure of list
// building is a bit misleading ... make it more simple for users"). Pick a
// campaign, see only its lists, each with how many people are LEFT TO CALL
// -- the number that matters, which the old one-table view never showed.
// One request for every list's progress (dialer_list_progress, v836) instead
// of one count request per list. Actions sit in one menu per list.
let lsCamp = lsGet('da.lists.camp');
let lsData = { camps: [], lists: [], prog: {}, agents: {} };
const LS_TONE = { good: 'ls-good', warn: 'ls-warn', off: 'ls-off' };

async function loadLists() {
  const [cr, lr, pr, ar] = await Promise.all([
    sb.from('dialer_campaigns')
      .select('id, name, status, dial_mode, calling_window_start, calling_window_end')
      .neq('status', 'archived').order('name'),
    sb.from('dialer_lists')
      .select('id, name, campaign_id, status, source_type, loaded_rows, readymode_scrubbed_at, is_active, deactivated_at')
      .order('created_at', { ascending: false }).limit(500),
    sb.rpc('dialer_list_progress'),
    sb.from('dialer_campaign_agents').select('campaign_id, is_active'),
  ]);
  if (lr.error || pr.error) {
    $('listRows').innerHTML = `<div class="ls-empty">${esc((lr.error || pr.error).message)}</div>`;
    return;
  }
  const prog = {};
  (pr.data || []).forEach((p) => { prog[p.list_id] = p; });
  const agents = {};
  (ar.data || []).forEach((a) => { if (a.is_active) agents[a.campaign_id] = (agents[a.campaign_id] || 0) + 1; });
  lsData = { camps: cr.data || [], lists: lr.data || [], prog, agents };

  // Upload goes to the campaign on screen; keep the importer's picker in step.
  if (lsData.camps.length) {
    $('impCampaign').innerHTML = lsData.camps.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (lsCamp) $('impCampaign').value = lsCamp;
  }
  if (!lsData.camps.some((c) => c.id === lsCamp)) {
    const withLists = lsData.camps.filter((c) => lsData.lists.some((l) => l.campaign_id === c.id));
    lsCamp = (withLists.find((c) => c.status === 'active') || withLists[0] || lsData.camps[0] || {}).id || null;
  }
  renderLists();
}

// Only lists that will actually dial count toward "left to call".
const lsLeft = (l) => (l.is_active === false ? 0 : Number(lsData.prog[l.id]?.left_to_call ?? 0));
function lsCampTotals(campId) {
  const t = { left: 0, done: 0, bad: 0 };
  lsData.lists.filter((l) => l.campaign_id === campId).forEach((l) => {
    const p = lsData.prog[l.id] || {};
    t.left += lsLeft(l);
    t.done += Number(p.finished || 0);
    t.bad += Number(p.bad || 0);
  });
  return t;
}
function lsStatus(l, camp) {
  if (l.is_active === false) return { tone: 'off', text: 'Switched off', sub: `on ${listDateMdy(l.deactivated_at)}` };
  if (l.source_type === 'manual') return { tone: 'off', text: 'Contacts only' };
  if (l.status === 'pending_scrub') return { tone: 'warn', text: 'Needs DNC scrub' };
  if (l.status === 'loading') return { tone: 'off', text: 'Loading' };
  if (l.status === 'archived') return { tone: 'off', text: 'Archived' };
  const p = lsData.prog[l.id];
  if (l.status === 'exhausted' || (p && Number(p.total) > 0 && Number(p.left_to_call) === 0)) {
    return { tone: 'off', text: 'Finished' };
  }
  if (camp && camp.status !== 'active') return { tone: 'warn', text: 'Campaign paused' };
  return { tone: 'good', text: 'Dialing' };
}

function renderLists() {
  const n = (v) => Number(v || 0).toLocaleString();
  $('lsChips').innerHTML = lsData.camps.map((c) => {
    const t = lsCampTotals(c.id);
    return `<button class="ls-chip${c.id === lsCamp ? ' on' : ''}" data-lscamp="${esc(c.id)}">${esc(c.name)}`
      + ` <span>${n(t.left)} left</span></button>`;
  }).join('') || '<span class="hint" style="margin:0">No campaigns yet. Create one on the Campaigns tab.</span>';
  $('lsChips').querySelectorAll('button[data-lscamp]').forEach((b) => {
    b.onclick = () => {
      lsCamp = b.dataset.lscamp;
      lsSet('da.lists.camp', lsCamp);
      showImport(false);
      show($('lrqPanel'), false);
      say($('valMsg'), '', 'ok');
      renderLists();
    };
  });

  const camp = lsData.camps.find((c) => c.id === lsCamp);
  const up = $('lsUpload');
  if (!camp) {
    $('lsName').textContent = 'No campaign';
    $('lsMeta').textContent = '';
    ['lsLeft', 'lsDone', 'lsBad'].forEach((id) => { $(id).textContent = '—'; });
    $('listRows').innerHTML = '';
    show(up, false);
    return;
  }
  const ag = lsData.agents[camp.id] || 0;
  $('lsName').textContent = camp.name;
  $('lsMeta').textContent = [
    camp.status === 'active' ? 'Dialing now' : 'Paused',
    `${ag} agent${ag === 1 ? '' : 's'}`,
    camp.calling_window_start && camp.calling_window_end
      ? `calling hours ${String(camp.calling_window_start).slice(0, 5)}–${String(camp.calling_window_end).slice(0, 5)}` : '',
    camp.dial_mode ? `${camp.dial_mode} dial` : '',
  ].filter(Boolean).join(' · ');
  up.textContent = `Upload list to ${camp.name}`;
  show(up, canManage);
  const t = lsCampTotals(camp.id);
  $('lsLeft').textContent = n(t.left);
  $('lsDone').textContent = n(t.done);
  $('lsBad').textContent = n(t.bad);

  const lists = lsData.lists.filter((l) => l.campaign_id === camp.id);
  if (!lists.length) {
    $('listRows').innerHTML = `<div class="ls-empty">No lists in ${esc(camp.name)} yet.`
      + (canManage ? ' Use <b>Upload list</b> to add one.' : '') + '</div>';
    return;
  }
  $('listRows').innerHTML = lists.map((l) => {
    const p = lsData.prog[l.id] || {};
    const total = Number(p.total || 0);
    const left = Number(p.left_to_call || 0);
    const pct = total ? Math.round(((total - left) / total) * 100) : 0;
    const st = lsStatus(l, camp);
    const noTz = Number(p.no_tz || 0);
    const bad = Number(p.bad || 0);
    const notes = [];
    if (noTz) {
      notes.push(`${n(noTz)} number${noTz === 1 ? ' has' : 's have'} no time zone`
        + (canManage ? ` · <button class="ls-link" data-lsfix="${esc(l.id)}">Fix</button>` : ''));
    }
    if (bad) notes.push(`${n(bad)} bad number${bad === 1 ? '' : 's'} removed`);
    const items = [];
    if (canManage) {
      items.push(`<button data-rq="${esc(l.id)}" data-rqname="${esc(l.name)}">Requeue…</button>`);
      if (!noTz) items.push(`<button data-val="${esc(l.id)}">Carrier check</button>`);
      items.push(`<button data-lact="${esc(l.id)}" data-lname="${esc(l.name)}" data-on="${l.is_active === false ? '1' : '0'}">`
        + `${l.is_active === false ? 'Reactivate' : 'Deactivate'}</button>`);
    }
    items.push(`<button data-lsdl="${esc(l.id)}" data-lsname="${esc(l.name)}">Download</button>`);
    return `<div class="ls-row">
      <div class="ls-cell-name"><div class="ls-lname">${esc(l.name)}</div>
        ${notes.map((x) => `<div class="ls-note">${x}</div>`).join('')}</div>
      <div class="ls-cell-bar"><div class="ls-bar"><i style="width:${pct}%"></i></div>
        <div class="ls-count">${n(left)} left of ${n(total)}${l.readymode_scrubbed_at ? ` · DNC scrubbed ${esc(listDateMdy(l.readymode_scrubbed_at))}` : ''}</div></div>
      <div><span class="ls-pill ${LS_TONE[st.tone]}">${esc(st.text)}</span>
        ${st.sub ? `<div class="ls-count">${esc(st.sub)}</div>` : ''}</div>
      <details class="ls-more"><summary aria-label="More actions for ${esc(l.name)}">…</summary>
        <div>${items.join('')}</div></details>
    </div>`;
  }).join('');

  const rows = $('listRows');
  const closeMenus = () => rows.querySelectorAll('details.ls-more[open]').forEach((d) => { d.open = false; });
  rows.querySelectorAll('details.ls-more').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) rows.querySelectorAll('details.ls-more[open]').forEach((o) => { if (o !== d) o.open = false; });
    });
  });
  rows.querySelectorAll('button[data-lsfix]').forEach((b) => {
    b.onclick = () => validateList(b.dataset.lsfix, b, true);
  });
  rows.querySelectorAll('button[data-val]').forEach((b) => {
    b.onclick = () => { closeMenus(); validateList(b.dataset.val, b, false); };
  });
  rows.querySelectorAll('button[data-lsdl]').forEach((b) => {
    b.onclick = async () => {
      closeMenus();
      say($('valMsg'), `Preparing ${b.dataset.lsname}…`, 'ok');
      await downloadList(b.dataset.lsdl, b.dataset.lsname, b);
      say($('valMsg'), '', 'ok');
    };
  });
  rows.querySelectorAll('button[data-rq]').forEach((b) => {
    b.onclick = () => { closeMenus(); openListRequeue(b.dataset.rq, b.dataset.rqname); };
  });
  rows.querySelectorAll('button[data-lact]').forEach((b) => {
    b.onclick = () => { closeMenus(); setListActive(b.dataset.lact, b.dataset.lname, b.dataset.on === '1', b); };
  });
}
// A click anywhere else closes an open list menu.
document.addEventListener('click', (e) => {
  document.querySelectorAll('#listRows details.ls-more[open]').forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

function showImport(on) {
  const camp = lsData.camps.find((c) => c.id === lsCamp);
  if (on && (!camp || !canManage)) return;
  $('impPanel').style.display = on ? '' : 'none';
  if (!on) return;
  $('impCampName').textContent = camp.name;
  $('impCampaign').value = camp.id;
  say($('impMsg'), '', 'ok');
  $('impPanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
$('lsUpload').onclick = () => showImport(true);
$('impCancel').onclick = () => showImport(false);

// v727 (the owner: "allow the option to deactivate lists on campaign and
// reactivate it when needed, and mention when it was deactivated, like
// 'deactivated on 9-15-2026'"). Deactivating deletes nothing and touches no
// contact: dialer_claim_next_contact() skips a switched-off list's numbers
// until it is reactivated, when they are all back exactly as they were.
function listDateMdy(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
}
async function setListActive(id, name, on, btn) {
  if (!on && !confirm(`Deactivate "${name}"?\n\nIts numbers stop being dialled until you reactivate it. Nothing is deleted.`)) return;
  btn.disabled = true;
  const patch = on
    ? { is_active: true, deactivated_at: null, deactivated_by: null }
    : { is_active: false, deactivated_at: new Date().toISOString(), deactivated_by: meId || null };
  const { error } = await sb.from('dialer_lists').update(patch).eq('id', id);
  btn.disabled = false;
  if (error) { alert('Could not change the list: ' + error.message); return; }
  loadLists();
}

// ------------------------------------------------------ v679: download a list --
// Every record on the list, every number on each record, and the fields that
// were mapped at import -- the whole list as it now stands, statuses included.
async function downloadList(listId, name, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const cols = 'id, contact_name, first_name, last_name, company, phone_e164, email, address, city, state, zip, '
      + 'timezone, status, retired_reason, attempt_count, last_outcome, last_attempt_at, next_attempt_at, '
      + 'recycle_count, readymode_dnc, readymode_status, contact_fields, created_at';
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('dialer_contacts').select(cols)
        .eq('list_id', listId).order('created_at').order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    if (!rows.length) { alert('That list has no records to download.'); return; }

    const phones = {};
    for (let i = 0; i < rows.length; i += 200) {
      const { data, error } = await sb.from('dialer_contact_phones')
        .select('contact_id, rank, phone_e164, status')
        .in('contact_id', rows.slice(i, i + 200).map((r) => r.id)).order('rank');
      if (error) throw error;
      (data || []).forEach((p) => { (phones[p.contact_id] = phones[p.contact_id] || []).push(p); });
    }
    const numbersOf = (r) => phones[r.id]?.length ? phones[r.id]
      : (r.phone_e164 ? [{ phone_e164: r.phone_e164, status: '' }] : []);
    const maxPh = Math.max(1, ...rows.map((r) => numbersOf(r).length));
    const extra = [...new Set(rows.flatMap((r) => Object.keys(r.contact_fields || {})))].sort();
    const pretty = (s) => String(s || '').replace(/_/g, ' ');

    const head = ['Name', 'First name', 'Last name', 'Company'];
    for (let i = 1; i <= maxPh; i++) head.push(`Phone ${i}`, `Phone ${i} status`);
    head.push('Email', 'Address', 'City', 'State', 'Zip', 'Time zone', 'Status', 'Retired reason', 'Attempts',
      'Last outcome', 'Last attempt', 'Next attempt', 'Recycles', 'ReadyMode DNC', 'ReadyMode status', 'Loaded');
    extra.forEach((k) => head.push(k));

    const cell = (v) => {
      const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.map(cell).join(',')].concat(rows.map((r) => {
      const out = [r.contact_name || [r.first_name, r.last_name].filter(Boolean).join(' '), r.first_name, r.last_name, r.company];
      const ph = numbersOf(r);
      for (let i = 0; i < maxPh; i++) out.push(ph[i]?.phone_e164 || '', pretty(ph[i]?.status));
      out.push(r.email, r.address, r.city, r.state, r.zip, r.timezone, r.status, pretty(r.retired_reason), r.attempt_count,
        pretty(r.last_outcome), r.last_attempt_at, r.next_attempt_at, r.recycle_count, r.readymode_dnc, r.readymode_status,
        r.created_at);
      extra.forEach((k) => out.push((r.contact_fields || {})[k]));
      return out.map(cell).join(',');
    }));
    // The BOM makes Excel read accented names as UTF-8 instead of mangling them.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(name || 'list').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'list'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    alert(`Could not download that list: ${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ------------------------------------------------------- v677: requeue a list --
let lrqList = null;
async function openListRequeue(listId, name, keepMsg) {
  lrqList = listId;
  $('lrqName').textContent = name || 'list';
  if (!keepMsg) $('lrqMsg').textContent = '';
  $('lrqScopes').innerHTML = '<span class="hint" style="margin:0">Counting…</span>';
  show($('lrqPanel'), true);
  $('lrqPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const base = () => sb.from('dialer_contacts').select('id', { count: 'exact', head: true })
    .eq('list_id', listId).not('status', 'in', '(suppressed,invalid)');
  const [dialed, retired, all] = await Promise.all([
    base().or('status.neq.new,attempt_count.gt.0'),
    base().eq('status', 'retired'),
    base(),
  ]);
  if (lrqList !== listId) return;
  const opt = (v, label, n, checked) => `<label class="da-scope"><input type="radio" name="lrqScope" value="${v}"${checked ? ' checked' : ''}>
    ${label} <b>${(n ?? 0).toLocaleString()}</b></label>`;
  $('lrqScopes').innerHTML = opt('dialed', 'Already dialed', dialed.count, true)
    + opt('retired', 'Retired only', retired.count, false)
    + opt('all', 'Whole list', all.count, false);
}
$('lrqCancel').onclick = () => { show($('lrqPanel'), false); lrqList = null; };
$('lrqGo').onclick = async () => {
  if (!lrqList || !canManage) return;
  const scope = (document.querySelector('input[name="lrqScope"]:checked') || {}).value || 'dialed';
  const label = { dialed: 'every already-dialed contact', retired: 'every retired contact', all: 'the whole list' }[scope];
  if (!confirm(`Requeue ${label} in "${$('lrqName').textContent}"? Their retry cadence starts over.`)) return;
  $('lrqGo').disabled = true;
  $('lrqMsg').textContent = 'Requeuing…';
  const { data, error } = await sb.rpc('dialer_admin_requeue_list', { p_list: lrqList, p_scope: scope });
  $('lrqGo').disabled = false;
  if (error) { $('lrqMsg').textContent = error.message; return; }
  const r = (data || [])[0] || {};
  $('lrqMsg').textContent = `Requeued ${(r.requeued || 0).toLocaleString()}`
    + (r.skipped_dnc ? ` · ${r.skipped_dnc.toLocaleString()} skipped (do-not-call)` : '')
    + '.';
  openListRequeue(lrqList, $('lrqName').textContent, true);
  loadLists();
}

// THE PAID PATH, WHICH IS NOW OPTIONAL.
//
// Import resolves time zone from the area code and drops undialable numbers
// on the digits alone, both for nothing, so a list is dialable without this
// ever running. What money still buys is the one thing free cannot see: a
// number that is properly formed and correctly zoned but dead. Without a
// carrier check you find that out on the first dial instead -- which the
// webhook now retires automatically, at the cost of one wasted dial.
//
// So there are exactly two reasons to press a button here:
//   - Resolve time zones: an area code this build's table does not carry.
//     Small, bounded, and worth the cents because those rows cannot be
//     dialled at all until something resolves them.
//   - Carrier check: pre-screening the dead numbers out of a batch before
//     agents reach it. Real money on a large list, and genuinely optional.
//
// Still bounded per press either way. An unbounded run over a 100k import
// is $150 spent mostly on numbers that will not be dialled for a year.
const VALIDATE_BATCH = 500;

async function validateList(listId, btn, timezonesOnly) {
  const est = (VALIDATE_BATCH * 0.0015).toFixed(2);
  const prompt = timezonesOnly
    ? `Look up the next ${VALIDATE_BATCH} numbers that have no time zone?\n\n`
      + `Costs about $${est}, and it is the only way these particular rows become `
      + `dialable — their area code is not in this build's table.`
    : `Carrier-check the next ${VALIDATE_BATCH} numbers in this list?\n\n`
      + `Costs about $${est}. This is optional: these contacts are already dialable. `
      + `It buys pre-dial detection of numbers that are dead but well-formed, which `
      + `otherwise costs one wasted dial each.`;
  if (!confirm(prompt)) return;

  btn.disabled = true;
  say($('valMsg'), 'Looking up…', 'ok');

  // Two passes of the function's own 300 cap covers one batch.
  let total = 0, remaining = 0;
  for (let pass = 0; pass < Math.ceil(VALIDATE_BATCH / 300); pass++) {
    const r = await callFn('dialer-validate-numbers', {
      list_id: listId, max_lookups: 300, only_missing_timezone: !!timezonesOnly,
    });
    if (!r?.ok) { say($('valMsg'), r?.error || 'Lookup failed', 'err'); btn.disabled = false; return; }
    total += r.checked || 0;
    remaining = r.remaining ?? 0;
    if (!r.remaining || !r.checked) break;
  }

  btn.disabled = false;
  say($('valMsg'),
    `Checked ${total} (~$${(total * 0.0015).toFixed(2)}). `
    + (remaining ? `${remaining.toLocaleString()} left in this list.`
                 : 'Nothing left to check on this list.'),
    'ok');
  loadLists();
}

// ---- manual CSV import ---------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
const nrm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const PHONE_ALIASES = ['phone', 'phonenumber', 'phone1', 'primaryphone', 'mobile', 'cell',
                       'cellphone', 'telephone', 'ownerphone', 'contactphone'];
function pick(headers, aliases) {
  const h = headers.map(nrm);
  for (const a of aliases) { const i = h.indexOf(a); if (i >= 0) return i; }
  return -1;
}
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

// ---- free pre-dial resolution --------------------------------------------
// NANP area code -> IANA time zone. Free, offline, and the reason an
// imported list is dialable the moment it lands.
//
// WHY THIS IS AS GOOD AS THE PAID LOOKUP: US number portability is confined
// to the same rate centre, so a ported number keeps its area code and its
// state. Telnyx's portability.state and the NPA therefore agree except in
// edge cases -- we were paying $0.0015 a number for an answer already
// carried in the first three digits.
//
// AND BETTER THAN WHAT PRECEDED IT: validation mapped whole STATES, so
// every Florida number resolved to Central and its 9am window opened at
// the seller's 10am. Half the state's dialable morning, gone. Same for
// El Paso (Mountain, not Central) and Boise (Mountain, not Pacific).
//
// SPLIT AREA CODES take the zone of the majority of the population, except
// where the split is close enough to matter, where they take the WESTERN
// zone -- the error direction that is safe. Assuming Central for a number
// that is really Eastern opens the window at their 10am: late, harmless.
// The reverse opens it at their 8am: a complaint. Conservative by choice:
//   448/850 Florida panhandle -> Central (Pensacola)
//   906     Michigan UP       -> Central
//   812/930 southwest Indiana -> Central (Evansville)
//   308     western Nebraska  -> Mountain
//   208/986 Idaho             -> Mountain (Boise; the panhandle is Pacific)
// 574 is the deliberate exception: South Bend is Eastern and carries the
// area code, so the two Central counties lose rather than the other 95%.
const NPA_TZ_GROUPS = {
  'America/New_York': [
    203, 475, 860, 959,                                        // CT
    302, 202,                                                  // DE, DC
    239, 305, 321, 352, 386, 407, 561, 656, 689, 727, 728,     // FL, eastern
    754, 772, 786, 813, 863, 904, 941, 954,
    229, 404, 470, 478, 678, 706, 762, 770, 912, 943,          // GA
    260, 317, 463, 574, 765,                                   // IN, eastern
    502, 606, 859,                                             // KY, eastern
    207,                                                       // ME
    227, 240, 301, 410, 443, 667,                              // MD
    339, 351, 413, 508, 617, 774, 781, 857, 978,               // MA
    231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 947, 989,// MI
    603,                                                       // NH
    201, 551, 609, 640, 732, 848, 856, 862, 908, 973,          // NJ
    212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646,     // NY
    680, 716, 718, 838, 845, 914, 917, 929, 934,
    252, 336, 472, 704, 743, 828, 910, 919, 980, 984,          // NC
    216, 220, 234, 283, 326, 330, 380, 419, 436, 440, 513,     // OH
    567, 614, 740, 937,
    215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717,     // PA
    724, 814, 835, 878,
    401,                                                       // RI
    803, 839, 843, 854, 864,                                   // SC
    423, 865,                                                  // TN, eastern
    802,                                                       // VT
    276, 434, 540, 571, 703, 757, 804, 826, 948,               // VA
    304, 681,                                                  // WV
  ],
  'America/Chicago': [
    205, 251, 256, 334, 659, 938,                              // AL
    327, 479, 501, 870,                                        // AR
    448, 850,                                                  // FL panhandle
    217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730,     // IL
    773, 779, 815, 847, 861, 872,
    219, 812, 930,                                             // IN, west/south
    319, 515, 563, 641, 712,                                   // IA
    316, 620, 785, 913,                                        // KS
    270, 364,                                                  // KY, western
    225, 318, 337, 504, 985,                                   // LA
    906,                                                       // MI, upper
    218, 320, 507, 612, 651, 763, 924, 952,                    // MN
    228, 601, 662, 769,                                        // MS
    314, 417, 557, 573, 636, 660, 816, 975,                    // MO
    402, 531,                                                  // NE, eastern
    701,                                                       // ND
    405, 539, 572, 580, 918,                                   // OK
    605,                                                       // SD
    615, 629, 731, 901, 931,                                   // TN, central
    210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469,     // TX
    512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 936,
    940, 945, 956, 972, 979,
    262, 274, 353, 414, 534, 608, 715, 920,                    // WI
  ],
  'America/Denver': [
    303, 719, 720, 970, 983,                                   // CO
    208, 986,                                                  // ID
    406,                                                       // MT
    308,                                                       // NE, western
    505, 575,                                                  // NM
    915,                                                       // TX, El Paso
    385, 435, 801,                                             // UT
    307,                                                       // WY
  ],
  'America/Phoenix': [480, 520, 602, 623, 928],                // AZ, no DST
  'America/Los_Angeles': [
    209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442,     // CA
    510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669,
    707, 714, 738, 747, 760, 764, 805, 818, 820, 831, 840,
    858, 909, 916, 925, 949, 951,
    702, 725, 775,                                             // NV
    458, 503, 541, 971,                                        // OR
    206, 253, 360, 425, 509, 564,                              // WA
  ],
  'America/Anchorage': [907],
  'Pacific/Honolulu': [808],
  'America/Puerto_Rico': [787, 939],
  'America/St_Thomas': [340],
};

// Area codes that can never be a seller's line: toll-free, premium rate,
// and personal-communications ranges. A file carrying these is carrying a
// business switchboard or a typo, and either way a dial is wasted on it.
const NPA_NOT_DIALABLE = new Set([
  800, 833, 844, 855, 866, 877, 888,                           // toll-free
  900, 976,                                                    // premium rate
  500, 521, 522, 523, 524, 525, 526, 527, 528, 529,            // personal comms
  533, 544, 566, 577, 588, 622, 710,
]);
const NPA_TZ = {};
for (const [tz, list] of Object.entries(NPA_TZ_GROUPS)) for (const n of list) NPA_TZ[n] = tz;

function npaOf(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? Number(d.slice(1, 4)) : null;
}

// The calling-hours gate's only requirement, answered for nothing.
function timezoneForNumber(e164) {
  const npa = npaOf(e164);
  return npa ? (NPA_TZ[npa] || null) : null;
}

// Structural screen. Catches what a paid lookup would also catch, on the
// numbers where the answer is knowable from the digits alone: service
// codes, toll-free switchboards, and the placeholder rows every skip-trace
// file carries. Anything it cannot rule out is left alone -- a number that
// is merely dead still looks perfectly well-formed, and that one is caught
// on the first dial instead (see dialer-telnyx-webhook, unallocated_number).
const FAKE_555 = 'fake 555 number';
function numberProblem(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  if (d.length !== 11 || d[0] !== '1') return 'not a US number';
  const npa = d.slice(1, 4), nxx = d.slice(4, 7);
  if (npa[0] < '2') return 'impossible area code';
  if (npa[1] === '1' && npa[2] === '1') return 'service code, not a phone number';
  if (NPA_NOT_DIALABLE.has(Number(npa))) return 'toll-free or premium-rate';
  if (nxx[0] < '2') return 'impossible exchange';
  if (nxx[1] === '1' && nxx[2] === '1') return 'service code, not a phone number';
  // v809: every 555 exchange, not just the reserved 555-0100..0199. A list
  // uploaded 2026-09-21 had 46 made-up 555 numbers (555-0288, 555-3319...)
  // and every call to them came back "destination number is invalid".
  if (nxx === '555') return FAKE_555;
  if (/^(\d)\1{9}$/.test(d.slice(1))) return 'placeholder digits';
  return null;
}

// Mobiles answer at materially higher rates than landlines, VOIP worst, and
// every skip-trace export (DealMachine, PropStream, BatchLeads) already says
// which is which. Writes the same phone_rank the paid lookup wrote, off a
// column the file gave us.
//
// A FILE WITHOUT A PHONE-TYPE COLUMN LOSES NOTHING, because line type does
// not currently order anything: dialer_next_number picks a contact's next
// number with `order by rank`, and that rank is the file's own Ph# position,
// not a quality score. Skip-trace vendors list numbers best-first, so file
// order is already the ranking. Unknown scores 3, which is where every
// contact sat before this existed.
function rankForPhoneType(raw) {
  const v = String(raw || '').toLowerCase();
  if (v.includes('mobile') || v.includes('wireless') || v.includes('cell')) return 0;
  if (v.includes('landline') || v.includes('fixed line') || v.includes('wireline')) return 1;
  if (v.includes('voip')) return 2;
  return 3;
}

// ---- column mapping -------------------------------------------------------
// Mapping happens here, at import, because this is the only moment anyone is
// looking at the file and can say which column is which. Before this, imports
// guessed a phone column by alias and dumped everything else into source_row
// under whatever the file called it -- fine as provenance, useless to a
// screen, because one file's "Owner" is the next one's "owner_name".
let fieldDefs = [];        // dialer_field_defs, ordered
let csvHeaders = [];       // headers of the loaded file
let csvFirstRow = [];      // its first data row, shown as a sample
let mapping = {};          // field key -> header index, or -1 for unmapped

// Extra spellings worth recognising beyond an exact normalised match. Keeps
// the common exports (DealMachine, ReadyMode, skip-trace vendors) hands-off.
const FIELD_ALIASES = {
  first_name: ['firstname', 'first', 'ownerfirstname', 'owner1firstname', 'fname'],
  last_name:  ['lastname', 'last', 'ownerlastname', 'owner1lastname', 'lname', 'surname'],
  phone:      PHONE_ALIASES,
  address:    ['address', 'propertyaddress', 'streetaddress', 'address1', 'mailingaddress', 'siteaddress'],
  city:       ['city', 'propertycity', 'mailingcity'],
  state:      ['state', 'propertystate', 'mailingstate', 'st'],
  zip:        ['zip', 'zipcode', 'postalcode', 'propertyzip', 'mailingzip'],
  email:      ['email', 'emailaddress', 'email1', 'owneremail'],
  county:     ['county', 'propertycounty'],
  // Mobile-or-landline, which DealMachine, PropStream and BatchLeads all
  // export. Mapped for the queue ranking that used to come off a paid lookup.
  phone_type: ['phonetype', 'phone1type', 'phonenumbertype', 'linetype',
               'numbertype', 'phonestatus', 'type'],
};
for (let i = 2; i <= 10; i++) {
  FIELD_ALIASES['phone_' + i] = ['phone' + i, 'ph' + i, 'phone' + i + 'number', 'mobile' + i];
}

async function loadFieldDefs() {
  const { data } = await sb.from('dialer_field_defs')
    .select('key, label, group_name, is_required, column_name, sort_order')
    .eq('is_active', true).order('sort_order');
  fieldDefs = data || [];
}

function guessMapping() {
  const norm = csvHeaders.map(nrm);
  mapping = {};
  fieldDefs.forEach((f) => {
    let idx = norm.indexOf(nrm(f.key));
    if (idx < 0) idx = norm.indexOf(nrm(f.label));
    if (idx < 0) {
      for (const a of (FIELD_ALIASES[f.key] || [])) {
        idx = norm.indexOf(nrm(a));
        if (idx >= 0) break;
      }
    }
    mapping[f.key] = idx;
  });
}

function renderMapping() {
  if (!csvHeaders.length || !fieldDefs.length) { show($('impMapWrap'), false); return; }
  show($('impMapWrap'), true);

  const opts = (sel) => '<option value="-1">-- not in this file --</option>'
    + csvHeaders.map((h, i) =>
        '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>'
        + esc(h || ('(column ' + (i + 1) + ')')) + '</option>').join('');

  const groups = [...new Set(fieldDefs.map((f) => f.group_name))];
  $('impMapRows').innerHTML = groups.map((g) => {
    const rows = fieldDefs.filter((f) => f.group_name === g).map((f) => {
      const sel = mapping[f.key] ?? -1;
      const sample = sel >= 0 ? (csvFirstRow[sel] ?? '') : '';
      const star = f.is_required
        ? ' <span style="color:var(--focus);font-weight:700">*</span>' : '';
      return '<tr>'
        + '<td>' + esc(f.label) + star + '</td>'
        + '<td><select data-map="' + esc(f.key) + '" style="width:100%">' + opts(sel) + '</select></td>'
        + '<td style="color:var(--text-2)">' + esc(String(sample).slice(0, 60)) + '</td>'
        + '</tr>';
    }).join('');
    return '<tr><td colspan="3" style="background:var(--inset);font-family:var(--mono);'
      + 'font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim)">'
      + esc(g) + '</td></tr>' + rows;
  }).join('');

  $('impMapRows').querySelectorAll('select[data-map]').forEach((selEl) => {
    selEl.onchange = () => {
      mapping[selEl.dataset.map] = Number(selEl.value);
      renderMapping();
    };
  });
  syncMapSummary();
}

function missingRequired() {
  return fieldDefs.filter((f) => f.is_required && (mapping[f.key] ?? -1) < 0);
}

function syncMapSummary() {
  const mapped = fieldDefs.filter((f) => (mapping[f.key] ?? -1) >= 0).length;
  const missing = missingRequired();
  $('impMapSummary').textContent = missing.length
    ? mapped + ' of ' + fieldDefs.length + ' mapped - still needed: '
      + missing.map((f) => f.label).join(', ')
    : mapped + ' of ' + fieldDefs.length + ' mapped - all required fields set';
  $('impMapSummary').style.color = missing.length ? 'var(--away)' : 'var(--good)';
}

async function loadCsvIntoMapper(text) {
  $('impCsv').value = text;
  const rows = parseCsv(text);
  if (rows.length < 2) { show($('impMapWrap'), false); return; }
  csvHeaders = rows[0];
  csvFirstRow = rows[1] || [];
  if (!fieldDefs.length) await loadFieldDefs();
  guessMapping();
  renderMapping();
}

$('impFile').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (f) await loadCsvIntoMapper(await f.text());
};
// Pasting straight into the box should behave the same as uploading.
$('impCsv').onchange = () => loadCsvIntoMapper($('impCsv').value);
$('impCsv').onblur = () => { if (!csvHeaders.length) loadCsvIntoMapper($('impCsv').value); };
$('impMapReset').onclick = () => { guessMapping(); renderMapping(); };
$('impMapClear').onclick = () => {
  fieldDefs.forEach((f) => { mapping[f.key] = -1; });
  renderMapping();
};

$('impBtn').onclick = async () => {
  const campaignId = $('impCampaign').value;
  const name = $('impName').value.trim();
  const csv = $('impCsv').value.trim();
  if (!campaignId) { say($('impMsg'), 'Pick a campaign.', 'err'); return; }
  if (!name) { say($('impMsg'), 'Give the list a name.', 'err'); return; }
  if (!csv) { say($('impMsg'), 'Paste or upload a CSV.', 'err'); return; }
  if (!$('impScrubbed').checked || !$('impScrubDate').value) {
    say($('impMsg'), 'Confirm the DNC scrub and its date - an unscrubbed list cannot be dialled.', 'err');
    return;
  }

  const rows = parseCsv(csv);
  if (rows.length < 2) { say($('impMsg'), 'CSV has no data rows.', 'err'); return; }
  // Re-read the file in case it was edited after the mapper was built.
  csvHeaders = rows[0]; csvFirstRow = rows[1] || [];
  if (!fieldDefs.length) { await loadFieldDefs(); guessMapping(); renderMapping(); }

  const missing = missingRequired();
  if (missing.length) {
    say($('impMsg'), 'Map these first: ' + missing.map((f) => f.label).join(', ') + '.', 'err');
    show($('impMapWrap'), true);
    return;
  }

  const at = (row, key) => {
    const i = mapping[key] ?? -1;
    if (i < 0) return '';
    return String(row[i] ?? '').trim();
  };

  $('impBtn').disabled = true;
  say($('impMsg'), 'Importing...', 'ok');

  const scrubbedAt = new Date($('impScrubDate').value + 'T12:00:00Z').toISOString();
  const { data: list, error: lErr } = await sb.from('dialer_lists').insert({
    campaign_id: campaignId, name, source_type: 'csv_upload', status: 'loading',
    readymode_scrubbed_at: scrubbedAt,
    readymode_scrub_note: 'Manual import - scrub attested by admin in dialer admin screen',
    total_rows: rows.length - 1,
  }).select('id').single();
  if (lErr) { say($('impMsg'), lErr.message, 'err'); $('impBtn').disabled = false; return; }

  // Optional fields go to contact_fields under their canonical key, so the
  // profile screen reads one shape whatever the file called the column.
  const optional = fieldDefs.filter((f) => !f.is_required && !f.column_name);
  const seen = new Set(); const contacts = []; let bad = 0;
  let unusable = 0, noZone = 0, fake555 = 0;
  // Ph#2..Ph#10, keyed by the primary number so they can be turned into
  // dialer_contact_phones rows once the contacts have ids. Before v563
  // nothing created those rows and the alternates were mapped, stored and
  // never dialled -- see that migration's header.
  const altsFor = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const phone = toE164(at(row, 'phone'));
    if (!phone || seen.has(phone)) { bad++; continue; }
    seen.add(phone);

    // Screened here rather than loaded and screened later: a service code
    // or a toll-free switchboard is knowable from the digits, and letting
    // one in costs a dial and a mark against the DID that placed it.
    const problem = numberProblem(phone);
    if (problem) { if (problem === FAKE_555) fake555++; else unusable++; continue; }

    const first = at(row, 'first_name'), last = at(row, 'last_name');
    const extra = {};
    optional.forEach((f) => { const v = at(row, f.key); if (v) extra[f.key] = v; });

    // source_row stays the untouched original: mapping is lossy, and this is
    // the only record of what the file actually contained.
    const src = {}; csvHeaders.forEach((h, i) => { if (h) src[h] = row[i] ?? ''; });

    // The two answers that used to cost $0.0015 each, taken from the number
    // itself and from a column the file already had. A contact leaves this
    // loop dialable; nothing has to run afterwards.
    const tz = timezoneForNumber(phone);
    if (!tz) noZone++;

    // Each alternate carries its OWN zone, from its OWN area code. A
    // seller's second line is routinely in a different state from their
    // first, and dialer-call-control reads the phone row's timezone before
    // the contact's, so inheriting the primary's would gate the alternate
    // on the wrong clock. Alternates go through the same structural screen
    // as the primary: an undialable one is dropped, not loaded and skipped.
    const alts = [];
    for (let n = 2; n <= 10; n++) {
      const a = toE164(extra['phone_' + n]);
      if (!a || a === phone || numberProblem(a)) continue;
      if (alts.some((x) => x.phone_e164 === a)) continue;
      alts.push({ rank: n, label: 'Ph#' + n, phone_e164: a, timezone: timezoneForNumber(a) });
    }
    if (alts.length) altsFor.set(phone, alts);

    contacts.push({
      list_id: list.id, campaign_id: campaignId, phone_e164: phone,
      first_name: first || null, last_name: last || null,
      contact_name: [first, last].filter(Boolean).join(' ') || null,
      address: at(row, 'address') || null,
      city: at(row, 'city') || null,
      state: at(row, 'state') || null,
      zip: at(row, 'zip') || null,
      email: at(row, 'email') || null,
      timezone: tz,
      phone_rank: rankForPhoneType(at(row, 'phone_type')),
      status: 'new', source_row: src, contact_fields: extra,
    });
  }

  // Batched: a single insert of thousands of rows will not survive, and any
  // Supabase call over ~1000 rows silently truncates without explicit paging.
  let done = 0;
  for (let i = 0; i < contacts.length; i += 500) {
    const { error } = await sb.from('dialer_contacts')
      .upsert(contacts.slice(i, i + 500), { onConflict: 'list_id,phone_e164', ignoreDuplicates: true });
    if (error) { say($('impMsg'), 'Stopped after ' + done + ': ' + error.message, 'err'); $('impBtn').disabled = false; return; }
    done += Math.min(500, contacts.length - i);
    say($('impMsg'), 'Imported ' + done + ' of ' + contacts.length + '...', 'ok');
  }

  // ---- the per-number rows the queue actually works ---------------------
  // dialer_next_number reads dialer_contact_phones, not dialer_contacts. A
  // contact with no rows here has no alternates the engine can reach and
  // falls back to its primary alone -- which is what every import between
  // v548 and v563 quietly produced. Rank 1 is the primary; 2..10 are the
  // Ph# columns the mapper picked up.
  //
  // Ids come from reading the list back rather than from the upsert, which
  // returns nothing under ignoreDuplicates, and re-importing the same file
  // must not create a second set of rows.
  say($('impMsg'), 'Imported ' + done + ' contacts. Building number rows...', 'ok');
  const phoneRows = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await sb.from('dialer_contacts')
      .select('id, phone_e164, timezone')
      .eq('list_id', list.id)
      .order('id')
      .range(from, from + 999);
    if (error) { say($('impMsg'), 'Contacts loaded, but number rows failed: ' + error.message, 'err'); break; }
    if (!page?.length) break;
    for (const c of page) {
      phoneRows.push({
        contact_id: c.id, rank: 1, label: 'Phone number',
        phone_e164: c.phone_e164, timezone: c.timezone, status: 'new',
      });
      for (const a of (altsFor.get(c.phone_e164) || [])) {
        phoneRows.push({ contact_id: c.id, ...a, status: 'new' });
      }
    }
    if (page.length < 1000) break;
  }

  let phonesDone = 0;
  for (let i = 0; i < phoneRows.length; i += 500) {
    const { error } = await sb.from('dialer_contact_phones')
      .upsert(phoneRows.slice(i, i + 500),
              { onConflict: 'contact_id,phone_e164', ignoreDuplicates: true });
    if (error) { say($('impMsg'), 'Number rows stopped after ' + phonesDone + ': ' + error.message, 'err'); break; }
    phonesDone += Math.min(500, phoneRows.length - i);
  }

  // v660: checked. The contacts are already in by this point, so a failure
  // here does not lose the import -- but the list stays stuck in its
  // pre-import status while the message below says it is dialable, which is
  // the kind of contradiction that sends somebody hunting for a bug in the
  // importer. Say which half actually happened.
  const { error: listErr } = await sb.from('dialer_lists').update({
    status: 'ready', loaded_rows: done, skipped_rows: bad + unusable + fake555,
  }).eq('id', list.id);
  if (listErr) {
    $('impBtn').disabled = false;
    say($('impMsg'), `Imported ${done} contacts, but the list could not be marked ready: `
      + `${listErr.message}. The contacts are loaded; the list status needs fixing before it dials.`, 'err');
    loadLists();
    return;
  }

  $('impBtn').disabled = false;
  say($('impMsg'), 'Imported ' + done + ' contacts (' + phonesDone + ' numbers incl. alternates), dialable now. '
    + bad + ' skipped (no usable phone, or a duplicate of a row already in this list)'
    + (unusable ? ', ' + unusable + ' skipped as undialable numbers (service codes, '
      + 'toll-free or placeholder digits)' : '')
    + (fake555 ? ', ' + fake555 + ' skipped as fake 555 numbers (made-up numbers that never connect)' : '')
    + (noZone ? '. ' + noZone + ' have an area code this build does not know, so they have no '
      + 'time zone and cannot be dialled until a carrier check resolves them' : '') + '.', 'ok');
  $('impCsv').value = ''; $('impName').value = ''; $('impScrubbed').checked = false;
  csvHeaders = []; csvFirstRow = []; show($('impMapWrap'), false);
  loadLists();
};


// ---------------------------------------------------------------- reports --
// Aggregates over a date range. Deliberately NOT another live-floor view --
// the Agents tab already shows who is on shift, and the Call log already
// lists individual calls. This answers what neither does: how a person or a
// campaign performed over a period.
//
// Open to reviewers as well as managers: the RPCs re-check
// role_can_review_calls() themselves (v541), so a read-only Quality user
// gets real numbers here even though every write control elsewhere on this
// page is disabled for them.
const rpPct = (v) => v == null ? '—' : (Number(v) * 100).toFixed(1) + '%';
const rpDur = (s) => {
  s = Number(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

function rpInitDates() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  [['rpAFrom', monthAgo], ['rpATo', today], ['rpCFrom', monthAgo], ['rpCTo', today]]
    .forEach(([id, v]) => { const el = $(id); if (el && !el.value) el.value = v; });
}

async function rpRunAgents() {
  const { data, error } = await sb.rpc('dialer_agent_stats', {
    from_ts: new Date($('rpAFrom').value + 'T00:00:00').toISOString(),
    to_ts: new Date($('rpATo').value + 'T23:59:59').toISOString(),
  });
  if (error) { $('rpAgentRows').innerHTML = `<tr><td colspan="9">${esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  $('rpAgentRows').innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${esc(r.agent_name || '—')}</td>
        <td class="num">${Number(r.dials).toLocaleString()}</td>
        <td class="num">${Number(r.connects).toLocaleString()}</td>
        <td class="num">${rpPct(r.answer_rate)}</td>
        <td class="num">${rpDur(r.talk_seconds)}</td>
        <td class="num">${rpDur(r.billed_seconds)}</td>
        <td class="num">${r.leads}</td>
        <td class="num">${r.manual_dials}</td>
        <td class="num">${r.unchecked_hours}</td>
      </tr>`).join('')
    : '<tr><td colspan="9">No calls in that range.</td></tr>';

  // Manual dials skip the calling-hours check by policy (v527). That choice
  // is only defensible if somebody actually looks at the result, so it is
  // surfaced here rather than left to a SQL query nobody runs.
  const unchecked = rows.reduce((a, r) => a + Number(r.unchecked_hours || 0), 0);
  const note = $('rpUnchecked');
  note.classList.toggle('hide', !unchecked);
  if (unchecked) {
    note.textContent = `${unchecked} call(s) went out without a calling-hours check — `
      + `all manual dials, where the agent judges local time instead of the system. `
      + `Worth a look if they cluster at odd hours.`;
  }
}

async function rpRunCampaigns() {
  const { data, error } = await sb.rpc('dialer_campaign_stats', {
    from_ts: new Date($('rpCFrom').value + 'T00:00:00').toISOString(),
    to_ts: new Date($('rpCTo').value + 'T23:59:59').toISOString(),
  });
  if (error) { $('rpCampRows').innerHTML = `<tr><td colspan="7">${esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  $('rpCampRows').innerHTML = rows.length
    ? rows.map((r) => {
      const d = r.dispositions || {};
      const chips = Object.keys(d).sort((a, b) => d[b] - d[a])
        .map((k) => `${esc(k)} ${d[k]}`).join(' · ') || '—';
      return `<tr>
        <td>${esc(r.campaign_name || 'Manual / no campaign')}</td>
        <td class="num">${Number(r.dials).toLocaleString()}</td>
        <td class="num">${Number(r.connects).toLocaleString()}</td>
        <td class="num">${rpPct(r.answer_rate)}</td>
        <td class="num">${r.leads}</td>
        <td class="num">${r.abandoned}</td>
        <td style="color:var(--ink2)">${chips}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="7">No calls in that range.</td></tr>';
}

if ($('rpARun')) $('rpARun').onclick = rpRunAgents;
if ($('rpCRun')) $('rpCRun').onclick = rpRunCampaigns;
rpInitDates();


// ------------------------------------------------------------------ inbox --
// v676: the floor's inbox. dialer_admin_conversations() carries the rule
// itself -- reviewers (admins, team leaders, Quality) get every conversation
// across every rep and channel, anyone else gets nothing -- so opening this
// page directly gains nobody a conversation they should not see.
let inboxPhone = null;
let inboxName = null;
let cvRows = [];
let cvActive = null;        // the row on show
let cvItems = [];           // its timeline
let cvKind = 'all';

const smsTime = (t) => new Date(t).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// A segment is 160 chars, but a single emoji drops the whole message to 70 --
// so a short-looking text can silently cost five segments. Count honestly.
const smsSegments = (t) => {
  if (!t) return 0;
  const unicode = /[^\u0000-\u007F]/.test(t);
  const per = unicode ? 70 : 160;
  return Math.ceil(t.length / per);
};
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : '');

function updateInboxBadge() {
  inboxBadge = cvRows.filter((r) => Number(r.unread) > 0).length;
  if (daGroup === 'conversations') renderInnerNav();
}

async function loadInbox() {
  const { data, error } = await sb.rpc('dialer_admin_conversations');
  if (error) { $('inboxThreads').innerHTML = `<div class="da-empty">${esc(error.message)}</div>`; return; }
  cvRows = data || [];
  floorThreadsAt = Date.now();
  const repSel = $('cvRep');
  const keep = repSel.value;
  const reps = [...new Set(cvRows.flatMap((r) => r.reps || []))].sort();
  repSel.innerHTML = '<option value="">All reps</option>'
    + reps.map((n) => `<option${n === keep ? ' selected' : ''}>${esc(n)}</option>`).join('');
  updateInboxBadge();
  renderInbox();
}

function renderInbox() {
  const q = $('cvSearch').value.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const rep = $('cvRep').value;
  const ch = $('cvChannel').value;
  const view = $('cvView').value;
  const rows = cvRows.filter((r) => {
    if (rep && !(r.reps || []).includes(rep)) return false;
    if (ch && !(r.channels || []).includes(ch)) return false;
    if (view === 'reply' && r.last_direction !== 'inbound') return false;
    if (view === 'unread' && !(Number(r.unread) > 0)) return false;
    if (view === 'nocontact' && r.contact_id) return false;
    if (q) {
      const hay = `${r.contact_name || ''} ${r.last_body || ''} ${r.campaign_name || ''}`.toLowerCase();
      const phoneHit = qDigits.length >= 3 && String(r.contact_phone || '').replace(/\D/g, '').includes(qDigits);
      if (!hay.includes(q) && !phoneHit) return false;
    }
    return true;
  });
  $('inboxMsg').textContent = `${rows.length} of ${cvRows.length}`;
  $('inboxThreads').innerHTML = rows.length ? rows.map((r) => {
    const unread = Number(r.unread) > 0;
    return `<button type="button" class="cv-item${cvActive && cvActive.phone_key === r.phone_key ? ' active' : ''}" data-k="${esc(r.phone_key)}">
      <div class="cv-top">
        <span class="cv-name">${unread ? '<span class="cv-dot"></span>' : ''}${esc(r.contact_name || r.contact_phone)}</span>
        <span class="cv-time">${r.last_at ? smsTime(r.last_at) : ''}</span>
      </div>
      <div class="cv-last">${r.last_direction === 'inbound' ? '' : '<b>Team:</b> '}${esc(r.last_body || '')}</div>
      <div class="cv-meta">
        ${(r.channels || []).map((c) => `<span class="chip">${c === 'whatsapp' ? 'WhatsApp' : c === 'email' ? 'Email' : c === 'voicemail' ? 'Voicemail' : 'SMS'}</span>`).join('')}
        ${Number(r.calls) ? `<span class="chip">${r.calls} call${Number(r.calls) === 1 ? '' : 's'}</span>` : ''}
        ${r.on_dnc ? '<span class="chip bad">DNC</span>' : ''}
        ${r.last_direction === 'inbound' ? '<span class="chip good">Needs reply</span>' : ''}
        ${(r.reps || []).length ? `<span>${esc(r.reps.join(', '))}</span>` : ''}
      </div>
    </button>`;
  }).join('') : `<div class="da-empty">${cvRows.length ? 'Nothing matches these filters.' : 'No conversations yet.'}</div>`;
  $('inboxThreads').querySelectorAll('.cv-item').forEach((b) => {
    b.onclick = () => openThread(cvRows.find((r) => r.phone_key === b.dataset.k));
  });
}
['cvRep', 'cvChannel', 'cvView'].forEach((id) => $(id).addEventListener('change', renderInbox));
$('cvSearch').addEventListener('input', renderInbox);

// The same history the agent console shows: every text, call and note for the
// contact (dialer_contact_timeline), or just the texts when the number is not a
// dialer contact.
// v747: every stored email with one address, for a thread that has no contact.
async function fetchEmailTimeline(addr) {
  const { data, error } = await sb.from('dialer_email_messages')
    .select('id, message_at, direction, subject, snippet, from_address, to_address, mailbox, provider, delivery_status, delivery_detail, is_draft, deleted_in_gmail_at, thread_id')
    .eq('contact_email', addr).order('message_at', { ascending: false }).limit(100);
  if (error) throw error;
  // v769: Gmail stores a new copy each time a draft is saved; show the latest
  // copy only -- same rule as dialer_email_hidden_draft() on the server. Rows
  // are newest first, so the first draft seen for a key is the one kept.
  const seenDraft = new Set();
  const rows = (data || []).filter((e) => {
    if (!e.is_draft) return true;
    const key = [e.mailbox, e.thread_id || '', String(e.subject || '').toLowerCase()].join('');
    if (seenDraft.has(key)) return false;
    seenDraft.add(key);
    return true;
  });
  return rows.map((e) => ({
    kind: 'email', at: e.message_at, direction: e.direction,
    title: e.subject || '(no subject)', body: e.snippet, actor: null, ref_id: e.id,
    meta: { from: e.from_address, to: e.to_address, mailbox: e.mailbox, provider: e.provider,
            delivery: e.delivery_status, delivery_detail: e.delivery_detail, draft: !!e.is_draft,
            deleted: !!e.deleted_in_gmail_at },
  }));
}

async function fetchTimeline(contactId, phone) {
  if (contactId) {
    const { data, error } = await sb.rpc('dialer_contact_timeline', { p_contact: contactId });
    if (error) throw error;
    return data || [];
  }
  // v679: not a dialer contact -- still show its calls, which is where a
  // voicemail left on a rep's own line lives. Two .eq() queries rather than
  // one .or(), because a literal '+' in an or() filter gets mangled.
  const callCols = 'id, created_at, direction, disposition, talk_seconds, answered_at, left_voicemail, recording_id, recording_path, error, agent_id';
  const [sms, outC, inC] = await Promise.all([
    sb.rpc('dialer_sms_thread', { p_phone: phone }),
    sb.from('dialer_attempts').select(callCols).eq('to_number', phone).order('created_at', { ascending: false }).limit(50),
    sb.from('dialer_attempts').select(callCols).eq('from_number', phone).order('created_at', { ascending: false }).limit(50),
  ]);
  if (sms.error) throw sms.error;
  const calls = new Map();
  [...(outC.data || []), ...(inC.data || [])].forEach((a) => calls.set(a.id, a));
  return (sms.data || []).map((m) => ({
    kind: 'sms', at: m.message_at, direction: m.direction, body: m.body,
    actor: m.agent_name, meta: { provider: m.provider } }))
    .concat([...calls.values()].map((a) => ({
      kind: 'call', at: a.created_at, direction: a.direction,
      title: a.disposition ? String(a.disposition).replace(/_/g, ' ') : (a.answered_at ? 'call' : 'no answer'),
      body: a.error || null, actor: null, ref_id: a.id,
      meta: { talk_seconds: a.talk_seconds, left_voicemail: !!a.left_voicemail,
              has_recording: !!(a.recording_id || a.recording_path), answered: !!a.answered_at } })));
}

function timelineHtml(items, kind, newestFirst) {
  const list = items.filter((i) => kind === 'all' || i.kind === kind
    || (kind === 'note' && (i.kind === 'opportunity' || i.kind === 'follow_up')))
    .sort((a, b) => (new Date(a.at) - new Date(b.at)) * (newestFirst ? -1 : 1));
  if (!list.length) return '<div class="da-empty">Nothing here yet.</div>';
  return list.map((i) => {
    const m = i.meta || {};
    const foot = `${i.at ? smsTime(i.at) : ''}${i.actor ? ' · ' + esc(i.actor) : ''}`;
    if (i.kind === 'sms') {
      const out = i.direction !== 'inbound';
      return `<div class="tl ${out ? 'out' : ''}"><div class="tl-b">
        <div class="tl-body">${esc(i.body || '')}</div>
        <div class="tl-foot">${m.provider === 'telnyx_whatsapp' ? 'WhatsApp · ' : ''}${foot}</div></div></div>`;
    }
    if (i.kind === 'email') {
      const out = i.direction !== 'inbound';
      // v746: what is actually known about delivery. Email has no delivery
      // receipt, so "Sent" means the mail server accepted it; only a bounce
      // proves it did not arrive.
      // v756e: a Gmail draft is stored too, and it was never sent.
      // v768: drafts stay listed even once Gmail drops them; a sent email the
      // rep later deleted for good in Gmail says Deleted.
      const st = m.draft ? 'draft' : out && m.deleted ? 'deleted' : out ? String(m.delivery || 'sent') : '';
      const label = st === 'draft' ? 'Draft — not sent' : st === 'deleted' ? 'Deleted in Gmail'
        : st === 'bounced' ? 'Bounced' : st === 'failed' ? 'Failed' : st ? 'Sent' : '';
      const why = st === 'draft'
        ? (m.deleted ? 'A draft that is no longer in Gmail (replaced by a newer save, sent as a new copy, or discarded). It was not sent as this message.'
          : 'Still a draft in the rep\'s Gmail. It has not been sent.')
        : st === 'deleted' ? 'This email was sent, then deleted from the rep\'s Gmail.'
        : st === 'bounced' ? (m.delivery_detail || 'A failure notice came back.')
        : st === 'failed' ? (m.delivery_detail || 'The mail server refused it.')
        : 'Accepted by the mail server. Email gives no delivery receipt; a bounce would show here.';
      const badge = label
        ? `<span class="tl-status ${esc(st)}" title="${esc(why)}">${label}</span>` : '';
      // v756e: Open shows the email itself, in full. (v747 opened the contact
      // card, which the conversation header already offers as Contact profile.)
      const open = i.ref_id
        ? `<button class="sm" data-email-open="${esc(i.ref_id)}" title="Read the whole email" style="margin-left:8px">Open</button>` : '';
      return `<div class="tl email ${out ? 'out' : ''}${st === 'draft' ? ' draft' : ''}"><div class="tl-b">
        <div>${st === 'draft' ? '📝' : '✉️'} <b>${esc(i.title || '(no subject)')}</b>${badge}${open}</div>
        ${i.body ? `<div class="tl-body">${esc(i.body)}</div>` : ''}
        <div class="tl-foot">${esc(st === 'draft' ? 'draft to ' + (m.to || '') : out ? 'to ' + (m.to || '') : 'from ' + (m.from || ''))} · ${foot}</div></div></div>`;
    }
    if (i.kind === 'call') {
      const bits = [i.direction === 'inbound' ? 'Inbound call' : 'Outbound call', i.title,
        m.talk_seconds ? fmtDur(m.talk_seconds) : '', m.left_voicemail ? 'voicemail left' : ''].filter(Boolean);
      return `<div class="tl event"><div class="tl-b">
        📞 ${esc(bits.join(' · '))}
        ${m.has_recording ? `<button class="sm" data-rec="${esc(i.ref_id)}" style="margin-left:8px">Play</button>` : ''}
        ${i.body ? `<div class="tl-body" style="color:var(--danger)">${esc(i.body)}</div>` : ''}
        <div class="tl-foot">${foot}</div></div></div>`;
    }
    return `<div class="tl event note"><div class="tl-b">
      <b>${esc(i.title || i.kind)}</b>${m.stage ? ' · ' + esc(m.stage) : ''}
      <div class="tl-body">${esc(i.body || '')}</div>
      <div class="tl-foot">${foot}</div></div></div>`;
  }).join('');
}

// v746: the delivery status of each email in the open conversation. Read here
// rather than through the timeline RPC, so the rule on who may read an email
// row (dialer_email_messages' own policy) still decides what comes back.
async function cvLoadDelivery() {
  const ids = (cvItems || []).filter((i) => i.kind === 'email' && i.ref_id).map((i) => i.ref_id);
  if (!ids.length) return false;
  const { data, error } = await sb.from('dialer_email_messages')
    .select('id, delivery_status, delivery_detail, is_draft, deleted_in_gmail_at').in('id', ids);
  if (error) { console.warn('delivery status:', error.message); return false; }
  const by = new Map((data || []).map((r) => [r.id, r]));
  let changed = false;
  cvItems.forEach((i) => {
    const r = i.kind === 'email' ? by.get(i.ref_id) : null;
    if (!r) return;
    i.meta = { ...(i.meta || {}), delivery: r.delivery_status, delivery_detail: r.delivery_detail,
               draft: !!r.is_draft, deleted: !!r.deleted_in_gmail_at };   // v756e, v768
    changed = true;
  });
  return changed;
}

// v756e: "Open" on an email shows THE EMAIL, in full -- read from Gmail at
// that moment by dialer-email-sync ('body'), which checks the caller may read
// the stored row. v747 opened the contact card here, which the conversation
// header already offers as "Contact profile".
//
// The HTML goes into a sandboxed iframe with no scripts and no same-origin
// access, so an email cannot run code in the portal. Links open in a new tab.
function wireOpenEmail(root) {
  root.querySelectorAll('[data-email-open]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); openEmailViewer(b.dataset.emailOpen); };
  });
}
function closeEmailViewer() { const v = $('daEmailView'); if (v) v.remove(); }
async function openEmailViewer(id) {
  if (!id) return;
  closeEmailViewer();
  const host = $('daHost') || document.body;
  const v = document.createElement('div');
  v.id = 'daEmailView';
  v.className = 'da-email-view';
  v.innerHTML = `<div class="da-email-card" role="dialog" aria-modal="true" aria-label="Email">
      <div class="da-drawer-head">
        <div style="min-width:0"><div class="da-drawer-title" data-ev="subject">Loading…</div>
          <div class="hint" style="margin:2px 0 0" data-ev="meta"></div></div>
        <button class="sm" data-ev="close" title="Close (Esc)">Close</button>
      </div>
      <div class="da-email-body" data-ev="body"><div class="da-empty">Loading the email…</div></div>
    </div>`;
  host.appendChild(v);
  const q = (k) => v.querySelector(`[data-ev="${k}"]`);
  q('close').onclick = closeEmailViewer;
  v.onclick = (e) => { if (e.target === v) closeEmailViewer(); };

  let r;
  try { r = await callFn('dialer-email-sync', { action: 'body', id }); }
  catch (e) { r = { ok: false, error: e?.message || String(e) }; }
  if (!v.isConnected) return;
  if (!r?.ok) {
    q('subject').textContent = 'Could not open this email';
    q('body').innerHTML = `<div class="da-empty">${esc(r?.error || 'Unknown error')}</div>`;
    return;
  }
  q('subject').textContent = r.subject || '(no subject)';
  const status = r.is_draft ? '<span class="tl-status draft">Draft — not sent</span>'
    : r.direction === 'outbound' && r.deleted ? '<span class="tl-status deleted">Deleted in Gmail</span>'   // v768
    : r.direction === 'outbound'
      ? `<span class="tl-status ${esc(r.delivery || 'sent')}">${r.delivery === 'bounced' ? 'Bounced' : r.delivery === 'failed' ? 'Failed' : 'Sent'}</span>`
      : '';
  q('meta').innerHTML = [
    r.from ? `From <b>${esc(r.from)}</b>` : '',
    r.to ? `to ${esc(r.to)}` : '',
    r.cc ? `cc ${esc(r.cc)}` : '',
    r.date ? esc(smsTime(r.date)) : '',
  ].filter(Boolean).join(' · ') + status;

  const bits = [];
  if (r.note) bits.push(`<div class="hint" style="margin:0 0 10px">${esc(r.note)}</div>`);
  if ((r.attachments || []).length) {
    bits.push(`<div class="hint" style="margin:0 0 10px">📎 ${r.attachments.map((a) => esc(a)).join(', ')}</div>`);
  }
  if (r.html) {
    bits.push('<iframe class="da-email-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Email content"></iframe>');
  } else {
    bits.push(`<div class="da-email-text">${esc(r.text || '(This email has no text.)')}</div>`);
  }
  q('body').innerHTML = bits.join('');
  const frame = q('body').querySelector('iframe');
  if (frame) {
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">'
      + '<base target="_blank"><style>body{margin:12px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;'
      + 'color:#1b1f24;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>'
      + r.html + '</body></html>';
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('daEmailView')) closeEmailViewer(); });

// v750: PRICE A MARKET BEFORE BUYING INTO IT.
//
// The old Coverage panel answers "where is my queue against what I own",
// which only works for a list already loaded. Choosing next quarter's market
// is the opposite question -- nothing is loaded yet -- so this asks Telnyx
// what is actually purchasable and prices the pool it would take.
const mpMoney = (n) => '$' + Number(n || 0).toFixed(2);

function mpRender(r) {
  const cost = r.cost_usd || {};
  const rows = (r.areas || []).map((a) => {
    const state = a.available < 1 ? '<span class="chip bad">none</span>'
                : a.available < 10 ? '<span class="chip">thin</span>'
                : '<span class="chip good">ok</span>';
    return `<tr><td class="mono">${esc(a.area_code)}</td>
      <td>${esc(a.state || '')}</td>
      <td class="num">${Number(a.available).toLocaleString()}</td>
      <td>${state}</td></tr>`;
  }).join('');

  const verdict = r.inventory_sufficient
    ? '<span class="chip good">Telnyx has enough numbers</span>'
    : '<span class="chip bad">Not enough numbers available</span>';

  $('mpOut').innerHTML = `
    <div class="fb-label" style="margin:0 0 6px">${esc(String(r.market))}</div>
    <p style="margin:0 0 10px">
      Needs <b>${r.numbers_needed}</b> numbers &mdash; set by
      <b>${esc(String(r.pool_set_by))}</b> &mdash; at
      ${r.assumptions.dials_per_day} dials a day and
      ${r.assumptions.dials_per_did_per_day} per number. ${verdict}
    </p>
    <table style="max-width:460px;margin-bottom:14px">
      <tbody>
        <tr><td>Numbers, monthly</td><td class="num">${mpMoney(cost.numbers_monthly)}</td></tr>
        <tr><td>Caller ID name (CNAM)</td><td class="num">${mpMoney(cost.cnam_monthly)}</td></tr>
        <tr><td>Texting activation</td><td class="num">${mpMoney(cost.messaging_monthly)}</td></tr>
        <tr><td><b>Total monthly</b></td><td class="num"><b>${mpMoney(cost.total_monthly)}</b></td></tr>
        <tr><td>One-off setup</td><td class="num">${mpMoney(cost.setup_once)}</td></tr>
      </tbody>
    </table>
    <div class="scroll">
      <table>
        <thead><tr><th>Area code</th><th>State</th>
          <th class="num">Available at Telnyx</th><th>Stock</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">No area codes found.</td></tr>'}</tbody>
      </table>
    </div>
    ${(r.notes || []).length
      ? '<ul class="hint" style="margin:12px 0 0;padding-left:18px">'
        + r.notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>'
      : ''}`;
}

if ($('mpRun')) $('mpRun').onclick = async () => {
  const state = ($('mpState').value || '').trim().toUpperCase();
  const areas = ($('mpAreas').value || '').split(/[^0-9]+/).filter((a) => a.length === 3);
  if (!state && !areas.length) {
    $('mpMsg').textContent = 'Enter a state or some area codes.';
    return;
  }
  $('mpRun').disabled = true;
  $('mpMsg').textContent = 'Asking Telnyx…';
  $('mpOut').innerHTML = '';
  try {
    const r = await callFn('dialer-pool', {
      action: 'market_plan',
      state: areas.length ? undefined : state,
      area_codes: areas.length ? areas : undefined,
      dials_per_day: Number($('mpDials').value) || 465,
      dials_per_did_per_day: Number($('mpCap').value) || 15,
    });
    if (!r || r.ok === false) throw new Error((r && r.error) || 'Could not price that market.');
    $('mpMsg').textContent = '';
    mpRender(r);
  } catch (e) {
    $('mpMsg').textContent = e.message;
  } finally {
    $('mpRun').disabled = false;
  }
};

function wireRecordings(root) {
  wireOpenEmail(root);   // v747
  root.querySelectorAll('[data-rec]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '…';
      const res = await callFn('dialer-recording', { attempt_id: b.dataset.rec }).catch(() => null);
      if (!res?.ok || !res.url) { b.textContent = 'No recording'; return; }
      const audio = document.createElement('audio');
      audio.controls = true; audio.autoplay = true; audio.src = res.url;
      audio.style.cssText = 'display:block;height:34px;margin-top:6px;max-width:100%';
      b.replaceWith(audio);
    };
  });
}

function renderThread() {
  $('inboxThread').innerHTML = timelineHtml(cvItems, cvKind, false);
  wireRecordings($('inboxThread'));
  const wrap = $('inboxThreadWrap');
  wrap.scrollTop = wrap.scrollHeight;   // newest at the bottom, like any chat
  // v746: delivery status arrives a moment later and repaints, so the thread
  // is never held up waiting for it.
  cvLoadDelivery().then((changed) => {
    if (!changed) return;
    $('inboxThread').innerHTML = timelineHtml(cvItems, cvKind, false);
    wireRecordings($('inboxThread'));
  });
}
$('cvTabs').querySelectorAll('[data-cv]').forEach((b) => {
  b.onclick = () => {
    cvKind = b.dataset.cv;
    $('cvTabs').querySelectorAll('[data-cv]').forEach((x) => x.classList.toggle('active', x === b));
    renderThread();
  };
});

async function openThread(row) {
  if (!row) return;
  cvActive = row;
  // v747: a thread keyed 'email:<address>' is email with somebody who is not a
  // contact. It has no number, so texting, dialling and mark-as-read are off
  // until "Add as contact" gives it one.
  const emailOnly = String(row.phone_key || '').startsWith('email:');
  const onlyAddr = emailOnly ? row.phone_key.slice(6) : null;
  inboxPhone = row.contact_phone;
  inboxName = row.contact_name || null;
  renderInbox();
  $('cvHead').innerHTML = `<div style="min-width:0">
      <div class="da-drawer-title">${esc(row.contact_name || row.contact_phone)}</div>
      <div class="hint" style="margin:2px 0 0">${emailOnly
        ? `<span class="mono">${esc(onlyAddr)}</span> · email only`
        : `<span class="mono">${esc(row.contact_phone)}</span>`}
        ${row.campaign_name ? ' · ' + esc(row.campaign_name) : ''}
        ${(row.reps || []).length ? ' · worked by ' + esc(row.reps.join(', ')) : ''}</div>
    </div>
    <div class="btn-row">
      ${row.on_dnc ? '<span class="chip bad">Do not call</span>' : ''}
      ${row.contact_id ? '<button class="sm" id="cvProfile">Contact profile</button>'
        : emailOnly ? '<span class="chip">No contact yet</span><button class="sm" id="cvAddContact">Add as contact</button>'
        : '<span class="chip">Not a dialer contact</span>'}
    </div>`;
  if ($('cvProfile')) $('cvProfile').onclick = () => openContactDrawer(row.contact_id);
  // v747: one click to make them a contact -- a mobile number is what turns on
  // calls, texts, WhatsApp and appointments. The stored emails attach
  // themselves to the new contact on the next email sync.
  if ($('cvAddContact')) $('cvAddContact').onclick = async () => {
    await showSection('conversations/contacts');
    show($('ctAddWrap'), true);
    $('ctAEmail').value = onlyAddr;
    const guess = onlyAddr.split('@')[0].replace(/[._+-]+/g, ' ').replace(/\d+/g, '').trim().split(/\s+/).filter(Boolean);
    const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : '');
    $('ctAFirst').value = cap(guess[0] || '');
    $('ctALast').value = cap(guess[1] || '');
    $('ctMsg').textContent = 'Add their mobile number to finish. That is what turns on calls, texts, WhatsApp and appointments; the emails already stored attach to them within a few minutes.';
    $('ctAPhone').focus();
  };
  show($('cvTabs'), true);
  $('inboxThread').innerHTML = '<div class="da-empty">Loading…</div>';
  try {
    cvItems = emailOnly ? await fetchEmailTimeline(onlyAddr) : await fetchTimeline(row.contact_id, row.contact_phone);
  } catch (e) {
    $('inboxThread').innerHTML = `<div class="da-empty">${esc(e.message)}</div>`;
    return;
  }
  if (cvActive !== row) return;          // they clicked on while it loaded
  renderThread();
  // Opening a thread is reading it. An email-only thread has no phone to mark.
  if (Number(row.unread) > 0 && !emailOnly) {
    sb.rpc('dialer_mark_thread_read', { p_phone: row.contact_phone }).then(() => {
      row.unread = 0; updateInboxBadge(); renderInbox();
    });
  }
  cvContactEmail = emailOnly ? onlyAddr : null;
  if (row.contact_id) {
    const { data: c } = await sb.from('dialer_contacts').select('email').eq('id', row.contact_id).maybeSingle();
    cvContactEmail = c && /@/.test(c.email || '') ? c.email : null;
  }
  // v747: no number, so email is the only channel here.
  const smsOpt = $('cvReplyChannel').querySelector('option[value="sms"]');
  if (smsOpt) smsOpt.disabled = emailOnly;
  if (emailOnly) $('cvReplyChannel').value = 'email';
  if (cvActive !== row) return;
  const emailOpt = $('cvReplyChannel').querySelector('option[value="email"]');
  emailOpt.disabled = !cvContactEmail;
  emailOpt.textContent = cvContactEmail ? `Reply by email (${cvContactEmail})` : 'Reply by email (no address on file)';
  // Default to whichever channel the conversation last used.
  const lastEmail = [...cvItems].filter((x) => x.kind === 'email' || x.kind === 'sms')
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  $('cvReplyChannel').value = cvContactEmail && lastEmail && lastEmail.kind === 'email' ? 'email' : 'sms';
  if ($('cvReplyChannel').value === 'email' && lastEmail) {
    const t = lastEmail.title || '';
    $('cvSubject').value = /^re:/i.test(t) ? t : (t ? 'Re: ' + t : '');
  } else {
    $('cvSubject').value = '';
  }
  applyReplyChannel();
}

let cvContactEmail = null;
// v744: an email from this screen goes from the sender's own Gmail (the
// default) or the shared mailbox -- the same choice the dialer's email window
// offers. dialer-conversations checks it again and sends over SMTP for shared.
let cvShared;   // { address, name } | null, read once from dialer_settings
async function cvFillFrom() {
  if (cvShared === undefined) {
    const { data } = await sb.from('dialer_settings').select('value').eq('key', 'shared_email').maybeSingle();
    const v = data && data.value;
    cvShared = v && v.from_address ? { address: String(v.from_address), name: String(v.from_name || '') } : null;
  }
  const sel = $('cvReplyFrom');
  const keep = sel.value;
  sel.innerHTML = '<option value="rep">From my Gmail</option>'
    + (cvShared ? `<option value="shared">From ${esc(cvShared.address)}</option>` : '');
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function applyReplyChannel() {
  const row = cvActive;
  const email = $('cvReplyChannel').value === 'email';
  show($('cvSubject'), email);
  show($('cvReplyFrom'), email);   // v744
  const blocked = !row || !canManage || (!email && row.on_dnc) || (email && !cvContactEmail);
  $('inboxBody').disabled = blocked;
  $('inboxSend').disabled = blocked;
  $('inboxBody').placeholder = !row ? 'Pick a conversation.'
    : !canManage ? 'View only — your role cannot send from here.'
    : email ? (cvContactEmail
        ? ($('cvReplyFrom').value === 'shared'
            ? `Write an email… it goes from ${(cvShared && cvShared.address) || 'the shared mailbox'}.`
            : 'Write an email… it goes from your own connected Gmail.')
        : 'This contact has no email address.')
    : row.on_dnc ? 'This number is on do-not-call and cannot be texted.' : 'Reply by SMS…';
}
$('cvReplyChannel').addEventListener('change', applyReplyChannel);
$('cvReplyFrom').addEventListener('change', applyReplyChannel);   // v744

$('inboxBody').addEventListener('input', () => {
  const t = $('inboxBody').value;
  const seg = smsSegments(t);
  $('inboxLen').textContent = t
    ? `${t.length} characters · ${seg} segment${seg === 1 ? '' : 's'}`
      + (/[^\u0000-\u007F]/.test(t) ? ' (non-ASCII — 70 chars per segment)' : '')
    : '';
});

$('inboxSend').onclick = async () => {
  const text = $('inboxBody').value.trim();
  const byEmail = $('cvReplyChannel').value === 'email';
  if (!text || !canManage) return;
  if (!byEmail && !inboxPhone) return;   // v747: no number on an email-only thread
  $('inboxSend').disabled = true;
  if (byEmail) {
    // v677: sent AS the signed-in person from their own Gmail (the address is
    // resolved server-side from the contact), then pulled into the store so it
    // shows in the thread straight away.
    const subject = $('cvSubject').value.trim();
    if (!subject) { $('inboxSend').disabled = false; $('inboxLen').textContent = 'Add a subject.'; return; }
    const r = await callFn('dialer-conversations', {
      action: 'send_email', subject, body: text,
      contact_id: cvActive.contact_id || undefined,          // v747
      to_email: cvActive.contact_id ? undefined : cvContactEmail,
      sender: $('cvReplyFrom').value || 'rep',   // v744
    });
    $('inboxSend').disabled = false;
    if (!r?.ok) { $('inboxLen').textContent = r?.error || 'Email not sent.'; return; }
    $('inboxLen').textContent = `Email sent from ${r.from || 'your Gmail'}.`;
    await callFn('dialer-email-sync', { action: 'sync' }).catch(() => null);
  } else {
  const r = await callFn('dialer-sms', {
    action: 'send', to: inboxPhone, body: text, name: inboxName || undefined,
  });
  $('inboxSend').disabled = false;
  if (!r?.ok) { $('inboxLen').textContent = r?.error || 'Send failed'; return; }
  if (!r.sent) { $('inboxLen').textContent = r.detail || 'Not sent.'; return; }
  }
  $('inboxBody').value = '';
  if (!byEmail) $('inboxLen').textContent = '';
  // Re-read rather than appending optimistically: dialer-sms writes the row
  // itself, so the thread is the source of truth.
  const row = cvActive;
  await loadInbox();
  openThread(cvRows.find((x) => x.phone_key === row.phone_key) || row);
};

// v677: email arrives by dialer-email-sync every 5 minutes; this pulls now.
async function loadEmailStatus() {
  cvFillFrom();   // v744: fill the "From" picker while the status loads
  const r = await callFn('dialer-email-sync', { action: 'status' }).catch(() => null);
  if (!r?.ok) { $('cvEmailStatus').textContent = ''; return; }
  const readable = (r.mailboxes || []).filter((m) => m.can_read);
  const sendOnly = (r.mailboxes || []).filter((m) => !m.can_read);
  $('cvEmailStatus').textContent = `Email from ${readable.length} connected Gmail${readable.length === 1 ? '' : 's'}`
    + (r.shared_configured ? ' and the shared inbox' : '')
    + (sendOnly.length ? ` · ${sendOnly.map((m) => m.owner || m.address).join(', ')} connected for sending only (reconnect to show their email)` : '');
}
$('cvSyncEmail').onclick = async () => {
  $('cvSyncEmail').disabled = true;
  $('cvSyncEmail').textContent = 'Syncing…';
  const r = await callFn('dialer-email-sync', { action: 'sync' }).catch(() => null);
  $('cvSyncEmail').disabled = false;
  $('cvSyncEmail').textContent = 'Sync email';
  const stored = (r?.results || []).reduce((n, x) => n + (Number(x.stored) || 0), 0);
  const errs = (r?.results || []).filter((x) => x.error).map((x) => `${x.mailbox}: ${x.error}`);
  $('inboxMsg').textContent = r?.ok ? `${stored} new email${stored === 1 ? '' : 's'}` : (r?.error || 'Sync failed');
  if (errs.length) $('cvEmailStatus').textContent = errs.join(' · ');
  const k = cvActive && cvActive.phone_key;
  await loadInbox();
  if (k) openThread(cvRows.find((x) => x.phone_key === k));
};

$('inboxRefresh').onclick = async () => {
  const k = cvActive && cvActive.phone_key;
  await loadInbox();
  if (k) openThread(cvRows.find((x) => x.phone_key === k));
};

// --------------------------------------------------------------- contacts --
// v676. Server-side search and paging: the table is every contact on every
// list, which is fine at hundreds and would not be at hundreds of thousands.
const CT_PAGE = 50;
let ctOffset = 0;
let ctTotal = 0;
let ctPageRows = [];
let ctLists = [];
let ctDispo = {};
let ctInit = false;
const ctSelected = new Set();
let ctSearchTimer = null;

async function initContacts() {
  if (!ctInit) {
    ctInit = true;
    const [lists, dispos] = await Promise.all([
      sb.from('dialer_lists').select('id, name, campaign_id').order('created_at', { ascending: false }).limit(500),
      sb.from('dialer_dispositions').select('code, label'),
    ]);
    ctLists = lists.data || [];
    (dispos.data || []).forEach((d) => { ctDispo[d.code] = d.label; });
    const campOpts = campaigns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('ctCampaign').innerHTML = '<option value="">All campaigns</option>' + campOpts;
    $('ctACampaign').innerHTML = '<option value="">No campaign</option>' + campOpts;
    fillCtLists();
  }
  loadContacts();
}
function fillCtLists() {
  const camp = $('ctCampaign').value;
  $('ctList').innerHTML = '<option value="">All lists</option>' + ctLists
    .filter((l) => !camp || l.campaign_id === camp)
    .map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
}

function contactsQuery(select, opts) {
  let q = sb.from('dialer_contacts').select(select, opts);
  const term = $('ctSearch').value.trim().replace(/[,()*%\\]/g, ' ').trim();
  if (term) {
    const digits = term.replace(/\D/g, '');
    // v691: name, number or email -- not the address.
    const parts = [`contact_name.ilike.*${term}*`, `first_name.ilike.*${term}*`, `last_name.ilike.*${term}*`, `email.ilike.*${term}*`];
    if (digits.length >= 3) parts.push(`phone_e164.ilike.*${digits}*`);
    q = q.or(parts.join(','));
  }
  if ($('ctCampaign').value) q = q.eq('campaign_id', $('ctCampaign').value);
  if ($('ctList').value) q = q.eq('list_id', $('ctList').value);
  if ($('ctStatus').value) q = q.eq('status', $('ctStatus').value);
  return q;
}

const ctName = (c) => c.contact_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
const ctWhen = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const ctPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '—');
};
const ctStatusTag = (c) => {
  const cls = c.status === 'retired' || c.status === 'suppressed' || c.status === 'invalid' ? 't-retired'
    : c.status === 'queued' ? 't-resting' : 't-active';
  return `<span class="tag ${cls}">${esc(c.status)}${c.retired_reason ? ' · ' + esc(c.retired_reason.replace(/_/g, ' ')) : ''}</span>`;
};

async function loadContacts() {
  $('ctRows').innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
  const { data, error, count } = await contactsQuery(
    'id, contact_name, first_name, last_name, phone_e164, address, city, state, status, retired_reason, attempt_count, last_outcome, next_attempt_at, campaign_id, list_id',
    { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(ctOffset, ctOffset + CT_PAGE - 1);
  if (error) { $('ctRows').innerHTML = `<tr><td colspan="9">${esc(error.message)}</td></tr>`; return; }
  ctPageRows = data || [];
  ctTotal = count || 0;
  const campName = {}; campaigns.forEach((c) => { campName[c.id] = c.name; });
  const listName = {}; ctLists.forEach((l) => { listName[l.id] = l.name; });
  $('ctCount').textContent = `${ctTotal.toLocaleString()} contact${ctTotal === 1 ? '' : 's'}`;
  $('ctRows').innerHTML = ctPageRows.length ? ctPageRows.map((c) => `<tr class="ct-row" data-id="${c.id}">
      <td data-nosel><input type="checkbox" data-sel="${c.id}"${ctSelected.has(c.id) ? ' checked' : ''} aria-label="Select"></td>
      <td><b>${esc(ctName(c))}</b></td>
      <td class="mono">${esc(ctPhone(c.phone_e164))}</td>
      <td>${esc([c.address, c.city, c.state].filter(Boolean).join(', ') || '—')}</td>
      <td>${esc(campName[c.campaign_id] || '—')}${c.list_id && listName[c.list_id] ? `<div class="hint" style="margin:0">${esc(listName[c.list_id])}</div>` : ''}</td>
      <td>${ctStatusTag(c)}</td>
      <td class="num">${c.attempt_count || 0}</td>
      <td>${esc(ctDispo[c.last_outcome] || (c.last_outcome || '—').replace(/_/g, ' '))}</td>
      <td>${c.status === 'retired' ? '—' : ctWhen(c.next_attempt_at)}</td>
    </tr>`).join('') : '<tr><td colspan="9">No contacts match.</td></tr>';
  $('ctRows').querySelectorAll('tr.ct-row').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('[data-nosel]')) return;
      openContactDrawer(tr.dataset.id);
    };
  });
  $('ctRows').querySelectorAll('[data-sel]').forEach((cb) => {
    cb.onchange = () => { cb.checked ? ctSelected.add(cb.dataset.sel) : ctSelected.delete(cb.dataset.sel); ctSelChanged(); };
  });
  $('ctAll').checked = ctPageRows.length > 0 && ctPageRows.every((c) => ctSelected.has(c.id));
  const last = Math.min(ctOffset + CT_PAGE, ctTotal);
  $('ctPage').textContent = ctTotal ? `${ctOffset + 1}–${last} of ${ctTotal.toLocaleString()}` : '';
  $('ctPrev').disabled = ctOffset === 0;
  $('ctNext').disabled = last >= ctTotal;
  ctSelChanged();
}
function ctSelChanged() {
  $('ctRequeueSel').textContent = ctSelected.size ? `Requeue selected (${ctSelected.size})` : 'Requeue selected';
  $('ctRequeueSel').disabled = !canManage || !ctSelected.size;
}
function ctReload() { ctOffset = 0; loadContacts(); }
$('ctSearch').addEventListener('input', () => { clearTimeout(ctSearchTimer); ctSearchTimer = setTimeout(ctReload, 300); });
$('ctCampaign').addEventListener('change', () => { fillCtLists(); ctReload(); });
$('ctList').addEventListener('change', ctReload);
$('ctStatus').addEventListener('change', ctReload);
$('ctPrev').onclick = () => { ctOffset = Math.max(0, ctOffset - CT_PAGE); loadContacts(); };
$('ctNext').onclick = () => { ctOffset += CT_PAGE; loadContacts(); };
$('ctAll').onchange = () => {
  ctPageRows.forEach((c) => ($('ctAll').checked ? ctSelected.add(c.id) : ctSelected.delete(c.id)));
  loadContacts();
};

$('ctRequeueSel').onclick = async () => {
  if (!canManage || !ctSelected.size) return;
  if (!confirm(`Put ${ctSelected.size} contact${ctSelected.size === 1 ? '' : 's'} back in the queue as new? Their retry cadence starts over. Numbers on do-not-call are skipped.`)) return;
  const { data, error } = await sb.rpc('dialer_admin_requeue', { p_contacts: [...ctSelected] });
  if (error) { $('ctMsg').textContent = error.message; return; }
  const r = (data || [])[0] || {};
  $('ctMsg').textContent = `Requeued ${r.requeued || 0}${r.skipped_dnc ? ` · ${r.skipped_dnc} skipped (do-not-call)` : ''}.`;
  ctSelected.clear();
  loadContacts();
};

$('ctExport').onclick = async () => {
  $('ctMsg').textContent = 'Preparing export…';
  const { data, error } = await contactsQuery(
    'contact_name, first_name, last_name, phone_e164, email, address, city, state, zip, status, retired_reason, attempt_count, last_outcome, last_attempt_at, next_attempt_at, campaign_id, list_id, created_at')
    .order('updated_at', { ascending: false }).limit(10000);
  if (error) { $('ctMsg').textContent = error.message; return; }
  const campName = {}; campaigns.forEach((c) => { campName[c.id] = c.name; });
  const listName = {}; ctLists.forEach((l) => { listName[l.id] = l.name; });
  const cols = ['Name', 'Phone', 'Email', 'Address', 'City', 'State', 'Zip', 'Campaign', 'List', 'Status',
    'Retired reason', 'Attempts', 'Last outcome', 'Last attempt', 'Next attempt', 'Created'];
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(',')].concat((data || []).map((c) => [ctName(c), c.phone_e164, c.email, c.address, c.city, c.state, c.zip,
    campName[c.campaign_id] || '', listName[c.list_id] || '', c.status, c.retired_reason,
    c.attempt_count, ctDispo[c.last_outcome] || c.last_outcome, c.last_attempt_at, c.next_attempt_at, c.created_at].map(cell).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dialer-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('ctMsg').textContent = `Exported ${(data || []).length.toLocaleString()} contacts.`;
};

$('ctAdd').onclick = () => show($('ctAddWrap'), $('ctAddWrap').classList.contains('hide'));
$('ctASave').onclick = async () => {
  if (!canManage) return;
  const first = $('ctAFirst').value.trim();
  const last = $('ctALast').value.trim();
  const phone = toE164($('ctAPhone').value);
  // Only the phone is required here, matching the list upload: every
  // dialer_field_defs entry except the number is optional (owner's rule,
  // 2026-09-16). A contact can be nothing but a number -- ctName() already
  // renders a blank one as an em dash.
  if (!phone) { $('ctMsg').textContent = 'A valid phone is required — 10 digits for US, or with the country code.'; return; }
  const { data: existing } = await sb.from('dialer_contacts').select('id, contact_name').eq('phone_e164', phone).limit(1);
  if (existing && existing.length) {
    $('ctMsg').textContent = `That number is already ${existing[0].contact_name || 'on another contact'}.`;
    openContactDrawer(existing[0].id);
    return;
  }
  $('ctASave').disabled = true;
  const { data, error } = await sb.from('dialer_contacts').insert({
    first_name: first || null, last_name: last || null,
    contact_name: [first, last].filter(Boolean).join(' ') || null,
    phone_e164: phone,
    email: $('ctAEmail').value.trim() || null,
    address: $('ctAAddr').value.trim() || null,
    city: $('ctACity').value.trim() || null,
    state: $('ctAState').value.trim().toUpperCase() || null,
    zip: $('ctAZip').value.trim() || null,
    campaign_id: $('ctACampaign').value || null,
    created_by: meId, status: 'new',
  }).select('id').maybeSingle();
  $('ctASave').disabled = false;
  if (error) { $('ctMsg').textContent = error.code === '42501' ? 'Your role cannot add contacts.' : 'Could not add it: ' + error.message; return; }
  ['ctAFirst', 'ctALast', 'ctAPhone', 'ctAEmail', 'ctAAddr', 'ctACity', 'ctAState', 'ctAZip'].forEach((id) => { $(id).value = ''; });
  show($('ctAddWrap'), false);
  $('ctMsg').textContent = 'Contact added.';
  ctReload();
  if (data?.id) openContactDrawer(data.id);
};

// ---------------------------------------------------- contact drawer --
let cdContact = null;
function closeContactDrawer() { show($('ctDrawer'), false); cdContact = null; }
$('cdClose').onclick = closeContactDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cdContact) closeContactDrawer(); });

async function openContactDrawer(id) {
  if (!id) return;
  show($('ctDrawer'), true);
  $('cdName').textContent = 'Loading…';
  $('cdSub').textContent = '';
  $('cdFacts').innerHTML = ''; $('cdPhones').innerHTML = ''; $('cdTimeline').innerHTML = ''; $('cdActMsg').textContent = '';
  const [c, phones, items] = await Promise.all([
    sb.from('dialer_contacts').select('*').eq('id', id).maybeSingle(),
    sb.from('dialer_contact_phones').select('rank, label, phone_e164, status, attempt_count, last_outcome, phone_line_type').eq('contact_id', id).order('rank'),
    fetchTimeline(id, null).catch((e) => ({ error: e })),
  ]);
  if (c.error || !c.data) { $('cdName').textContent = c.error ? c.error.message : 'Contact not found.'; return; }
  cdContact = c.data;
  const k = cdContact;
  if (!ctInit) {
    const d = await sb.from('dialer_dispositions').select('code, label');
    (d.data || []).forEach((x) => { ctDispo[x.code] = x.label; });
  }
  const camp = campaigns.find((x) => x.id === k.campaign_id);
  $('cdName').textContent = ctName(k);
  $('cdSub').innerHTML = `<span class="mono">${esc(ctPhone(k.phone_e164))}</span>${camp ? ' · ' + esc(camp.name) : ''}`;
  const fact = (label, v) => `<div><span>${label}</span>${v}</div>`;
  $('cdFacts').innerHTML = [
    fact('Status', ctStatusTag(k)),
    fact('Attempts', esc(k.attempt_count || 0)),
    fact('Last outcome', esc(ctDispo[k.last_outcome] || (k.last_outcome || '—').replace(/_/g, ' '))),
    fact('Last call', esc(ctWhen(k.last_attempt_at))),
    fact('Next attempt', esc(k.status === 'retired' ? '—' : ctWhen(k.next_attempt_at))),
    fact('Email', esc(k.email || '—')),
    fact('Property', esc([k.address, k.city, k.state, k.zip].filter(Boolean).join(', ') || '—')),
    fact('Added', esc(ctWhen(k.created_at))),
  ].join('');
  const ph = phones.data || [];
  $('cdPhones').innerHTML = ph.length ? `<div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Number</th><th>Type</th><th>Status</th><th class="num">Tries</th><th>Last</th></tr></thead>
      <tbody>${ph.map((p) => `<tr><td>${p.rank ?? ''}</td><td class="mono">${esc(ctPhone(p.phone_e164))}</td>
        <td>${esc(p.phone_line_type || p.label || '—')}</td><td>${esc(p.status || '—')}</td>
        <td class="num">${p.attempt_count || 0}</td><td>${esc(ctDispo[p.last_outcome] || p.last_outcome || '—')}</td></tr>`).join('')}</tbody>
    </table></div>` : `<div class="hint" style="margin:0">Only the main number: <span class="mono">${esc(ctPhone(k.phone_e164))}</span></div>`;
  if (items && items.error) {
    $('cdTimeline').innerHTML = `<div class="da-empty">${esc(items.error.message)}</div>`;
  } else {
    $('cdTimeline').innerHTML = timelineHtml(items, 'all', true);
    wireRecordings($('cdTimeline'));
  }
  $('cdRequeue').disabled = !canManage;
  $('cdRetire').disabled = !canManage || k.status === 'retired';
  $('cdNoteSave').disabled = !canManage;
  $('cdNote').disabled = !canManage;
  const convo = cvRows.find((r) => r.contact_id === k.id)
    || cvRows.find((r) => r.phone_key === String(k.phone_e164 || '').replace(/\D/g, '').slice(-10));
  show($('cdOpenConvo'), !!convo && daPane !== 'inbox');
  $('cdOpenConvo').onclick = async () => {
    closeContactDrawer();
    await showSection('conversations/inbox');
    const row = cvRows.find((r) => r.phone_key === convo.phone_key);
    if (row) openThread(row);
  };
}

$('cdRequeue').onclick = async () => {
  if (!cdContact || !canManage) return;
  const { data, error } = await sb.rpc('dialer_admin_requeue', { p_contacts: [cdContact.id] });
  if (error) { $('cdActMsg').textContent = error.message; return; }
  const r = (data || [])[0] || {};
  const id = cdContact.id;
  await openContactDrawer(id);
  $('cdActMsg').textContent = r.requeued ? 'Back in the queue as new.' : 'Not requeued: the number is on do-not-call.';
  if (daPane === 'contacts') loadContacts();
};
$('cdRetire').onclick = async () => {
  if (!cdContact || !canManage) return;
  if (!confirm('Retire this contact? The dialer stops serving it until someone requeues it.')) return;
  const { error } = await sb.from('dialer_contacts')
    .update({ status: 'retired', retired_reason: 'retired_by_manager', next_attempt_at: null, claimed_by: null, claimed_at: null })
    .eq('id', cdContact.id);
  if (error) { $('cdActMsg').textContent = error.message; return; }
  const id = cdContact.id;
  await openContactDrawer(id);
  $('cdActMsg').textContent = 'Retired.';
  if (daPane === 'contacts') loadContacts();
};
$('cdNoteSave').onclick = async () => {
  const body = $('cdNote').value.trim();
  if (!cdContact || !body || !canManage) return;
  $('cdNoteSave').disabled = true;
  const { error } = await sb.from('dialer_contact_notes').insert({ contact_id: cdContact.id, author_id: meId, body });
  $('cdNoteSave').disabled = false;
  if (error) { $('cdActMsg').textContent = error.message; return; }
  $('cdNote').value = '';
  const id = cdContact.id;
  await openContactDrawer(id);
  $('cdActMsg').textContent = 'Note added.';
};


// ------------------------------------------------------ v677: change history --
const HS_AREAS = {
  dialer_campaigns: 'Campaigns', dialer_dispositions: 'Wrap-up outcomes', dialer_campaign_dispositions: 'Campaign outcomes',
  dialer_disposition_actions: 'Outcome messages (legacy)', dialer_outcome_rules: 'Outcome rules', dialer_message_templates: 'Message templates',
  dialer_settings: 'Hand-offs & settings', dialer_inbound_queues: 'Inbound queues', dialer_queue_agents: 'Queue agents',
  dialer_campaign_agents: 'Campaign agents', dialer_agent_statuses: 'Agent statuses', dialer_calendars: 'Booking availability',
  dialer_dids: 'Numbers', dialer_role_access: 'Console access', dialer_field_defs: 'List fields',
};
const HS_PAGE = 100;
let hsInit = false;
let hsOffset = 0;
let hsNames = {};
let hsLabels = {};

async function initHistory() {
  if (!hsInit) {
    hsInit = true;
    $('hsArea').innerHTML = '<option value="">Every area</option>' + Object.entries(HS_AREAS)
      .sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    const [people, queues, dispos] = await Promise.all([
      sb.from('profiles').select('id, full_name'),
      sb.from('dialer_inbound_queues').select('id, name'),
      sb.from('dialer_dispositions').select('id, code, label'),
    ]);
    (people.data || []).forEach((p) => { hsNames[p.id] = p.full_name || p.id.slice(0, 8); });
    campaigns.forEach((c) => { hsLabels[c.id] = c.name; });
    (queues.data || []).forEach((q) => { hsLabels[q.id] = q.name; });
    (dispos.data || []).forEach((d) => { hsLabels[d.id] = d.label || d.code; });
    Object.entries(hsNames).forEach(([id, n]) => { hsLabels[id] = n; });
    $('hsWho').innerHTML = '<option value="">Anyone</option>' + Object.entries(hsNames)
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
  }
  hsOffset = 0;
  loadHistory(false);
}

function hsValue(v) {
  if (v === null || v === undefined) return '<i>empty</i>';
  if (typeof v === 'string' && hsLabels[v]) return esc(hsLabels[v]);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return esc(s.length > 90 ? s.slice(0, 90) + '…' : s);
}

async function loadHistory(append) {
  const since = new Date(Date.now() - Number($('hsDays').value) * 86400000).toISOString();
  let q = sb.from('dialer_settings_audit').select('*', { count: 'exact' })
    .gte('at', since).order('at', { ascending: false }).range(hsOffset, hsOffset + HS_PAGE - 1);
  if ($('hsArea').value) q = q.eq('table_name', $('hsArea').value);
  if ($('hsWho').value) q = q.eq('actor_id', $('hsWho').value);
  else if (!$('hsSystem').checked) q = q.not('actor_id', 'is', null);
  if (!append) $('hsRows').innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  const { data, error, count } = await q;
  if (error) { $('hsRows').innerHTML = `<tr><td colspan="5">${esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  const html = rows.map((r) => {
    const ch = r.changes || {};
    const keys = Object.keys(ch);
    const body = r.action === 'update'
      ? keys.map((k) => `<div><b>${esc(k.replace(/_/g, ' '))}</b> <span class="hs-old">${hsValue(ch[k][0])}</span> → <span class="hs-new">${hsValue(ch[k][1])}</span></div>`).join('')
      : `<div>${r.action === 'insert' ? 'Created' : 'Deleted'}${keys.length ? ` — <span class="hint" style="margin:0">${esc(keys.slice(0, 6).join(', '))}${keys.length > 6 ? '…' : ''}</span>` : ''}</div>`;
    const item = r.row_label || (r.row_key || '').split('|').map((x) => hsLabels[x] || x.slice(0, 8)).join(' · ');
    return `<tr>
      <td style="white-space:nowrap">${esc(new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
      <td>${r.actor_id ? esc(hsNames[r.actor_id] || r.actor_id.slice(0, 8)) : '<span class="hint" style="margin:0">Automatic</span>'}</td>
      <td>${esc(HS_AREAS[r.table_name] || r.table_name)}</td>
      <td>${esc(item || '—')}</td>
      <td class="hs-change">${body}</td>
    </tr>`;
  }).join('');
  if (append) $('hsRows').insertAdjacentHTML('beforeend', html);
  else $('hsRows').innerHTML = html || '<tr><td colspan="5">No changes in this period.</td></tr>';
  hsOffset += rows.length;
  $('hsCount').textContent = `${(count || 0).toLocaleString()} change${count === 1 ? '' : 's'}`;
  show($('hsMore'), hsOffset < (count || 0));
}
['hsArea', 'hsWho', 'hsDays', 'hsSystem'].forEach((id) => $(id).addEventListener('change', () => { hsOffset = 0; loadHistory(false); }));
$('hsRefresh').onclick = () => { hsOffset = 0; loadHistory(false); };
$('hsMore').onclick = () => loadHistory(true);

window.DialerAdmin = { showSection };
})();
