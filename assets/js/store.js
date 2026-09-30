/* Pheenyx Capital - Pipeline Workflow
   store.js : one in-memory cache, two interchangeable back ends.

     local     -> browser localStorage (demo mode, works with no setup)
     firebase  -> Cloud Firestore, live for everyone, real-time listeners

   Views always read the cache synchronously via Store.db().
   Every mutation goes through the backend adapter B, which notifies
   subscribers once the write has landed (Firestore fires its local
   snapshot immediately, so the UI still feels instant).                  */

const KEY = 'phx_pipeline_v1';
/* collections anyone may read (the public form page needs these) */
const PUBLIC_COLLS = ['pipelines', 'forms'];
/* collections that require a signed-in team member */
const PRIVATE_COLLS = ['contacts', 'opportunities', 'tasks', 'activity', 'team'];
const ALL_COLLS = PUBLIC_COLLS.concat(PRIVATE_COLLS);
/* what a reset / import is allowed to replace - `team` is deliberately
   absent, so no reset can ever lock the team out of their own workspace */
const RESETTABLE_COLLS = ['pipelines', 'forms', 'contacts', 'opportunities', 'tasks', 'activity'];

const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();
const dayShift = (n) => new Date(Date.now() + n * 864e5).toISOString();

let DB = emptyDb();
let MODE = 'local';
let B = null;              /* backend adapter */
let FB = null;             /* { app, db, fns... } injected by boot.js */
const subs = [];
let authed = false;
let denied = false;        /* signed in, but this email is not on the team */

function emptyDb() {
  return {
    org: { name: 'Pheenyx Capital', tagline: 'Pipeline Workflow', owners: ['Chris'] },
    pipelines: [], forms: [], contacts: [], opportunities: [], tasks: [], activity: [], team: []
  };
}
function notify() { subs.forEach(fn => { try { fn(DB); } catch (e) { console.error(e); } }); }
function onChange(fn) { subs.push(fn); }
function db() { return DB; }
function mode() { return MODE; }

