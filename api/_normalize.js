/* Pheenyx Capital - Pipeline Workflow
   api/_normalize.js
   ------------------------------------------------------------------
   Turns whatever GoHighLevel posts at us into the same shape a form
   submission on our own page produces.

   GHL's webhook payload is not one fixed schema - it differs by trigger
   (Form Submitted / Contact Created / Opportunity Stage Changed), by
   whether "customData" was configured on the action, and by how the
   form's fields were named. So instead of hard-coding key names we:

     1. flatten the whole payload into one lookup table of normalised keys
     2. answer the standard things (name, email, phone) from a list of
        known aliases
     3. for every question on OUR form, look for a payload key that
        matches that question's label
     4. keep the raw payload on the contact so the first real submission
        tells us exactly what GHL sent, and mapping can be tightened

   Pure functions only - no Firebase, no network. Unit-tested by
   test/normalize.test.js.                                              */

/** 'First Name?' -> 'first_name' */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const SKIP_KEYS = new Set(['raw', 'headers', 'body']);

/* Containers whose child keys ARE the lead's own answers, so a child key
   may be looked up by its own short name. Everything else (location,
   workflow, user, company, calendar, attributionSource...) keeps its full
   path only - otherwise GHL's `location.name` (your company name) would
   answer a lookup for "name" and every lead would be called
   "Pheenyx Capital". */
const PROMOTE = new Set([
  'customdata', 'custom_data', 'customfields', 'custom_fields', 'customfield',
  'data', 'form', 'formdata', 'form_data', 'contact', 'fields', 'answers',
  'submission', 'payload', 'lead'
]);
const isIndex = (s) => /^[0-9]+$/.test(s);

/** may the leaf name of this path be used as a lookup key on its own? */
function promotable(path) {
  if (path.length <= 1) return true;                 /* top-level key */
  return path.slice(0, -1).every(seg => isIndex(seg) || PROMOTE.has(norm(seg)));
}

/** flatten nested objects/arrays into { lookupKey: scalarString } */
function flatten(value, out, path, depth) {
  out = out || {};
  path = path || [];
  depth = depth || 0;
  if (value == null || depth > 6) return out;

  if (Array.isArray(value)) {
    /* an array of scalars becomes a comma list; arrays of objects recurse */
    const allScalar = value.every(v => v == null || typeof v !== 'object');
    if (allScalar) {
      setKey(out, path, value.filter(v => v != null && v !== '').join(', '));
    } else {
      value.forEach((v, i) => flatten(v, out, path.concat(String(i)), depth + 1));
    }
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(k => {
      if (SKIP_KEYS.has(k.toLowerCase())) return;
      flatten(value[k], out, path.concat(k), depth + 1);
    });
    /* GHL also sends custom fields as [{ id, name|key|label, value }] pairs */
    const nameish = value.name || value.key || value.label || value.fieldKey;
    if (nameish && typeof nameish !== 'object' &&
        Object.prototype.hasOwnProperty.call(value, 'value') &&
        (value.value == null || typeof value.value !== 'object')) {
      setKey(out, [String(nameish)], value.value);
    }
    return out;
  }
  setKey(out, path, value);
  return out;
}

function setKey(out, path, value) {
  if (value === '' || value == null) return;
  const v = typeof value === 'boolean' || typeof value === 'number' ? String(value) : String(value).trim();
  if (!v) return;
  const full = norm(path.join('_'));
  if (full && !(full in out)) out[full] = v;
  if (promotable(path)) {
    const leaf = norm(path[path.length - 1]);
    if (leaf && !(leaf in out)) out[leaf] = v;
  }
}

/* GoHighLevel's standard webhook sends EVERY custom field defined in the
   location as a top-level key - often hundreds, nearly all empty. If one of
   them is labelled "Email", "Phone" or "Full Name" it collides head-on with
   the contact's real fields, so identity keys are resolved first and never
   overwritten by an arbitrary custom-field label. */
const IDENTITY_KEYS = new Set(
  ['full_name', 'fullname', 'name', 'contact_name', 'contact_full_name',
   'first_name', 'firstname', 'contact_first_name', 'given_name',
   'last_name', 'lastname', 'contact_last_name', 'family_name', 'surname',
   'email', 'email_address', 'contact_email', 'e_mail',
   'phone', 'phone_number', 'contact_phone', 'mobile', 'mobile_phone', 'telephone',
   'contact_id', 'contactid', 'ghl_contact_id'].map(norm));

