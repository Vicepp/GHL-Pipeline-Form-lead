/* Pheenyx Capital - Pipeline Workflow
   api/ghl-inbound.js
   ------------------------------------------------------------------
   Receives a GoHighLevel workflow webhook and creates the same three
   records a submission on our own form creates:

       contact  +  pipeline card  +  follow-up task   (+ activity line)

   The routing is NOT configured here. The webhook URL names one of the
   forms you already built in the app, and that form's pipeline, stage,
   tags, assignee and task template are used. So "which pipeline does this
   GHL form feed" stays a dropdown on the website, not a code change.

       POST /api/ghl-inbound?form=<formId>&key=<INBOUND_SECRET>
       GET  /api/ghl-inbound?form=<formId>&key=<INBOUND_SECRET>   -> health check

   Env vars required (Vercel -> Settings -> Environment Variables):
       INBOUND_SECRET         any long random string you invent
       FIREBASE_PROJECT_ID    from the service account JSON
       FIREBASE_CLIENT_EMAIL  from the service account JSON
       FIREBASE_PRIVATE_KEY   from the service account JSON (keep the \n)

   This runs server-side, so it writes with admin rights and bypasses
   firestore.rules. That is deliberate: it lets us store the raw GHL
   payload and de-duplicate retries, neither of which we want to open up
   to the public form.                                                  */

const { mapToForm } = require('./_normalize');

/* ---------------------------------------------------- firebase admin */
let adminApp = null;
function getDb() {
  const admin = require('firebase-admin');
  if (!adminApp) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    /* Vercel stores the key with literal \n - turn them back into newlines */
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase service account env vars are not set (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)');
    }
    adminApp = admin.apps && admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  }
  return require('firebase-admin').firestore();
}

/* ------------------------------------------------------------ helpers */
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowIso = () => new Date().toISOString();
const dayShift = (n) => new Date(Date.now() + n * 864e5).toISOString();

function readBody(req) {
  /* Vercel parses JSON for us, but GHL can also send form-encoded */
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) { /* fall through */ }
    const out = {};
    new URLSearchParams(req.body).forEach((v, k) => { out[k] = v; });
    return out;
  }
  return {};
}

function send(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(obj, null, 2));
}

/* ------------------------------------------------------------ handler */
/** the shared secret, however the caller chose to present it.
    GHL's webhook action offers several auth schemes; accept the ones that
    can carry a single secret, so picking the "wrong" one in GHL still works:
      None       -> ?key=... on the URL
      API Key    -> x-inbound-key: <secret>   (custom header name)
      Bearer     -> Authorization: Bearer <secret>
      Basic Auth -> Authorization: Basic base64(anything:<secret>)
    OAuth2 cannot work here - it needs a token server we do not run.      */
