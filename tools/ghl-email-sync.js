#!/usr/bin/env node
/* Pheenyx Capital - Pipeline Workflow
   tools/ghl-email-sync.js
   ------------------------------------------------------------------
   Pulls every mass email out of GoHighLevel - who it went to, and
   whether they opened it or clicked a link - and publishes it to
   Firestore for the Email Campaigns page.

       node tools/ghl-email-sync.js            full pull, resumes if stopped
       node tools/ghl-email-sync.js --upload   just republish what is cached

   Reads .env.local:
       GHL_API_TOKEN, GHL_LOCATION_ID          (Private Integration token)
   and for the upload, either tools/service-account.json or the
   FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY pair.

   How GHL gives this up (API v2):
     GET /conversations/messages/export   every email message, 500 a page
     GET /conversations/messages/email/id the LIVE status of one email -
                                          delivered / opened / clicked.
                                          The export's status is stale,
                                          so this is one call per email.
     POST /contacts/search                names for the recipients
   GHL allows ~200k calls a day. A full history can exceed that, so when
   the daily allowance runs out this publishes what it has, waits, and
   carries on. Everything is cached in tools/.ghl-cache/ (gitignored -
   it holds contact emails), so a stopped run picks up where it left off.

   What lands in Firestore - collection emailAnalytics, team-read-only:
     meta              counts, sync time, and the names of the chunks below
     campaigns_<v>     one line per send: subject, source, date
     contacts_<v>_NNN  one line per contact: id, name, email
     events_<v>_NNN    one line per email sent: who, which send, when,
                       status, seconds until the last open/click, bot flag
   Packed into ~30 documents rather than 270k, so the page loads in one
   go and a page view costs ~30 reads instead of a quarter of a million. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.ghl-cache');
const MSGS = path.join(CACHE, 'messages.jsonl');
const CURSOR = path.join(CACHE, 'export.cursor');
const STATUS = path.join(CACHE, 'status.jsonl');
const CONTACTS = path.join(CACHE, 'contacts.json');
const STATE = path.join(CACHE, 'state.json');

const BASE = 'https://services.leadconnectorhq.com';
const MASS = { campaign: 1, bulk_actions: 1 };   /* Email Campaigns + Contacts > Bulk Action */
const RECHECK_DAYS = 21;                         /* younger emails can still be opened - look again */
const WORKERS = 8;                               /* GHL bursts at 100 per 10s */
const UPLOAD_EVERY = 20000;                      /* publish progress this often during lookups */
const COLL = 'emailAnalytics';

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
const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

