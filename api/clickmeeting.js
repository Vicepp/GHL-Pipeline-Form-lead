/* Pheenyx Capital - Pipeline Workflow
   api/clickmeeting.js
   ------------------------------------------------------------------
   Server-side proxy for the ClickMeeting API.

   It exists for two reasons, both hard requirements:
     1. The ClickMeeting key must never reach the browser. Anyone who
        opened the page could otherwise read every webinar, registrant
        and attendee in the account - and delete them.
     2. ClickMeeting does not send CORS headers, so a browser cannot
        call it directly anyway.

   Access is gated on a Firebase ID token, verified against Google with
   the public web API key - no service account needed. The caller must
   also be on the /team allow-list, the same list that gates the app.

       GET /api/clickmeeting?action=list
       GET /api/clickmeeting?action=runs&ids=10219326,10178445

   Env vars (Vercel -> Settings -> Environment Variables):
       CLICKMEETING_API_KEY   from ClickMeeting -> Account -> API
       FIREBASE_API_KEY       the public web key (already set)
       FIREBASE_PROJECT_ID    (already set)                            */

const { groupTopics, reconcile } = require('./_webinars');

const CM = 'https://api.clickmeeting.com/v1';
const MAX_RUNS = 20;          /* per request, so one click cannot fan out to 500 calls */

function send(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(obj));
}

/** the signed-in person, proved by their Firebase ID token */
async function callerEmail(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw Object.assign(new Error('Sign in to load webinars.'), { status: 401 });
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw Object.assign(new Error('FIREBASE_API_KEY is not set on the server.'), { status: 500 });

  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: m[1].trim() })
  });
  const j = await r.json().catch(() => ({}));
  const email = j && j.users && j.users[0] && j.users[0].email;
  if (!r.ok || !email) {
    throw Object.assign(new Error('Your session has expired - reload and sign in again.'), { status: 401 });
  }
  return String(email).toLowerCase();
}

/** on the team, or the bootstrap owner */
async function assertTeam(email) {
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (!pid) throw Object.assign(new Error('FIREBASE_PROJECT_ID is not set.'), { status: 500 });
  const owners = String(process.env.OWNER_EMAILS || 'info@phcinvest.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (owners.indexOf(email) >= 0) return;
  const url = 'https://firestore.googleapis.com/v1/projects/' + pid +
    '/databases/(default)/documents/team/' + encodeURIComponent(email) +
    '?key=' + process.env.FIREBASE_API_KEY;
  const r = await fetch(url);
  if (r.status === 200) return;
  throw Object.assign(new Error(email + ' is not on the team list.'), { status: 403 });
}

async function cm(path) {
  const key = process.env.CLICKMEETING_API_KEY;
  if (!key) throw Object.assign(new Error('CLICKMEETING_API_KEY is not set on the server.'), { status: 500 });
  const r = await fetch(CM + path, {
    headers: { 'X-Api-Key': key, 'Accept': 'application/json' }
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* ClickMeeting sometimes returns html on error */ }
  if (!r.ok) {
    throw Object.assign(new Error('ClickMeeting said ' + r.status + ' for ' + path), { status: 502 });
  }
  return body;
}

/** one webinar run, reconciled into who registered and who turned up */
async function loadRun(id) {
  const out = { id: id, registered: 0, attended: 0, noShow: 0, walkIns: 0, rate: 0, people: [], error: null };
  let sessions = [];
  try { sessions = (await cm('/conferences/' + id + '/sessions')) || []; }
  catch (e) { out.error = e.message; return out; }

  let regs = [];
  try { regs = (await cm('/conferences/' + id + '/registrations/all')) || []; }
  catch (e) { regs = []; out.error = 'registrations unavailable'; }
  if (!Array.isArray(regs)) regs = [];

  let atts = [];
  for (const s of sessions.slice(0, 6)) {
    try {
      const a = await cm('/conferences/' + id + '/sessions/' + s.id + '/attendees');
      if (Array.isArray(a)) atts = atts.concat(a);
    } catch (e) { /* a session with no attendee record is simply empty */ }
  }
  return Object.assign(out, reconcile(regs, atts), { sessions: sessions.length });
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  try {
    const email = await callerEmail(req);
    await assertTeam(email);

    if (q.action === 'list') {
      const [active, inactive] = await Promise.all([
        cm('/conferences/active').catch(() => []),
        cm('/conferences/inactive').catch(() => [])
      ]);
      const all = []
        .concat(Array.isArray(active) ? active : (active && active.active_conferences) || [])
        .concat(Array.isArray(inactive) ? inactive : []);
      let overrides = {};
      if (q.overrides) { try { overrides = JSON.parse(q.overrides); } catch (e) { overrides = {}; } }
      return send(res, 200, {
        ok: true,
        conferences: all.length,
        topics: groupTopics(all, overrides, Date.now())
      });
    }

    if (q.action === 'runs') {
      const ids = String(q.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_RUNS);
      if (!ids.length) return send(res, 400, { ok: false, error: 'Add ?ids=<conference ids>' });
      const runs = [];
      for (const id of ids) runs.push(await loadRun(id));   /* serial: ClickMeeting rate-limits */
      return send(res, 200, { ok: true, runs: runs, truncated: String(q.ids || '').split(',').length > MAX_RUNS });
    }

    return send(res, 400, { ok: false, error: 'Unknown action. Use list or runs.' });
  } catch (e) {
    return send(res, e.status || 500, { ok: false, error: e.message || String(e) });
  }
};