/* ================================================================ seed */
function seedData() {
  const investor = {
    id: 'pl_investor', name: 'Investor Relations', color: '#c8a04a', order: 0, createdAt: now(),
    stages: [
      { id: 'st_i1', name: 'New Lead' }, { id: 'st_i2', name: 'Contacted' },
      { id: 'st_i3', name: 'Discovery Call Booked' }, { id: 'st_i4', name: 'Docs / PPM Sent' },
      { id: 'st_i5', name: 'Soft Commit' }, { id: 'st_i6', name: 'Funded' }
    ]
  };
  const acq = {
    id: 'pl_acq', name: 'Acquisitions - Seller Leads', color: '#2563eb', order: 1, createdAt: now(),
    stages: [
      { id: 'st_a1', name: 'New Lead' }, { id: 'st_a2', name: 'Underwriting' },
      { id: 'st_a3', name: 'LOI Sent' }, { id: 'st_a4', name: 'Under Contract' }, { id: 'st_a5', name: 'Closed' }
    ]
  };
  const li = {
    id: 'pl_li', name: 'LinkedIn Unlocked - Prospect Portal', color: '#0f9d63', order: 2, createdAt: now(),
    stages: [
      { id: 'st_l1', name: 'New Lead' }, { id: 'st_l2', name: 'Registered' },
      { id: 'st_l3', name: 'Attended' }, { id: 'st_l4', name: 'Not Attended' }, { id: 'st_l5', name: 'Follow Up Booked' }
    ]
  };
  /* a ready-made GHL receiver: the form lives in GoHighLevel, this record
     only says where its leads land and how to read the payload */
  const fGhl = {
    id: 'fm_ghl_intake', source: 'ghl', name: 'GHL - Lead Intake',
    headline: '', blurb: '',
    pipelineId: investor.id, stageId: 'st_i1',
    tags: ['ghl'], assignTo: 'Chris',
    taskTemplate: 'Call {{name}} - came in from GHL', taskDueDays: 1,
    active: true, createdAt: now(),
    fields: [
      { id: 'g1', label: 'Full name', type: 'text', required: true, map: 'name' },
      { id: 'g2', label: 'Email', type: 'email', required: true, map: 'email' },
      { id: 'g3', label: 'Phone', type: 'phone', required: false, map: 'phone' },
      { id: 'g4', label: 'Notes', type: 'textarea', required: false, map: 'notes' }
    ]
  };

  const fInvestor = {
    id: 'fm_investor', source: 'hosted', name: 'Investor Interest Form',
    headline: 'Invest with Pheenyx Capital',
    blurb: 'Tell us a little about your goals and an advisor will reach out within one business day.',
    pipelineId: investor.id, stageId: 'st_i1', tags: ['investor', 'inbound'], assignTo: 'Chris',
    taskTemplate: 'Call {{name}} - new investor enquiry', taskDueDays: 1, active: true, createdAt: now(),
    fields: [
      { id: 'q1', label: 'Full name', type: 'text', required: true, map: 'name', placeholder: 'Jane Investor' },
      { id: 'q2', label: 'Email', type: 'email', required: true, map: 'email', placeholder: 'you@company.com' },
      { id: 'q3', label: 'Phone', type: 'phone', required: true, map: 'phone', placeholder: '(555) 123-4567' },
      { id: 'q4', label: 'Capital you are looking to deploy', type: 'select', required: true, map: 'value',
        options: ['50000', '100000', '250000', '500000', '1000000'],
        optionLabels: ['$50k - $100k', '$100k - $250k', '$250k - $500k', '$500k - $1M', '$1M+'] },
      { id: 'q5', label: 'Are you an accredited investor?', type: 'select', required: true, map: 'none', options: ['Yes', 'No', 'Not sure'] },
      { id: 'q6', label: 'What are you hoping to achieve?', type: 'textarea', required: false, map: 'notes' }
    ]
  };
  const fSeller = {
    id: 'fm_seller', source: 'hosted', name: 'Off-Market Deal Submission', headline: 'Submit a property',
    blurb: 'Send us the basics and our acquisitions team will underwrite it and come back with a number.',
    pipelineId: acq.id, stageId: 'st_a1', tags: ['seller', 'off-market'], assignTo: 'Acquisitions',
    taskTemplate: 'Underwrite {{name}} submission', taskDueDays: 2, active: true, createdAt: now(),
    fields: [
      { id: 'q1', label: 'Your name', type: 'text', required: true, map: 'name' },
      { id: 'q2', label: 'Email', type: 'email', required: true, map: 'email' },
      { id: 'q3', label: 'Phone', type: 'phone', required: false, map: 'phone' },
      { id: 'q4', label: 'Property address', type: 'text', required: true, map: 'title' },
      { id: 'q5', label: 'Asking price', type: 'number', required: false, map: 'value', placeholder: '1250000' },
      { id: 'q6', label: 'Number of units', type: 'number', required: false, map: 'none' },
      { id: 'q7', label: 'Anything we should know?', type: 'textarea', required: false, map: 'notes' }
    ]
  };

  /* the approved sign-in list. In live mode this collection is written by
     tools/provision-team.js and is never replaced by a reset; these rows
     are here so the Settings -> Team table is populated in demo mode. */
  const TEAM = [
    ['info@phcinvest.com', 'Main account'], ['chris@phcinvest.com', 'Chris'],
    ['isaiah@phcinvest.com', 'Isaiah'], ['adetutu@phcinvest.com', 'Adetutu'],
    ['nkem@phcinvest.com', 'Nkem'], ['pandora@phcinvest.com', 'Pandora'],
    ['famimi@phcinvest.com', 'Famimi'], ['grace@phcinvest.com', 'Grace'],
    ['glory@phcinvest.com', 'Glory']
  ].map(([email, name]) => ({ id: email, email, name, createdAt: now() }));

  const out = {
    org: {
      name: 'Pheenyx Capital', tagline: 'Pipeline Workflow',
      /* 'Acquisitions' is a desk, not a person - the seeded seller form
         assigns to it. Rename or remove any of these in Settings. */
      owners: ['Chris', 'Isaiah', 'Adetutu', 'Nkem', 'Pandora', 'Famimi', 'Grace', 'Glory', 'Acquisitions']
    },
    pipelines: [investor, acq, li], forms: [fInvestor, fSeller, fGhl],
    contacts: [], opportunities: [], tasks: [], activity: [], team: TEAM
  };

  const demo = [
    ['Marcus Feldman', 'marcus.feldman@northbridge.co', '(312) 555-0142', fInvestor, 'st_i3', 250000, -6, true],
    ['Priya Raghavan', 'priya.r@avenuecap.io', '(646) 555-0188', fInvestor, 'st_i1', 100000, -1, false],
    ['Dale Whitmore', 'dwhitmore@gmail.com', '(704) 555-0119', fInvestor, 'st_i1', 50000, 0, false],
    ['Sonia Alvarez', 'sonia@alvarezholdings.com', '(786) 555-0173', fInvestor, 'st_i5', 500000, -14, true],
    ['Ken Obi', 'ken.obi@outlook.com', '(214) 555-0166', fInvestor, 'st_i2', 100000, -3, false],
    ['Tanya Brooks', 'tanya.brooks@realtysouth.com', '(901) 555-0137', fSeller, 'st_a1', 1450000, -2, false],
    ['Ray Kessler', 'ray@kesslerprop.com', '(615) 555-0155', fSeller, 'st_a2', 2850000, -9, true],
    ['Jordan Mills', 'jmills@fastmail.com', '(404) 555-0121', fSeller, 'st_a1', 780000, 0, false]
  ];
  demo.forEach(([name, email, phone, form, stageId, value, dayOff, taskDone]) => {
    const created = dayShift(dayOff);
    const c = { id: uid('ct'), name, email, phone, formId: form.id, tags: form.tags.slice(), createdAt: created, answers: {} };
    form.fields.forEach(f => {
      if (f.map === 'name') c.answers[f.label] = name;
      else if (f.map === 'email') c.answers[f.label] = email;
      else if (f.map === 'phone') c.answers[f.label] = phone;
      else if (f.map === 'value') c.answers[f.label] = String(value);
      else if (f.map === 'title') c.answers[f.label] = '4821 Kingsley Ave';
      else if (f.map === 'notes') c.answers[f.label] = 'Submitted through ' + form.name + '.';
      else if (f.type === 'select') c.answers[f.label] = (f.options || [''])[0];
    });
    out.contacts.push(c);
    out.opportunities.push({
      id: uid('op'), contactId: c.id, pipelineId: form.pipelineId, stageId,
      title: form.pipelineId === acq.id ? (c.answers['Property address'] || name) : name,
      value, status: 'open', formId: form.id, owner: form.assignTo, createdAt: created, updatedAt: created
    });
    out.tasks.push({
      id: uid('tk'), contactId: c.id, formId: form.id, pipelineId: form.pipelineId,
      title: form.taskTemplate.replace('{{name}}', name), owner: form.assignTo,
      dueAt: dayShift(dayOff + form.taskDueDays), done: taskDone,
      doneAt: taskDone ? dayShift(dayOff + 1) : null, createdAt: created
    });
    out.activity.push({
      id: uid('ac'), at: created, type: 'submission',
      text: name + ' submitted "' + form.name + '"', pipelineId: form.pipelineId
    });
  });
  return out;
}

