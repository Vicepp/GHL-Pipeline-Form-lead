#!/usr/bin/env node
/* Pheenyx Capital - Pipeline Workflow
   tools/calendly-sync.js
   ------------------------------------------------------------------
   Pulls everything Calendly knows about our meetings - every booking,
   who booked it and what they answered, cancellations, reschedules,
   no-shows, and the Notetaker recap + full transcript of each recorded
   call - and publishes it to Firestore for the Calendly page (#/calendly).

       node tools/calendly-sync.js            full pull (daily)
       node tools/calendly-sync.js --recent   light run: last 14 days + everything upcoming
       node tools/calendly-sync.js --upload   just republish what is archived

   Reads .env.local:
       CALENDLY_TOKEN                          (personal access token)
   and for the upload, either tools/service-account.json or the
   FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY pair.

   THE ARCHIVE. Calendly only serves about a year of history. Nothing this
   script has ever seen is dropped: tools/.calendly-cache/archive.json keeps
   every booking, invitee and recap, and transcripts/<id>.txt every
   transcript, whether or not Calendly still has them. A booking Calendly no
   longer returns is kept and marked `gone`. Firestore holds the same data,
   so if this folder is ever lost the next run rebuilds it from there before
   touching Calendly - the archive survives a new computer.

   What lands in Firestore:
     calendlyAnalytics (team may read)
       meta               counts, sync time, users, event types, chunk names
       events_<v>_N       bookings (JSON)
       invitees_<v>_N     who booked: answers, UTM, cancel, no-show, reschedule
       recaps_<v>_N       Notetaker recaps of calls with anyone outside the team
       tr_<recapId>       one transcript each (loaded only when opened)
     calendlyPrivate (owner + CALENDLY_LEADERS in firestore.rules only)
       meta, recaps_<v>_N, tr_<recapId>
                          internal meetings - every attendee is @phcinvest.com
                          (check-ins, standups, bonus talks). Kept out of the
                          team-wide collection on purpose.                     */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.calendly-cache');
const ARCHIVE = path.join(CACHE, 'archive.json');
const TR_DIR = path.join(CACHE, 'transcripts');
const API = 'https://api.calendly.com';
const COLL = 'calendlyAnalytics';
const PRIV = 'calendlyPrivate';
const TEAM_DOMAIN = 'phcinvest.com';
const RECENT_DAYS = 14;          /* --recent re-reads bookings from this far back, plus all upcoming */
const INVITEE_STALE_MS = 50 * 60e3;   /* a recent booking's invitees are re-read at most hourly-ish */
const WORKERS = 6;               /* Calendly allows 500 calls a minute */
const TR_MAX = 900000;           /* Firestore caps a document at 1 MiB - split longer transcripts */

/* ------------------------------------------------------------ helpers */
function readEnv() {
  const env = {};
  const f = path.join(ROOT, '.env.local');
  if (!fs.existsSync(f)) return env;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    env[m[1]] = v;
  });
  return env;
}
const ENV = Object.assign(readEnv(), process.env);
const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uuidOf = (uri) => (uri ? String(uri).split('/').pop() : '');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function loadArchive() {
  if (!fs.existsSync(ARCHIVE)) return null;
  return JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
}
function emptyArchive() {
  return { org: null, users: {}, eventTypes: {}, events: {}, invitees: {}, recaps: {}, published: {}, firstSync: new Date().toISOString() };
}
/* written to a temp file and renamed: a crash mid-write never corrupts the archive */
function saveArchive(a) {
  const tmp = ARCHIVE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a));
  fs.renameSync(tmp, ARCHIVE);
}

