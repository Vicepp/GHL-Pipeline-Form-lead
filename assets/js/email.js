/* Pheenyx Capital - Pipeline Workflow
   email.js : the Email Campaigns page (#/email).

   Reads what tools/ghl-email-sync.js publishes to Firestore - every
   campaign / bulk email sent from GoHighLevel, who it went to, and whether
   they opened it or clicked a link - and turns it into one filterable set.

   Loaded after app.js, so it uses that file's helpers (shell, title, tile,
   gauge, esc, fmtDate, openModal ...). Everything is computed in the
   browser from ~30 packed documents; a filter change never hits the network.

   Times are Central (America/Chicago) - where the team and the sends are.

   Opens and clicks: corporate and university mail servers run security
   scanners that open every email and "click" every link seconds after it
   lands. The sync flags those clicks; by default they are left out of the
   open and click numbers so the page counts people, not robots.         */

const EM_TZ = 'America/Chicago';
const EM_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EM_BLUE = '#3366cc';          /* the categorical slot the app already uses */
const EM_GREEN = '#0f9d63';
/* sequential: one hue, light -> dark */
const EM_RAMP = ['#eef3fc', '#d5e2f8', '#b3caf1', '#87aae6', '#5a88d8', '#3366cc', '#244fa6', '#173777'];

let emData = null;       /* decoded dataset */
let emMeta = null;
let emLoading = false;
let emError = null;
let emF = { preset: '90', from: '', to: '', camp: 'all', source: 'all', status: 'all', audience: 'all', q: '', bots: false };
let emPeopleView = 'contacts';   /* contacts | emails | campaigns */
let emSort = 'engaged';
let emShow = 200;

/* ------------------------------------------------------------ loading */
async function emLoad(force) {
  if ((emData && !force) || emLoading) return;
  if (!window.FsRead) { emError = 'local'; render(); return; }
  emLoading = true; emError = null; render();
  try {
    const { fs, doc, getDoc } = window.FsRead;
    const meta = await getDoc(doc(fs, 'emailAnalytics', 'meta'));
    if (!meta.exists()) { emMeta = null; emData = null; emLoading = false; emError = 'empty'; render(); return; }
    emMeta = meta.data();
    const ids = emMeta.chunks || {};
    const get = (id) => getDoc(doc(fs, 'emailAnalytics', id)).then(s => (s.exists() ? s.data().d || '' : ''));
    const [ev, ct, cp] = await Promise.all([
      Promise.all((ids.events || []).map(get)),
      Promise.all((ids.contacts || []).map(get)),
      Promise.all((ids.campaigns || []).map(get))
    ]);
    emData = emDecode(ev, ct, cp);
  } catch (e) {
    emError = /permission/i.test(e.message)
      ? 'The database refused the read. The emailAnalytics rule in firestore.rules has not been published yet.'
      : e.message;
  }
  emLoading = false;
  render();
}