/* ====================================================== local back end */
function localSave() { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { console.warn('save failed', e); } }
function idx(coll, id) { return DB[coll].findIndex(x => x.id === id); }

const localBackend = {
  async put(coll, obj) {
    const i = idx(coll, obj.id);
    if (i >= 0) DB[coll][i] = obj; else DB[coll].push(obj);
    localSave(); notify();
  },
  async patch(coll, id, fields) {
    const i = idx(coll, id);
    if (i >= 0) Object.assign(DB[coll][i], fields);
    localSave(); notify();
  },
  async del(coll, id) { DB[coll] = DB[coll].filter(x => x.id !== id); localSave(); notify(); },
  async delMany(coll, ids) { const s = new Set(ids); DB[coll] = DB[coll].filter(x => !s.has(x.id)); localSave(); notify(); },
  async batch(ops) {
    ops.forEach(o => {
      if (o.op === 'put') { const i = idx(o.coll, o.data.id); if (i >= 0) DB[o.coll][i] = o.data; else DB[o.coll].push(o.data); }
      else if (o.op === 'patch') { const i = idx(o.coll, o.id); if (i >= 0) Object.assign(DB[o.coll][i], o.data); }
      else if (o.op === 'del') DB[o.coll] = DB[o.coll].filter(x => x.id !== o.id);
    });
    localSave(); notify();
  },
  async setOrg(org) { DB.org = org; localSave(); notify(); },
  async replaceAll(data) {
    const keepTeam = DB.team || [];            /* a reset must not revoke access */
    DB = Object.assign(emptyDb(), data);
    if (!data.team || !data.team.length) DB.team = keepTeam;
    localSave(); notify();
  }
};