const ANSWER_CONTAINERS = ['contact', 'customData', 'custom_data', 'customFields',
  'custom_fields', 'customField', 'data', 'form', 'formData', 'form_data',
  'fields', 'answers', 'submission', 'payload', 'lead'];

/** the flat lookup table for a payload */
function index(payload) {
  const idx = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return flatten(payload, {}, [], 0);
  }
  const take = (src) => {
    Object.keys(src).forEach(k => { if (!(k in idx)) idx[k] = src[k]; });
  };
  /* the containers holding a lead's own answers outrank the loose
     custom-field keys sprayed across the top level */
  ANSWER_CONTAINERS.forEach(k => {
    const sub = payload[k];
    if (sub && typeof sub === 'object') take(flatten(sub, {}, [], 0));
  });
  take(flatten(payload, {}, [], 0));
  return idx;
}

/**
 * The contact's OWN identity fields, kept apart from the custom-field noise.
 *
 * GHL writes its own fields in canonical form (`email`, `first_name`), while a
 * custom field carries its human label (`Email`, `Full Name`). Both can appear
 * in the same payload, so trust is tiered:
 *   A - the key is already canonical  -> certainly GHL's own field
 *   B - identity-ish, no whitespace   -> probably, e.g. `firstName`
 * A label containing a space is never treated as an identity field; it stays a
 * custom field, so "Full Name: Imported Placeholder" cannot rename the lead.
 */
function identity(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;

  const sources = [payload];
  if (payload.contact && typeof payload.contact === 'object' && !Array.isArray(payload.contact)) {
    sources.push(payload.contact);
  }
  const put = (canon, v) => {
    if (v == null || typeof v === 'object') return;
    const s = String(v).trim();
    if (s && !(canon in out)) out[canon] = s;
  };
  const tiers = [
    (k) => k === norm(k),        /* A */
    (k) => !/\s/.test(k)         /* B */
  ];
  tiers.forEach(passes => {
    sources.forEach(src => {
      Object.keys(src).forEach(k => {
        const n = norm(k);
        if (IDENTITY_KEYS.has(n) && passes(k)) put(n, src[k]);
      });
    });
  });
  return out;
}

const first = (idx, keys) => {
  for (const k of keys) { const v = idx[norm(k)]; if (v) return v; }
  return '';
};

const NAME_KEYS = ['full_name', 'fullname', 'name', 'contact_name', 'contact_full_name'];
const FIRST_KEYS = ['first_name', 'firstname', 'contact_first_name', 'given_name'];
const LAST_KEYS = ['last_name', 'lastname', 'contact_last_name', 'family_name', 'surname'];
const EMAIL_KEYS = ['email', 'email_address', 'contact_email', 'e_mail'];
const PHONE_KEYS = ['phone', 'phone_number', 'contact_phone', 'mobile', 'mobile_phone', 'telephone'];
const VALUE_KEYS = ['opportunity_value', 'monetary_value', 'value', 'amount', 'budget', 'lead_value'];
const NOTES_KEYS = ['notes', 'note', 'message', 'comments', 'comment', 'details', 'description'];
const GHLID_KEYS = ['contact_id', 'contactid', 'id', 'ghl_contact_id'];

/** trusted identity first; the loose index only as a last resort */
function personName(id, idx) {
  idx = idx || id;
  const build = (src) => {
    const full = first(src, NAME_KEYS);
    if (full) return full;
    const f = first(src, FIRST_KEYS), l = first(src, LAST_KEYS);
    return (f + ' ' + l).trim();
  };
  return build(id) || build(idx);
}

function toNumber(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) && n > 0 ? n : 0;
}

function tagList(idx) {
  const raw = first(idx, ['tags', 'tag', 'contact_tags']);
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
}

/**
 * Map a GHL payload onto one of our forms.
 * @param {object} form  a form document from Firestore
 * @param {object} payload  the raw webhook body
 * @returns {{name,email,phone,title,value,notes,answers,tags,ghlContactId,matched,unmatched}}
 */
/* GHL wraps every webhook in routing and analytics metadata. Drop it by
   exact name or known path prefix - NEVER by loose prefix, or real questions
   like "Source 5 speaking engagements per week" and "Type of Service Needed"
   get thrown away with it. */
