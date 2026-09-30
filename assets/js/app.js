/* Pheenyx Capital - Pipeline Workflow
   app.js : routing, views, interactions.  Started by boot.js.

   Routes: #/dashboard #/pipelines #/pipeline/<id> #/forms #/forms/<id|new>
           #/contacts #/settings        (all require a signed-in team member)
           #/f/<formId>                 (public form - no login, ever)        */

const S = window.Store;
const app = () => document.getElementById('app');

/* ------------------------------------------------------------- helpers */
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const short = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n;
};
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysFromToday = (iso) => Math.round((startOfDay(iso) - startOfDay(new Date())) / 864e5);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function dueLabel(iso) {
  const d = daysFromToday(iso);
  if (d < 0) return { cls: 'overdue', text: Math.abs(d) + (Math.abs(d) === 1 ? ' day overdue' : ' days overdue') };
  if (d === 0) return { cls: 'today', text: 'Due today' };
  if (d === 1) return { cls: '', text: 'Due tomorrow' };
  return { cls: '', text: 'Due ' + fmtDate(iso) };
}
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  const d = Math.round(mins / 1440);
  return d === 1 ? 'yesterday' : d + 'd ago';
}
function toast(msg, kind) {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
/** every mutation is async now - surface failures instead of swallowing them */
function go(p, okMsg) {
  return Promise.resolve(p)
    .then(r => { if (okMsg) toast(okMsg, 'ok'); return r; })
    .catch(e => { console.error(e); toast(e && e.message ? e.message : 'Could not save that change.', 'bad'); throw e; })
    .catch(() => {});
}
const formUrl = (formId) => location.origin + location.pathname + '#/f/' + formId;
const liveMode = () => S.mode() === 'firebase';

/* --------------------------------------------------------------- modal */
let modalEl = null;
let openContactId = null;
function openModal({ title, body, footer, wide }) {
  closeModal();
  modalEl = document.createElement('div');
  modalEl.className = 'veil';
  modalEl.innerHTML =
    '<div class="modal ' + (wide ? 'wide' : '') + '">' +
    '<div class="modal-h"><h3>' + esc(title) + '</h3><button class="x" data-act="modal-close">&times;</button></div>' +
    '<div class="modal-b">' + body + '</div>' +
    (footer ? '<div class="modal-f">' + footer + '</div>' : '') + '</div>';
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
  const first = modalEl.querySelector('input,select,textarea');
  if (first) first.focus();
}
function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } openContactId = null; }
const mVal = (name) => { const e = modalEl && modalEl.querySelector('[name="' + name + '"]'); return e ? e.value.trim() : ''; };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------------------------------------------------------------- shell */
const NAV = [
  { r: 'dashboard', label: 'Dashboard', ic: '▦' },
  { r: 'pipelines', label: 'Pipelines', ic: '⌸' },
  { r: 'forms', label: 'Forms', ic: '☰' },
  { r: 'contacts', label: 'Contacts', ic: '☺' },
  { r: 'settings', label: 'Settings', ic: '⚙' }
];
function shell(route, topbar, content) {
  const d = S.db();
  const pending = d.tasks.filter(t => !t.done).length;
  const counts = { dashboard: pending, pipelines: d.pipelines.length, forms: d.forms.length, contacts: d.contacts.length, settings: 0 };
  const nav = NAV.map(n =>
    '<a class="' + (route === n.r ? 'on' : '') + '" href="#/' + n.r + '">' +
    '<span class="ic">' + n.ic + '</span>' + n.label +
    (counts[n.r] ? '<span class="count">' + counts[n.r] + '</span>' : '') + '</a>').join('');
  const pipeLinks = d.pipelines.map(p =>
    '<a href="#/pipeline/' + p.id + '"><span class="ic" style="color:' + esc(p.color || '#8697b0') + '">&#9679;</span>' +
    esc(p.name) + '<span class="count">' + S.oppsIn(p.id).length + '</span></a>').join('');
  const user = window.Auth && window.Auth.user ? window.Auth.user() : null;

  app().innerHTML =
    '<div class="shell">' +
      '<aside class="sidebar">' +
        '<div class="brand"><div class="mark">P</div><div><b>' + esc(d.org.name) + '</b><span>' + esc(d.org.tagline) + '</span></div></div>' +
        '<nav class="nav">' + nav + '<div class="nav-label">Your pipelines</div>' + pipeLinks + '</nav>' +
        '<div class="side-foot">' +
          '<button class="btn btn-sm" data-act="new-form">+ New form</button>' +
          '<button class="btn btn-sm" data-act="new-pipeline">+ New pipeline</button>' +
          (user ? '<div style="margin:10px 0 6px;color:#9fb0c8;word-break:break-all">' + esc(user.email) + '</div>' +
            '<button class="btn btn-sm" data-act="sign-out">Sign out</button>' : '') +
          '<div style="margin-top:8px">' + (liveMode()
            ? '<span class="pill ok"><span class="dot"></span>Live database</span>'
            : '<span class="pill warn">Local demo data</span>') + '</div>' +
        '</div>' +
      '</aside>' +
      '<div class="main"><div class="topbar">' + topbar + '</div><div class="content">' + content + '</div></div>' +
    '</div>';
}
const title = (h, sub) => '<div><h1>' + esc(h) + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div><div class="spacer"></div>';

/* ---------------------------------------------------------- login views */
let authView = 'in';   /* in | up | reset */
function viewLogin() {
  const d = S.db();
  const heads = { in: 'Sign in', up: 'Set your password', reset: 'Reset your password' };
  const blurbs = {
    in: 'Use your @phcinvest.com email and the temporary password you were sent. ' +
        'Please change it once you are in. Public forms do not need a login.',
    up: 'Only if you were added to the team but never given a password. Your email must already be on the team list.',
    reset: 'We will email you a reset link. Use this to change your temporary password too.'
  };
  app().innerHTML =
    '<div class="pub"><div class="pub-wrap" style="max-width:440px">' +
      '<div class="pub-brand"><div class="mark">P</div><div><b>' + esc(d.org.name) + '</b>' +
        '<span>' + esc(d.org.tagline) + '</span></div></div>' +
      '<div class="pub-card"><div class="hd"><h2>' + heads[authView] + '</h2><p>' + blurbs[authView] + '</p></div>' +
      '<div class="bd">' +
        '<label class="f"><span>Work email</span><input class="inp" id="aEmail" type="email" autocomplete="username" placeholder="you@phcinvest.com"></label>' +
        (authView === 'reset' ? '' :
          '<label class="f"><span>Password</span><input class="inp" id="aPass" type="password" autocomplete="' +
          (authView === 'up' ? 'new-password' : 'current-password') + '" placeholder="' +
          (authView === 'up' ? 'at least 6 characters' : '') + '"></label>') +
        '<div class="err hide" id="aErr"></div>' +
      '</div>' +
      '<div class="ft"><button class="btn btn-gold" data-act="auth-go">' +
        (authView === 'in' ? 'Sign in' : authView === 'up' ? 'Create password &amp; sign in' : 'Send reset email') +
      '</button></div></div>' +
      '<div class="pub-note">' +
        (authView === 'in'
          ? '<a href="#" data-act="auth-mode" data-m="up" style="text-decoration:underline">First time here?</a> &middot; ' +
            '<a href="#" data-act="auth-mode" data-m="reset" style="text-decoration:underline">Forgot password</a>'
          : '<a href="#" data-act="auth-mode" data-m="in" style="text-decoration:underline">Back to sign in</a>') +
      '</div>' +
    '</div></div>';
  const inp = document.getElementById('aEmail');
  if (inp) inp.focus();
  ['aEmail', 'aPass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
  });
}
function authErr(msg) {
  const e = document.getElementById('aErr');
  if (!e) return;
  e.textContent = msg; e.classList.toggle('hide', !msg);
}
function doAuth() {
  const email = (document.getElementById('aEmail') || {}).value || '';
  const passEl = document.getElementById('aPass');
  const pass = passEl ? passEl.value : '';
  authErr('');
  if (!email.trim()) { authErr('Enter your email address.'); return; }
  const A = window.Auth;
  if (authView === 'reset') {
    A.reset(email).then(() => { toast('Reset email sent to ' + email.trim(), 'ok'); authView = 'in'; viewLogin(); })
      .catch(e => authErr(e.message));
    return;
  }
  if (!pass) { authErr('Enter your password.'); return; }
  const p = authView === 'up' ? A.signUp(email, pass) : A.signIn(email, pass);
  p.catch(e => authErr(e.message));
}
function viewNoAccess() {
  const u = window.Auth.user();
  app().innerHTML =
    '<div class="pub"><div class="pub-wrap" style="max-width:480px">' +
      '<div class="pub-brand"><div class="mark">P</div><div><b>' + esc(S.db().org.name) + '</b><span>Pipeline Workflow</span></div></div>' +
      '<div class="pub-card"><div class="thanks">' +
        '<div class="ring" style="background:var(--warn-bg);color:var(--warn)">!</div>' +
        '<h2>Not on the team yet</h2>' +
        '<p class="muted">You are signed in as <b>' + esc(u ? u.email : '') + '</b>, but that email has not been ' +
        'given access to the pipelines. An admin adds it under Settings &rarr; Team.</p>' +
        '<button class="btn btn-primary" data-act="sign-out" style="margin-top:18px">Sign out</button>' +
      '</div></div>' +
    '</div></div>';
}