/* =================================================== firestore backend */
function sortColl(coll, rows) {
  if (coll === 'pipelines') return rows.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.createdAt).localeCompare(b.createdAt));
  if (coll === 'activity') return rows.sort((a, b) => String(b.at).localeCompare(a.at));
  if (coll === 'contacts') return rows.sort((a, b) => String(b.createdAt).localeCompare(a.createdAt));
  return rows.sort((a, b) => String(a.createdAt || '').localeCompare(b.createdAt || ''));
}

function makeFirebaseBackend(fb) {
  const { fs, doc, setDoc, updateDoc, deleteDoc, writeBatch, collection, onSnapshot } = fb;
  const unsub = {};

  function listen(coll) {
    if (unsub[coll]) return;
    unsub[coll] = onSnapshot(collection(fs, coll),
      snap => {
        DB[coll] = sortColl(coll, snap.docs.map(d => Object.assign({ id: d.id }, d.data())));
        notify();
      },
      err => {
        /* an unauthenticated visitor on the public form page will hit this
           for the private collections - harmless, they never render them.
           A SIGNED-IN user hitting it means their email is not on the team. */
        if (err.code === 'permission-denied') {
          if (authed && PRIVATE_COLLS.indexOf(coll) >= 0) { denied = true; notify(); }
        } else console.warn('listener ' + coll, err);
      });
  }
  function stop(coll) { if (unsub[coll]) { unsub[coll](); delete unsub[coll]; DB[coll] = []; } }

  return {
    listen, stop,
    listenOrg() {
      if (unsub.__org) return;
      unsub.__org = onSnapshot(doc(fs, 'org', 'settings'),
        s => { if (s.exists()) { DB.org = Object.assign({}, DB.org, s.data()); notify(); } },
        () => {});
    },
    async put(coll, obj) {
      const copy = Object.assign({}, obj); delete copy.id;
      await setDoc(doc(fs, coll, obj.id), copy);
    },
    async patch(coll, id, fields) { await updateDoc(doc(fs, coll, id), fields); },
    async del(coll, id) { await deleteDoc(doc(fs, coll, id)); },
    async delMany(coll, ids) {
      for (let i = 0; i < ids.length; i += 400) {
        const b = writeBatch(fs);
        ids.slice(i, i + 400).forEach(id => b.delete(doc(fs, coll, id)));
        await b.commit();
      }
    },
    async batch(ops) {
      const b = writeBatch(fs);
      ops.forEach(o => {
        if (o.op === 'put') { const c = Object.assign({}, o.data); delete c.id; b.set(doc(fs, o.coll, o.data.id), c); }
        else if (o.op === 'patch') b.update(doc(fs, o.coll, o.id), o.data);
        else if (o.op === 'del') b.delete(doc(fs, o.coll, o.id));
      });
      await b.commit();
    },
    async setOrg(org) { await setDoc(doc(fs, 'org', 'settings'), org); },
    async replaceAll(data) {
      const ops = [];
      /* NEVER touch `team` here - wiping it would lock every member out of
         their own workspace. Team access is managed only in Settings. */
      RESETTABLE_COLLS.forEach(coll => (DB[coll] || []).forEach(r => ops.push({ op: 'del', coll, id: r.id })));
      RESETTABLE_COLLS.forEach(coll => (data[coll] || []).forEach(r => ops.push({ op: 'put', coll, data: r })));
      await this.batch(ops);
      if (data.org) await this.setOrg(data.org);
    }
  };
}

/* ================================================================ init */
/** local mode - synchronous, seeds itself on first run */
function initLocal() {
  MODE = 'local'; B = localBackend;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { DB = Object.assign(emptyDb(), JSON.parse(raw)); return Promise.resolve(DB); }
  } catch (e) { console.warn('storage read failed', e); }
  DB = Object.assign(emptyDb(), seedData());
  localSave();
  return Promise.resolve(DB);
}

