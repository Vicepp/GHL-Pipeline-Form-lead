/* Pheenyx Capital - Pipeline Workflow
   api/_firestore.js
   ------------------------------------------------------------------
   Two ways to reach Firestore from the server, behind one interface.

     admin  - firebase-admin with a service account. Full rights, so it
              can de-duplicate GHL retries and store the raw payload.
     rest   - the plain REST API with the public web API key. Subject to
              firestore.rules exactly like a browser, which means it can
              ONLY create the fields the public-submission rule allows:
              no raw payload, no dedupe. Needs no service account.

   The point of the rest mode is that a missing service account should
   degrade what we record, not lose the lead entirely.                 */

/* ---------------------------------------- typed-value conversion ---- */
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') {
    const fields = {};
    Object.keys(v).forEach(k => { fields[k] = toFs(v[k]); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fromFs(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    Object.keys(f).forEach(k => { out[k] = fromFs(f[k]); });
    return out;
  }
  return null;
}
const docToObj = (doc) => {
  const out = {};
  const f = (doc && doc.fields) || {};
  Object.keys(f).forEach(k => { out[k] = fromFs(f[k]); });
  if (doc && doc.name) out.id = doc.name.split('/').pop();
  return out;
};

/* only these keys survive a public create - see firestore.rules */
const PUBLIC_CONTACT_KEYS =
  ['name', 'email', 'phone', 'formId', 'tags', 'createdAt', 'answers', 'notes'];

/* ----------------------------------------------------- admin mode ---- */
let cachedApp = null;
function adminStore() {
  const admin = require('firebase-admin');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!cachedApp) {
    cachedApp = (admin.apps && admin.apps.length)
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  }
  const fs = admin.firestore();
  return {
    mode: 'admin',
    canDedupe: true,
    keepsRawPayload: true,
    async getDoc(coll, id) {
      const s = await fs.collection(coll).doc(id).get();
      return s.exists ? Object.assign({ id: s.id }, s.data()) : null;
    },
    async findBy(coll, field, value, limit) {
      const s = await fs.collection(coll).where(field, '==', value).limit(limit || 25).get();
      return s.docs.map(d => Object.assign({ id: d.id }, d.data()));
    },
    async commit(ops) {
      const b = fs.batch();
      ops.forEach(o => b.set(fs.collection(o.coll).doc(o.id), o.data));
      await b.commit();
    }
  };
}

/* ------------------------------------------------------ rest mode ---- */
function restStore(projectId, apiKey) {
  /* a document's `name` in a commit is the resource path, NOT the URL -
     prefixing it with https://... is rejected as lacking "projects" */
  const docRoot = 'projects/' + projectId + '/databases/(default)/documents';
  const base = 'https://firestore.googleapis.com/v1/' + docRoot;
  return {
    mode: 'rest',
    canDedupe: false,
    keepsRawPayload: false,
    async getDoc(coll, id) {
      const r = await fetch(base + '/' + coll + '/' + encodeURIComponent(id) + '?key=' + apiKey);
      if (r.status === 404) return null;
      const j = await r.json();
      if (j.error) throw new Error('Firestore read failed: ' + j.error.message);
      return docToObj(j);
    },
    async findBy() { return []; },     /* rules forbid querying as the public */
    async commit(ops) {
      const writes = ops.map(o => {
        let data = o.data;
        /* the public rule pins exactly which keys a contact may carry */
        if (o.coll === 'contacts') {
          data = {};
          PUBLIC_CONTACT_KEYS.forEach(k => {
            if (o.data[k] !== undefined) data[k] = o.data[k];
          });
        }
        const fields = {};
        Object.keys(data).forEach(k => { fields[k] = toFs(data[k]); });
        return { update: { name: docRoot + '/' + o.coll + '/' + o.id, fields } };
      });
      const r = await fetch(base + ':commit?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
        throw new Error('Firestore write refused: ' + msg +
          (/PERMISSION_DENIED/i.test(msg)
            ? ' - check firestore.rules is published and the form is active.'
            : ''));
      }
    }
  };
}

/** pick the best available mode, or explain what is missing */
function openStore() {
  const pid = process.env.FIREBASE_PROJECT_ID;
  const email = process.env.FIREBASE_CLIENT_EMAIL;
  const pkey = process.env.FIREBASE_PRIVATE_KEY;
  const apiKey = process.env.FIREBASE_API_KEY;

  if (pid && email && pkey) return adminStore();
  if (pid && apiKey) return restStore(pid, apiKey);

  const missing = [];
  if (!pid) missing.push('FIREBASE_PROJECT_ID');
  if (!apiKey && !(email && pkey)) {
    missing.push('and either FIREBASE_API_KEY (simple mode) or ' +
      'FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (full mode)');
  }
  throw new Error('Firestore is not configured on the server. Missing: ' + missing.join(', '));
}

module.exports = { openStore, toFs, fromFs, docToObj, PUBLIC_CONTACT_KEYS };