/* Central-time calendar bits for an epoch second, cached per hour */
const emHourCache = new Map();
const emFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: EM_TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short'
});
function emCal(sec) {
  const h = Math.floor(sec / 3600);
  let v = emHourCache.get(h);
  if (!v) {
    const p = {};
    emFmt.formatToParts(new Date(h * 3600000)).forEach(x => { p[x.type] = x.value; });
    v = {
      day: Math.round(Date.UTC(+p.year, +p.month - 1, +p.day) / 864e5),
      dow: (EM_DAYS.indexOf(p.weekday) + 7) % 7,
      hour: +p.hour % 24
    };
    emHourCache.set(h, v);
  }
  return v;
}
const emDayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const emDayIso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const emDayLabel = (n) => new Date(n * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const emStamp = (sec) => new Date(sec * 1000).toLocaleString('en-US', {
  timeZone: EM_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
});
const emHourLabel = (h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);

function emDecode(evChunks, ctChunks, cpChunks) {
  const camps = [];
  cpChunks.join('\n').split('\n').forEach(l => {
    if (!l) return;
    const [subject, source, day] = l.split('\t');
    camps.push({ subject, source, day: day ? emDayNum(day) : 0 });
  });
  const conts = [];
  ctChunks.join('\n').split('\n').forEach(l => {
    if (!l) return;
    const [id, name, email] = l.split('\t');
    conts.push({ id, name: name || '', email: email || '', key: (name + ' ' + email).toLowerCase() });
  });
  const lines = evChunks.join('\n').split('\n').filter(Boolean);
  const n = lines.length;
  const E = {
    n, ci: new Int32Array(n), ki: new Int32Array(n), sent: new Float64Array(n),
    st: new Uint8Array(n), dl: new Int32Array(n), bot: new Uint8Array(n),
    day: new Int32Array(n), dow: new Uint8Array(n), hour: new Uint8Array(n),
    aday: new Int32Array(n), adow: new Uint8Array(n), ahour: new Uint8Array(n)
  };
  for (let i = 0; i < n; i++) {
    const f = lines[i].split(',');
    E.ci[i] = parseInt(f[0], 36);
    E.ki[i] = parseInt(f[1], 36);
    const s = parseInt(f[2], 36);
    E.sent[i] = s;
    E.st[i] = f[3].charCodeAt(0);
    E.dl[i] = f[4] ? parseInt(f[4], 36) : -1;
    E.bot[i] = f[5] === 'b' ? 1 : 0;
    const c = emCal(s);
    E.day[i] = c.day; E.dow[i] = c.dow; E.hour[i] = c.hour;
    if (E.dl[i] >= 0) {
      const a = emCal(s + E.dl[i]);
      E.aday[i] = a.day; E.adow[i] = a.dow; E.ahour[i] = a.hour;
    } else E.aday[i] = -1;
  }
  /* each contact's first-ever open, across the whole history (bot clicks don't count) */
  const firstOpen = new Int32Array(conts.length).fill(0x7fffffff);
  for (let i = 0; i < n; i++) {
    if (emIsOpen(E, i, false)) {
      const d = E.aday[i] >= 0 ? E.aday[i] : E.day[i];
      if (d < firstOpen[E.ci[i]]) firstOpen[E.ci[i]] = d;
    }
  }
  let minDay = Infinity, maxDay = -Infinity;
  for (let i = 0; i < n; i++) { if (E.day[i] < minDay) minDay = E.day[i]; if (E.day[i] > maxDay) maxDay = E.day[i]; }
  return { camps, conts, E, firstOpen, minDay, maxDay };
}

const C_O = 'o'.charCodeAt(0), C_C = 'c'.charCodeAt(0), C_F = 'f'.charCodeAt(0),
  C_D = 'd'.charCodeAt(0), C_S = 's'.charCodeAt(0);
/* a bot-flagged click is machine activity: neither a human open nor a click */
function emIsOpen(E, i, bots) { const s = E.st[i]; return (s === C_O || s === C_C) && (bots || !E.bot[i]); }
function emIsClick(E, i, bots) { return E.st[i] === C_C && (bots || !E.bot[i]); }

/* ------------------------------------------------------------ filtering */
function emRange() {
  const D = emData;
  if (emF.preset === 'custom') {
    return { from: emF.from ? emDayNum(emF.from) : D.minDay, to: emF.to ? emDayNum(emF.to) : D.maxDay };
  }
  if (emF.preset === 'all') return { from: D.minDay, to: D.maxDay };
  const today = emCal(Date.now() / 1000).day;
  if (emF.preset === 'ytd') return { from: emDayNum(new Date().getFullYear() + '-01-01'), to: today };
  return { from: today - Number(emF.preset) + 1, to: today };
}

/** one pass: which events survive the filters */
function emSelect() {
  const D = emData, E = D.E, r = emRange();
  const q = emF.q.trim().toLowerCase();
  const camp = emF.camp === 'all' ? -1 : Number(emF.camp);
  const bots = emF.bots;
  const keep = [];
  for (let i = 0; i < E.n; i++) {
    const d = E.day[i];
    if (d < r.from || d > r.to) continue;
    if (camp >= 0 && E.ki[i] !== camp) continue;
    if (emF.source !== 'all' && D.camps[E.ki[i]].source !== emF.source) continue;
    if (emF.status !== 'all') {
      const o = emIsOpen(E, i, bots), c = emIsClick(E, i, bots);
      if (emF.status === 'opened' && !o) continue;
      if (emF.status === 'clicked' && !c) continue;
      if (emF.status === 'opened-no-click' && (!o || c)) continue;
      if (emF.status === 'unopened' && (o || E.st[i] === C_F)) continue;
      if (emF.status === 'failed' && E.st[i] !== C_F) continue;
      if (emF.status === 'bot' && !E.bot[i]) continue;
    }
    if (emF.audience !== 'all') {
      const fo = D.firstOpen[E.ci[i]];
      if (emF.audience === 'new' && !(fo >= r.from && fo <= r.to)) continue;
      if (emF.audience === 'previous' && !(fo < r.from)) continue;
      if (emF.audience === 'never' && fo !== 0x7fffffff) continue;
    }
    if (q && D.conts[E.ci[i]].key.indexOf(q) < 0 && D.camps[E.ki[i]].subject.toLowerCase().indexOf(q) < 0) continue;
    keep.push(i);
  }
  return { idx: keep, range: r };
}

/* ------------------------------------------------------------ aggregates */
function emAggregate(sel) {
  const D = emData, E = D.E, bots = emF.bots;
  const a = {
    sent: sel.idx.length, failed: 0, opened: 0, clicks: 0, botClicks: 0,
    contacts: new Set(), openers: new Set(), clickers: new Set(),
    engage: Array.from({ length: 7 }, () => new Array(24).fill(0)),      /* when opens/clicks happen */
    sendN: Array.from({ length: 7 }, () => new Array(24).fill(0)),       /* sends per slot */
    sendO: Array.from({ length: 7 }, () => new Array(24).fill(0)),       /* opens from those sends */
    sendC: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    lag: [0, 0, 0, 0, 0, 0], days: new Map(), camps: new Map(), people: new Map(),
    clickIdx: []          /* every recorded click, scanner or not - for the Click quality tab */
  };
  for (const i of sel.idx) {
    const ci = E.ci[i], ki = E.ki[i];
    const o = emIsOpen(E, i, bots), c = emIsClick(E, i, bots);
    a.contacts.add(ci);
    if (E.st[i] === C_F) a.failed++;
    if (E.bot[i]) a.botClicks++;
    if (E.st[i] === C_C) a.clickIdx.push(i);
    if (o) { a.opened++; a.openers.add(ci); }
    if (c) { a.clicks++; a.clickers.add(ci); }
    a.sendN[E.dow[i]][E.hour[i]]++;
    if (o) a.sendO[E.dow[i]][E.hour[i]]++;
    if (c) a.sendC[E.dow[i]][E.hour[i]]++;
    if (o && E.aday[i] >= 0) {
      a.engage[E.adow[i]][E.ahour[i]]++;
      const h = E.dl[i] / 3600;
      a.lag[h <= 1 ? 0 : h <= 3 ? 1 : h <= 24 ? 2 : h <= 72 ? 3 : h <= 168 ? 4 : 5]++;
    }
    let dd = a.days.get(E.day[i]);
    if (!dd) { dd = { n: 0, o: 0, c: 0 }; a.days.set(E.day[i], dd); }
    dd.n++; if (o) dd.o++; if (c) dd.c++;

    let k = a.camps.get(ki);
    if (!k) { k = { ki, n: 0, f: 0, o: 0, c: 0, b: 0, first: E.sent[i] }; a.camps.set(ki, k); }
    k.n++; if (E.st[i] === C_F) k.f++; if (o) k.o++; if (c) k.c++; if (E.bot[i]) k.b++;
    if (E.sent[i] < k.first) k.first = E.sent[i];

    let p = a.people.get(ci);
    if (!p) { p = { ci, n: 0, o: 0, c: 0, lastSent: 0, lastOpen: 0, lastOpenK: -1, lastClick: 0, lastClickK: -1 }; a.people.set(ci, p); }
    p.n++;
    if (E.sent[i] > p.lastSent) p.lastSent = E.sent[i];
    if (o) {
      p.o++;
      const at = E.dl[i] >= 0 ? E.sent[i] + E.dl[i] : E.sent[i];
      if (at > p.lastOpen) { p.lastOpen = at; p.lastOpenK = ki; }
    }
    if (c) {
      p.c++;
      const at = E.dl[i] >= 0 ? E.sent[i] + E.dl[i] : E.sent[i];
      if (at > p.lastClick) { p.lastClick = at; p.lastClickK = ki; }
    }
  }
  a.delivered = a.sent - a.failed;
  return a;
}

/** the send slot to recommend - judged on open rate, never on a thin sample */
function emRecommend(a) {
  const total = a.sent;
  const minN = Math.max(300, Math.round(total * 0.02));
  let best = null;
  const dayRate = EM_DAYS.map((d, di) => {
    let n = 0, o = 0, c = 0;
    for (let h = 0; h < 24; h++) { n += a.sendN[di][h]; o += a.sendO[di][h]; c += a.sendC[di][h]; }
    return { k: d, di, n, o, c, rate: pct(o, n), crate: pct(c, n) };
  });
  const hourRate = Array.from({ length: 24 }, (_, h) => {
    let n = 0, o = 0, c = 0;
    for (let di = 0; di < 7; di++) { n += a.sendN[di][h]; o += a.sendO[di][h]; c += a.sendC[di][h]; }
    return { h, n, o, c, rate: pct(o, n), crate: pct(c, n) };
  });
  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      const n = a.sendN[di][h];
      if (n < minN) continue;
      const r = a.sendO[di][h] / n;
      if (!best || r > best.r) best = { di, h, n, r, o: a.sendO[di][h], c: a.sendC[di][h] };
    }
  }
  /* when people actually read: the busiest 2-hour window of opens and clicks */
  let peak = null;
  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      const v = a.engage[di][h] + a.engage[di][(h + 1) % 24];
      if (!peak || v > peak.v) peak = { di, h, v };
    }
  }
  let engTotal = 0;
  a.engage.forEach(r => r.forEach(v => { engTotal += v; }));
  const days = dayRate.filter(d => d.n >= minN).sort((x, y) => y.rate - x.rate);
  const hours = hourRate.filter(h => h.n >= minN).sort((x, y) => y.rate - x.rate);
  return { best, peak, engTotal, minN, days, hours, dayRate, hourRate };
}