/** firebase mode - resolves once the public collections have arrived once */
function initFirebase(fb) {
  MODE = 'firebase'; FB = fb; B = makeFirebaseBackend(fb);
  DB = emptyDb();
  return new Promise(resolve => {
    let left = PUBLIC_COLLS.length;
    const off = [];
    PUBLIC_COLLS.forEach(c => {
      B.listen(c);
      const once = () => { if (--left <= 0) { off.forEach(f => f()); resolve(DB); } };
      /* first notify after this collection populates counts as loaded */
      let fired = false;
      const h = () => { if (!fired) { fired = true; once(); } };
      subs.push(h); off.push(() => { const i = subs.indexOf(h); if (i >= 0) subs.splice(i, 1); });
    });
    B.listenOrg();
    setTimeout(() => { off.forEach(f => f()); resolve(DB); }, 6000); /* never hang the page */
  });
}

/** called by boot.js on every auth state change */
function setAuthed(on) {
  authed = !!on;
  denied = false;
  if (MODE !== 'firebase') return;
  if (on) PRIVATE_COLLS.forEach(c => B.listen(c));
  else PRIVATE_COLLS.forEach(c => B.stop(c));
  notify();
}
const isAuthed = () => authed;
const isDenied = () => denied;

/* ==================================================== lookups / helpers */
const pipeline = (id) => DB.pipelines.find(p => p.id === id);
const form = (id) => DB.forms.find(f => f.id === id);
const contact = (id) => DB.contacts.find(c => c.id === id);
const opp = (id) => DB.opportunities.find(o => o.id === id);
const stageName = (pid, sid) => {
  const p = pipeline(pid); const s = p && (p.stages || []).find(x => x.id === sid);
  return s ? s.name : '-';
};
const oppsIn = (pid) => DB.opportunities.filter(o => o.pipelineId === pid && o.status === 'open');
const formsFor = (pid) => DB.forms.filter(f => f.pipelineId === pid);
/** newest first, whichever backend is in use */
const activityFeed = (n) =>
  DB.activity.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, n || 20);

/* =========================================================== pipelines */
async function addPipeline(name, stageNames) {
  const stages = (stageNames || []).filter(s => s.trim()).map(s => ({ id: uid('st'), name: s.trim() }));
  const p = {
    id: uid('pl'), name: name.trim(), color: '#1e2d4a',
    order: DB.pipelines.length, createdAt: now(),
    stages: stages.length ? stages : [{ id: uid('st'), name: 'New Lead' }]
  };
  await B.put('pipelines', p); return p;
}
const renamePipeline = (id, name) => B.patch('pipelines', id, { name: name.trim() });

async function deletePipeline(id) {
  const ops = [{ op: 'del', coll: 'pipelines', id }];
  DB.opportunities.filter(o => o.pipelineId === id).forEach(o => ops.push({ op: 'del', coll: 'opportunities', id: o.id }));
  DB.forms.filter(f => f.pipelineId === id).forEach(f =>
    ops.push({ op: 'patch', coll: 'forms', id: f.id, data: { pipelineId: null, stageId: null, active: false } }));
  await B.batch(ops);
}
async function addStage(pid, name) {
  const p = pipeline(pid);
  await B.patch('pipelines', pid, { stages: p.stages.concat([{ id: uid('st'), name: (name || '').trim() || 'New Stage' }]) });
}
async function renameStage(pid, sid, name) {
  const stages = pipeline(pid).stages.map(s => s.id === sid ? { id: s.id, name: name.trim() } : s);
  await B.patch('pipelines', pid, { stages });
}
async function moveStage(pid, sid, dir) {
  const stages = pipeline(pid).stages.slice();
  const i = stages.findIndex(s => s.id === sid), j = i + dir;
  if (j < 0 || j >= stages.length) return;
  [stages[i], stages[j]] = [stages[j], stages[i]];
  await B.patch('pipelines', pid, { stages });
}
/** cards in a deleted stage fall back to the first stage so nothing is lost */
async function deleteStage(pid, sid) {
  const p = pipeline(pid);
  if (p.stages.length < 2) return false;
  const stages = p.stages.filter(s => s.id !== sid);
  const fallback = stages[0].id;
  const ops = [{ op: 'patch', coll: 'pipelines', id: pid, data: { stages } }];
  DB.opportunities.filter(o => o.pipelineId === pid && o.stageId === sid)
    .forEach(o => ops.push({ op: 'patch', coll: 'opportunities', id: o.id, data: { stageId: fallback, updatedAt: now() } }));
  DB.forms.filter(f => f.pipelineId === pid && f.stageId === sid)
    .forEach(f => ops.push({ op: 'patch', coll: 'forms', id: f.id, data: { stageId: fallback } }));
  await B.batch(ops); return true;
}