const ENVELOPE_EXACT = new Set([
  'contact_id', 'contactid', 'first_name', 'last_name', 'full_name', 'name',
  'email', 'phone', 'tags', 'country', 'timezone',
  /* exact names only: a loose "date_" prefix would also eat a real
     question such as "Date of birth" */
  'date_created', 'date_updated', 'date_added', 'datecreated', 'dateupdated', 'dateadded',
  'full_address', 'contact_type', 'triggerdata', 'webhook_id', 'event', 'type',
  'source', 'url', 'ip', 'useragent', 'referrer', 'medium', 'mediumid',
  'sessionsource', 'gclid', 'gbraid', 'wbraid', 'fbp', 'fbeventid',
  'gaclientid', 'gasessionid', 'adname', 'adgroupid', 'adid', 'company',
  'website', 'dnd', 'assigned_to', 'assigneduser', 'calendar', 'state',
  'city', 'postal_code', 'address1', 'timestamp'
]);
const ENVELOPE_PREFIX = [
  'location_', 'workflow_', 'triggerdata_', 'attributionsource_',
  'lastattributionsource_', 'contact_attributionsource_',
  'contact_lastattributionsource_', 'utm_', 'customdata_'
];
function isEnvelope(k) {
  if (ENVELOPE_EXACT.has(k)) return true;
  return ENVELOPE_PREFIX.some(p => k.indexOf(p) === 0);
}

function mapToForm(form, payload) {
  const idx = index(payload);
  const id = identity(payload);              /* the contact's own fields */
  const pick = (keys) => first(id, keys) || first(idx, keys);
  const fields = (form && form.fields) || [];

  const answers = {};
  const matched = [];
  const unmatched = [];

  /* 1. every question on our form looks for its own label in the payload */
  fields.forEach(q => {
    let v = '';
    /* 1. a question asking who this is trusts GHL's own contact fields
          ahead of its own label - otherwise a custom field happening to be
          called "Email" answers it before the real address is ever read */
    if (q.map === 'name') v = personName(id, {});
    else if (q.map === 'email') v = first(id, EMAIL_KEYS);
    else if (q.map === 'phone') v = first(id, PHONE_KEYS);

    /* 2. otherwise match the question's own label against the payload */
    if (!v) {
      const candidates = [q.label, q.ghlKey, q.id].filter(Boolean);
      v = first(idx, candidates);
    }
    /* 3. last resort: the usual aliases anywhere in the payload */
    if (!v) {
      if (q.map === 'name') v = personName(id, idx);
      else if (q.map === 'email') v = pick(EMAIL_KEYS);
      else if (q.map === 'phone') v = pick(PHONE_KEYS);
      else if (q.map === 'value') v = first(idx, VALUE_KEYS);
      else if (q.map === 'notes') v = first(idx, NOTES_KEYS);
    }
    answers[q.label] = v ? String(v).slice(0, 4000) : '';
    (v ? matched : unmatched).push(q.label);
  });

  /* 3. the record-level fields, preferring a mapped question's answer */
  const byMap = (m) => {
    const q = fields.find(x => x.map === m);
    return q && answers[q.label] ? answers[q.label] : '';
  };
  const name = (byMap('name') || personName(id, idx) || 'Unnamed lead').slice(0, 120);
  const email = (byMap('email') || pick(EMAIL_KEYS)).slice(0, 160);
  const phone = (byMap('phone') || pick(PHONE_KEYS)).slice(0, 40);
  const title = (byMap('title') || name).slice(0, 160);
  const value = toNumber(byMap('value') || first(idx, VALUE_KEYS));
  const notes = (byMap('notes') || first(idx, NOTES_KEYS)).slice(0, 4000);

  /* anything GHL sent that our form has no question for is still kept,
     so nothing is silently lost */
  const known = new Set();
  fields.forEach(q => { known.add(norm(q.label)); });
  NAME_KEYS.concat(FIRST_KEYS, LAST_KEYS, EMAIL_KEYS, PHONE_KEYS, GHLID_KEYS)
    .forEach(k => known.add(norm(k)));
  const extras = {};
  Object.keys(idx).forEach(k => {
    if (known.has(k)) return;
    if (isEnvelope(k)) return;
    if (Object.keys(extras).length >= 25) return;
    extras[k] = String(idx[k]).slice(0, 500);
  });

  return {
    name, email, phone, title, value, notes, answers,
    tags: tagList(idx),
    ghlContactId: pick(GHLID_KEYS) || first(idx, GHLID_KEYS),
    ghlFormName: first(idx, ['contact_source', 'form_name', 'formname']),
    extras, matched, unmatched
  };
}

module.exports = { norm, flatten, index, identity, mapToForm, personName, toNumber, tagList, isEnvelope };