/* ------------------------------------------------------------ pieces */
function emHeatmap(grid, opts) {
  let max = 0;
  grid.forEach(r => r.forEach(v => { if (v != null && v > max) max = v; }));
  const cell = (di, h) => {
    const v = grid[di][h];
    if (v == null) return '<div class="em-cell na" title="' + EM_DAYS[di] + ' ' + emHourLabel(h) +
      ': too few emails sent at this time to judge"></div>';
    const step = max ? Math.min(EM_RAMP.length - 1, Math.floor(v / max * (EM_RAMP.length - 1) + 0.0001)) : 0;
    const dark = step >= 4;
    return '<div class="em-cell" style="background:' + EM_RAMP[step] + ';color:' + (dark ? '#fff' : '#3c4a63') + '" ' +
      'title="' + esc(opts.tip(di, h, v)) + '">' + (opts.show(v) || '') + '</div>';
  };
  let html = '<div class="em-heat"><div class="em-hrow em-hhead"><span></span>' +
    Array.from({ length: 24 }, (_, h) => '<i>' + (h % 3 === 0 ? emHourLabel(h) : '') + '</i>').join('') + '</div>';
  for (let di = 0; di < 7; di++) {
    html += '<div class="em-hrow"><span>' + EM_DAYS[di] + '</span>' +
      Array.from({ length: 24 }, (_, h) => cell(di, h)).join('') + '</div>';
  }
  html += '</div><div class="em-scale"><span>' + esc(opts.low) + '</span>' +
    EM_RAMP.map(c => '<i style="background:' + c + '"></i>').join('') + '<span>' + esc(opts.high) + '</span></div>';
  return html;
}

/** opens % and clicks % per send day - one axis, both are percentages */
function emTrend(a, range) {
  const span = range.to - range.from + 1;
  const week = span > 120;
  const buckets = new Map();
  a.days.forEach((v, d) => {
    const k = week ? d - ((new Date(d * 864e5).getUTCDay() + 6) % 7) : d;
    const b = buckets.get(k) || { n: 0, o: 0, c: 0 };
    b.n += v.n; b.o += v.o; b.c += v.c;
    buckets.set(k, b);
  });
  const keys = [...buckets.keys()].sort((x, y) => x - y);
  if (keys.length < 2) return '';
  const W = 720, H = 210, L = 38, R = 10, T = 12, B = 26;
  const pts = keys.map(k => Object.assign({ k }, buckets.get(k), { or: pct(buckets.get(k).o, buckets.get(k).n), cr: pct(buckets.get(k).c, buckets.get(k).n) }));
  const ymax = Math.max(10, Math.ceil(Math.max(...pts.map(p => p.or)) / 10) * 10);
  const x = (i) => L + (W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const line = (key, col) => '<polyline fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" points="' +
    pts.map((p, i) => x(i).toFixed(1) + ',' + y(p[key]).toFixed(1)).join(' ') + '"/>';
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = Math.round(ymax * f);
    return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="rgba(16,24,40,.07)"/>' +
      '<text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="em-ax">' + v + '%</text>';
  }).join('');
  const every = Math.max(1, Math.ceil(pts.length / 8));
  const xl = pts.map((p, i) => (i % every === 0
    ? '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle" class="em-ax">' +
      esc(new Date(p.k * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })) + '</text>' : '')).join('');
  const hits = pts.map((p, i) => {
    const w = (W - L - R) / pts.length;
    return '<rect x="' + (x(i) - w / 2).toFixed(1) + '" y="' + T + '" width="' + w.toFixed(1) + '" height="' + (H - T - B) +
      '" fill="transparent"><title>' + esc((week ? 'Week of ' : '') + emDayLabel(p.k) + '\n' + p.n.toLocaleString() +
      ' emails sent\nOpened: ' + p.o.toLocaleString() + ' (' + p.or + '%)\nClicked: ' + p.c.toLocaleString() + ' (' + p.cr + '%)') +
      '</title></rect>';
  }).join('');
  const dots = (key, col) => pts.length <= 60 ? pts.map((p, i) =>
    '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p[key]).toFixed(1) + '" r="3" fill="' + col + '" stroke="#fff" stroke-width="1.5"/>').join('') : '';
  return '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Open &amp; click rate by ' + (week ? 'week' : 'send day') +
    '</h3><div class="spacer"></div><div class="st-legend"><span><i style="background:' + EM_BLUE + '"></i>Opened</span>' +
    '<span><i style="background:' + EM_GREEN + '"></i>Clicked</span></div></div>' +
    '<div class="card-b"><svg viewBox="0 0 ' + W + ' ' + H + '" class="em-trend" role="img" aria-label="Open and click rate over time">' +
    grid + xl + line('or', EM_BLUE) + line('cr', EM_GREEN) + dots('or', EM_BLUE) + dots('cr', EM_GREEN) + hits +
    '</svg><div class="tiny muted">Hover any point for the counts. Rates are of emails sent that ' + (week ? 'week' : 'day') + '.</div></div></div>';
}

function emSel(name, label, opts, cur) {
  return '<label class="wb-f"><span>' + esc(label) + '</span><select class="inp sort-sel" data-emf="' + name + '">' +
    opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></label>';
}