/* ------------------------------------------------------------ GHL calls */
let dailyLeft = null;
async function ghl(method, p, body) {
  for (let attempt = 0; ; attempt++) {
    if (resetWait) await resetWait;   /* the allowance ran out: everyone waits on the one shared wait */
    let r, text;
    try {
      r = await fetch(BASE + p, {
        method,
        headers: {
          Authorization: 'Bearer ' + ENV.GHL_API_TOKEN, Version: '2021-07-28',
          Accept: 'application/json', 'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000)
      });
      text = await r.text();   /* inside the try: a body that stalls is retried, not fatal */
    } catch (e) {
      await sleep(Math.min(60000, 2000 * 2 ** Math.min(attempt, 5)));
      continue;
    }
    const dl = r.headers.get('x-ratelimit-daily-remaining');
    if (dl != null) dailyLeft = Number(dl);
    if (r.status === 429 || r.status >= 500) {
      if (dailyLeft != null && dailyLeft <= 5) { await waitForDailyReset(); attempt = 0; continue; }
      await sleep(Math.min(60000, (Number(r.headers.get('retry-after')) * 1000) || 1500 * 2 ** Math.min(attempt, 5)));
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-json error page */ }
    return { status: r.status, json, text };
  }
}

let onDailyLimit = null;   /* set by main: publish what we have before sleeping */
let resetWait = null;      /* one wait shared by every worker - not one upload per worker */
function waitForDailyReset() {
  if (!resetWait) resetWait = doWaitForDailyReset().finally(() => { resetWait = null; });
  return resetWait;
}
async function doWaitForDailyReset() {
  log('GHL daily API allowance used up - publishing progress, then waiting for it to reset.');
  if (onDailyLimit) { try { await onDailyLimit(); } catch (e) { log('upload failed:', e.message); } }
  for (;;) {
    await sleep(20 * 60 * 1000);
    const r = await fetch(BASE + '/locations/' + ENV.GHL_LOCATION_ID, {
      headers: { Authorization: 'Bearer ' + ENV.GHL_API_TOKEN, Version: '2021-07-28' },
      signal: AbortSignal.timeout(60000)
    }).catch(() => null);
    if (r && r.status !== 429) {
      dailyLeft = Number(r.headers.get('x-ratelimit-daily-remaining') || 1000);
      log('GHL allowance is back (' + dailyLeft + ' left today) - resuming.');
      return;
    }
    log('still rate-limited, checking again in 20 minutes');
  }
}

/* ---------------------------------------------------- 1. export emails */
const slim = (m) => ({
  id: m.id, c: m.contactId || '', d: m.direction || '', s: m.source || '',
  st: m.status || '', at: m.dateAdded, sub: m.subject || '', to: (m.to && m.to[0]) || ''
});

async function exportMessages(state) {
  fs.mkdirSync(CACHE, { recursive: true });
  /* first full pass, resumable by cursor */
  if (!state.exportDone) {
    let cursor = fs.existsSync(CURSOR) ? fs.readFileSync(CURSOR, 'utf8').trim() : null;
    let have = readJsonl(MSGS).length;
    if (have && !cursor) { fs.writeFileSync(MSGS, ''); have = 0; }  /* half-written with no cursor: restart */
    const started = new Date().toISOString();
    for (;;) {
      const q = 'locationId=' + ENV.GHL_LOCATION_ID + '&channel=Email&limit=500' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await ghl('GET', '/conversations/messages/export?' + q);
      if (r.status !== 200) throw new Error('export failed ' + r.status + ': ' + r.text.slice(0, 300));
      const page = r.json.messages || [];
      if (page.length) fs.appendFileSync(MSGS, page.map(m => JSON.stringify(slim(m))).join('\n') + '\n');
      have += page.length;
      cursor = r.json.nextCursor;
      if (have % 5000 < 500) log('exported ' + have + ' / ' + r.json.total + ' email messages');
      if (!page.length || !cursor) break;
      fs.writeFileSync(CURSOR, cursor);
    }
    if (fs.existsSync(CURSOR)) fs.unlinkSync(CURSOR);
    state.exportDone = true;
    state.exportedUpTo = started;
    saveState(state);
    log('export complete: ' + have + ' email messages');
    return;
  }
  /* later runs: only what arrived since last time (2-day overlap, merged by id) */
  const since = new Date(new Date(state.exportedUpTo).getTime() - 2 * 864e5).toISOString();
  const started = new Date().toISOString();
  const known = new Set(readJsonl(MSGS).map(m => m.id));
  let cursor = null, added = 0;
  for (;;) {
    const q = 'locationId=' + ENV.GHL_LOCATION_ID + '&channel=Email&limit=500&startDate=' +
      encodeURIComponent(since) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await ghl('GET', '/conversations/messages/export?' + q);
    if (r.status !== 200) throw new Error('export failed ' + r.status + ': ' + r.text.slice(0, 300));
    const fresh = (r.json.messages || []).filter(m => !known.has(m.id));
    fresh.forEach(m => known.add(m.id));
    if (fresh.length) fs.appendFileSync(MSGS, fresh.map(m => JSON.stringify(slim(m))).join('\n') + '\n');
    added += fresh.length;
    cursor = r.json.nextCursor;
    if (!(r.json.messages || []).length || !cursor) break;
  }
  state.exportedUpTo = started;
  saveState(state);
  log('incremental export: ' + added + ' new email messages since ' + since.slice(0, 10));
}

/* ----------------------------------------------- 2. open/click status */
function loadStatuses() {
  const m = new Map();
  readJsonl(STATUS).forEach(s => m.set(s.id, s));
  return m;
}

async function lookupStatuses(mass, statuses, publish) {
  const now = Date.now();
  const todo = mass.filter(m => {
    const s = statuses.get(m.id);
    if (!s) return true;
    /* a young email can still be opened; an old one is settled */
    return now - new Date(m.at).getTime() < RECHECK_DAYS * 864e5 &&
      now - new Date(s.checked || 0).getTime() > 6 * 3600e3;
  }).sort((a, b) => new Date(b.at) - new Date(a.at));   /* newest first: the page is useful sooner */
  log('status lookups: ' + (mass.length - todo.length) + ' settled, ' + todo.length + ' to fetch');
  if (!todo.length) return;

  const out = fs.createWriteStream(STATUS, { flags: 'a' });
  let i = 0, done = 0, sinceUpload = 0;
  const t0 = Date.now();
  async function worker() {
    while (i < todo.length) {
      const m = todo[i++];
      const r = await ghl('GET', '/conversations/messages/email/' + m.id);
      const e = r.status === 200 && r.json && r.json.emailMessage;
      const s = {
        id: m.id,
        st: e ? String(e.status || '').toLowerCase() : 'error_' + r.status,
        up: e ? e.dateUpdated : null,
        checked: new Date().toISOString()
      };
      statuses.set(m.id, s);
      out.write(JSON.stringify(s) + '\n');
      done++; sinceUpload++;
      if (done % 1000 === 0 || done === todo.length) {
        const rate = done / ((Date.now() - t0) / 60000);
        log('  status ' + done + ' / ' + todo.length + '  (' + Math.round(rate) + '/min, ~' +
          Math.round((todo.length - done) / rate) + ' min left' +
          (dailyLeft != null ? ', GHL daily left ' + dailyLeft : '') + ')');
      }
      if (sinceUpload >= UPLOAD_EVERY) { sinceUpload = 0; await publish(); }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await new Promise(r => out.end(r));
}

/* ------------------------------------------------------- 3. contacts */
async function loadContacts(wanted) {
  const cached = fs.existsSync(CONTACTS) ? JSON.parse(fs.readFileSync(CONTACTS, 'utf8')) : {};
  const missing = [...wanted].filter(id => id && !cached[id]);
  if (!missing.length) return cached;
  log('contacts: ' + Object.keys(cached).length + ' cached, ' + missing.length + ' missing - paging the contact list');
  let searchAfter = null, page = 1, n = 0;
  for (;;) {
    const body = { locationId: ENV.GHL_LOCATION_ID, pageLimit: 500 };
    if (searchAfter) body.searchAfter = searchAfter; else body.page = page;
    const r = await ghl('POST', '/contacts/search', body);
    if (r.status !== 200) { log('contact search stopped: ' + r.status + ' ' + r.text.slice(0, 200)); break; }
    const cs = r.json.contacts || [];
    cs.forEach(c => {
      cached[c.id] = {
        n: [c.firstNameLowerCase || c.firstName || '', c.lastNameLowerCase || c.lastName || '']
          .map(x => String(x || '').replace(/\b\w/g, ch => ch.toUpperCase())).join(' ').trim(),
        e: c.email || ''
      };
    });
    n += cs.length;
    if (n % 5000 < 500) log('  contacts loaded ' + n + (r.json.total ? ' / ' + r.json.total : ''));
    if (cs.length < 500) break;
    searchAfter = cs[cs.length - 1].searchAfter || null;
    if (!searchAfter) page++;
  }
  /* deleted contacts, or anything search missed: one by one */
  const still = missing.filter(id => !cached[id]);
  if (still.length) log('  fetching ' + still.length + ' contacts individually');
  for (const id of still) {
    const r = await ghl('GET', '/contacts/' + id);
    const c = r.status === 200 && r.json && r.json.contact;
    cached[id] = c
      ? { n: [c.firstName, c.lastName].filter(Boolean).join(' '), e: c.email || '' }
      : { n: '', e: '', gone: true };
  }
  fs.writeFileSync(CONTACTS, JSON.stringify(cached));
  return cached;
}

/* ----------------------------------------------------- 4. pack + push */
const ST_CODE = {
  delivered: 'd', opened: 'o', read: 'o', clicked: 'c', sent: 's', pending: 's', scheduled: 's',
  failed: 'f', undelivered: 'f', bounced: 'f', rejected: 'f', unsubscribed: 'u', complained: 'm'
};
/* merge-field subjects ("Emmanuel, let's finish the story") are one send, not one per name */
const normSubject = (s) => String(s || '(no subject)')
  .replace(/^[A-Za-z][A-Za-z'.\- ]{0,24},\s*|^,\s*/, '{first_name}, ').replace(/[\t\n\r]+/g, ' ').trim();
const chicagoDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const clean = (s) => String(s || '').replace(/[\t\n\r]+/g, ' ').trim();

function pack(mass, statuses, contacts) {
  const campIdx = new Map(), camps = [];
  const contIdx = new Map(), conts = [];
  const rows = [];
  let looked = 0;
  mass.sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const m of mass) {
    const subj = normSubject(m.sub);
    const ck = subj + '\t' + m.s + '\t' + chicagoDay(m.at);
    if (!campIdx.has(ck)) { campIdx.set(ck, camps.length); camps.push(ck); }
    const who = m.c || ('email:' + m.to.toLowerCase());
    if (!contIdx.has(who)) {
      const c = contacts[m.c] || {};
      contIdx.set(who, conts.length);
      conts.push([m.c, clean(c.n), clean(m.to || c.e).toLowerCase()].join('\t'));
    }
    const s = statuses.get(m.id);
    if (s) looked++;
    const raw = s ? s.st : (m.st || 'sent');
    const code = ST_CODE[raw] || (raw.indexOf('error') === 0 ? 'x' : 'x');
    const sent = Math.round(new Date(m.at).getTime() / 1000);
    const up = s && s.up ? Math.round(new Date(s.up).getTime() / 1000) : 0;
    const engaged = code === 'o' || code === 'c';
    rows.push({ ci: contIdx.get(who), ki: campIdx.get(ck), sent, code, dl: engaged && up >= sent ? up - sent : -1 });
  }
  /* security scanners at work/university addresses "click" every link within
     seconds of delivery - flag them so the page can count real people only */
  const per = new Map();
  rows.forEach(r => {
    const p = per.get(r.ci) || { n: 0, c: 0 };
    p.n++; if (r.code === 'c') p.c++;
    per.set(r.ci, p);
  });
  const lines = rows.map(r => {
    const p = per.get(r.ci);
    const bot = r.code === 'c' && ((r.dl >= 0 && r.dl <= 120) || (p.n >= 5 && p.c / p.n >= 0.8));
    return r.ci.toString(36) + ',' + r.ki.toString(36) + ',' + r.sent.toString(36) + ',' + r.code +
      ',' + (r.dl >= 0 ? r.dl.toString(36) : '') + (bot ? ',b' : '');
  });
  return { camps, conts, lines, looked };
}

function chunk(lines, maxBytes) {
  const out = [];
  let cur = [], size = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l) + 1;
    if (size + b > maxBytes && cur.length) { out.push(cur.join('\n')); cur = []; size = 0; }
    cur.push(l); size += b;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

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
  if (!admin.apps.length) admin.initializeApp({ credential: cred });
  fsAdmin = admin.firestore();
  return fsAdmin;
}

let uploading = Promise.resolve();
function upload(mass, statuses, contacts, final) {
  uploading = uploading.catch(() => {}).then(() => doUpload(mass, statuses, contacts, final));
  return uploading;
}
async function doUpload(mass, statuses, contacts, final) {
  const db = firestore();
  if (!db) {
    log('NOT uploaded: no tools/service-account.json yet. Data is cached; it will upload once the key is there.');
    return false;
  }
  const { camps, conts, lines, looked } = pack(mass.slice(), statuses, contacts);
  const v = Date.now().toString(36);
  const evChunks = chunk(lines, 700000);
  const ctChunks = chunk(conts, 700000);
  const cpChunks = chunk(camps, 700000);
  const ids = { events: [], contacts: [], campaigns: [] };
  const writes = [];
  evChunks.forEach((d, i) => { const id = 'events_' + v + '_' + i; ids.events.push(id); writes.push([id, { d }]); });
  ctChunks.forEach((d, i) => { const id = 'contacts_' + v + '_' + i; ids.contacts.push(id); writes.push([id, { d }]); });
  cpChunks.forEach((d, i) => { const id = 'campaigns_' + v + '_' + i; ids.campaigns.push(id); writes.push([id, { d }]); });
  /* chunks first, meta last: a reader never sees a meta pointing at missing chunks */
  for (const [id, data] of writes) await db.collection(COLL).doc(id).set(data);
  const prev = await db.collection(COLL).doc('meta').get();
  const sent = mass.map(m => m.at).sort();
  await db.collection(COLL).doc('meta').set({
    version: v,
    syncedAt: new Date().toISOString(),
    complete: !!final,
    emails: lines.length,
    contacts: conts.length,
    campaigns: camps.length,
    statusChecked: looked,
    firstSent: sent[0] || null,
    lastSent: sent[sent.length - 1] || null,
    timezone: 'America/Chicago',
    chunks: ids,
    format: 'events: contact,campaign,sentEpoch,status,secsToLastActivity[,b] (base36)'
  });
  /* then retire the previous version's chunks */
  if (prev.exists) {
    const old = prev.data().chunks || {};
    for (const id of [].concat(old.events || [], old.contacts || [], old.campaigns || [])) {
      await db.collection(COLL).doc(id).delete().catch(() => {});
    }
  }
  log('published to Firestore: ' + lines.length + ' emails, ' + conts.length + ' contacts, ' +
    camps.length + ' sends (' + looked + ' with live status) in ' + writes.length + ' chunks');
  return true;
}

/* -------------------------------------------------------------- main */
module.exports = { pack, normSubject };
if (require.main === module) (async function main() {
  if (!ENV.GHL_API_TOKEN || !ENV.GHL_LOCATION_ID) {
    console.error('Add GHL_API_TOKEN and GHL_LOCATION_ID to .env.local first.');
    process.exit(1);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const state = loadState();
  const uploadOnly = process.argv.includes('--upload');

  if (!uploadOnly) {
    log('1) exporting email messages from GoHighLevel');
    await exportMessages(state);
  }
  const all = readJsonl(MSGS);
  const byId = new Map();
  all.forEach(m => byId.set(m.id, m));
  const mass = [...byId.values()].filter(m => m.d === 'outbound' && MASS[m.s]);
  const srcCount = {};
  [...byId.values()].forEach(m => { const k = m.d + '/' + (m.s || '-'); srcCount[k] = (srcCount[k] || 0) + 1; });
  log('   ' + byId.size + ' email messages; ' + mass.length + ' are campaign / bulk sends');
  log('   by direction/source: ' + JSON.stringify(srcCount));

  const statuses = loadStatuses();
  let contacts = fs.existsSync(CONTACTS) ? JSON.parse(fs.readFileSync(CONTACTS, 'utf8')) : {};
  const publish = async () => upload(mass, statuses, contacts, false);
  onDailyLimit = publish;

  if (!uploadOnly) {
    log('2) contact names');
    contacts = await loadContacts(new Set(mass.map(m => m.c)));
    await publish();
    log('3) live open/click status, newest emails first');
    await lookupStatuses(mass, statuses, publish);
  }
  log('4) publishing');
  await upload(mass, statuses, contacts, true);
  log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