/* ------------------------------------------------------------ dashboard */
function viewDashboard() {
  const d = S.db();
  const open = d.tasks.filter(t => !t.done);
  const overdue = open.filter(t => daysFromToday(t.dueAt) < 0);
  const todayTasks = open.filter(t => daysFromToday(t.dueAt) === 0);
  const week = d.contacts.filter(c => daysFromToday(c.createdAt) > -7);
  const openOpps = d.opportunities.filter(o => o.status === 'open');
  const pipeValue = openOpps.reduce((s, o) => s + (Number(o.value) || 0), 0);

  const kpis = '<div class="kpis">' +
    kpi('Pending outreach', open.length, overdue.length + ' overdue &middot; ' + todayTasks.length + ' due today', true) +
    kpi('New leads (7 days)', week.length, d.contacts.length + ' contacts total') +
    kpi('Open opportunities', openOpps.length, 'across ' + d.pipelines.length + ' pipelines') +
    kpi('Open pipeline value', short(pipeValue), money(pipeValue)) + '</div>';

  const sorted = open.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const doneRecent = d.tasks.filter(t => t.done).sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt)).slice(0, 4);
  const tasksCard =
    '<div class="card"><div class="card-h"><h3>Pending tasks &mdash; people to reach out to</h3><div class="spacer"></div>' +
      '<span class="pill ' + (overdue.length ? 'bad' : 'ok') + '">' + open.length + ' open</span></div>' +
      (sorted.length ? sorted.map(taskRow).join('')
        : '<div class="empty"><div class="big">&#10003;</div>Nothing pending. Every lead has been actioned.</div>') +
      (doneRecent.length ? '<div class="card-h" style="border-top:1px solid var(--line);border-bottom:0">' +
        '<h3 class="muted tiny">Recently completed</h3></div>' + doneRecent.map(taskRow).join('') : '') +
    '</div>';

  const perForm = d.forms.map(f => ({ f, n: d.contacts.filter(c => c.formId === f.id).length })).sort((a, b) => b.n - a.n);
  const maxN = Math.max(1, ...perForm.map(x => x.n));
  const formsCard =
    '<div class="card"><div class="card-h"><h3>Form &rarr; pipeline routing</h3><div class="spacer"></div>' +
      '<button class="btn btn-sm btn-gold" data-act="new-form">+ New form</button></div><div class="card-b bars">' +
      (perForm.length ? perForm.map(x =>
        '<div class="bar-row"><div class="bl"><span><a href="#/forms/' + x.f.id + '"><b>' + esc(x.f.name) + '</b></a><br>' +
        '<span class="muted tiny">&rarr; ' + esc(x.f.pipelineId && S.pipeline(x.f.pipelineId) ? S.pipeline(x.f.pipelineId).name : 'not routed') +
        ' / ' + esc(x.f.stageId ? S.stageName(x.f.pipelineId, x.f.stageId) : '-') + '</span></span><b>' + x.n + '</b></div>' +
        '<div class="track"><i style="width:' + Math.round(x.n / maxN * 100) + '%"></i></div></div>').join('')
        : '<div class="empty">No forms yet. Create one to start collecting leads.</div>') + '</div></div>';

  const feed = S.activityFeed(8);
  const activityCard =
    '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Activity</h3></div>' +
      (feed.length ? feed.map(a =>
        '<div class="task"><div><div class="t-title">' + esc(a.text) + '</div><div class="t-meta">' + ago(a.at) +
        (a.pipelineId && S.pipeline(a.pipelineId) ? ' &middot; ' + esc(S.pipeline(a.pipelineId).name) : '') +
        '</div></div></div>').join('') : '<div class="empty">No activity yet.</div>') + '</div>';

  const recent = d.contacts.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
  const subsCard =
    '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Recent submissions</h3><div class="spacer"></div>' +
      '<a class="btn btn-sm" href="#/contacts">View all</a></div><div class="scroll-x"><table class="tbl">' +
      '<thead><tr><th>Name</th><th>Contact</th><th>Form</th><th>Pipeline</th><th>Stage</th><th>Value</th><th>Received</th><th></th></tr></thead><tbody>' +
      (recent.length ? recent.map(c => {
        const o = d.opportunities.find(x => x.contactId === c.id);
        const f = c.formId ? S.form(c.formId) : null;
        return '<tr><td class="n">' + esc(c.name) + '</td>' +
          '<td class="tiny muted">' + esc(c.email || '') + (c.phone ? '<br>' + esc(c.phone) : '') + '</td>' +
          '<td>' + (f ? '<span class="pill gold">' + esc(f.name) + '</span>' : '<span class="pill">manual</span>') + '</td>' +
          '<td>' + (o && S.pipeline(o.pipelineId) ? esc(S.pipeline(o.pipelineId).name) : '-') + '</td>' +
          '<td>' + (o ? '<span class="pill info">' + esc(S.stageName(o.pipelineId, o.stageId)) + '</span>' : '-') + '</td>' +
          '<td>' + (o && o.value ? money(o.value) : '<span class="muted">-</span>') + '</td>' +
          '<td class="tiny muted">' + ago(c.createdAt) + '</td>' +
          '<td><button class="btn btn-sm" data-act="contact" data-id="' + c.id + '">Open</button></td></tr>';
      }).join('') : '<tr><td colspan="8"><div class="empty">No submissions yet. Open one of your forms and try it.</div></td></tr>') +
      '</tbody></table></div></div>';

  shell('dashboard',
    title('Dashboard', 'Everything that came in through a form, and who still needs a call.') +
    '<button class="btn" data-act="try-form">Open a form as a lead</button>' +
    '<button class="btn btn-gold" data-act="new-form">+ New form</button>',
    kpis + '<div class="two"><div>' + tasksCard + subsCard + '</div><div>' + formsCard + activityCard + '</div></div>');
}
const kpi = (lab, val, foot, accent) =>
  '<div class="kpi ' + (accent ? 'accent' : '') + '"><div class="lab">' + lab + '</div>' +
  '<div class="val">' + val + '</div><div class="foot">' + foot + '</div></div>';

function taskRow(t) {
  const c = S.contact(t.contactId);
  const dl = dueLabel(t.dueAt);
  const p = t.pipelineId ? S.pipeline(t.pipelineId) : null;
  const o = c ? S.db().opportunities.find(x => x.contactId === c.id) : null;
  return '<div class="task ' + (t.done ? 'done' : '') + '">' +
    '<button class="chk" data-act="task-toggle" data-id="' + t.id + '" title="Mark done">&#10003;</button>' +
    '<div style="min-width:0"><div class="t-title">' + esc(t.title) + '</div><div class="t-meta">' +
      (t.done ? '<span class="pill ok">done ' + ago(t.doneAt) + '</span>' : '<span class="' + dl.cls + '">' + dl.text + '</span>') +
      (c && c.phone ? '<span class="muted">&middot; ' + esc(c.phone) + '</span>' : '') +
      (c && c.email ? '<span class="muted">&middot; ' + esc(c.email) + '</span>' : '') +
      (p ? '<span class="pill">' + esc(p.name) + (o ? ' / ' + esc(S.stageName(o.pipelineId, o.stageId)) : '') + '</span>' : '') +
      (t.owner ? '<span class="pill">@' + esc(t.owner) + '</span>' : '') +
    '</div></div><div class="t-act">' +
      (c ? '<button class="btn btn-sm" data-act="contact" data-id="' + c.id + '">Open</button>' : '') +
      (t.done ? '' : '<button class="btn btn-sm" data-act="task-snooze" data-id="' + t.id + '">Snooze</button>') +
    '</div></div>';
}