/* ------------------------------------------------------------ Calendly calls */
async function cal(p) {
  const url = p.indexOf('http') === 0 ? p : API + p;
  for (let attempt = 0; ; attempt++) {
    let r, text;
    try {
      r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + ENV.CALENDLY_TOKEN, Accept: 'application/json' },
        signal: AbortSignal.timeout(60000)
      });
      text = await r.text();
    } catch (e) {
      if (attempt > 6) throw e;
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempt > 8) throw new Error('Calendly ' + r.status + ' on ' + p);
      const reset = Number(r.headers.get('x-ratelimit-reset')) || 0;
      await sleep(r.status === 429 ? (reset + 1) * 1000 : Math.min(60000, 1500 * 2 ** attempt));
      continue;
    }
    if (r.status === 401) throw new Error('Calendly refused the token (401). Make a new personal access token and update CALENDLY_TOKEN in .env.local.');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-json */ }
    return { status: r.status, json, text };
  }
}
async function calAll(p) {
  const out = [];
  let url = p;
  while (url) {
    const r = await cal(url);
    if (r.status !== 200) throw new Error('Calendly ' + r.status + ' on ' + p + ': ' + r.text.slice(0, 300));
    out.push(...(r.json.collection || []));
    url = r.json.pagination && r.json.pagination.next_page;
  }
  return out;
}
async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

/* ------------------------------------------------------------ slimming */
function slimEvent(e) {
  const loc = e.location || {};
  return {
    id: uuidOf(e.uri), name: e.name || '', status: e.status, start: e.start_time, end: e.end_time,
    created: e.created_at, updated: e.updated_at, type: uuidOf(e.event_type),
    loc: loc.type || '', locStatus: loc.status || '',
    hosts: (e.event_memberships || []).map(m => ({ n: m.user_name || '', e: (m.user_email || '').toLowerCase() })),
    guests: (e.event_guests || []).map(g => (g.email || '').toLowerCase()).filter(Boolean),
    cancel: e.cancellation ? { by: e.cancellation.canceled_by || '', type: e.cancellation.canceler_type || '',
      reason: e.cancellation.reason || '', at: e.cancellation.created_at } : null,
    inv: e.invitees_counter ? { active: e.invitees_counter.active, total: e.invitees_counter.total, limit: e.invitees_counter.limit } : null,
    cal: (e.calendar_event && e.calendar_event.kind) || '',
    notes: e.meeting_notes_plain || ''
  };
}
function slimInvitee(v, evId) {
  const tr = {};
  Object.entries(v.tracking || {}).forEach(([k, x]) => { if (x) tr[k] = x; });
  return {
    id: uuidOf(v.uri), ev: evId, name: (v.name || [v.first_name, v.last_name].filter(Boolean).join(' ') || '').trim(),
    email: (v.email || '').toLowerCase(), status: v.status, created: v.created_at, updated: v.updated_at,
    tz: v.timezone || '', phone: v.text_reminder_number || '',
    qa: (v.questions_and_answers || []).sort((a, b) => a.position - b.position).map(q => [q.question, q.answer]),
    utm: tr, noShow: v.no_show ? v.no_show.created_at || true : null,
    rescheduled: !!v.rescheduled, oldInv: uuidOf(v.old_invitee), newInv: uuidOf(v.new_invitee),
    cancel: v.cancellation ? { by: v.cancellation.canceled_by || '', type: v.cancellation.canceler_type || '',
      reason: v.cancellation.reason || '', at: v.cancellation.created_at } : null,
    by: v.invitee_scheduled_by || '', method: v.scheduling_method || '',
    routing: uuidOf(v.routing_form_submission),
    paid: v.payment ? { amount: v.payment.amount, currency: v.payment.currency, ok: !!v.payment.successful } : null
  };
}
function slimRecap(r) {
  const att = (r.attendees || []).map(a => ({ n: a.user_name || '', e: String(a.user_email || '').toLowerCase(), host: !!a.host }));
  /* internal: everybody in the room is on the team's own domain */
  const internal = att.length > 0 && att.every(a => a.e.endsWith('@' + TEAM_DOMAIN));
  return {
    id: uuidOf(r.uri), name: (r.name || '').trim(), start: r.start_time, end: r.end_time,
    created: r.created_at, updated: r.updated_at, status: r.status, ev: uuidOf(r.event),
    att, internal, loc: (r.location && r.location.type) || '',
    summary: r.summary_md || '', actions: r.action_items_md || '', discussion: r.discussion_md || '',
    app: r.app_url || '', share: r.share_link || '', hasTr: !!r.transcript
  };
}