/* =============================================================== forms */
const saveForm = (f) => B.put('forms', f).then(() => f);
const deleteForm = (id) => B.del('forms', id);
function blankForm() {
  const p = DB.pipelines[0];
  return {
    id: uid('fm'),
    /* 'hosted' = a form people fill in on this site.
       'ghl'    = a receiver: the form lives in GoHighLevel and posts here. */
    source: 'hosted',
    name: '', headline: '', blurb: '',
    pipelineId: p ? p.id : null, stageId: p && p.stages[0] ? p.stages[0].id : null,
    tags: [], assignTo: (DB.org.owners || [])[0] || '', taskTemplate: 'Reach out to {{name}}',
    taskDueDays: 1, active: true, createdAt: now(),
    fields: [
      { id: uid('q'), label: 'Full name', type: 'text', required: true, map: 'name' },
      { id: uid('q'), label: 'Email', type: 'email', required: true, map: 'email' },
      { id: uid('q'), label: 'Phone', type: 'phone', required: false, map: 'phone' }
    ]
  };
}

/* ---- THE core of the app: one submission -> contact + card + task ---- */
async function submitForm(formId, answers) {
  const f = form(formId);
  if (!f) throw new Error('This form is no longer available.');
  if (!f.pipelineId || !f.stageId) throw new Error('This form is not connected to a pipeline yet.');

  const pick = (m) => { const fl = f.fields.find(x => x.map === m); return fl ? (answers[fl.id] || '') : ''; };
  const name = (pick('name') || 'Unnamed lead').slice(0, 120);
  const email = pick('email').slice(0, 160);
  const phone = pick('phone').slice(0, 40);
  const title = (pick('title') || name).slice(0, 160);
  const value = parseFloat(String(pick('value')).replace(/[^0-9.]/g, '')) || 0;
  const notes = pick('notes').slice(0, 4000);

  const labelled = {};
  f.fields.forEach(x => { labelled[x.label] = String(answers[x.id] == null ? '' : answers[x.id]).slice(0, 4000); });

  const c = {
    id: uid('ct'), name, email, phone, formId: f.id, tags: (f.tags || []).slice(),
    createdAt: now(), answers: labelled, notes
  };
  const o = {
    id: uid('op'), contactId: c.id, pipelineId: f.pipelineId, stageId: f.stageId,
    title, value, status: 'open', formId: f.id, owner: f.assignTo || '', createdAt: now(), updatedAt: now()
  };
  const t = {
    id: uid('tk'), contactId: c.id, formId: f.id, pipelineId: f.pipelineId,
    title: (f.taskTemplate || 'Reach out to {{name}}').replace('{{name}}', name),
    owner: f.assignTo || '', dueAt: dayShift(Number(f.taskDueDays) || 1),
    done: false, doneAt: null, createdAt: now()
  };
  const a = {
    id: uid('ac'), at: now(), type: 'submission',
    text: name + ' submitted "' + f.name + '"', pipelineId: f.pipelineId
  };
  await B.batch([
    { op: 'put', coll: 'contacts', data: c },
    { op: 'put', coll: 'opportunities', data: o },
    { op: 'put', coll: 'tasks', data: t },
    { op: 'put', coll: 'activity', data: a }
  ]);
  return { contact: c, opp: o, task: t, form: f };
}

/* ======================================================= opportunities */
async function moveOpp(oppId, stageId) {
  const o = opp(oppId);
  if (!o || o.stageId === stageId) return;
  const c = contact(o.contactId);
  await B.batch([
    { op: 'patch', coll: 'opportunities', id: oppId, data: { stageId, updatedAt: now() } },
    { op: 'put', coll: 'activity', data: {
      id: uid('ac'), at: now(), type: 'move', pipelineId: o.pipelineId,
      text: (c ? c.name : o.title) + ' moved to ' + stageName(o.pipelineId, stageId)
    } }
  ]);
}
const updateOpp = (id, patch) => B.patch('opportunities', id, Object.assign({}, patch, { updatedAt: now() }));
const deleteOpp = (id) => B.del('opportunities', id);

