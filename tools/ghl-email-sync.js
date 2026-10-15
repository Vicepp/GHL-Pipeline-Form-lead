#!/usr/bin/env node
/* Pheenyx Capital - Pipeline Workflow
   tools/ghl-email-sync.js
   ------------------------------------------------------------------
   Pulls every mass email out of GoHighLevel - who it went to, and
   whether they opened it or clicked a link - and publishes it to
   Firestore for the Email Campaigns page.

       node tools/ghl-email-sync.js            full pull, resumes if stopped
       node tools/ghl-email-sync.js --upload   just republish what is cached
       node tools/ghl-email-sync.js --days=3   light run: re-check only the last 3 days

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
     POST /contacts/search                names, and who has unsubscribed (email DND
                                          + the reason they gave)
     GET  /conversations/<id>/messages    the date each unsubscribe happened
   GHL allows ~200k calls a day. A full history can exceed that, so when
   the daily allowance runs out this publishes what it has, waits, and
   carries on. Everything is cached in tools/.ghl-cache/ (gitignored -
   it holds contact emails), so a stopped run picks up where it left off.

   What lands in Firestore - collection emailAnalytics, team-read-only:
     meta              counts, sync time, and the names of the chunks below
     campaigns_<v>     one line per send: subject, source, date
     contacts_<v>_NNN  one line per contact: id, name, email, unsubscribe
                       reason code, unsubscribe date
     events_<v>_NNN    one line per email sent: who, which send, when,
                       status (failed split into hard / soft / blocked),
                       seconds until the last open/click, bot flag
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
const DND = path.join(CACHE, 'dnd.json');

const BASE = 'https://services.leadconnectorhq.com';
const MASS = { campaign: 1, bulk_actions: 1 };   /* Email Campaigns + Contacts > Bulk Action */
/* --days N: a light run that only re-checks the last N days (the 2-hourly
   run uses 3, which keeps the page's "last 24 hours" view current) */