/* ------------------------------------------------------------ the view */
function viewEmailCampaigns() {
  if (!emData && !emLoading && !emError) emLoad();
  const head = title('Email Campaigns', emMeta
    ? 'GoHighLevel campaign &amp; bulk emails &middot; synced ' + esc(ago(emMeta.syncedAt)) + ' &middot; Central time'
    : 'GoHighLevel campaign &amp; bulk emails') +
    (emData ? '<button class="btn btn-sm" data-act="em-csv">Export CSV</button>' : '') +
    '<button class="btn btn-sm" data-act="em-reload">Reload</button>';

  if (emError === 'local') {
    shell('email', head, '<div class="card"><div class="empty">Email analytics needs the live database.<br>' +
      '<span class="tiny muted">It is read from Firestore, so it does not show in local demo mode.</span></div></div>');
    return;
  }
  if (emError === 'empty') {
    shell('email', head, '<div class="card"><div class="empty"><div class="big">&#9993;</div>No email data has been synced yet.<br>' +
      '<span class="tiny muted">Run <code>node tools/ghl-email-sync.js</code> on the computer that has the GHL token.</span></div></div>');
    return;
  }
  if (emError) { shell('email', head, '<div class="card"><div class="empty">Could not load email data.<br><span class="tiny muted">' + esc(emError) + '</span></div></div>'); return; }
  if (!emData) { shell('email', head, '<div class="card"><div class="empty">Loading email history&hellip;</div></div>'); return; }

  const D = emData, E = D.E;
  const sel = emSelect();
  const a = emAggregate(sel);
  const rec = emRecommend(a);
  const r = sel.range;

  /* ---------- sync banner ---------- */
  const partial = emMeta && (!emMeta.complete || emMeta.statusChecked < emMeta.emails);
  const banner = partial
    ? '<div class="em-banner"><b>Sync still running.</b> Live open/click status is in for ' +
      (emMeta.statusChecked || 0).toLocaleString() + ' of ' + (emMeta.emails || 0).toLocaleString() +
      ' emails, newest first. Older emails show as "sent" until their status arrives - hit Reload later.</div>'
    : '';

  /* ---------- filters ---------- */

  const campList = D.camps.map((c, i) => ({ i, c })).filter(x => x.c.day >= r.from && x.c.day <= r.to)
    .sort((x, y) => y.c.day - x.c.day);
  if (emF.camp !== 'all' && !campList.some(x => String(x.i) === String(emF.camp))) {
    const c = D.camps[Number(emF.camp)];
    if (c) campList.unshift({ i: Number(emF.camp), c });
  }
  const sources = [...new Set(D.camps.map(c => c.source))];
  const filters =
    '<div class="card" style="margin-bottom:16px"><div class="card-b wb-filters">' +
      emSel('preset', 'Date range', [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'],
        ['365', 'Last 12 months'], ['ytd', 'This year'], ['all', 'All time'], ['custom', 'Custom dates']], emF.preset) +
      '<label class="wb-f"><span>From</span><input type="date" class="inp sort-sel" data-emf="from" value="' + emDayIso(r.from) +
        '" min="' + emDayIso(D.minDay) + '" max="' + emDayIso(D.maxDay) + '"></label>' +
      '<label class="wb-f"><span>To</span><input type="date" class="inp sort-sel" data-emf="to" value="' + emDayIso(r.to) +
        '" min="' + emDayIso(D.minDay) + '" max="' + emDayIso(Math.max(D.maxDay, r.to)) + '"></label>' +
      '<label class="wb-f"><span>Email / campaign</span><select class="inp sort-sel" data-emf="camp">' +
        '<option value="all">All emails (' + campList.length + ')</option>' +
        campList.map(x => '<option value="' + x.i + '"' + (String(emF.camp) === String(x.i) ? ' selected' : '') + '>' +
          esc(emDayIso(x.c.day) + ' - ' + x.c.subject).slice(0, 90) + '</option>').join('') +
      '</select></label>' +
      (sources.length > 1 ? emSel('source', 'Sent from', [['all', 'Everywhere']].concat(sources.map(s =>
        [s, s === 'bulk_actions' ? 'Bulk action' : s === 'campaign' ? 'Campaign' : s])), emF.source) : '') +
      emSel('status', 'Status', [['all', 'Every email'], ['opened', 'Opened'], ['clicked', 'Clicked a link'],
        ['opened-no-click', 'Opened, no click'], ['unopened', 'Not opened'], ['failed', 'Failed'], ['bot', 'Scanner (bot) clicks']], emF.status) +
      emSel('audience', 'Contacts', [['all', 'Everyone'], ['new', 'Newly opened (first open in range)'],
        ['previous', 'Previously opened (before range)'], ['never', 'Never opened anything']], emF.audience) +
      '<label class="wb-f"><span>Search</span><input class="inp sort-sel" data-emf="q" placeholder="name, email or subject" value="' + esc(emF.q) + '"></label>' +
      '<label class="em-chk"><input type="checkbox" data-emf="bots"' + (emF.bots ? ' checked' : '') + '> Count scanner clicks</label>' +
      '<button class="btn btn-sm" data-act="em-clear">Clear</button>' +
    '</div></div>';

  if (!sel.idx.length) {
    shell('email', head, banner + filters + '<div class="card"><div class="empty">No emails match these filters.</div></div>');
    return;
  }

  /* ---------- tiles ---------- */
  const openRate = pct(a.opened, a.delivered), clickRate = pct(a.clicks, a.delivered);
  const newOpeners = [...a.openers].filter(ci => D.firstOpen[ci] >= r.from && D.firstOpen[ci] <= r.to).length;
  const tiles = '<div class="tiles">' +
    tile({ tone: 'lav', icon: '&#9993;', label: 'Emails sent', value: a.sent.toLocaleString(),
      delta: { text: a.camps.size + ' send' + (a.camps.size === 1 ? '' : 's') },
      foot: a.contacts.size.toLocaleString() + ' contacts &middot; ' + a.failed.toLocaleString() + ' failed' }) +
    tile({ tone: 'mint', icon: '&#128065;', label: 'Opened', value: a.opened.toLocaleString(),
      delta: { dir: openRate >= 35 ? 'up' : openRate >= 20 ? '' : 'down', text: openRate + '%' },
      foot: a.openers.size.toLocaleString() + ' people opened at least one' }) +
    tile({ tone: 'pink', icon: '&#10138;', label: 'Clicked a link', value: a.clicks.toLocaleString(),
      delta: { dir: clickRate >= 2 ? 'up' : clickRate >= 1 ? '' : 'down', text: clickRate + '%' },
      foot: a.clickers.size.toLocaleString() + ' people' + (emF.bots ? ' (scanner clicks included)' : ' &middot; <a href="#" data-act="em-tab" data-v="clicks">' + a.botClicks.toLocaleString() + ' scanner clicks left out</a>') }) +
    tile({ tone: 'cream', icon: '&#9733;', label: 'Newly opened', value: newOpeners.toLocaleString(),
      delta: a.openers.size ? { text: Math.round(newOpeners / a.openers.size * 100) + '% of openers' } : null,
      foot: 'opened for the first time ever in this range' }) +
  '</div>';

  /* ---------- recommendation ---------- */
  const b = rec.best, pk = rec.peak;
  const bestDay = rec.days[0], bestHour = rec.hours[0];
  const recCard =
    '<div class="focus">' +
      '<div class="f-head">' +
        (b
          ? '<b>Best time to send: ' + EM_DAYS[b.di] + ' around ' + emHourLabel(b.h).replace('a', ' AM').replace('p', ' PM') + ' CT</b>' +
            '<span>Emails sent then were opened ' + pct(b.o, b.n) + '% of the time (' + b.n.toLocaleString() + ' sent), against ' +
            openRate + '% overall.' +
            (bestDay ? ' Best day overall: <b>' + bestDay.k + '</b> (' + bestDay.rate + '%).' : '') +
            (bestHour ? ' Best hour overall: <b>' + emHourLabel(bestHour.h) + '</b> (' + bestHour.rate + '%).' : '') +
            (pk && pk.v ? ' Readers are most active <b>' + EM_DAYS[pk.di] + ' ' + emHourLabel(pk.h) + '&ndash;' + emHourLabel((pk.h + 2) % 24) +
              '</b> - land in the inbox just before that.' : '') + '</span>'
          : '<b>Not enough sends yet to recommend a time</b><span>Each day-and-hour slot needs at least ' + rec.minN +
            ' emails before its open rate means anything. Widen the date range.</span>') +
      '</div>' +
    '</div>' +
    '<div class="card gauges"><div class="card-b">' +
      gauge(openRate, 'Open rate', a.opened.toLocaleString() + ' of ' + a.delivered.toLocaleString() + ' delivered', EM_BLUE) +
      gauge(pct(a.clicks, a.opened), 'Click-to-open', a.clicks.toLocaleString() + ' clicks from ' + a.opened.toLocaleString() + ' opens', EM_GREEN) +
    '</div></div>';

  /* ---------- heatmaps ---------- */
  const rateGrid = a.sendN.map((row, di) => row.map((n, h) => (n >= Math.max(30, rec.minN / 5) ? a.sendO[di][h] / n * 100 : null)));
  const heatEngage = '<div class="card" style="margin-top:16px"><div class="card-h"><h3>When people open and click</h3><div class="spacer"></div>' +
    '<span class="tiny muted">' + rec.engTotal.toLocaleString() + ' opens/clicks by day &amp; hour, Central</span></div><div class="card-b">' +
    emHeatmap(a.engage, {
      tip: (di, h, v) => EM_DAYS[di] + ' ' + emHourLabel(h) + '-' + emHourLabel((h + 1) % 24) + ': ' + v.toLocaleString() +
        ' opens/clicks (' + pct(v, rec.engTotal) + '% of all)',
      show: () => '', low: 'quiet', high: 'busiest'
    }) +
    '<div class="tiny muted" style="margin-top:8px">The time is each email\'s most recent open or click - GoHighLevel keeps only the latest one per email.</div>' +
    '</div></div>';
  const heatSend = '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Open rate by send time</h3><div class="spacer"></div>' +
    '<span class="tiny muted">which day &amp; hour you sent, and how many opened</span></div><div class="card-b">' +
    emHeatmap(rateGrid, {
      tip: (di, h, v) => 'Sent ' + EM_DAYS[di] + ' ' + emHourLabel(h) + ': ' + a.sendN[di][h].toLocaleString() + ' emails, ' +
        a.sendO[di][h].toLocaleString() + ' opened (' + v.toFixed(1) + '%), ' + a.sendC[di][h].toLocaleString() + ' clicked',
      show: (v) => Math.round(v), low: 'lower open rate', high: 'higher'
    }) +
    '<div class="tiny muted" style="margin-top:8px">Blank cells: too few emails sent then to judge. Numbers are open rate %.</div>' +
    '</div></div>';

  /* ---------- day / hour / lag bars ---------- */
  const rateBars = (titleTxt, items, note) => wbRateBars(titleTxt, items.map(x => ({ k: x.k, rate: Math.round(x.rate), a: x.o, n: x.n })), note);
  const dayBars = rateBars('Open rate by send day', rec.dayRate.filter(d => d.n).map(d => ({ k: d.k, rate: d.rate, o: d.o, n: d.n })), 'opened of sent');
  const hourBars = rateBars('Open rate by send hour', rec.hourRate.filter(h => h.n >= 20)
    .map(h => ({ k: emHourLabel(h.h) + ' CT', rate: h.rate, o: h.o, n: h.n })), 'hours with 20+ sends');
  const lagNames = ['Within 1 hour', '1-3 hours', '3-24 hours', '1-3 days', '3-7 days', 'Over a week'];
  const lagTot = a.lag.reduce((x, y) => x + y, 0);
  const lagBars = wbBars('How long after sending they engage', a.lag.map((n, i) => ({ k: lagNames[i], n })).filter(x => x.n), lagTot,
    'time to the latest open/click');

  /* ---------- campaigns ---------- */
  const campRows = [...a.camps.values()].sort((x, y) => y.first - x.first);
  const campCard = '<div class="scroll-x"><table class="tbl"><thead><tr><th>Sent</th><th>Subject</th><th>Recipients</th>' +
    '<th>Opened</th><th>Clicked</th><th>Click-to-open</th><th>Failed</th>' + (emF.bots ? '' : '<th>Scanner clicks</th>') + '</tr></thead><tbody>' +
    campRows.slice(0, emShow).map(k => {
      const c = D.camps[k.ki], del = k.n - k.f;
      return '<tr><td class="tiny muted" title="' + esc(emStamp(k.first)) + '">' + esc(emStamp(k.first)) + '</td>' +
        '<td><a href="#" class="n" data-act="em-camp" data-v="' + k.ki + '">' + esc(c.subject) + '</a>' +
          (c.source === 'campaign' ? ' <span class="pill">campaign</span>' : '') + '</td>' +
        '<td>' + k.n.toLocaleString() + '</td>' +
        '<td><b>' + pct(k.o, del) + '%</b> <span class="tiny muted">' + k.o.toLocaleString() + '</span></td>' +
        '<td><b>' + pct(k.c, del) + '%</b> <span class="tiny muted">' + k.c.toLocaleString() + '</span></td>' +
        '<td>' + pct(k.c, k.o) + '%</td>' +
        '<td>' + (k.f ? '<span class="pill bad">' + k.f + '</span>' : '<span class="tiny muted">0</span>') + '</td>' +
        (emF.bots ? '' : '<td class="tiny muted">' + k.b + '</td>') + '</tr>';
    }).join('') + '</tbody></table></div>' +
    (campRows.length > emShow ? '<div class="card-b"><button class="btn btn-sm" data-act="em-more">Show more (' + (campRows.length - emShow) + ' left)</button></div>' : '');

  /* ---------- contacts ---------- */
  const people = [...a.people.values()];
  const sorters = {
    engaged: (x, y) => (y.c - x.c) || (y.o - x.o) || (y.lastOpen - x.lastOpen),
    lastOpen: (x, y) => y.lastOpen - x.lastOpen,
    lastClick: (x, y) => y.lastClick - x.lastClick,
    received: (x, y) => y.n - x.n,
    cold: (x, y) => (x.o - y.o) || (y.n - x.n),
    name: (x, y) => (D.conts[x.ci].name || D.conts[x.ci].email).localeCompare(D.conts[y.ci].name || D.conts[y.ci].email)
  };
  people.sort(sorters[emSort] || sorters.engaged);
  const badge = (ci) => {
    const fo = D.firstOpen[ci];
    if (fo === 0x7fffffff) return '<span class="pill">never opened</span>';
    if (fo >= r.from && fo <= r.to) return '<span class="wb-new" title="Their first-ever open is in this date range">NEW OPENER</span>';
    return '<span class="pill ok" title="First opened on ' + esc(emDayLabel(fo)) + '">opened before</span>';
  };
  const subj = (k) => (k >= 0 ? esc(D.camps[k].subject) : '');
  const contactCard = '<div class="em-toolbar">' +
      emSel('sort', 'Sort contacts', [['engaged', 'Most engaged'], ['lastOpen', 'Opened most recently'], ['lastClick', 'Clicked most recently'],
        ['received', 'Received the most'], ['cold', 'Least engaged'], ['name', 'Name']], emSort) + '</div>' +
    '<div class="scroll-x"><table class="tbl"><thead><tr><th>Contact</th><th>Emails</th><th>Opened</th><th>Clicked</th>' +
    '<th>Last opened</th><th>Last clicked</th><th></th></tr></thead><tbody>' +
    people.slice(0, emShow).map(p => {
      const c = D.conts[p.ci];
      return '<tr><td><a href="#" class="n" data-act="em-person" data-v="' + p.ci + '">' + esc(c.name || c.email) + '</a>' +
          '<div class="tiny muted">' + esc(c.email) + '</div></td>' +
        '<td>' + p.n + '</td>' +
        '<td>' + (p.o ? '<b>' + p.o + '</b> <span class="tiny muted">' + Math.round(p.o / p.n * 100) + '%</span>' : '<span class="tiny muted">0</span>') + '</td>' +
        '<td>' + (p.c ? '<span class="pill ok">' + p.c + '</span>' : '<span class="tiny muted">0</span>') + '</td>' +
        '<td class="tiny">' + (p.lastOpen ? esc(emStamp(p.lastOpen)) + '<div class="muted em-subj">' + subj(p.lastOpenK) + '</div>' : '<span class="muted">-</span>') + '</td>' +
        '<td class="tiny">' + (p.lastClick ? esc(emStamp(p.lastClick)) + '<div class="muted em-subj">' + subj(p.lastClickK) + '</div>' : '<span class="muted">-</span>') + '</td>' +
        '<td>' + badge(p.ci) + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    (people.length > emShow ? '<div class="card-b"><button class="btn btn-sm" data-act="em-more">Show more (' + (people.length - emShow) + ' left)</button></div>' : '');

  /* ---------- every email ---------- */
  const evs = sel.idx.slice().sort((x, y) => E.sent[y] - E.sent[x]);
  const emailCard = '<div class="scroll-x"><table class="tbl"><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Status</th><th>Last opened / clicked</th></tr></thead><tbody>' +
    evs.slice(0, emShow).map(i => {
      const c = D.conts[E.ci[i]];
      return '<tr><td class="tiny muted">' + esc(emStamp(E.sent[i])) + '</td>' +
        '<td><a href="#" class="n" data-act="em-person" data-v="' + E.ci[i] + '">' + esc(c.name || c.email) + '</a><div class="tiny muted">' + esc(c.email) + '</div></td>' +
        '<td class="tiny">' + esc(D.camps[E.ki[i]].subject) + '</td>' +
        '<td>' + emStatusPill(E, i) + '</td>' +
        '<td class="tiny">' + (E.dl[i] >= 0 ? esc(emStamp(E.sent[i] + E.dl[i])) + ' <span class="muted">(' + emLag(E.dl[i]) + ' later)</span>' : '<span class="muted">-</span>') + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    (evs.length > emShow ? '<div class="card-b"><button class="btn btn-sm" data-act="em-more">Show more (' + (evs.length - emShow) + ' left)</button></div>' : '');

  const tab = (v, l, n) => '<button class="seg-btn ' + (emPeopleView === v ? 'on' : '') + '" data-act="em-tab" data-v="' + v + '">' + l +
    ' <b>' + n.toLocaleString() + '</b></button>';
  const listCard = '<div class="card" style="margin-top:16px"><div class="card-h"><div class="seg">' +
    tab('campaigns', 'Campaigns', campRows.length) + tab('contacts', 'Contacts', people.length) + tab('emails', 'Every email', evs.length) + tab('clicks', 'Click quality', a.clickIdx.length) +
    '</div><div class="spacer"></div><span class="tiny muted">' + esc(emDayLabel(r.from)) + ' &ndash; ' + esc(emDayLabel(r.to)) + '</span></div>' +
    (emPeopleView === 'campaigns' ? campCard : emPeopleView === 'emails' ? emailCard :
      emPeopleView === 'clicks' ? emClickQuality(a) : contactCard) + '</div>';

  const y = window.scrollY;
  shell('email', head,
    banner + filters + tiles +
    '<div class="two dash-mid"><div>' + emTrend(a, r) + '</div><div>' + recCard + '</div></div>' +
    '<div class="two em-heats"><div>' + heatEngage + '</div><div>' + heatSend + '</div></div>' +
    '<div class="two" style="margin-top:16px"><div>' + dayBars + hourBars + '</div><div>' + lagBars + '</div></div>' +
    listCard);
  if (emKeepScroll) { window.scrollTo(0, y); }
}

function emLag(s) {
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
  if (s < 172800) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' days';
}
function emStatusPill(E, i) {
  const s = E.st[i];
  if (E.bot[i]) return '<span class="pill warn" title="Clicked within 2 minutes, or this address clicks nearly every email - a mail security scanner">scanner click</span>';
  if (s === C_C) return '<span class="pill ok">clicked</span>';
  if (s === C_O) return '<span class="pill info">opened</span>';
  if (s === C_F) return '<span class="pill bad">failed</span>';
  if (s === C_D) return '<span class="pill">delivered</span>';
  if (s === C_S) return '<span class="pill">sent</span>';
  return '<span class="pill">' + esc(String.fromCharCode(s)) + '</span>';
}

/* ------------------------------------------------------------ click quality
   The evidence behind every "scanner" flag, so a person can judge it.
   A click is flagged when it came within 2 minutes of sending (no person
   opens, reads and clicks that fast across thousands of emails), or when
   the address clicks 80%+ of the 5+ emails it received (a link scanner
   follows every link; people do not).                                    */
const EM_FREE = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|comcast|att|sbcglobal|verizon|bellsouth|cox|charter|protonmail|proton|gmx|mail|zoho|yandex)\./;
const EM_GOLD = '#b8860b';
function emClickReason(E, i) {
  if (!E.bot[i]) return '';
  return E.dl[i] >= 0 && E.dl[i] <= 120 ? 'instant' : 'serial';
}
function emClickQuality(a) {
  const D = emData, E = D.E, ix = a.clickIdx;
  if (!ix.length) return '<div class="empty">No clicks in this selection.</div>';
  let real = 0, instant = 0, serial = 0;
  const SPEED = ['Under 10 seconds', '10-30 seconds', '30 sec - 2 min', '2-10 minutes', '10-60 minutes', '1-24 hours', 'Over a day'];
  const speedBot = SPEED.map(() => 0), speedReal = SPEED.map(() => 0);
  const kind = { personal: { n: 0, b: 0 }, work: { n: 0, b: 0 } };
  const dom = new Map(), who = new Map();
  /* each contact's click habit over everything they were ever sent, not just this filter */
  const habit = new Map();
  for (let i = 0; i < E.n; i++) {
    const h = habit.get(E.ci[i]) || { n: 0, c: 0 };
    h.n++; if (E.st[i] === C_C) h.c++;
    habit.set(E.ci[i], h);
  }
  ix.forEach(i => {
    const r = emClickReason(E, i);
    if (!r) real++; else if (r === 'instant') instant++; else serial++;
    const s = E.dl[i];
    const b = s < 0 ? 6 : s < 10 ? 0 : s < 30 ? 1 : s <= 120 ? 2 : s < 600 ? 3 : s < 3600 ? 4 : s < 86400 ? 5 : 6;
    if (r) speedBot[b]++; else speedReal[b]++;
    const c = D.conts[E.ci[i]];
    const d = (c.email.split('@')[1] || 'unknown').toLowerCase();
    const k = EM_FREE.test(d) ? 'personal' : 'work';
    kind[k].n++; if (r) kind[k].b++;
    const dd = dom.get(d) || { d, k, n: 0, b: 0, people: new Set() };
    dd.n++; if (r) dd.b++; dd.people.add(E.ci[i]); dom.set(d, dd);
    if (r) {
      const w = who.get(E.ci[i]) || { ci: E.ci[i], n: 0, instant: 0, secs: [] };
      w.n++; if (r === 'instant') w.instant++; if (s >= 0) w.secs.push(s);
      who.set(E.ci[i], w);
    }
  });
  const total = ix.length, bots = instant + serial;
  const share = (x) => Math.round(x / total * 100) + '%';

  const head = '<div class="card-b"><div class="em-cq">' +
    '<div><b>' + total.toLocaleString() + '</b><span>clicks recorded by GoHighLevel</span></div>' +
    '<div class="ok"><b>' + real.toLocaleString() + '</b><span>look genuine (' + share(real) + ')</span></div>' +
    '<div class="bad"><b>' + bots.toLocaleString() + '</b><span>scanner clicks (' + share(bots) + ')</span></div>' +
    '<div><b>' + instant.toLocaleString() + '</b><span>came within 2 min of sending</span></div>' +
    '<div><b>' + serial.toLocaleString() + '</b><span>from addresses that click 80%+ of emails</span></div>' +
    '</div><div class="tiny muted" style="margin-top:10px">Work, hospital and university mail servers run link scanners (Mimecast, Proofpoint, ' +
    'Microsoft Defender) that open each email and follow every link the moment it arrives, before a person sees it. GoHighLevel records ' +
    'those as clicks. A person rarely clicks within seconds, and nobody clicks every single email - those are the two tests used here.</div></div>';

  const smax = Math.max(1, ...SPEED.map((_, j) => speedBot[j] + speedReal[j]));
  const speedCard = '<div class="card-b"><h4 class="em-h4">How soon after sending the click came</h4>' +
    '<div class="st-legend" style="margin-bottom:8px"><span><i style="background:' + EM_GREEN + '"></i>Looks genuine</span>' +
    '<span><i style="background:' + EM_GOLD + '"></i>Scanner</span></div><div class="wb-bars">' +
    SPEED.map((l, b) => {
      const n = speedBot[b] + speedReal[b];
      if (!n) return '';
      return '<div class="wb-bar"><div class="wb-bl"><span>' + l + '</span><b>' + n.toLocaleString() +
        '<i>' + speedReal[b] + ' genuine &middot; ' + speedBot[b] + ' scanner</i></b></div>' +
        '<div class="wb-track em-stack"><span style="width:' + (speedReal[b] / smax * 100).toFixed(1) + '%;background:' + EM_GREEN + '"></span>' +
        '<span style="width:' + (speedBot[b] / smax * 100).toFixed(1) + '%;background:' + EM_GOLD + '"></span></div></div>';
    }).join('') + '</div><div class="tiny muted" style="margin-top:6px">Measured from send to the latest click GoHighLevel kept for that email.</div></div>';

  const kindCard = '<div class="card-b"><h4 class="em-h4">Personal inboxes vs work addresses</h4><div class="wb-bars">' +
    [['personal', 'Personal (Gmail, Yahoo, Outlook...)'], ['work', 'Work / hospital / university']].map(kv => {
      const k = kind[kv[0]], p = pct(k.b, k.n);
      return '<div class="wb-bar"><div class="wb-bl"><span>' + kv[1] + '</span><b>' + p + '% scanner<i>' +
        k.b + ' of ' + k.n + ' clicks</i></b></div><div class="wb-track"><span style="width:' + p + '%;background:' + EM_GOLD + '"></span></div></div>';
    }).join('') +
    '</div><div class="tiny muted" style="margin-top:6px">The check on the flags: scanners sit on company mail servers, not on Gmail - ' +
    'so if the flags were wrong, these two rows would look alike.</div></div>';

  const doms = [...dom.values()].filter(x => x.n >= 3).sort((x, y) => y.b - x.b || y.n - x.n).slice(0, 25);
  const domCard = '<div class="card-b"><h4 class="em-h4">Email domains behind the clicks</h4>' +
    '<div class="tiny muted">Domains with 3+ clicks, most scanner clicks first.</div></div><div class="scroll-x"><table class="tbl"><thead><tr>' +
    '<th>Domain</th><th>Type</th><th>People</th><th>Clicks</th><th>Scanner</th><th>Genuine</th></tr></thead><tbody>' +
    doms.map(x => '<tr><td class="n">' + esc(x.d) + '</td><td class="tiny muted">' + x.k + '</td><td>' + x.people.size + '</td><td>' + x.n +
      '</td><td>' + (x.b ? '<span class="pill warn">' + x.b + ' &middot; ' + Math.round(x.b / x.n * 100) + '%</span>' : '<span class="tiny muted">0</span>') +
      '</td><td>' + (x.n - x.b ? '<span class="pill ok">' + (x.n - x.b) + '</span>' : '<span class="tiny muted">0</span>') + '</td></tr>').join('') +
    '</tbody></table></div>';

  const med = (arr) => { if (!arr.length) return -1; const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const ws = [...who.values()].sort((x, y) => y.n - x.n);
  const whoCard = '<div class="card-b"><h4 class="em-h4">Contacts whose clicks were flagged</h4>' +
    '<div class="tiny muted">Click a name to see every email they were sent. Their opens still count; only the flagged clicks are set aside.</div></div>' +
    '<div class="scroll-x"><table class="tbl"><thead><tr><th>Contact</th><th>Emails received</th><th>Clicked (all time)</th>' +
    '<th>Flagged clicks</th><th>Typical time to click</th><th>Why flagged</th></tr></thead><tbody>' +
    ws.slice(0, emShow).map(w => {
      const c = D.conts[w.ci], h = habit.get(w.ci), m = med(w.secs);
      const why = [];
      if (w.instant) why.push(w.instant + ' within 2 min of sending');
      if (h.n >= 5 && h.c / h.n >= 0.8) why.push('clicks ' + Math.round(h.c / h.n * 100) + '% of emails');
      return '<tr><td><a href="#" class="n" data-act="em-person" data-v="' + w.ci + '">' + esc(c.name || c.email) + '</a>' +
        '<div class="tiny muted">' + esc(c.email) + '</div></td><td>' + h.n + '</td><td>' + h.c + ' <span class="tiny muted">' +
        Math.round(h.c / h.n * 100) + '%</span></td><td>' + w.n + '</td><td class="tiny">' +
        (m < 0 ? '-' : m < 60 ? m + ' seconds' : emLag(m)) + '</td><td class="tiny">' + esc(why.join(' · ')) + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    (ws.length > emShow ? '<div class="card-b"><button class="btn btn-sm" data-act="em-more">Show more (' + (ws.length - emShow) + ' left)</button></div>' : '');

  return head + '<div class="two em-cq-two"><div>' + speedCard + '</div><div>' + kindCard + '</div></div>' + domCard + whoCard;
}

/** everything one contact has been sent, newest first */
function emPerson(ci) {
  const D = emData, E = D.E, c = D.conts[ci];
  const rows = [];
  for (let i = 0; i < E.n; i++) if (E.ci[i] === ci) rows.push(i);
  rows.sort((x, y) => E.sent[y] - E.sent[x]);
  const opened = rows.filter(i => emIsOpen(E, i, emF.bots)).length;
  const clicked = rows.filter(i => emIsClick(E, i, emF.bots)).length;
  const fo = D.firstOpen[ci];
  openModal({
    title: c.name || c.email,
    wide: true,
    body: '<div class="tiny muted" style="margin-bottom:12px"><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a> &middot; ' +
      rows.length + ' emails &middot; opened ' + opened + ' &middot; clicked ' + clicked +
      (fo !== 0x7fffffff ? ' &middot; first opened ' + esc(emDayLabel(fo)) : ' &middot; never opened') + '</div>' +
      '<div class="scroll-x" style="max-height:60vh;overflow-y:auto"><table class="tbl"><thead><tr><th>Sent</th><th>Subject</th><th>Status</th><th>Last opened / clicked</th></tr></thead><tbody>' +
      rows.map(i => '<tr><td class="tiny muted">' + esc(emStamp(E.sent[i])) + '</td><td class="tiny">' + esc(D.camps[E.ki[i]].subject) + '</td>' +
        '<td>' + emStatusPill(E, i) + '</td><td class="tiny">' +
        (E.dl[i] >= 0 ? esc(emStamp(E.sent[i] + E.dl[i])) : '<span class="muted">-</span>') + '</td></tr>').join('') +
      '</tbody></table></div>',
    footer: '<button class="btn" data-act="modal-close">Close</button>'
  });
}

/** the current filtered set, one row per email */
function emCsv() {
  const D = emData, E = D.E, sel = emSelect();
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const st = (i) => (E.bot[i] ? 'scanner click' : ({ c: 'clicked', o: 'opened', d: 'delivered', f: 'failed', s: 'sent' })[String.fromCharCode(E.st[i])] || 'other');
  const lines = [['sent_at_central', 'subject', 'source', 'name', 'email', 'status', 'opened', 'clicked', 'last_open_or_click_central', 'first_ever_open']
    .map(q).join(',')];
  sel.idx.forEach(i => {
    const c = D.conts[E.ci[i]], k = D.camps[E.ki[i]], fo = D.firstOpen[E.ci[i]];
    lines.push([emStamp(E.sent[i]), k.subject, k.source, c.name, c.email, st(i),
      emIsOpen(E, i, emF.bots) ? 'yes' : 'no', emIsClick(E, i, emF.bots) ? 'yes' : 'no',
      E.dl[i] >= 0 ? emStamp(E.sent[i] + E.dl[i]) : '', fo !== 0x7fffffff ? emDayIso(fo) : ''].map(q).join(','));
  });
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'email-campaigns_' + emDayIso(sel.range.from) + '_to_' + emDayIso(sel.range.to) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(sel.idx.length.toLocaleString() + ' emails exported', 'ok');
}

/* ------------------------------------------------------------ events */
let emKeepScroll = false;
function emRerender() { emKeepScroll = true; render(); emKeepScroll = false; }

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act^="em-"]');
  if (!t) return;
  e.preventDefault();
  const v = t.dataset.v;
  switch (t.dataset.act) {
    case 'em-reload': emData = null; emError = null; emLoad(true); return;
    case 'em-clear': emF = { preset: '90', from: '', to: '', camp: 'all', source: 'all', status: 'all', audience: 'all', q: '', bots: false }; emShow = 200; emRerender(); return;
    case 'em-tab': emPeopleView = v; emShow = 200; emRerender(); return;
    case 'em-more': emShow += 300; emRerender(); return;
    case 'em-camp': emF.camp = v; emPeopleView = 'contacts'; emShow = 200; render(); return;
    case 'em-person': emPerson(Number(v)); return;
    case 'em-csv': emCsv(); return;
  }
});

let emQTimer = null;
function emOnField(el) {
  const k = el.dataset.emf;
  if (k === 'bots') emF.bots = el.checked;
  else if (k === 'sort') emSort = el.value;
  else if (k === 'from' || k === 'to') {
    const r = emRange();
    emF.from = emF.from || emDayIso(r.from); emF.to = emF.to || emDayIso(r.to);
    emF[k] = el.value; emF.preset = 'custom';
  } else emF[k] = el.value;
  if (k === 'preset' && el.value !== 'custom') { emF.from = ''; emF.to = ''; }
  emShow = 200;
  emRerender();
}
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.emf && el.dataset.emf !== 'q') emOnField(el);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (!(el.dataset && el.dataset.emf === 'q')) return;
  clearTimeout(emQTimer);
  emQTimer = setTimeout(() => {
    emF.q = el.value;
    emShow = 200;
    emRerender();
    const box = document.querySelector('[data-emf="q"]');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }, 350);
});
