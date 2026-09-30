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

/** the flat lookup table for a payload */
function index(payload) {
  const idx = flatten(payload, {}, [], 0);
  /* common containers deserve a second pass at the top level so their
     leaf names are not shadowed by an outer key of the same name */
  ['customData', 'custom_data', 'customFields', 'custom_fields', 'data', 'form', 'contact']
    .forEach(k => {
      const sub = payload && payload[k];
      if (sub && typeof sub === 'object') Object.assign(idx, flatten(sub, {}, [], 0), idx);
    });
  return idx;
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

function personName(idx) {
  const full = first(idx, NAME_KEYS);
  if (full) return full;
  const f = first(idx, FIRST_KEYS), l = first(idx, LAST_KEYS);
  return (f + ' ' + l).trim();
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
function mapToForm(form, payload) {
  const idx = index(payload);
  const fields = (form && form.fields) || [];

  const answers = {};
  const matched = [];
  const unmatched = [];

  /* 1. every question on our form looks for its own label in the payload */
  fields.forEach(q => {
    const candidates = [q.label, q.ghlKey, q.id].filter(Boolean);
    let v = first(idx, candidates);
    /* 2. fall back to the standard aliases for mapped questions */
    if (!v) {
      if (q.map === 'name') v = personName(idx);
      else if (q.map === 'email') v = first(idx, EMAIL_KEYS);
      else if (q.map === 'phone') v = first(idx, PHONE_KEYS);
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
  const name = (byMap('name') || personName(idx) || 'Unnamed lead').slice(0, 120);
  const email = (byMap('email') || first(idx, EMAIL_KEYS)).slice(0, 160);
  const phone = (byMap('phone') || first(idx, PHONE_KEYS)).slice(0, 40);
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
    if (/^(location|company|workflow|webhook|event|timestamp|date_|created|updated|type|source|country|state|city|postal|address|website|dnd|assigned|user|calendar|attribution|utm|medium|campaign|referrer|session|fingerprint|ip$)/.test(k)) return;
    if (Object.keys(extras).length >= 25) return;
    extras[k] = String(idx[k]).slice(0, 500);
  });

  return {
    name, email, phone, title, value, notes, answers,
    tags: tagList(idx),
    ghlContactId: first(idx, GHLID_KEYS),
    extras, matched, unmatched
  };
}

module.exports = { norm, flatten, index, mapToForm, personName, toNumber, tagList };