async function addOppManual({ pipelineId, stageId, name, email, phone, title, value, owner }) {
  const c = { id: uid('ct'), name, email: email || '', phone: phone || '', formId: null, tags: ['manual'], createdAt: now(), answers: {}, notes: '' };
  const o = {
    id: uid('op'), contactId: c.id, pipelineId, stageId, title: title || name,
    value: Number(value) || 0, status: 'open', formId: null, owner: owner || '', createdAt: now(), updatedAt: now()
  };
  const t = {
    id: uid('tk'), contactId: c.id, formId: null, pipelineId, title: 'Reach out to ' + name,
    owner: owner || '', dueAt: dayShift(1), done: false, doneAt: null, createdAt: now()
  };
  await B.batch([
    { op: 'put', coll: 'contacts', data: c },
    { op: 'put', coll: 'opportunities', data: o },
    { op: 'put', coll: 'tasks', data: t },
    { op: 'put', coll: 'activity', data: { id: uid('ac'), at: now(), type: 'manual', text: name + ' added manually', pipelineId } }
  ]);
  return o;
}

/* =============================================================== tasks */
async function toggleTask(id) {
  const t = DB.tasks.find(x => x.id === id);
  await B.patch('tasks', id, { done: !t.done, doneAt: !t.done ? now() : null });
}
const snoozeTask = (id, days) => B.patch('tasks', id, { dueAt: dayShift(days) });
async function addTask(contactId, title, days, owner) {
  const c = contact(contactId);
  const o = DB.opportunities.find(x => x.contactId === contactId);
  await B.put('tasks', {
    id: uid('tk'), contactId, formId: c ? c.formId : null, pipelineId: o ? o.pipelineId : null,
    title, owner: owner || '', dueAt: dayShift(days || 1), done: false, doneAt: null, createdAt: now()
  });
}
const deleteTask = (id) => B.del('tasks', id);
const assignTask = (id, owner) => B.patch('tasks', id, { owner: owner || '' });

/* ================================================================ team */
async function addTeam(email, name) {
  const key = email.trim().toLowerCase();
  await B.put('team', { id: key, email: key, name: name || '', createdAt: now() });
}
const removeTeam = (id) => B.del('team', id);
const renameTeam = (id, name) => B.patch('team', id, { name: name || '' });
/** the display name for a signed-in email, from the team allow-list */
function teamName(email) {
  const key = String(email || '').toLowerCase();
  const row = (DB.team || []).find(t => String(t.email || t.id || '').toLowerCase() === key);
  return row && row.name ? row.name : '';
}

/* ========================================================== org / data */
const saveOrg = (org) => B.setOrg(org);
const exportJson = () => JSON.stringify(DB, null, 2);
async function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed.pipelines || !parsed.forms) throw new Error('This file does not look like a Pheenyx pipeline backup.');
  await B.replaceAll(parsed);
}
async function seedRemote() { await B.replaceAll(seedData()); }
async function resetAll() { await B.replaceAll(seedData()); }
async function wipeRecords() {
  const ops = [];
  ['contacts', 'opportunities', 'tasks', 'activity'].forEach(coll =>
    DB[coll].forEach(r => ops.push({ op: 'del', coll, id: r.id })));
  await B.batch(ops);
}

window.Store = {
  initLocal, initFirebase, setAuthed, isAuthed, isDenied, mode, db, onChange,
  uid, now, dayShift,
  pipeline, form, contact, opp, stageName, oppsIn, formsFor, activityFeed,
  addPipeline, renamePipeline, deletePipeline, addStage, renameStage, moveStage, deleteStage,
  saveForm, deleteForm, blankForm, submitForm,
  moveOpp, updateOpp, deleteOpp, addOppManual,
  toggleTask, snoozeTask, addTask, deleteTask, assignTask,
  addTeam, removeTeam, renameTeam, teamName,
  saveOrg, exportJson, importJson, seedRemote, resetAll, wipeRecords
};