/* ------------------------------------------------------------ 1. who + what */
async function loadBasics(A) {
  const me = await cal('/users/me');
  if (me.status !== 200) throw new Error('Calendly /users/me failed ' + me.status + ': ' + me.text.slice(0, 200));
  const org = me.json.resource.current_organization;
  A.org = { uri: org, id: uuidOf(org), owner: me.json.resource.email, tz: me.json.resource.timezone };
  const members = await calAll('/organization_memberships?count=100&organization=' + encodeURIComponent(org));
  members.forEach(m => {
    const u = m.user || {};
    A.users[uuidOf(u.uri)] = { n: u.name || '', e: (u.email || '').toLowerCase(), role: m.role, url: u.scheduling_url || '', tz: u.timezone || '' };
  });
  const types = await calAll('/event_types?count=100&organization=' + encodeURIComponent(org));
  types.forEach(t => {
    A.eventTypes[uuidOf(t.uri)] = {
      n: t.name, dur: t.duration, active: t.active, kind: t.kind, url: t.scheduling_url || '',
      owner: (t.profile && t.profile.name) || '', color: t.color || '', secret: !!t.secret,
      qs: (t.custom_questions || []).filter(q => q.enabled).map(q => q.name)
    };
  });
  log('   ' + Object.keys(A.users).length + ' team member(s), ' + Object.keys(A.eventTypes).length + ' event type(s)');
}

/* ------------------------------------------------------------ 2. bookings */
async function loadEvents(A, recent) {
  const q = '/scheduled_events?count=100&sort=start_time:asc&organization=' + encodeURIComponent(A.org.uri) +
    (recent ? '&min_start_time=' + encodeURIComponent(new Date(Date.now() - RECENT_DAYS * 864e5).toISOString()) : '');
  const list = await calAll(q);
  const seenAt = new Date().toISOString();
  const touched = [];
  list.forEach(e => {
    const s = slimEvent(e);
    const old = A.events[s.id];
    if (!old || old.updated !== s.updated || old.status !== s.status) touched.push(s.id);
    A.events[s.id] = Object.assign(s, { seen: seenAt, invAt: old ? old.invAt : null, gone: false });
  });
  /* a full listing that no longer includes a booking means Calendly dropped it:
     keep it, just mark it, so the page can say "only in our archive" */
  if (!recent) {
    const ids = new Set(list.map(e => uuidOf(e.uri)));
    let gone = 0;
    Object.values(A.events).forEach(e => { if (!ids.has(e.id)) { if (!e.gone) e.gone = seenAt; gone++; } });
    if (gone) log('   ' + gone + ' booking(s) Calendly no longer returns - kept from the archive');
  }
  log('   ' + list.length + ' bookings from Calendly (' + touched.length + ' new or changed)');
  return { list: list.map(e => uuidOf(e.uri)), touched: new Set(touched) };
}

async function loadInvitees(A, evIds, touched) {
  const now = Date.now();
  const todo = evIds.filter(id => {
    const e = A.events[id];
    if (!e || e.gone) return false;
    if (!e.invAt || touched.has(id)) return true;
    /* no-shows are marked after the call - re-read recent ones while that can still change */
    const start = new Date(e.start).getTime();
    return start > now - RECENT_DAYS * 864e5 && now - new Date(e.invAt).getTime() > INVITEE_STALE_MS;
  });
  log('   invitees: ' + todo.length + ' booking(s) to read');
  let done = 0;
  await pool(todo, async (id) => {
    const rows = await calAll('/scheduled_events/' + id + '/invitees?count=100');
    rows.forEach(v => { const s = slimInvitee(v, id); A.invitees[s.id] = s; });
    A.events[id].invAt = new Date().toISOString();
    if (++done % 200 === 0) log('     ' + done + ' / ' + todo.length);
  });
}