/* ------------------------------------------------------- pipelines list */
function viewPipelines() {
  const d = S.db();
  const cards = d.pipelines.map(p => {
    const opps = S.oppsIn(p.id);
    const val = opps.reduce((s, o) => s + (Number(o.value) || 0), 0);
    const forms = S.formsFor(p.id);
    return '<div class="card"><div class="card-h">' +
      '<span class="dot" style="color:' + esc(p.color || '#1e2d4a') + '"></span><h3>' + esc(p.name) + '</h3>' +
      '<div class="spacer"></div><a class="btn btn-sm btn-primary" href="#/pipeline/' + p.id + '">Open board</a></div>' +
      '<div class="card-b"><div class="row" style="margin-bottom:14px">' +
        '<div><div class="tiny muted">Opportunities</div><b style="font-size:19px">' + opps.length + '</b></div>' +
        '<div><div class="tiny muted">Value</div><b style="font-size:19px">' + short(val) + '</b></div>' +
        '<div><div class="tiny muted">Stages</div><b style="font-size:19px">' + p.stages.length + '</b></div>' +
        '<div><div class="tiny muted">Feeder forms</div><b style="font-size:19px">' + forms.length + '</b></div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
          p.stages.map(s => '<span class="pill">' + esc(s.name) + ' <b>' + opps.filter(o => o.stageId === s.id).length + '</b></span>').join('') +
        '</div><div class="tiny muted">Fed by: ' + (forms.length ? forms.map(f =>
          '<a href="#/forms/' + f.id + '"><span class="pill gold">' + esc(f.name) + '</span></a>').join(' ')
          : '<i>no form points here yet</i>') + '</div></div>' +
      '<div class="modal-f" style="border-top:1px solid var(--line)">' +
        '<button class="btn btn-sm left" data-act="pl-rename" data-id="' + p.id + '">Rename</button>' +
        '<button class="btn btn-sm" data-act="new-form" data-pipeline="' + p.id + '">+ Form into this pipeline</button>' +
        '<button class="btn btn-sm btn-danger" data-act="pl-delete" data-id="' + p.id + '">Delete</button>' +
      '</div></div>';
  }).join('');
  shell('pipelines',
    title('Pipelines', 'Create the stages a lead moves through, then point a form at the first stage.') +
    '<button class="btn btn-gold" data-act="new-pipeline">+ New pipeline</button>',
    '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))">' +
    (cards || '<div class="card"><div class="empty"><div class="big">&#9776;</div>No pipelines yet.<br><br>' +
      '<button class="btn btn-gold" data-act="new-pipeline">+ Create your first pipeline</button></div></div>') + '</div>');
}

/* --------------------------------------------------------- kanban board */
function viewBoard(pid) {
  const p = S.pipeline(pid);
  if (!p) { location.hash = '#/pipelines'; return; }
  const opps = S.oppsIn(pid);
  const forms = S.formsFor(pid);
  const total = opps.reduce((s, o) => s + (Number(o.value) || 0), 0);
  const cols = p.stages.map((s, i) => {
    const items = opps.filter(o => o.stageId === s.id).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const sum = items.reduce((x, o) => x + (Number(o.value) || 0), 0);
    const feeders = forms.filter(f => f.stageId === s.id);
    return '<div class="col" data-stage="' + s.id + '"><div class="col-h"><div class="top">' +
      '<span class="nm">' + esc(s.name) + '</span><span class="num">' + items.length + '</span>' +
      '<button class="btn btn-sm btn-icon" data-act="stage-menu" data-id="' + s.id + '" data-i="' + i + '" title="Stage options">&#8943;</button>' +
      '</div><div class="sum">' + short(sum) +
      (feeders.length ? ' &middot; <span class="pill gold" title="' + esc(feeders.map(f => f.name).join(', ')) + '">&#8600; form entry</span>' : '') +
      '</div></div><div class="col-b" data-drop="' + s.id + '">' + items.map(oppCard).join('') + '</div>' +
      '<div class="col-add"><button class="btn btn-sm" data-act="opp-new" data-stage="' + s.id + '">+ Add</button></div></div>';
  }).join('');
  shell('pipelines',
    title(p.name, opps.length + ' open &middot; ' + money(total) + ' &middot; fed by ' + forms.length + ' form' + (forms.length === 1 ? '' : 's')) +
    '<a class="btn btn-sm" href="#/pipelines">All pipelines</a>' +
    '<button class="btn btn-sm" data-act="pl-rename" data-id="' + p.id + '">Rename</button>' +
    '<button class="btn btn-sm btn-gold" data-act="new-form" data-pipeline="' + p.id + '">+ Form into this pipeline</button>',
    (forms.length ? '' : '<div class="card" style="margin-bottom:14px;border-left:3px solid var(--gold)"><div class="card-b tiny">' +
      '<b>No form feeds this pipeline yet.</b> Leads can only arrive here manually. ' +
      '<button class="btn btn-sm btn-gold" data-act="new-form" data-pipeline="' + p.id + '">Create a form for it</button></div></div>') +
    '<div class="board-wrap"><div class="board">' + cols +
    '<button class="stage-new" data-act="stage-add" data-id="' + p.id + '">+ Add stage</button></div></div>');
  wireDnd();
}
function oppCard(o) {
  const c = S.contact(o.contactId);
  const f = o.formId ? S.form(o.formId) : null;
  return '<div class="opp" draggable="true" data-opp="' + o.id + '" data-act="opp-open" data-id="' + o.id + '">' +
    '<div class="t">' + esc(o.title) + '</div>' +
    (c && c.name !== o.title ? '<div class="who">' + esc(c.name) + '</div>' : '') +
    '<div class="m">' + (o.value ? '<span class="v">' + money(o.value) + '</span>' : '') +
      (o.owner ? '<span class="pill">@' + esc(o.owner) + '</span>' : '') +
      '<span class="pill">' + ago(o.createdAt) + '</span></div>' +
    (c && (c.phone || c.email) ? '<div class="who tiny" style="margin-top:6px">' + esc(c.phone || c.email) + '</div>' : '') +
    '<div class="src">' + (f ? '&#8600; ' + esc(f.name) : o.formId ? '&#8600; form' : '&#9998; added manually') + '</div></div>';
}
function wireDnd() {
  let dragId = null;
  document.querySelectorAll('.opp').forEach(el => {
    el.addEventListener('dragstart', e => {
      dragId = el.dataset.opp; el.classList.add('dragging');
      e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragId = null; });
  });
  document.querySelectorAll('[data-drop]').forEach(zone => {
    const col = zone.closest('.col');
    zone.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
    zone.addEventListener('dragleave', () => col.classList.remove('over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain') || dragId;
      if (id) go(S.moveOpp(id, zone.dataset.drop), 'Moved to ' + col.querySelector('.nm').textContent);
    });
  });
}

/* ----------------------------------------------------------- forms list */
function viewForms() {
  const d = S.db();
  const rows = d.forms.map(f => {
    const n = d.contacts.filter(c => c.formId === f.id).length;
    const p = f.pipelineId ? S.pipeline(f.pipelineId) : null;
    const ghl = f.source === 'ghl';
    return '<tr><td><div class="n">' + esc(f.name) + ' ' +
        (ghl ? '<span class="pill gold" title="The form lives in GoHighLevel and posts here">GHL</span>'
             : '<span class="pill" title="Hosted on this site">hosted</span>') + '</div>' +
      '<div class="tiny muted">' + f.fields.length + ' fields &middot; created ' + fmtDate(f.createdAt) + '</div></td>' +
      '<td>' + (p ? '<b>' + esc(p.name) + '</b><div class="tiny muted">&rarr; ' + esc(S.stageName(f.pipelineId, f.stageId)) + '</div>'
        : '<span class="pill bad">not routed</span>') + '</td>' +
      '<td>' + (f.tags || []).map(t => '<span class="pill">' + esc(t) + '</span>').join(' ') + '</td>' +
      '<td>' + (f.assignTo ? '@' + esc(f.assignTo) : '<span class="muted">-</span>') + '</td>' +
      '<td><b>' + n + '</b></td>' +
      '<td>' + (f.active ? '<span class="pill ok"><span class="dot"></span>live</span>' : '<span class="pill">paused</span>') + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-sm" data-act="form-open" data-id="' + f.id + '">' + (ghl ? 'Test' : 'Preview') + '</button> ' +
        '<button class="btn btn-sm" data-act="form-share" data-id="' + f.id + '">' + (ghl ? 'Webhook' : 'Share') + '</button> ' +
        '<a class="btn btn-sm btn-primary" href="#/forms/' + f.id + '">Edit</a></td></tr>';
  }).join('');
  shell('forms',
    title('Forms', 'Every form is wired to one pipeline and one stage. Fill it in and the lead lands on that board.') +
    '<button class="btn btn-gold" data-act="new-form">+ New form</button>',
    '<div class="card"><div class="scroll-x"><table class="tbl"><thead><tr>' +
    '<th>Form</th><th>Goes into</th><th>Tags applied</th><th>Assigned</th><th>Submissions</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' + (rows ||
      '<tr><td colspan="7"><div class="empty"><div class="big">&#9776;</div>No forms yet.<br><br>' +
      '<button class="btn btn-gold" data-act="new-form">+ Create your first form</button></div></td></tr>') +
    '</tbody></table></div></div>');
}

/* --------------------------------------------------------- form builder */
const FIELD_TYPES = [['text', 'Short text'], ['email', 'Email'], ['phone', 'Phone'], ['number', 'Number'],
  ['select', 'Dropdown'], ['radio', 'Radio buttons'], ['textarea', 'Long text'], ['date', 'Date']];
const MAPS = [['none', 'Just store the answer'], ['name', 'Contact name'], ['email', 'Contact email'],
  ['phone', 'Contact phone'], ['title', 'Opportunity title'], ['value', 'Opportunity value ($)'], ['notes', 'Notes']];
let draft = null;