const DAYS_ARG = (process.argv.find(a => /^--days=\d+$/.test(a)) || '').split('=')[1];
const RECHECK_DAYS = DAYS_ARG ? Number(DAYS_ARG) : 90;   /* younger emails can still be opened - look again */
const STALE_MS = (DAYS_ARG ? 1 : 6) * 3600e3;          /* don't re-check anything looked at more recently */
const FINAL = { clicked: 1, failed: 1, undelivered: 1, bounced: 1 };   /* can't change any more - never re-checked */
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
    if (s.st === 'failed' && s.err === undefined) return true;   /* reason not fetched yet */
    if (FINAL[s.st]) return false;
    /* a young email can still be opened; an old one is settled */
    return now - new Date(m.at).getTime() < RECHECK_DAYS * 864e5 &&
      now - new Date(s.checked || 0).getTime() > STALE_MS;
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
      if (s.st === 'failed') s.err = String((e && e.error) || '').replace(/\s+/g, ' ').slice(0, 240);
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
  /* paged every run, not just when someone is missing: unsubscribes change daily */
  log('contacts: ' + Object.keys(cached).length + ' cached, ' + missing.length + ' new - paging the contact list');
  let searchAfter = null, page = 1, n = 0;
  for (;;) {
    const body = { locationId: ENV.GHL_LOCATION_ID, pageLimit: 500 };
    if (searchAfter) body.searchAfter = searchAfter; else body.page = page;
    const r = await ghl('POST', '/contacts/search', body);
    if (r.status !== 200) { log('contact search stopped: ' + r.status + ' ' + r.text.slice(0, 200)); break; }
    const cs = r.json.contacts || [];
    cs.forEach(c => {
      const de = (c.dndSettings && c.dndSettings.Email) || {};
      cached[c.id] = {
        n: [c.firstNameLowerCase || c.firstName || '', c.lastNameLowerCase || c.lastName || '']
          .map(x => String(x || '').replace(/\b\w/g, ch => ch.toUpperCase())).join(' ').trim(),
        e: c.email || '',
        /* unsubscribed from email: the reason text GHL stored, or '' */
        u: de.status === 'active' ? (de.message || 'unsubscribed') : c.dnd === true ? (de.message || 'all channels') : ''
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
    const de = (c && c.dndSettings && c.dndSettings.Email) || {};
    cached[id] = c
      ? { n: [c.firstName, c.lastName].filter(Boolean).join(' '), e: c.email || '',
          u: de.status === 'active' ? (de.message || 'unsubscribed') : c.dnd === true ? 'all channels' : '' }
      : { n: '', e: '', gone: true };
  }
  fs.writeFileSync(CONTACTS, JSON.stringify(cached));
  return cached;
}

/* ------------------------------------------- 3b. unsubscribe dates
   GHL keeps the reason on the contact but the date only in their
   conversation's activity log ("DND enabled by customer"). Two calls per
   unsubscriber, once - the answer is cached in dnd.json.               */
async function loadUnsubDates(contacts) {
  const dates = fs.existsSync(DND) ? JSON.parse(fs.readFileSync(DND, 'utf8')) : {};
  const todo = Object.keys(contacts).filter(id => contacts[id].u && !(id in dates));
  Object.keys(dates).forEach(id => { if (contacts[id] && !contacts[id].u) delete dates[id]; });  /* resubscribed */
  if (todo.length) log('unsubscribe dates: looking up ' + todo.length + ' contacts');
  for (const id of todo) {
    let at = null;
    const cv = await ghl('GET', '/conversations/search?locationId=' + ENV.GHL_LOCATION_ID + '&contactId=' + id);
    const conv = cv.json && cv.json.conversations && cv.json.conversations[0];
    let lastId = null;
    for (let page = 0; conv && page < 5 && !at; page++) {
      const r = await ghl('GET', '/conversations/' + conv.id + '/messages?limit=100' + (lastId ? '&lastMessageId=' + lastId : ''));
      const box = r.json && r.json.messages;
      const ms = (box && box.messages) || [];
      for (const m of ms) {
        const a = m.activity || {};
        const ch = (a.data && a.data.channel) || [];
        if (/dnd_enabled/i.test(a.type || '') && (!ch.length || ch.indexOf('Email') >= 0)) { at = m.dateAdded; break; }
      }
      if (!box || !box.nextPage || !ms.length) break;
      lastId = box.lastMessageId;
    }
    dates[id] = at;
  }
  fs.writeFileSync(DND, JSON.stringify(dates));
  return dates;
}

/* ----------------------------------------------------- 4. pack + push */
const ST_CODE = {
  delivered: 'd', opened: 'o', read: 'o', clicked: 'c', sent: 's', pending: 's', scheduled: 's',
  failed: 'f', undelivered: 'f', bounced: 'f', rejected: 'f', unsubscribed: 'u', complained: 'm'
};
/* why a send failed, from the receiving server's reply */
/* Order matters - checked against the real replies in this account:
   "mailbox is full" arrives as a 5.x code but is temporary, and "request limit
   exceeded" mentions "not allowed" but is our own sending limit, not a block. */
function failKind(err) {
  const e = String(err || '');
  /* t - we sent too fast: the provider throttled us, or GHL/Mailgun's sending
         limit was hit, or retries ran out ("Too old") after that */
  if (/limit exceeded|concurrent connections|too many|rate limit|^too old|throttl/i.test(e)) return 't';
  /* q - soft: the recipient's side, temporary */
  if (/mailbox (is )?full|over quota|quota|out of storage|storage space|unable to connect|connection failed|temporar|try again later/i.test(e)) return 'q';
  /* h - hard: the address or domain does not exist */
  if (/previously bounced|no mx|no such host|does not exist|no such user|user unknown|unknown user|invalid recipient|address rejected|not found|unavailable|disabled|inactive/i.test(e)) return 'h';
  /* k - refused: spam filter, IP/domain reputation, recipient policy */
  if (/spam|block|blacklist|policy|reputation|weren't sent|5\.7\.\d|denied|not allowed|rejected/i.test(e)) return 'k';
  if (/^5|\s5\.\d\.\d/.test(e)) return 'h';
  if (/^4|\s4\.\d\.\d/.test(e)) return 'q';
  return 'f';
}
/* what the unsubscriber said */
function unsubKind(msg) {
  const m = String(msg || '');
  if (!m) return '';
  if (/never signed up/i.test(m)) return 'x';
  if (/spam complaint/i.test(m)) return 's';
  if (/permanent bounce/i.test(m)) return 'p';
  if (/no longer want/i.test(m)) return 'n';
  if (/unsubscribe link/i.test(m)) return 'l';
  return 'm';
}

/* merge-field subjects ("Emmanuel, let's finish the story") are one send, not one per name */
/* The recipient's own first name is replaced wherever it sits ("Did you forget
   something, Ramon?"); only when it isn't found is a short leading "Name," taken
   as the merge field - for names GHL filled in that our contact list lacks. */
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function normSubject(s, name) {
  let t = String(s || '(no subject)').replace(/[\t\n\r]+/g, ' ').replace(/\s+([?!.,])/g, '$1').trim();
  const full = String(name || '').trim();
  const first = full.split(/\s+/)[0] || '';
  let hit = false;
  /* full name first ("Uche Uka"), then the first name alone */
  for (const nm of [full, first]) {
    if (hit || !nm || (nm === full && !/\s/.test(full))) continue;
    const re = new RegExp('(^|[^\\p{L}])' + reEsc(nm) + '(?=$|[^\\p{L}])', 'giu');
    t = t.replace(re, (m0, pre) => { hit = true; return pre + '{first_name}'; });
  }
  t = t.replace(/^\{first_name\}[^,]{1,20},/, '{first_name},');   /* "Binyamin (Ben)," */
  if (!hit) {
    t = t.replace(/^,\s*|^[^\s,\d]+(?:\s+[^\s,\d]+)?,\s*(?=\S)/u, '{first_name}, ')     /* "Name, ..."  */
      .replace(/,\s*[^\s,\d{}]+(?:\s+[^\s,\d{}]+)?([?!.])$/u, ', {first_name}$1');        /* "..., Name?" */
  }
  return t;
}
const chicagoDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const clean = (s) => String(s || '').replace(/[\t\n\r]+/g, ' ').trim();

function pack(mass, statuses, contacts, dnd) {
  const campIdx = new Map(), camps = [];
  const contIdx = new Map(), conts = [];
  const rows = [];
  let looked = 0;
  mass.sort((a, b) => new Date(a.at) - new Date(b.at));
  /* A merge-field guess is kept only when it actually merges: 2+ differently
     worded subjects that day collapse to it. A contact called "Grove" whose
     "Grove Parkview" subject turns into "{first_name} Parkview" merges with
     nothing, so it keeps its real subject. */
  const rawSubj = (m) => String(m.sub || '(no subject)').replace(/[\t\n\r]+/g, ' ').trim();
  const guess = new Map(), variants = new Map();
  for (const m of mass) {
    const g = normSubject(m.sub, (contacts[m.c] || {}).n);
    guess.set(m.id, g);
    const k = g + '\t' + m.s + '\t' + chicagoDay(m.at);
    if (!variants.has(k)) variants.set(k, new Set());
    variants.get(k).add(rawSubj(m));
  }
  for (const m of mass) {
    const g = guess.get(m.id);
    const day = chicagoDay(m.at);
    const subj = variants.get(g + '\t' + m.s + '\t' + day).size >= 2 ? g : rawSubj(m);
    const ck = subj + '\t' + m.s + '\t' + day;
    if (!campIdx.has(ck)) { campIdx.set(ck, camps.length); camps.push(ck); }
    const who = m.c || ('email:' + m.to.toLowerCase());
    if (!contIdx.has(who)) {
      const c = contacts[m.c] || {};
      contIdx.set(who, conts.length);
      const ua = dnd && dnd[m.c] ? Math.round(new Date(dnd[m.c]).getTime() / 1000).toString(36) : '';
      conts.push([m.c, clean(c.n), clean(m.to || c.e).toLowerCase(), unsubKind(c.u), ua].join('\t'));
    }
    const s = statuses.get(m.id);
    if (s) looked++;
    const raw = s ? s.st : (m.st || 'sent');
    let code = ST_CODE[raw] || 'x';
    if (code === 'f') code = failKind(s && s.err);
    const sent = Math.round(new Date(m.at).getTime() / 1000);
    const up = s && s.up ? Math.round(new Date(s.up).getTime() / 1000) : 0;
    const engaged = code === 'o' || code === 'c';
    /* the 2-minute scanner test uses the exact gap: rounding each time to the
       second first let a 120.4s click count as 120s and be flagged */
    const exact = s && s.up ? (new Date(s.up).getTime() - new Date(m.at).getTime()) / 1000 : -1;
    rows.push({ ci: contIdx.get(who), ki: campIdx.get(ck), sent, code, dl: engaged && up >= sent ? up - sent : -1,
      fast: engaged && exact >= 0 && exact <= 120 });
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
    const bot = r.code === 'c' && (r.fast || (p.n >= 5 && p.c / p.n >= 0.8));
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
  if (process.argv.includes("--no-upload")) { log("(--no-upload: not publishing)"); return false; }
  const db = firestore();
  if (!db) {
    log('NOT uploaded: no tools/service-account.json yet. Data is cached; it will upload once the key is there.');
    return false;
  }
  const dnd = fs.existsSync(DND) ? JSON.parse(fs.readFileSync(DND, 'utf8')) : {};
  const { camps, conts, lines, looked } = pack(mass.slice(), statuses, contacts, dnd);
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
    format: 'events: contact,campaign,sentEpoch,status,secsToLastActivity[,b] (base36); ' +
      'status f/h/q/k = failed other/hard/soft/blocked; contacts: id,name,email,unsubKind,unsubEpoch36'
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
module.exports = { pack, normSubject, failKind, unsubKind };
if (require.main === module) (async function main() {
  if (!ENV.GHL_API_TOKEN || !ENV.GHL_LOCATION_ID) {
    console.error('Add GHL_API_TOKEN and GHL_LOCATION_ID to .env.local first.');
    process.exit(1);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  /* one run at a time: the daily scheduled run must not race a manual one */
  const LOCK = path.join(CACHE, 'sync.lock');
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { /* stale lock */ }
    if (alive) { log('another sync is already running (pid ' + pid + ') - leaving it to finish'); return; }
  }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch (e) {} });
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
    await loadUnsubDates(contacts);
    await publish();
    log('3) live open/click status, newest emails first');
    await lookupStatuses(mass, statuses, publish);
  }
  log('4) publishing');
  await upload(mass, statuses, contacts, true);
  log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