/* ------------------------------------------------------------ 3. recaps + transcripts */
async function loadRecaps(A) {
  const list = await calAll('/meeting_recaps?count=100&organization=' + encodeURIComponent(A.org.uri));
  const todo = list.filter(r => {
    const old = A.recaps[uuidOf(r.uri)];
    return !old || old.updated !== r.updated_at || !old.detail;
  });
  log('   ' + list.length + ' recorded meetings (' + todo.length + ' new or changed)');
  const seenAt = new Date().toISOString();
  list.forEach(r => { const o = A.recaps[uuidOf(r.uri)]; if (o) o.seen = seenAt; });
  await pool(todo, async (r) => {
    const id = uuidOf(r.uri);
    const d = await cal('/meeting_recaps/' + id);
    const full = d.status === 200 && d.json && d.json.resource ? d.json.resource : r;
    const s = slimRecap(full);
    const old = A.recaps[id];
    A.recaps[id] = Object.assign(s, { detail: d.status === 200, seen: seenAt, trAt: old ? old.trAt : null, trUpdated: old ? old.trUpdated : null });
  });
  /* transcripts: once each, again only if the recap was updated since */
  fs.mkdirSync(TR_DIR, { recursive: true });
  const trTodo = Object.values(A.recaps).filter(r => r.hasTr && !r.gone &&
    (!fs.existsSync(path.join(TR_DIR, r.id + '.txt')) || r.trUpdated !== r.updated));
  log('   transcripts: ' + trTodo.length + ' to download');
  let done = 0;
  await pool(trTodo, async (r) => {
    const t = await cal('/meeting_recaps/' + r.id + '/transcript');
    if (t.status !== 200 || !t.json || !t.json.resource) return;   /* not ready yet - next run */
    fs.writeFileSync(path.join(TR_DIR, r.id + '.txt'), t.json.resource.text || '');
    r.trAt = new Date().toISOString();
    r.trUpdated = r.updated;
    if (++done % 50 === 0) log('     ' + done + ' / ' + trTodo.length);
  });
}

