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

   Env vars (Vercel -> Settings -> Environment Variables).

     SIMPLE MODE - no service account needed:
       INBOUND_SECRET         any long random string you invent
       FIREBASE_PROJECT_ID    e.g. ghl-phc-pipeline
       FIREBASE_API_KEY       the public web API key (same one in config.js)

     FULL MODE - adds raw-payload storage and retry de-duplication:
       INBOUND_SECRET
       FIREBASE_PROJECT_ID
       FIREBASE_CLIENT_EMAIL  from the service account JSON
       FIREBASE_PRIVATE_KEY   from the service account JSON (keep the \n)

   Simple mode writes through the public API and is therefore bound by
   firestore.rules exactly like a lead submitting a form: it may create a
   submission and nothing else. Full mode holds a service account, so it
   bypasses the rules and can also keep the raw payload and spot retries.
   A missing service account should cost us detail, never the lead.     */

const { mapToForm } = require('./_normalize');
const { openStore } = require('./_firestore');

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
    db = openStore();
    form = await db.getDoc('forms', formId);
    if (!form) return send(res, 404, { ok: false, error: 'No form "' + formId + '" in this workspace.' });
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
      const p = await db.getDoc('pipelines', form.pipelineId);
      if (p) {
        pipelineName = p.name;
        const st = (p.stages || []).find(s => s.id === form.stageId);
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
      questionsOnThisForm: (form.fields || []).map(f => f.label),
      storageMode: db.mode,
      note: db.mode === 'rest'
        ? 'Simple mode: leads are saved, but the raw GHL payload is not kept and ' +
          'retries are not de-duplicated. Add FIREBASE_CLIENT_EMAIL and ' +
          'FIREBASE_PRIVATE_KEY for the full version.'
        : 'Full mode: raw payloads kept, retries de-duplicated.'
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

  /* ---- ?echo=1 : show what arrived, create nothing -------------------
     Add &echo=1 to the webhook URL in GHL, hit Test workflow, and GHL's
     Execution logs will show this response. It is the exact payload GHL
     sends, read from inside our own endpoint - no third-party capture
     service, and no test lead left on the board. Remove &echo=1 after.  */
  if (q.echo === '1' || q.echo === 'true') {
    return send(res, 200, {
      ok: true,
      echo: true,
      message: 'Echo mode: nothing was saved. Send this whole response to Claude to tighten the field mapping, then remove &echo=1 from the URL.',
      form: form.name,
      receivedKeys: Object.keys(payload),
      received: payload,
      wouldCreate: {
        name: m.name, email: m.email, phone: m.phone,
        title: m.title, value: m.value, notes: m.notes,
        tags: Array.from(new Set((form.tags || []).concat(m.tags, ['ghl'])))
      },
      fieldsFilled: m.matched,
      fieldsLeftEmpty: m.unmatched,
      unmatchedFromGhl: m.extras
    });
  }

  /* ------- de-duplicate GHL retries: same person, same form, last 5 min ------
     Deliberately ONE equality filter per query. Firestore auto-indexes single
     fields; combining an equality and a range (formId + createdAt) would need
     a composite index, and if that index were missing the dedupe would fail
     silently forever. */
  try {
    const cutoff = Date.now() - 5 * 60e3;
    let rows = [];
    if (db.canDedupe) {
      if (m.ghlContactId) rows = await db.findBy('contacts', 'ghlContactId', m.ghlContactId, 25);
      else if (m.email) rows = await db.findBy('contacts', 'email', m.email, 25);
      else if (m.phone) rows = await db.findBy('contacts', 'phone', m.phone, 25);
    }
    const dupe = rows.find(c => c.formId === form.id && new Date(c.createdAt).getTime() >= cutoff);
    if (dupe) {
      return send(res, 200, {
        ok: true, duplicate: true, contactId: dupe.id,
        message: 'Already received this lead in the last 5 minutes - ignored the retry.'
      });
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
    await db.commit([
      { coll: 'contacts', id: contactId, data: contact },
      { coll: 'opportunities', id: oppId, data: opportunity },
      { coll: 'tasks', id: uid('tk'), data: task },
      { coll: 'activity', id: uid('ac'), data: activity }
    ]);
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
    alsoKept: db.keepsRawPayload ? Object.keys(m.extras) : [],
    /* so GHL's execution log alone is enough to debug a mapping problem,
       without needing the raw payload stored anywhere */
    receivedKeys: Object.keys(payload),
    unmatchedFromGhl: Object.keys(m.extras),
    storageMode: db.mode
  });
};