function viewFormBuilder(id) {
  const d = S.db();
  if (!draft || (id !== 'new' && draft.id !== id)) {
    draft = id === 'new' ? S.blankForm() : JSON.parse(JSON.stringify(S.form(id) || S.blankForm()));
  }
  const f = draft;
  const p = f.pipelineId ? S.pipeline(f.pipelineId) : null;

  const routing =
    '<div class="card"><div class="card-h"><h3>1. Where do these leads go?</h3><div class="spacer"></div>' +
      '<span class="pill gold">the link between form and pipeline</span></div><div class="card-b">' +
      '<div class="row">' +
        '<label class="f"><span>Pipeline <span class="req">*</span></span><select class="inp" data-fb="pipelineId">' +
          '<option value="">- pick a pipeline -</option>' +
          d.pipelines.map(x => '<option value="' + x.id + '"' + (x.id === f.pipelineId ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') +
        '</select></label>' +
        '<label class="f"><span>Lands in stage <span class="req">*</span></span><select class="inp" data-fb="stageId">' +
          (p ? p.stages.map(s => '<option value="' + s.id + '"' + (s.id === f.stageId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') : '') +
        '</select></label></div>' +
      '<div class="row">' +
        '<label class="f"><span>Tags to apply</span><input class="inp" data-fb="tags" value="' + esc((f.tags || []).join(', ')) + '" placeholder="investor, webinar"></label>' +
        '<label class="f"><span>Assign follow-up to</span><input class="inp" data-fb="assignTo" value="' + esc(f.assignTo || '') + '" placeholder="Chris" list="owners"></label></div>' +
      '<div class="row">' +
        '<label class="f"><span>Follow-up task title</span><input class="inp" data-fb="taskTemplate" value="' + esc(f.taskTemplate || '') + '" placeholder="Call {{name}} - new lead"></label>' +
        '<label class="f"><span>Task due in (days)</span><input class="inp" type="number" min="0" max="60" data-fb="taskDueDays" value="' + esc(f.taskDueDays) + '"></label></div>' +
      '<datalist id="owners">' + (d.org.owners || []).map(o => '<option>' + esc(o) + '</option>').join('') + '</datalist>' +
      '<div class="tiny muted">Use <code>{{name}}</code> in the task title and it is replaced with the person who submitted.</div>' +
    '</div></div>';

  const isGhl = f.source === 'ghl';

  const origin =
    '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Where is this form filled in?</h3></div>' +
    '<div class="card-b"><div class="row">' +
      '<label class="f" style="margin:0"><span>Source</span><select class="inp" data-fb="source">' +
        '<option value="hosted"' + (isGhl ? '' : ' selected') + '>On this website (we host the form)</option>' +
        '<option value="ghl"' + (isGhl ? ' selected' : '') + '>In GoHighLevel (GHL posts the data here)</option>' +
      '</select></label>' +
    '</div><div class="tiny muted" style="margin-top:8px">' +
      (isGhl
        ? 'Nobody fills this form in here &mdash; it is a <b>receiver</b>. The form lives in GHL; ' +
          'this record decides which pipeline and stage the GHL lead lands in, and its field names ' +
          'tell us how to read the payload. Save it, then <b>Share</b> gives you the webhook URL for GHL.'
        : 'This form gets a public link and an embed code. People fill it in here.') +
    '</div></div></div>';

  const details =
    '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>' +
      (isGhl ? '2. Naming' : '2. What the form says') + '</h3></div><div class="card-b">' +
      '<label class="f"><span>Form name (internal) <span class="req">*</span></span>' +
        '<input class="inp" data-fb="name" value="' + esc(f.name) + '" placeholder="' +
        (isGhl ? 'GHL - Investor Interest' : 'Investor Interest Form') + '"></label>' +
      (isGhl
        ? '<div class="tiny muted" style="margin:-4px 0 12px">Name it after the GHL form it receives, so the ' +
          'dashboard shows where each lead came from.</div>'
        : '<label class="f"><span>Public headline</span>' +
            '<input class="inp" data-fb="headline" value="' + esc(f.headline || '') + '" placeholder="Invest with Pheenyx Capital"></label>' +
          '<label class="f"><span>Public sub-text</span>' +
            '<textarea class="inp" data-fb="blurb" placeholder="Tell us about your goals...">' + esc(f.blurb || '') + '</textarea></label>') +
      '<label class="f" style="display:flex;gap:9px;align-items:center;margin:0"><input type="checkbox" data-fb="active"' + (f.active ? ' checked' : '') + '>' +
        '<span style="margin:0">' + (isGhl ? 'Accepting leads from GoHighLevel' : 'Form is live and accepting submissions') + '</span></label>' +
      (isGhl ? '<div class="tiny muted" style="margin-top:6px">Unticked, the webhook answers GHL with ' +
        '&ldquo;paused&rdquo; and saves nothing.</div>' : '') +
    '</div></div>';

  const fields =
    '<div class="card"><div class="card-h"><h3>3. ' + (isGhl ? 'Fields to capture' : 'Questions') + '</h3>' +
      '<div class="spacer"></div><button class="btn btn-sm" data-act="fb-add">+ Add ' + (isGhl ? 'field' : 'question') + '</button></div>' +
      '<div class="card-b">' +
      (isGhl ? '<div class="tiny muted" style="margin:-4px 0 12px;padding:9px 11px;background:var(--gold-soft);border-radius:8px">' +
        '<b>Match these labels to your GHL field names.</b> A GHL field called ' +
        '&ldquo;Capital you are looking to deploy&rdquo; fills the field with that label here. ' +
        'Name, email and phone are recognised automatically (<code>first_name</code>, <code>full_name</code>, ' +
        '<code>email</code>, <code>phone</code> and the usual variants), so you mostly only need to add your ' +
        'custom questions. Anything GHL sends that has no field here is still saved on the contact.</div>' : '') +
      f.fields.map((q, i) => fieldRow(q, i, f.fields.length)).join('') +
      (f.fields.length ? '' : '<div class="empty">Nothing yet.</div>') + '</div></div>';

  shell('forms',
    title(id === 'new' ? 'New form' : 'Edit form',
      liveMode() ? 'Saves to the live database - the share link works for anyone.' : 'Local demo mode - saves to this browser.') +
    '<a class="btn" href="#/forms">Cancel</a>' +
    (id !== 'new' && S.form(id) ? '<button class="btn btn-danger" data-act="form-delete" data-id="' + id + '">Delete</button>' : '') +
    '<button class="btn" data-act="fb-preview">Preview</button>' +
    '<button class="btn btn-gold" data-act="fb-save">Save form</button>',
    '<div class="two" style="grid-template-columns:1fr 1fr"><div>' + origin + details + fields + '</div><div>' + routing +
    '<div class="card" style="margin-top:16px"><div class="card-h"><h3>How this works</h3></div><div class="card-b tiny muted">' +
      '<p style="margin-top:0"><b>' + (isGhl ? 'One GHL submission' : 'One submission') + ' creates three things:</b></p>' +
      '<p>1. a <b>Contact</b> with every answer, the form it came from and the date,<br>' +
      '2. a <b>card on the pipeline board</b> in the stage you picked,<br>' +
      '3. a <b>pending task</b> on the dashboard so somebody reaches out.</p>' +
      '<p>Map a field to <i>Contact name / email / phone</i> so the card and the task know who to call. ' +
      'Map one to <i>Opportunity value</i> and the board totals up.</p>' +
      (isGhl ? '<p><b>No GHL pipeline is involved.</b> The only trigger needed in GHL is ' +
        '&ldquo;Form Submitted&rdquo;. Nothing here reads or changes GHL opportunities or stages.</p>' : '') +
    '</div></div></div></div>');
}
function fieldRow(q, i, n) {
  return '<div class="fld" data-q="' + q.id + '"><div class="hd"><span class="idx">Q' + (i + 1) + '</span>' +
    '<span class="pill">' + esc((FIELD_TYPES.find(t => t[0] === q.type) || ['', q.type])[1]) + '</span>' +
    (q.map && q.map !== 'none' ? '<span class="pill gold">&rarr; ' + esc((MAPS.find(m => m[0] === q.map) || ['', q.map])[1]) + '</span>' : '') +
    '<div class="spacer"></div>' +
    '<button class="btn btn-sm btn-icon" data-act="fb-up" data-id="' + q.id + '"' + (i === 0 ? ' disabled' : '') + '>&uarr;</button>' +
    '<button class="btn btn-sm btn-icon" data-act="fb-down" data-id="' + q.id + '"' + (i === n - 1 ? ' disabled' : '') + '>&darr;</button>' +
    '<button class="btn btn-sm btn-danger btn-icon" data-act="fb-del" data-id="' + q.id + '">&times;</button></div>' +
    '<div class="kv" style="margin-bottom:8px">' +
      '<input class="inp" data-q-label="' + q.id + '" value="' + esc(q.label) + '" placeholder="Question label">' +
      '<select class="inp" data-q-type="' + q.id + '">' + FIELD_TYPES.map(t =>
        '<option value="' + t[0] + '"' + (t[0] === q.type ? ' selected' : '') + '>' + t[1] + '</option>').join('') + '</select>' +
      '<select class="inp" data-q-map="' + q.id + '">' + MAPS.map(m =>
        '<option value="' + m[0] + '"' + (m[0] === (q.map || 'none') ? ' selected' : '') + '>' + m[1] + '</option>').join('') + '</select></div>' +
    '<div class="kv"><input class="inp" data-q-ph="' + q.id + '" value="' + esc(q.placeholder || '') + '" placeholder="Placeholder (optional)">' +
      '<label class="tiny" style="display:flex;gap:7px;align-items:center;flex:0 0 auto">' +
      '<input type="checkbox" data-q-req="' + q.id + '"' + (q.required ? ' checked' : '') + '> Required</label></div>' +
    (q.type === 'select' || q.type === 'radio'
      ? '<textarea class="inp" style="margin-top:8px;min-height:62px" data-q-opts="' + q.id + '" placeholder="One choice per line">' +
        esc((q.options || []).join('\n')) + '</textarea>' : '') + '</div>';
}
function harvestDraft() {
  document.querySelectorAll('[data-fb]').forEach(el => {
    const k = el.dataset.fb;
    if (k === 'tags') draft.tags = el.value.split(',').map(s => s.trim()).filter(Boolean);
    else if (k === 'active') draft.active = el.checked;
    else if (k === 'taskDueDays') draft.taskDueDays = Number(el.value) || 0;
    else draft[k] = el.value;
  });
  draft.fields.forEach(q => {
    const g = (sel) => document.querySelector('[data-q-' + sel + '="' + q.id + '"]');
    if (g('label')) q.label = g('label').value;
    if (g('type')) q.type = g('type').value;
    if (g('map')) q.map = g('map').value;
    if (g('ph')) q.placeholder = g('ph').value;
    if (g('req')) q.required = g('req').checked;
    const o = g('opts');
    if (o) { q.options = o.value.split('\n').map(s => s.trim()).filter(Boolean); delete q.optionLabels; }
  });
}

/* ------------------------------------------------------------- contacts */
function viewContacts() {
  const d = S.db();
  const q = (window.__cq || '').toLowerCase();
  const list = d.contacts.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter(c => !q || ((c.name || '') + ' ' + (c.email || '') + ' ' + (c.phone || '')).toLowerCase().includes(q));
  const rows = list.map(c => {
    const o = d.opportunities.find(x => x.contactId === c.id);
    const f = c.formId ? S.form(c.formId) : null;
    const open = d.tasks.filter(t => t.contactId === c.id && !t.done).length;
    return '<tr><td><div class="n">' + esc(c.name) + '</div><div class="tiny muted">' + esc(c.email || '') + '</div></td>' +
      '<td class="tiny">' + esc(c.phone || '-') + '</td>' +
      '<td>' + (f ? '<span class="pill gold">' + esc(f.name) + '</span>' : '<span class="pill">manual</span>') + '</td>' +
      '<td>' + (o ? esc((S.pipeline(o.pipelineId) || {}).name || '-') + ' <span class="pill info">' + esc(S.stageName(o.pipelineId, o.stageId)) + '</span>' : '-') + '</td>' +
      '<td>' + (open ? '<span class="pill warn">' + open + ' open</span>' : '<span class="pill ok">clear</span>') + '</td>' +
      '<td class="tiny muted">' + fmtDate(c.createdAt) + '</td>' +
      '<td><button class="btn btn-sm" data-act="contact" data-id="' + c.id + '">Open</button></td></tr>';
  }).join('');
  shell('contacts',
    title('Contacts', d.contacts.length + ' people have come through your forms.') +
    '<input class="inp" style="max-width:250px" id="cq" placeholder="Search name, email, phone" value="' + esc(window.__cq || '') + '">',
    '<div class="card"><div class="scroll-x"><table class="tbl"><thead><tr>' +
    '<th>Name</th><th>Phone</th><th>Came from</th><th>Pipeline / stage</th><th>Tasks</th><th>Added</th><th></th>' +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">No contacts match.</div></td></tr>') +
    '</tbody></table></div></div>');
  const cq = document.getElementById('cq');
  cq.addEventListener('input', () => {
    window.__cq = cq.value;
    const pos = cq.selectionStart; viewContacts();
    const n = document.getElementById('cq'); n.focus(); n.setSelectionRange(pos, pos);
  });
}

function openContact(id) {
  const d = S.db(), c = S.contact(id);
  if (!c) return;
  const o = d.opportunities.find(x => x.contactId === id);
  const f = c.formId ? S.form(c.formId) : null;
  const tasks = d.tasks.filter(t => t.contactId === id);
  const answers = Object.entries(c.answers || {});
  openModal({
    title: c.name, wide: true,
    body:
      '<div class="kvlist" style="margin-bottom:18px">' +
        kvRow('Email', c.email ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>' : '-') +
        kvRow('Phone', c.phone ? '<a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a>' : '-') +
        kvRow('Came from', f ? '<span class="pill gold">' + esc(f.name) + '</span>' : '<span class="pill">added manually</span>') +
        kvRow('Pipeline', o ? esc((S.pipeline(o.pipelineId) || {}).name || '-') + ' &rarr; <span class="pill info">' + esc(S.stageName(o.pipelineId, o.stageId)) + '</span>' : '-') +
        kvRow('Value', o && o.value ? money(o.value) : '-') +
        kvRow('Tags', (c.tags || []).map(t => '<span class="pill">' + esc(t) + '</span>').join(' ') || '-') +
        kvRow('Received', fmtDateTime(c.createdAt)) +
      '</div>' +
      (o ? '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Move stage</h3></div><div class="card-b">' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        ((S.pipeline(o.pipelineId) || { stages: [] }).stages || []).map(s =>
          '<button class="btn btn-sm ' + (s.id === o.stageId ? 'btn-primary' : '') + '" data-act="opp-stage" data-id="' + o.id + '" data-stage="' + s.id + '">' + esc(s.name) + '</button>').join('') +
        '</div></div></div>' : '') +
      '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Tasks</h3><div class="spacer"></div>' +
        '<button class="btn btn-sm" data-act="task-add" data-id="' + c.id + '">+ Task</button></div>' +
        (tasks.length ? tasks.map(taskRow).join('') : '<div class="empty tiny">No tasks.</div>') + '</div>' +
      '<div class="card"><div class="card-h"><h3>Form answers</h3></div><div class="card-b">' +
        (answers.length ? '<div class="kvlist">' + answers.map(([k, v]) => kvRow(k, esc(v) || '-')).join('') + '</div>'
          : '<div class="muted tiny">No stored answers (added manually).</div>') + '</div></div>',
    footer: (o ? '<button class="btn btn-danger left" data-act="opp-delete" data-id="' + o.id + '">Remove from pipeline</button>' : '') +
      '<button class="btn" data-act="modal-close">Close</button>'
  });
  openContactId = id;
}
const kvRow = (k, v) => '<div class="k">' + esc(k) + '</div><div>' + v + '</div>';

/* ------------------------------------------------------------- settings */
function viewSettings() {
  const d = S.db();
  const team = d.team || [];
  const teamCard = liveMode()
    ? '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Team access</h3><div class="spacer"></div>' +
      '<button class="btn btn-sm btn-gold" data-act="team-add">+ Add member</button></div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr><th>Email</th><th>Name</th><th>Added</th><th></th></tr></thead><tbody>' +
      (team.length ? team.map(t =>
        '<tr><td class="n">' + esc(t.email) + '</td><td>' + esc(t.name || '-') + '</td>' +
        '<td class="tiny muted">' + (t.createdAt ? fmtDate(t.createdAt) : '-') + '</td>' +
        '<td><button class="btn btn-sm btn-danger" data-act="team-del" data-id="' + esc(t.id) + '">Remove</button></td></tr>').join('')
        : '<tr><td colspan="4"><div class="empty tiny">Nobody added yet. Add an email here, then that person uses ' +
          '<b>First time here?</b> on the sign-in page to set their own password.</div></td></tr>') +
      '</tbody></table></div></div>'
    : '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Team access</h3></div>' +
      '<div class="card-b tiny muted">Logins switch on once the Firebase config is filled in ' +
      '(<code>assets/js/config.js</code>). In local demo mode there is nothing to sign in to.</div></div>';

  shell('settings', title('Settings', 'Branding, team and your data.'),
    '<div class="two" style="grid-template-columns:1fr 1fr"><div>' +
      '<div class="card"><div class="card-h"><h3>Workspace</h3></div><div class="card-b">' +
        '<label class="f"><span>Company name</span><input class="inp" id="orgName" value="' + esc(d.org.name) + '"></label>' +
        '<label class="f"><span>Sub-label</span><input class="inp" id="orgTag" value="' + esc(d.org.tagline) + '"></label>' +
        '<label class="f"><span>Assignable people (comma separated)</span>' +
          '<input class="inp" id="orgOwners" value="' + esc((d.org.owners || []).join(', ')) + '"></label>' +
        '<button class="btn btn-gold" data-act="save-org">Save</button></div></div>' +
      teamCard +
    '</div><div>' +
      '<div class="card"><div class="card-h"><h3>Data</h3><div class="spacer"></div>' +
        (liveMode() ? '<span class="pill ok"><span class="dot"></span>Firestore</span>' : '<span class="pill warn">This browser only</span>') +
      '</div><div class="card-b">' +
        '<p class="tiny muted" style="margin-top:0">' + (liveMode()
          ? 'Live in Cloud Firestore. Every team member sees the same boards in real time, and public form submissions land here instantly.'
          : 'Saved in this browser only (localStorage). Fill in <code>assets/js/config.js</code> to go live.') + '</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn" data-act="export">Export JSON</button>' +
          '<button class="btn" data-act="import">Import JSON</button>' +
          (liveMode() ? '<button class="btn" data-act="seed">Load demo pipelines</button>' : '') +
          '<button class="btn btn-danger" data-act="wipe">Clear leads &amp; tasks</button>' +
          '<button class="btn btn-danger" data-act="reset">Reset everything</button>' +
        '</div><div class="tiny muted" style="margin-top:12px">' +
          d.contacts.length + ' contacts &middot; ' + d.opportunities.length + ' opportunities &middot; ' +
          d.tasks.length + ' tasks &middot; ' + d.forms.length + ' forms &middot; ' + d.pipelines.length + ' pipelines</div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h3>GoHighLevel</h3><div class="spacer"></div>' +
        '<span class="pill gold">inbound only</span></div>' +
        '<div class="card-b tiny muted"><p style="margin-top:0">GHL forms post their submissions to ' +
        '<code>/api/ghl-inbound</code> and the lead appears on the board here. <b>No GHL pipeline or stage is ' +
        'involved</b> &mdash; the only thing needed in GHL is a workflow with a <i>Form Submitted</i> trigger and a ' +
        '<i>Webhook</i> action. Nothing here reads or moves GHL opportunities.</p>' +
        '<p>To connect one: make a form here with its <b>Source</b> set to <i>In GoHighLevel</i>, then ' +
        '<b>Forms &rarr; Webhook</b> gives you the URL to paste into the GHL workflow.</p>' +
        '<p>Needs four environment variables on the host (<code>INBOUND_SECRET</code> and three ' +
        '<code>FIREBASE_*</code> values) &mdash; see START-HERE.md. No GHL API token is needed for this direction.</p>' +
        '</div></div>' +
    '</div></div>');
}

/* ---------------------------------------------------------- public form */
function viewPublicForm(formId, done) {
  const f = S.form(formId);
  const d = S.db();
  if (!f) {
    app().innerHTML = '<div class="pub"><div class="pub-wrap"><div class="pub-card"><div class="thanks">' +
      '<h2>Form not found</h2><p class="muted">This link is not active.</p>' +
      '<a class="btn btn-primary" href="#/dashboard">Go to the app</a></div></div></div></div>';
    return;
  }
  const brand = '<div class="pub-brand"><div class="mark">P</div><div><b>' + esc(d.org.name) + '</b>' +
    '<span>' + esc(f.active ? 'Secure submission' : 'Preview - form is paused') + '</span></div></div>';

  if (done) {
    app().innerHTML = '<div class="pub"><div class="pub-wrap">' + brand +
      '<div class="pub-card"><div class="thanks"><div class="ring">&#10003;</div>' +
        '<h2>Thank you' + (done.name ? ', ' + esc(String(done.name).split(' ')[0]) : '') + '</h2>' +
        '<p class="muted">We have received your details. ' + esc(f.assignTo || 'Our team') + ' will be in touch shortly.</p>' +
        (S.isAuthed() || !liveMode() ? '<div class="pill gold" style="margin-top:10px">Added to ' +
          esc((S.pipeline(f.pipelineId) || {}).name || '-') + ' &rarr; ' + esc(S.stageName(f.pipelineId, f.stageId)) + '</div>' : '') +
        '<div style="margin-top:22px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
          '<a class="btn btn-primary" href="#/dashboard">See it on the dashboard</a>' +
          '<a class="btn" href="#/f/' + f.id + '">Submit another</a></div>' +
      '</div></div></div></div>';
    return;
  }
  if (!f.active) {
    app().innerHTML = '<div class="pub"><div class="pub-wrap">' + brand +
      '<div class="pub-card"><div class="thanks"><h2>' + esc(f.headline || f.name) + '</h2>' +
      '<p class="muted">This form is not accepting submissions right now.</p></div></div></div></div>';
    return;
  }

  const body = f.fields.map(q => {
    const req = q.required ? ' <span class="req">*</span>' : '';
    const ph = esc(q.placeholder || '');
    let ctrl;
    if (q.type === 'textarea') ctrl = '<textarea class="inp" data-in="' + q.id + '" placeholder="' + ph + '"></textarea>';
    else if (q.type === 'select') ctrl = '<select class="inp" data-in="' + q.id + '"><option value="">Select...</option>' +
      (q.options || []).map((o, i) => '<option value="' + esc(o) + '">' +
        esc((q.optionLabels && q.optionLabels[i]) || o) + '</option>').join('') + '</select>';
    else if (q.type === 'radio') ctrl = '<div class="chks" data-in="' + q.id + '">' + (q.options || []).map(o =>
      '<label><input type="radio" name="r_' + q.id + '" value="' + esc(o) + '"> ' + esc(o) + '</label>').join('') + '</div>';
    else {
      const t = q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text';
      ctrl = '<input class="inp" type="' + t + '" data-in="' + q.id + '" placeholder="' + ph + '">';
    }
    return '<label class="f"><span>' + esc(q.label) + req + '</span>' + ctrl + '<div class="err hide"></div></label>';
  }).join('');

  app().innerHTML = '<div class="pub"><div class="pub-wrap">' + brand +
    '<div class="pub-card"><div class="hd"><h2>' + esc(f.headline || f.name) + '</h2>' +
      (f.blurb ? '<p>' + esc(f.blurb) + '</p>' : '') + '</div>' +
      '<div class="bd">' + body + '</div>' +
      '<div class="ft"><button class="btn btn-gold" data-act="pub-submit" data-id="' + f.id + '">Submit</button></div></div>' +
    '<div class="pub-note">' + esc(d.org.name) + ' &middot; your details are only used to contact you' +
      (S.isAuthed() || !liveMode() ? ' &middot; goes to <b>' + esc((S.pipeline(f.pipelineId) || {}).name || '-') + '</b> &rarr; ' +
        esc(S.stageName(f.pipelineId, f.stageId)) : '') + '</div>' +
  '</div></div>';
}

function submitPublic(formId, btn) {
  const f = S.form(formId);
  const answers = {};
  let ok = true;
  f.fields.forEach(q => {
    const holder = document.querySelector('[data-in="' + q.id + '"]');
    if (!holder) return;
    const wrap = holder.closest('label.f');
    const err = wrap.querySelector('.err');
    let val = q.type === 'radio'
      ? (holder.querySelector('input:checked') || { value: '' }).value
      : holder.value.trim();
    answers[q.id] = val;
    err.classList.add('hide'); holder.classList.remove('bad');
    if (q.required && !val) {
      ok = false; err.textContent = 'This field is required.'; err.classList.remove('hide'); holder.classList.add('bad');
    } else if (q.type === 'email' && val && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) {
      ok = false; err.textContent = 'Enter a valid email address.'; err.classList.remove('hide'); holder.classList.add('bad');
    }
  });
  if (!ok) { toast('Please fix the highlighted fields.', 'bad'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  S.submitForm(formId, answers).then(res => {
    window.__lastSubmit = { formId, name: res.contact.name };
    const target = '#/f/' + formId + '/thanks';
    if (location.hash === target) viewPublicForm(formId, window.__lastSubmit);
    else location.hash = target;
  }).catch(e => {
    console.error(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
    toast(e.message || 'Could not send that - please try again.', 'bad');
  });
}

/* --------------------------------------------------------------- dialogs */
function dlgNewPipeline() {
  openModal({
    title: 'New pipeline',
    body: '<label class="f"><span>Pipeline name <span class="req">*</span></span>' +
      '<input class="inp" name="name" placeholder="e.g. Investor Relations"></label>' +
      '<label class="f"><span>Stages (one per line, in order)</span>' +
      '<textarea class="inp" name="stages" style="min-height:130px">New Lead\nContacted\nCall Booked\nProposal Sent\nWon</textarea></label>' +
      '<div class="tiny muted">You can rename, reorder and add stages on the board afterwards.</div>',
    footer: '<button class="btn" data-act="modal-close">Cancel</button>' +
      '<button class="btn btn-gold" data-act="pl-create">Create pipeline</button>'
  });
}
function dlgShareForm(id) {
  const f = S.form(id), url = formUrl(id);
  const isGhl = f.source === 'ghl';
  const dest = '<b>' + esc((S.pipeline(f.pipelineId) || {}).name || '-') + ' &rarr; ' +
    esc(S.stageName(f.pipelineId, f.stageId)) + '</b>';
  const embed = '<iframe src="' + url + '" style="width:100%;height:780px;border:0"></iframe>';
  const hookUrl = location.origin + '/api/ghl-inbound?form=' + id + '&key=YOUR_INBOUND_SECRET';

  const webhookBlock =
    '<p class="tiny muted" style="margin:0 0 10px">In GHL: <b>Automation &rarr; Workflows</b>, trigger ' +
      '<b>Form Submitted</b>, then <b>+ Add Action &rarr; Webhook</b>, method <b>POST</b>, and this URL. ' +
      'Swap <code>YOUR_INBOUND_SECRET</code> for the value you set in Vercel.</p>' +
    '<label class="f"><span>Inbound webhook URL (POST)</span><div class="copybar">' +
      '<input class="inp" id="hookUrl" readonly value="' + esc(hookUrl) + '">' +
      '<button class="btn" data-act="copy" data-target="hookUrl">Copy</button></div></label>' +
    '<div class="tiny muted">Whatever GHL sends is matched against this form’s field labels, and the lead lands in ' +
      dest + ' with a follow-up task. <b>No GHL pipeline or stage is used.</b> ' +
      'Open the same URL in a browser and it reports what it would do &mdash; the quickest way to check the wiring.</div>';

  const publicBlock =
    '<label class="f"><span>Form link</span><div class="copybar">' +
      '<input class="inp" id="shareUrl" readonly value="' + esc(url) + '">' +
      '<button class="btn" data-act="copy" data-target="shareUrl">Copy</button></div></label>' +
    '<label class="f"><span>Embed on a website</span>' +
      '<textarea class="inp" id="shareEmbed" readonly style="min-height:70px">' + esc(embed) + '</textarea></label>' +
    '<div class="copybar"><button class="btn btn-sm" data-act="copy" data-target="shareEmbed">Copy embed code</button></div>';

  const hostNote = '<div class="card" style="margin-top:16px"><div class="card-b tiny muted">' +
    (liveMode() && !/^(localhost|127\.)/.test(location.hostname)
      ? '<b>Live.</b> This works for anyone, on any device.'
      : '<b>Not public yet.</b> ' + (liveMode()
          ? 'The database is live but this page is still on localhost. Deploy to Vercel and the URL above becomes the real one.'
          : 'Running on local demo data, so nothing here is reachable from outside this browser.')) +
    '</div></div>';

  openModal({
    title: (isGhl ? 'Connect "' : 'Share "') + f.name + '"',
    body: isGhl
      ? '<span class="pill gold" style="margin-bottom:10px">Receives from GoHighLevel</span>' + webhookBlock +
        '<hr style="border:0;border-top:1px solid var(--line);margin:20px 0">' +
        '<h4 style="margin:0 0 4px">Testing link (optional)</h4>' +
        '<p class="tiny muted" style="margin:0 0 10px">This form also has a page here, which is handy for testing ' +
        'the routing without involving GHL. You do not have to give it to anyone.</p>' + publicBlock + hostNote
      : '<p class="tiny muted" style="margin-top:0">Anyone who opens this link and submits lands in ' + dest + '.</p>' +
        publicBlock +
        '<hr style="border:0;border-top:1px solid var(--line);margin:20px 0">' +
        '<h4 style="margin:0 0 4px">Or let GoHighLevel feed this form instead</h4>' + webhookBlock + hostNote,
    footer: '<button class="btn" data-act="form-open" data-id="' + id + '">' +
      (isGhl ? 'Open test page' : 'Open form') + '</button>' +
      '<button class="btn btn-primary" data-act="modal-close">Done</button>'
  });
}
function dlgStageMenu(pid, sid, i) {
  const p = S.pipeline(pid), s = p.stages.find(x => x.id === sid);
  openModal({
    title: 'Stage: ' + s.name,
    body: '<label class="f"><span>Stage name</span><input class="inp" name="name" value="' + esc(s.name) + '"></label>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-sm" data-act="stage-move" data-id="' + sid + '" data-pl="' + pid + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>&larr; Move left</button>' +
      '<button class="btn btn-sm" data-act="stage-move" data-id="' + sid + '" data-pl="' + pid + '" data-dir="1"' + (i === p.stages.length - 1 ? ' disabled' : '') + '>Move right &rarr;</button></div>',
    footer: '<button class="btn btn-danger left" data-act="stage-del" data-id="' + sid + '" data-pl="' + pid + '">Delete stage</button>' +
      '<button class="btn" data-act="modal-close">Cancel</button>' +
      '<button class="btn btn-gold" data-act="stage-rename" data-id="' + sid + '" data-pl="' + pid + '">Save</button>'
  });
}
function dlgNewOpp(pid, sid) {
  const d = S.db();
  openModal({
    title: 'Add to ' + S.stageName(pid, sid),
    body: '<div class="row"><label class="f"><span>Name <span class="req">*</span></span><input class="inp" name="name"></label>' +
      '<label class="f"><span>Value ($)</span><input class="inp" type="number" name="value"></label></div>' +
      '<div class="row"><label class="f"><span>Email</span><input class="inp" name="email"></label>' +
      '<label class="f"><span>Phone</span><input class="inp" name="phone"></label></div>' +
      '<div class="row"><label class="f"><span>Card title (optional)</span><input class="inp" name="title" placeholder="defaults to the name"></label>' +
      '<label class="f"><span>Owner</span><input class="inp" name="owner" list="owners2" value="' + esc((d.org.owners || [])[0] || '') + '"></label></div>' +
      '<datalist id="owners2">' + (d.org.owners || []).map(o => '<option>' + esc(o) + '</option>').join('') + '</datalist>' +
      '<div class="tiny muted">Manual adds still create a follow-up task, same as a form submission.</div>',
    footer: '<button class="btn" data-act="modal-close">Cancel</button>' +
      '<button class="btn btn-gold" data-act="opp-create" data-pl="' + pid + '" data-stage="' + sid + '">Add</button>'
  });
}
function dlgPickForm() {
  const d = S.db();
  if (!d.forms.length) {
    openModal({ title: 'No forms yet', body: '<p>Create a form first &mdash; that is what feeds your pipelines.</p>',
      footer: '<button class="btn btn-gold" data-act="new-form">+ New form</button>' });
    return;
  }
  openModal({
    title: 'Open a form as a lead would see it',
    body: '<p class="tiny muted" style="margin-top:0">Pick a form, fill it in, and watch the lead appear on the board and in the pending list.</p>' +
      d.forms.map(f => '<div class="fld" style="display:flex;align-items:center;gap:10px">' +
        '<div style="flex:1"><b>' + esc(f.name) + '</b><div class="tiny muted">&rarr; ' +
        esc((S.pipeline(f.pipelineId) || {}).name || 'not routed') + ' / ' + esc(S.stageName(f.pipelineId, f.stageId)) + '</div></div>' +
        '<button class="btn btn-sm btn-gold" data-act="form-open" data-id="' + f.id + '">Open</button></div>').join(''),
    footer: '<button class="btn" data-act="modal-close">Close</button>'
  });
}

/* ---------------------------------------------------------- click router */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (t.tagName === 'A' && t.getAttribute('href') === '#') e.preventDefault();

  switch (act) {
    case 'modal-close': closeModal(); return;

    /* auth */
    case 'auth-mode': authView = t.dataset.m; viewLogin(); return;
    case 'auth-go': doAuth(); return;
    case 'sign-out':
      closeModal();
      Promise.resolve(window.Auth.signOut()).then(() => { location.hash = '#/dashboard'; });
      return;

    /* pipelines */
    case 'new-pipeline': dlgNewPipeline(); return;
    case 'pl-create': {
      const n = mVal('name'); if (!n) { toast('Give the pipeline a name.', 'bad'); return; }
      const stages = mVal('stages').split('\n');
      closeModal();
      go(S.addPipeline(n, stages).then(p => { location.hash = '#/pipeline/' + p.id; }), 'Pipeline created');
      return;
    }
    case 'pl-rename': {
      const p = S.pipeline(id);
      openModal({
        title: 'Rename pipeline',
        body: '<label class="f"><span>Name</span><input class="inp" name="name" value="' + esc(p.name) + '"></label>',
        footer: '<button class="btn" data-act="modal-close">Cancel</button>' +
          '<button class="btn btn-gold" data-act="pl-rename-go" data-id="' + id + '">Save</button>'
      });
      return;
    }
    case 'pl-rename-go': { const n = mVal('name'); closeModal(); go(S.renamePipeline(id, n), 'Renamed'); return; }
    case 'pl-delete': {
      const p = S.pipeline(id), n = S.oppsIn(id).length;
      if (!confirm('Delete "' + p.name + '"?\n\n' + n + ' opportunit' + (n === 1 ? 'y' : 'ies') +
        ' will be removed. Forms pointing here will be unrouted.')) return;
      go(S.deletePipeline(id).then(() => { location.hash = '#/pipelines'; }), 'Pipeline deleted');
      return;
    }

    /* stages */
    case 'stage-add': { const name = prompt('New stage name:'); if (name) go(S.addStage(id, name), 'Stage added'); return; }
    case 'stage-menu': dlgStageMenu(currentPipelineId(), id, Number(t.dataset.i)); return;
    case 'stage-rename': { const n = mVal('name'), pl = t.dataset.pl; closeModal(); go(S.renameStage(pl, id, n), 'Stage renamed'); return; }
    case 'stage-move': { const pl = t.dataset.pl, dir = Number(t.dataset.dir); closeModal(); go(S.moveStage(pl, id, dir)); return; }
    case 'stage-del': {
      if (!confirm('Delete this stage? Its cards move to the first stage.')) return;
      const pl = t.dataset.pl; closeModal();
      go(S.deleteStage(pl, id).then(okd => {
        if (!okd) toast('A pipeline needs at least one stage.', 'bad'); else toast('Stage deleted');
      }));
      return;
    }

    /* opportunities */
    case 'opp-new': dlgNewOpp(currentPipelineId(), t.dataset.stage); return;
    case 'opp-create': {
      const name = mVal('name'); if (!name) { toast('Name is required.', 'bad'); return; }
      const payload = {
        pipelineId: t.dataset.pl, stageId: t.dataset.stage, name,
        email: mVal('email'), phone: mVal('phone'), title: mVal('title'),
        value: mVal('value'), owner: mVal('owner')
      };
      closeModal(); go(S.addOppManual(payload), name + ' added');
      return;
    }
    case 'opp-open': { const o = S.opp(id); if (o) openContact(o.contactId); return; }
    case 'opp-stage': go(S.moveOpp(id, t.dataset.stage), 'Stage updated'); return;
    case 'opp-delete': {
      if (!confirm('Remove this opportunity from the pipeline? The contact is kept.')) return;
      closeModal(); go(S.deleteOpp(id), 'Removed'); return;
    }

    /* forms */
    case 'new-form': {
      closeModal(); draft = S.blankForm();
      if (t.dataset.pipeline && S.pipeline(t.dataset.pipeline)) {
        draft.pipelineId = t.dataset.pipeline;
        draft.stageId = S.pipeline(t.dataset.pipeline).stages[0].id;
      }
      if (location.hash === '#/forms/new') viewFormBuilder('new'); else location.hash = '#/forms/new';
      return;
    }
    case 'form-open': closeModal(); location.hash = '#/f/' + id; return;
    case 'form-share': dlgShareForm(id); return;
    case 'try-form': dlgPickForm(); return;
    case 'fb-add':
      harvestDraft();
      draft.fields.push({ id: S.uid('q'), label: '', type: 'text', required: false, map: 'none' });
      render(); return;
    case 'fb-del': harvestDraft(); draft.fields = draft.fields.filter(q => q.id !== id); render(); return;
    case 'fb-up': case 'fb-down': {
      harvestDraft();
      const i = draft.fields.findIndex(q => q.id === id), j = i + (act === 'fb-up' ? -1 : 1);
      if (j >= 0 && j < draft.fields.length) { const a = draft.fields; [a[i], a[j]] = [a[j], a[i]]; }
      render(); return;
    }
    case 'fb-preview': case 'fb-save': {
      harvestDraft();
      if (!draft.name.trim()) { toast('Give the form a name.', 'bad'); return; }
      if (!draft.pipelineId || !draft.stageId) { toast('Pick the pipeline and stage this form feeds.', 'bad'); return; }
      if (draft.fields.find(q => !q.label.trim())) { toast('Every question needs a label.', 'bad'); return; }
      const copy = JSON.parse(JSON.stringify(draft));
      const savedId = copy.id, preview = act === 'fb-preview';
      go(S.saveForm(copy).then(() => {
        toast('Form saved - it feeds ' + S.stageName(copy.pipelineId, copy.stageId), 'ok');
        if (preview) location.hash = '#/f/' + savedId;
        else { draft = null; location.hash = '#/forms'; }
      }));
      return;
    }
    case 'form-delete': {
      if (!confirm('Delete this form? Leads already collected stay in the pipeline.')) return;
      go(S.deleteForm(id).then(() => { draft = null; location.hash = '#/forms'; }), 'Form deleted');
      return;
    }

    /* tasks */
    case 'task-toggle': go(S.toggleTask(id)); return;
    case 'task-snooze': go(S.snoozeTask(id, 2), 'Snoozed 2 days'); return;
    case 'task-add': {
      const tt = prompt('Task title:', 'Follow up call');
      if (tt) go(S.addTask(id, tt, 1, ''), 'Task added');
      return;
    }

    /* contacts */
    case 'contact': closeModal(); openContact(id); return;

    /* public form */
    case 'pub-submit': submitPublic(id, t); return;

    /* team */
    case 'team-add': {
      openModal({
        title: 'Add a team member',
        body: '<label class="f"><span>Work email <span class="req">*</span></span><input class="inp" name="email" type="email" placeholder="name@phcinvest.com"></label>' +
          '<label class="f"><span>Name (optional)</span><input class="inp" name="name"></label>' +
          '<div class="tiny muted">They then open the sign-in page, click <b>First time here?</b> and choose their own password. ' +
          'You never handle their password.</div>',
        footer: '<button class="btn" data-act="modal-close">Cancel</button><button class="btn btn-gold" data-act="team-add-go">Add</button>'
      });
      return;
    }
    case 'team-add-go': {
      const em = mVal('email'), nm = mVal('name');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { toast('Enter a valid email address.', 'bad'); return; }
      closeModal(); go(S.addTeam(em, nm), em + ' can now sign in');
      return;
    }
    case 'team-del': {
      if (!confirm('Remove ' + id + ' from the team? They lose access immediately.')) return;
      go(S.removeTeam(id), 'Removed');
      return;
    }

    /* settings + data */
    case 'save-org': {
      const org = {
        name: document.getElementById('orgName').value.trim() || 'Pheenyx Capital',
        tagline: document.getElementById('orgTag').value.trim(),
        owners: document.getElementById('orgOwners').value.split(',').map(s => s.trim()).filter(Boolean)
      };
      go(S.saveOrg(org), 'Saved'); return;
    }
    case 'export': {
      const blob = new Blob([S.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pheenyx-pipeline-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click(); URL.revokeObjectURL(a.href); toast('Exported', 'ok'); return;
    }
    case 'import':
      openModal({
        title: 'Import backup',
        body: '<label class="f"><span>Paste the JSON you exported</span><textarea class="inp" name="json" style="min-height:180px"></textarea></label>' +
          (liveMode() ? '<div class="tiny muted">This replaces everything in the live database.</div>' : ''),
        footer: '<button class="btn" data-act="modal-close">Cancel</button><button class="btn btn-gold" data-act="import-go">Import</button>'
      });
      return;
    case 'import-go': { const txt = mVal('json'); closeModal(); go(S.importJson(txt), 'Imported'); return; }
    case 'seed':
      if (!confirm('Load the demo pipelines and forms? This replaces what is in the database now.')) return;
      go(S.seedRemote(), 'Demo data loaded'); return;
    case 'wipe':
      if (!confirm('Clear all contacts, opportunities and tasks? Forms and pipelines stay.')) return;
      go(S.wipeRecords(), 'Cleared'); return;
    case 'reset':
      if (!confirm('Reset everything back to the demo data?')) return;
      go(S.resetAll(), 'Reset'); return;
    case 'copy': {
      const el = document.getElementById(t.dataset.target);
      el.select(); el.setSelectionRange(0, 99999);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(el.value).then(() => toast('Copied', 'ok'),
          () => toast('Press Ctrl+C to copy', 'bad'));
      } else toast('Press Ctrl+C to copy');
      return;
    }
  }
});

/* builder: changing the pipeline repopulates the stage list */
document.addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset || !draft) return;
  if (el.dataset.fb === 'pipelineId') {
    harvestDraft();
    const p = S.pipeline(el.value);
    draft.pipelineId = el.value || null;
    draft.stageId = p && p.stages[0] ? p.stages[0].id : null;
    render();
  } else if (el.dataset.fb === 'source') {
    harvestDraft();
    draft.source = el.value;
    render();
  } else if (el.dataset.qType || el.dataset.qMap) { harvestDraft(); render(); }
});

/* --------------------------------------------------------------- router */
function currentPipelineId() {
  const m = location.hash.match(/^#\/pipeline\/([^/]+)/);
  return m ? m[1] : null;
}
function render() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const parts = h.split('/');

  /* the public form is always reachable, signed in or not */
  if (parts[0] === 'f') {
    const last = window.__lastSubmit;
    const done = parts[2] === 'thanks' ? (last && last.formId === parts[1] ? last : {}) : null;
    viewPublicForm(parts[1], done);
    return;
  }
  if (window.Auth && window.Auth.enabled) {
    if (!window.Auth.user()) { viewLogin(); return; }
    if (S.isDenied()) { viewNoAccess(); return; }
  }
  switch (parts[0]) {
    case 'dashboard': viewDashboard(); break;
    case 'pipelines': viewPipelines(); break;
    case 'pipeline': viewBoard(parts[1]); break;
    case 'forms': parts[1] ? viewFormBuilder(parts[1]) : viewForms(); break;
    case 'contacts': viewContacts(); break;
    case 'settings': viewSettings(); break;
    default: location.hash = '#/dashboard';
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { closeModal(); render(); });

/* ---------------------------------------------------------------- start */
let started = false;
window.App = {
  toast, render,
  get started() { return started; },
  start() {
    if (started) { render(); return; }
    started = true;
    const d = S.db();
    if (d.org && d.org.name) document.title = d.org.name + ' - ' + (d.org.tagline || 'Pipeline');
    S.onChange(() => {
      /* never redraw the sign-in form under someone's fingers */
      const onLogin = window.Auth && window.Auth.enabled && !window.Auth.user() &&
        location.hash.indexOf('#/f/') !== 0;
      if (onLogin) return;
      const keep = openContactId;
      render();
      if (keep && S.contact(keep)) openContact(keep);
    });
    render();
  }
};