/* ------------------------------------------------------------ firestore */
let fsAdmin = null;
function firestore() {
  if (fsAdmin) return fsAdmin;
  const admin = require('firebase-admin');
  const saFile = path.join(__dirname, 'service-account.json');
  let cred = null;
  if (fs.existsSync(saFile)) cred = admin.credential.cert(JSON.parse(fs.readFileSync(saFile, 'utf8')));
  else if (ENV.FIREBASE_CLIENT_EMAIL && ENV.FIREBASE_PRIVATE_KEY) {
    cred = admin.credential.cert({
      projectId: ENV.FIREBASE_PROJECT_ID, clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
      privateKey: ENV.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
  }
  if (!cred) return null;
  if (!require('firebase-admin').apps.length) admin.initializeApp({ credential: cred });
  fsAdmin = admin.firestore();
  return fsAdmin;
}

function chunkJson(rows, maxBytes) {
  const out = [];
  let cur = [], size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    const b = Buffer.byteLength(s) + 1;
    if (size + b > maxBytes && cur.length) { out.push('[' + cur.join(',') + ']'); cur = []; size = 2; }
    cur.push(s); size += b;
  }
  if (cur.length) out.push('[' + cur.join(',') + ']');
  return out;
}
const byStart = (a, b) => String(a.start).localeCompare(String(b.start));
const noBookkeeping = (o) => { const c = Object.assign({}, o); delete c.invAt; delete c.detail; delete c.trAt; delete c.trUpdated; return c; };

/** archive lost (new computer, deleted folder)? rebuild it from Firestore first */
async function restoreFromFirestore() {
  const db = firestore();
  if (!db) return null;
  const meta = await db.collection(COLL).doc('meta').get();
  if (!meta.exists) return null;
  log('no local archive - rebuilding it from Firestore before calling Calendly');
  const A = emptyArchive();
  const m = meta.data();
  A.org = m.org || null; A.users = m.users || {}; A.eventTypes = m.eventTypes || {};
  A.firstSync = m.firstSync || A.firstSync;
  const read = async (coll, ids) => {
    const out = [];
    for (const id of ids || []) { const s = await db.collection(coll).doc(id).get(); if (s.exists) out.push(...JSON.parse(s.data().d || '[]')); }
    return out;
  };
  (await read(COLL, (m.chunks || {}).events)).forEach(e => { A.events[e.id] = e; });
  (await read(COLL, (m.chunks || {}).invitees)).forEach(v => { A.invitees[v.id] = v; });
  (await read(COLL, (m.chunks || {}).recaps)).forEach(r => { A.recaps[r.id] = Object.assign(r, { detail: true }); });
  const pm = await db.collection(PRIV).doc('meta').get();
  if (pm.exists) (await read(PRIV, (pm.data().chunks || {}).recaps)).forEach(r => { A.recaps[r.id] = Object.assign(r, { detail: true }); });
  /* transcripts too - Calendly may no longer have the older ones */
  fs.mkdirSync(TR_DIR, { recursive: true });
  for (const r of Object.values(A.recaps)) {
    if (!r.hasTr) continue;
    const s = await db.collection(r.internal ? PRIV : COLL).doc('tr_' + r.id).get();
    if (!s.exists) continue;
    let text = s.data().t || '';
    for (let i = 1; i < (s.data().parts || 1); i++) {
      const p = await db.collection(r.internal ? PRIV : COLL).doc('tr_' + r.id + '_' + i).get();
      if (p.exists) text += p.data().t || '';
    }
    fs.writeFileSync(path.join(TR_DIR, r.id + '.txt'), text);
    r.trUpdated = r.updated;
    A.published['tr_' + r.id] = hash(text);
  }
  log('   restored ' + Object.keys(A.events).length + ' bookings, ' + Object.keys(A.invitees).length + ' invitees, ' +
    Object.keys(A.recaps).length + ' recaps');
  return A;
}

/** one chunked dataset: write the new chunks, then the meta, then drop the old chunks */
async function publishSet(db, coll, sets, metaExtra, A) {
  const prev = await db.collection(coll).doc('meta').get();
  const sig = hash(JSON.stringify(sets));
  if (prev.exists && prev.data().sig === sig) {
    await db.collection(coll).doc('meta').set(Object.assign({}, prev.data(), metaExtra), { merge: false });
    return false;
  }
  const v = Date.now().toString(36);
  const ids = {};
  for (const [name, rows] of Object.entries(sets)) {
    ids[name] = [];
    const parts = chunkJson(rows, 700000);
    for (let i = 0; i < parts.length; i++) {
      const id = name + '_' + v + '_' + i;
      await db.collection(coll).doc(id).set({ d: parts[i] });
      ids[name].push(id);
    }
  }
  await db.collection(coll).doc('meta').set(Object.assign({ version: v, sig, chunks: ids }, metaExtra));
  if (prev.exists) {
    const old = prev.data().chunks || {};
    for (const id of [].concat(...Object.values(old))) await db.collection(coll).doc(id).delete().catch(() => {});
  }
  return true;
}

async function upload(A, mode) {
  if (process.argv.includes('--no-upload')) { log('(--no-upload: not publishing)'); return; }
  const db = firestore();
  if (!db) { log('NOT uploaded: no tools/service-account.json yet. Data is archived locally; it uploads once the key is there.'); return; }

  const events = Object.values(A.events).sort(byStart).map(noBookkeeping);
  const invitees = Object.values(A.invitees).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const recaps = Object.values(A.recaps).sort(byStart).map(r => Object.assign(noBookkeeping(r),
    { trChars: fs.existsSync(path.join(TR_DIR, r.id + '.txt')) ? fs.statSync(path.join(TR_DIR, r.id + '.txt')).size : 0 }));
  const pub = recaps.filter(r => !r.internal), priv = recaps.filter(r => r.internal);

  /* transcripts first: a recap row never points at a transcript that is not there yet */
  let trWritten = 0;
  for (const r of recaps) {
    const f = path.join(TR_DIR, r.id + '.txt');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const key = 'tr_' + r.id, h = hash(text + (r.internal ? 'p' : 't'));
    if (A.published[key] === h) continue;
    const coll = r.internal ? PRIV : COLL;
    const parts = [];
    for (let i = 0; i < text.length; i += TR_MAX) parts.push(text.slice(i, i + TR_MAX));
    if (!parts.length) parts.push('');
    for (let i = 0; i < parts.length; i++) {
      await db.collection(coll).doc(i ? key + '_' + i : key).set(i ? { t: parts[i] } : {
        t: parts[0], parts: parts.length, name: r.name, start: r.start || null, chars: text.length
      });
    }
    /* a meeting that moved between team-wide and private: remove the other copy */
    await db.collection(r.internal ? COLL : PRIV).doc(key).delete().catch(() => {});
    A.published[key] = h;
    trWritten++;
  }

  const starts = events.map(e => e.start).filter(Boolean).sort();
  const common = { syncedAt: new Date().toISOString(), mode, timezone: 'America/Chicago' };
  const changedPub = await publishSet(db, COLL, { events, invitees, recaps: pub }, Object.assign({}, common, {
    org: A.org, users: A.users, eventTypes: A.eventTypes, firstSync: A.firstSync,
    counts: {
      events: events.length, invitees: invitees.length, recaps: pub.length, privateRecaps: priv.length,
      archivedOnly: events.filter(e => e.gone).length,
      transcripts: recaps.filter(r => r.trChars).length
    },
    firstEvent: starts[0] || null, lastEvent: starts[starts.length - 1] || null
  }), A);
  const changedPriv = await publishSet(db, PRIV, { recaps: priv }, Object.assign({}, common, { counts: { recaps: priv.length } }), A);
  saveArchive(A);
  log('published: ' + events.length + ' bookings, ' + invitees.length + ' invitees, ' + pub.length + ' team-visible + ' +
    priv.length + ' internal recaps, ' + trWritten + ' transcript(s) written' +
    (changedPub || changedPriv ? '' : ' (no data changes - sync time only)'));
}

/* -------------------------------------------------------------- main */
module.exports = { slimEvent, slimInvitee, slimRecap, chunkJson };
if (require.main === module) (async function main() {
  if (!ENV.CALENDLY_TOKEN) { console.error('Add CALENDLY_TOKEN to .env.local first.'); process.exit(1); }
  fs.mkdirSync(TR_DIR, { recursive: true });
  /* one run at a time: the 15-minute run must not race the daily one */
  const LOCK = path.join(CACHE, 'sync.lock');
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { /* stale lock */ }
    if (alive) { log('another Calendly sync is already running (pid ' + pid + ') - leaving it to finish'); return; }
  }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch (e) {} });

  let A = loadArchive();
  if (!A) A = (await restoreFromFirestore().catch(e => { log('restore skipped: ' + e.message); return null; })) || emptyArchive();
  const uploadOnly = process.argv.includes('--upload');
  const recent = process.argv.includes('--recent');

  if (!uploadOnly) {
    log('1) team, event types');
    await loadBasics(A);
    log('2) bookings' + (recent ? ' (last ' + RECENT_DAYS + ' days + upcoming)' : ' (full history)'));
    const ev = await loadEvents(A, recent);
    await loadInvitees(A, ev.list, ev.touched);
    saveArchive(A);
    log('3) Notetaker recaps and transcripts');
    await loadRecaps(A);
    saveArchive(A);
  }
  log('4) publishing');
  await upload(A, uploadOnly ? 'upload' : recent ? 'recent' : 'full');
  log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