function presentedKey(req, q) {
  if (q.key) return String(q.key);
  if (req.headers['x-inbound-key']) return String(req.headers['x-inbound-key']);
  const auth = req.headers.authorization || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const basic = auth.match(/^Basic\s+(.+)$/i);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      return i >= 0 ? decoded.slice(i + 1) : decoded;  /* password half */
    } catch (e) { /* malformed header */ }
  }
  return '';
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const formId = q.form || q.formId || '';
  const key = presentedKey(req, q);

  const secret = process.env.INBOUND_SECRET;
  if (!secret) return send(res, 500, { ok: false, error: 'INBOUND_SECRET is not set on the server.' });
  if (key !== secret) return send(res, 401, { ok: false, error: 'Bad or missing key.' });
  if (!formId) return send(res, 400, { ok: false, error: 'Add ?form=<formId> to the webhook URL.' });

  let db, form;
  try {
    db = getDb();
    const snap = await db.collection('forms').doc(formId).get();
    if (!snap.exists) return send(res, 404, { ok: false, error: 'No form "' + formId + '" in this workspace.' });
    form = Object.assign({ id: snap.id }, snap.data());
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }

  if (!form.pipelineId || !form.stageId) {
    return send(res, 409, { ok: false, error: 'Form "' + form.name + '" is not connected to a pipeline and stage yet.' });
  }
  if (form.active === false) {
    return send(res, 409, {
      ok: false,
      error: 'Form "' + form.name + '" is paused, so nothing was saved. Switch it back on in the form builder.'
    });
  }

  /* ---- GET: health check, so you can verify wiring from a browser ---- */
  if (req.method === 'GET') {
    let pipelineName = form.pipelineId, stageLabel = form.stageId;
    try {
      const p = await db.collection('pipelines').doc(form.pipelineId).get();
      if (p.exists) {
        pipelineName = p.data().name;
        const st = (p.data().stages || []).find(s => s.id === form.stageId);
        if (st) stageLabel = st.name;
      }
    } catch (e) { /* names are cosmetic here */ }
    return send(res, 200, {
      ok: true,
      message: 'Wiring is good. Point your GoHighLevel webhook here with POST.',
      form: form.name,
      willCreateIn: { pipeline: pipelineName, stage: stageLabel },
      assignsTo: form.assignTo || null,
      taskDueInDays: form.taskDueDays == null ? 1 : form.taskDueDays,
      questionsOnThisForm: (form.fields || []).map(f => f.label)
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'Use POST.' });
  }

  /* ---------------------------- map the payload ---------------------------- */
  const payload = readBody(req);
  if (!payload || !Object.keys(payload).length) {
    return send(res, 400, { ok: false, error: 'Empty body. GHL should POST JSON.' });
  }
  const m = mapToForm(form, payload);

  /* ------- de-duplicate GHL retries: same person, same form, last 5 min ------
     Deliberately ONE equality filter per query. Firestore auto-indexes single
     fields; combining an equality and a range (formId + createdAt) would need
     a composite index, and if that index were missing the dedupe would fail
     silently forever. */
  try {
    const cutoff = Date.now() - 5 * 60e3;
    let probe = null;
    if (m.ghlContactId) probe = db.collection('contacts').where('ghlContactId', '==', m.ghlContactId);
    else if (m.email) probe = db.collection('contacts').where('email', '==', m.email);
    else if (m.phone) probe = db.collection('contacts').where('phone', '==', m.phone);

    if (probe) {
      const snap = await probe.limit(25).get();
      const dupe = snap.docs.find(d => {
        const c = d.data();
        return c.formId === form.id && new Date(c.createdAt).getTime() >= cutoff;
      });
      if (dupe) {
        return send(res, 200, {
          ok: true, duplicate: true, contactId: dupe.id,
          message: 'Already received this lead in the last 5 minutes - ignored the retry.'
        });
      }
    }
  } catch (e) {
    /* a lead must never be lost because the duplicate check had a problem */
    console.warn('dedupe check skipped:', e.message);
  }

  /* --------------------------- write the records --------------------------- */
  const created = nowIso();
  const contact = {
    name: m.name, email: m.email, phone: m.phone,
    formId: form.id,
    tags: Array.from(new Set((form.tags || []).concat(m.tags, ['ghl']))).slice(0, 25),
    createdAt: created,
    answers: m.answers,
    notes: m.notes,
    source: 'ghl',
    ghlContactId: m.ghlContactId || null,
    ghlExtras: m.extras,
    raw: JSON.parse(JSON.stringify(payload))
  };
  const contactId = uid('ct');
  const oppId = uid('op');

  const opportunity = {
    contactId, pipelineId: form.pipelineId, stageId: form.stageId,
    title: m.title, value: m.value, status: 'open',
    formId: form.id, owner: form.assignTo || '',
    createdAt: created, updatedAt: created, source: 'ghl'
  };
  const task = {
    contactId, formId: form.id, pipelineId: form.pipelineId,
    title: (form.taskTemplate || 'Reach out to {{name}}').replace('{{name}}', m.name),
    owner: form.assignTo || '',
    dueAt: dayShift(Number(form.taskDueDays) || 1),
    done: false, doneAt: null, createdAt: created
  };
  const activity = {
    at: created, type: 'submission', pipelineId: form.pipelineId,
    text: m.name + ' came in from GoHighLevel via "' + form.name + '"'
  };

  try {
    const batch = db.batch();
    batch.set(db.collection('contacts').doc(contactId), contact);
    batch.set(db.collection('opportunities').doc(oppId), opportunity);
    batch.set(db.collection('tasks').doc(uid('tk')), task);
    batch.set(db.collection('activity').doc(uid('ac')), activity);
    await batch.commit();
  } catch (e) {
    console.error('write failed', e);
    return send(res, 500, { ok: false, error: 'Could not save the lead: ' + e.message });
  }

  return send(res, 200, {
    ok: true,
    contactId, opportunityId: oppId,
    lead: { name: m.name, email: m.email, phone: m.phone, value: m.value },
    landedIn: { pipelineId: form.pipelineId, stageId: form.stageId },
    /* so you can see at a glance whether the field mapping worked */
    mapped: m.matched,
    couldNotFill: m.unmatched,
    alsoKept: Object.keys(m.extras)
  });
};
