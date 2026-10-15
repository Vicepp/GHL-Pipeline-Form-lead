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
let emF = { preset: '90', from: '', to: '', camps: [], source: 'all', status: 'all', audience: 'all', q: '', bots: false };
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
    const [id, name, email, unsub, unsubAt] = l.split('\t');
    conts.push({ id, name: name || '', email: email || '', key: (name + ' ' + email).toLowerCase(),
      unsub: unsub || '', unsubAt: unsubAt ? parseInt(unsubAt, 36) : 0 });
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
  const D = { camps, conts, E, firstOpen, minDay, maxDay };
  emDecodeHealth(D);
  return D;
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
  const pick = emF.camps.length ? new Set(emF.camps) : null;
  const bots = emF.bots;
  const keep = [];
  for (let i = 0; i < E.n; i++) {
    const d = E.day[i];
    if (d < r.from || d > r.to) continue;
    if (pick && !pick.has(E.ki[i])) continue;
    if (emF.source !== 'all' && D.camps[E.ki[i]].source !== emF.source) continue;
    if (emF.status !== 'all') {
      const o = emIsOpen(E, i, bots), c = emIsClick(E, i, bots);
      if (emF.status === 'opened' && !o) continue;
      if (emF.status === 'clicked' && !c) continue;
      if (emF.status === 'opened-no-click' && (!o || c)) continue;
      if (emF.status === 'unopened' && (o || emFailed(E.st[i]))) continue;
      if (emF.status === 'failed' && !emFailed(E.st[i])) continue;
      if (emF.status === 'hard' && E.st[i] !== C_H) continue;
      if (emF.status === 'soft' && E.st[i] !== C_Q) continue;
      if (emF.status === 'blocked' && E.st[i] !== C_K) continue;
      if (emF.status === 'throttled' && E.st[i] !== C_T) continue;
      if (emF.status === 'unsub' && !E.unsubEv[i]) continue;
      if (emF.status === 'bot' && !E.bot[i]) continue;
    }
    if (emF.audience !== 'all') {
      const fo = D.firstOpen[E.ci[i]];
      if (emF.audience === 'new' && !(fo >= r.from && fo <= r.to)) continue;
      if (emF.audience === 'previous' && !(fo < r.from)) continue;
      if (emF.audience === 'never' && fo !== 0x7fffffff) continue;
      if (emF.audience === 'unsub' && !D.conts[E.ci[i]].unsub) continue;
      if (emF.audience === 'subscribed' && D.conts[E.ci[i]].unsub) continue;
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
    if (emFailed(E.st[i])) a.failed++;
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
    k.n++; if (emFailed(E.st[i])) k.f++; if (o) k.o++; if (c) k.c++; if (E.bot[i]) k.b++;
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
    (emData ? '<a class="btn btn-sm btn-gold" href="#/email/24h">Last 24 hours</a>' +
      '<button class="btn btn-sm" data-act="em-csv">Export CSV</button>' : '') +
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
  /* only while emails are genuinely missing a status - every run's first upload is marked
     incomplete, which would otherwise flash this banner for a few minutes every 2 hours */
  const partial = emMeta && emMeta.statusChecked < emMeta.emails;
  const banner = partial
    ? '<div class="em-banner"><b>Sync still running.</b> Live open/click status is in for ' +
      (emMeta.statusChecked || 0).toLocaleString() + ' of ' + (emMeta.emails || 0).toLocaleString() +
      ' emails, newest first. Older emails show as "sent" until their status arrives - hit Reload later.</div>'
    : '';

  /* ---------- filters ---------- */

  const sources = [...new Set(D.camps.map(c => c.source))];
  const filters =
    '<div class="card em-filters" style="margin-bottom:16px"><div class="card-b wb-filters">' +
      emSel('preset', 'Date range', [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'],
        ['365', 'Last 12 months'], ['ytd', 'This year'], ['all', 'All time'], ['custom', 'Custom dates']], emF.preset) +
      '<label class="wb-f"><span>From</span><input type="date" class="inp sort-sel" data-emf="from" value="' + emDayIso(r.from) +
        '" min="' + emDayIso(D.minDay) + '" max="' + emDayIso(D.maxDay) + '"></label>' +
      '<label class="wb-f"><span>To</span><input type="date" class="inp sort-sel" data-emf="to" value="' + emDayIso(r.to) +
        '" min="' + emDayIso(D.minDay) + '" max="' + emDayIso(Math.max(D.maxDay, r.to)) + '"></label>' +
      emPicker(r) +
      (sources.length > 1 ? emSel('source', 'Sent from', [['all', 'Everywhere']].concat(sources.map(s =>
        [s, s === 'bulk_actions' ? 'Bulk action' : s === 'campaign' ? 'Campaign' : s])), emF.source) : '') +
      emSel('status', 'Status', [['all', 'Every email'], ['opened', 'Opened'], ['clicked', 'Clicked a link'],
        ['opened-no-click', 'Opened, no click'], ['unopened', 'Not opened'], ['failed', 'Failed / bounced'], ['hard', '- hard bounce'], ['soft', '- soft bounce'],
        ['blocked', '- blocked / spam filter'], ['throttled', '- throttled (sent too fast)'], ['unsub', 'Unsubscribed after it'], ['bot', 'Scanner (bot) clicks']], emF.status) +
      emSel('audience', 'Contacts', [['all', 'Everyone'], ['new', 'Newly opened (first open in range)'],
        ['previous', 'Previously opened (before range)'], ['never', 'Never opened anything'],
        ['subscribed', 'Still subscribed'], ['unsub', 'Unsubscribed']], emF.audience) +
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
      '<button class="btn btn-gold" data-act="em-analysis">Full analysis &amp; recommendations</button>' +
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
    if (D.conts[ci].unsub) return '<span class="pill bad" title="' + esc(EM_UNSUB[D.conts[ci].unsub] || '') +
      (D.conts[ci].unsubAt ? ' - ' + esc(emStamp(D.conts[ci].unsubAt)) : '') + '">unsubscribed</span>';
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
    emHealthCard(emHealthStats(sel)) + listCard);
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
  if (s === C_H) return '<span class="pill bad" title="The address does not exist">hard bounce</span>';
  if (s === C_Q) return '<span class="pill warn" title="Full inbox or a temporary problem">soft bounce</span>';
  if (s === C_K) return '<span class="pill bad" title="Refused as spam or by policy">blocked</span>';
  if (s === C_T) return '<span class="pill warn" title="Sent too fast - the provider or the sending limit refused it; it never arrived">throttled</span>';
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

/** #/email/24h - the last-24-hours view on a page of its own */
function viewEmail24h() {
  if (!emData && !emLoading && !emError) emLoad();
  const head = title('Last 24 hours', emMeta
    ? 'Who opened or clicked, and on which email &middot; synced ' + esc(ago(emMeta.syncedAt)) + ' &middot; Central time'
    : 'Who opened or clicked, and on which email') +
    '<a class="btn btn-sm" href="#/email">&larr; Email Campaigns</a>' +
    '<button class="btn btn-sm" data-act="em-reload">Reload</button>';
  if (!emData) {
    shell('email', head, '<div class="card"><div class="empty">' + (emError
      ? (emError === 'local' ? 'Email analytics needs the live database.' : emError === 'empty' ? 'No email data has been synced yet.' : 'Could not load email data.<br><span class="tiny muted">' + esc(emError) + '</span>')
      : 'Loading email history&hellip;') + '</div></div>');
    return;
  }
  const y = window.scrollY;
  shell('email', head, emLast24() +
    '<div class="tiny muted">Refreshed every 2 hours by the scheduled sync. Scanner clicks are ' +
    (emF.bots ? 'included' : 'left out') + ' (change it on the Email Campaigns page).</div>');
  if (emKeepScroll) window.scrollTo(0, y);
}

/* ------------------------------------------------------------ last 24 hours
   Who opened or clicked, and on which email, in the 24 hours up to the
   last sync. Anchored to the sync - not to "now" - because nothing after
   the sync is in the data yet, and saying "last 24 hours" over a window
   that is half empty would undercount without saying so. Independent of
   the filters below it; the scanner-click setting still applies.       */
let emL24 = 'contacts';   /* contacts | campaigns */
function emLast24() {
  const D = emData, E = D.E, bots = emF.bots;
  const end = Math.round(new Date(emMeta && emMeta.syncedAt ? emMeta.syncedAt : Date.now()).getTime() / 1000);
  const start = end - 86400;
  const hours = Array.from({ length: 24 }, () => ({ o: 0, c: 0 }));
  const camps = new Map(), people = new Map();
  let opens = 0, clicks = 0;
  for (let i = 0; i < E.n; i++) {
    if (E.dl[i] < 0) continue;
    const at = E.sent[i] + E.dl[i];
    if (at < start || at > end) continue;
    const o = emIsOpen(E, i, bots);
    if (!o) continue;
    const c = emIsClick(E, i, bots);
    opens++; if (c) clicks++;
    const h = hours[Math.min(23, Math.floor((at - start) / 3600))];
    if (c) h.c++; else h.o++;
    const k = camps.get(E.ki[i]) || { ki: E.ki[i], o: 0, c: 0, last: 0, people: new Set() };
    k.o++; if (c) k.c++; if (at > k.last) k.last = at; k.people.add(E.ci[i]);
    camps.set(E.ki[i], k);
    const p = people.get(E.ci[i]) || { ci: E.ci[i], acts: [] };
    p.acts.push({ i, at, c });
    people.set(E.ci[i], p);
  }
  const syncTxt = emStamp(end);
  const headH = '<div class="card-h"><h3>Last 24 hours</h3><span class="tiny muted">up to the last sync, ' + esc(syncTxt) +
    ' CT</span><div class="spacer"></div>';
  if (!opens) {
    return '<div class="card" style="margin-bottom:16px">' + headH + '</div><div class="empty">No opens or clicks in the 24 hours before the last sync.</div></div>';
  }

  /* hour-by-hour columns, stacked: opened-only underneath, clicked on top */
  const W = 720, H = 150, L = 30, B = 22, T = 8;
  const max = Math.max(1, ...hours.map(h => h.o + h.c));
  const bw = (W - L) / 24;
  const y = (v) => (H - B - T) * v / max;
  const cols = hours.map((h, j) => {
    const x = L + j * bw + 2, w = bw - 4;
    const ho = y(h.o), hc = y(h.c);
    const t0 = start + j * 3600;
    const tip = emStamp(t0) + ' - ' + emStamp(t0 + 3600).replace(/^.*, /, '') + '\n' + (h.o + h.c) + ' opened' +
      (h.c ? ', ' + h.c + ' of them clicked' : '');
    return '<g><title>' + esc(tip) + '</title>' +
      (ho ? '<rect x="' + x.toFixed(1) + '" y="' + (H - B - ho).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + ho.toFixed(1) + '" rx="2" fill="' + EM_BLUE + '"/>' : '') +
      (hc ? '<rect x="' + x.toFixed(1) + '" y="' + (H - B - ho - hc - (ho ? 2 : 0)).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hc.toFixed(1) + '" rx="2" fill="' + EM_GREEN + '"/>' : '') +
      '<rect x="' + (L + j * bw).toFixed(1) + '" y="' + T + '" width="' + bw.toFixed(1) + '" height="' + (H - B - T) + '" fill="transparent"/></g>';
  }).join('');
  const xl = hours.map((_, j) => (j % 3 === 0
    ? '<text x="' + (L + j * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="em-ax">' +
      esc(emHourLabel(emCal(start + j * 3600).hour)) + '</text>' : '')).join('');
  const yl = '<text x="' + (L - 6) + '" y="' + (T + 8) + '" text-anchor="end" class="em-ax">' + max + '</text>' +
    '<text x="' + (L - 6) + '" y="' + (H - B) + '" text-anchor="end" class="em-ax">0</text>' +
    '<line x1="' + L + '" x2="' + W + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="rgba(16,24,40,.12)"/>';
  const chart = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="em-trend" role="img" aria-label="Opens and clicks per hour, last 24 hours">' +
    yl + cols + xl + '</svg>';

  const nPeople = people.size, nClickers = [...people.values()].filter(p => p.acts.some(a => a.c)).length;
  const stats = '<div class="em-cq em-l24">' +
    '<div><b>' + opens.toLocaleString() + '</b><span>emails opened</span></div>' +
    '<div class="ok"><b>' + clicks.toLocaleString() + '</b><span>' + (bots ? 'clicked (scanners included)' : 'genuine clicks') + '</span></div>' +
    '<div><b>' + nPeople.toLocaleString() + '</b><span>people engaged</span></div>' +
    '<div><b>' + nClickers.toLocaleString() + '</b><span>people clicked</span></div>' +
    '<div><b>' + camps.size.toLocaleString() + '</b><span>emails they engaged with</span></div></div>';

  const seg = (v, l, n) => '<button class="seg-btn ' + (emL24 === v ? 'on' : '') + '" data-act="em-l24" data-v="' + v + '">' + l + ' <b>' + n + '</b></button>';
  let list;
  if (emL24 === 'campaigns') {
    const ks = [...camps.values()].sort((a, b) => b.o - a.o);
    list = '<div class="scroll-x em-l24-list"><table class="tbl"><thead><tr><th>Email</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>People</th><th>Latest</th></tr></thead><tbody>' +
      ks.map(k => {
        const c = D.camps[k.ki];
        return '<tr><td><a href="#" class="n" data-act="em-camp" data-v="' + k.ki + '">' + esc(c.subject) + '</a></td>' +
          '<td class="tiny muted">' + esc(emDayLabel(c.day)) + '</td><td><b>' + k.o + '</b></td>' +
          '<td>' + (k.c ? '<span class="pill ok">' + k.c + '</span>' : '<span class="tiny muted">0</span>') + '</td>' +
          '<td>' + k.people.size + '</td><td class="tiny">' + esc(emStamp(k.last)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  } else {
    const ps = [...people.values()].map(p => { p.acts.sort((a, b) => b.at - a.at); return p; })
      .sort((a, b) => (b.acts.some(x => x.c) - a.acts.some(x => x.c)) || (b.acts[0].at - a.acts[0].at));
    list = '<div class="scroll-x em-l24-list"><table class="tbl"><thead><tr><th>Contact</th><th>Did</th><th>Email</th><th>When</th></tr></thead><tbody>' +
      ps.map(p => {
        const c = D.conts[p.ci], a = p.acts[0], more = p.acts.length - 1;
        return '<tr><td><a href="#" class="n" data-act="em-person" data-v="' + p.ci + '">' + esc(c.name || c.email) + '</a>' +
          '<div class="tiny muted">' + esc(c.email) + '</div></td>' +
          '<td>' + (p.acts.some(x => x.c) ? '<span class="pill ok">clicked</span>' : '<span class="pill info">opened</span>') + '</td>' +
          '<td class="tiny"><div class="em-subj">' + esc(D.camps[E.ki[a.i]].subject) + '</div>' +
            (more ? '<span class="muted">+ ' + more + ' more email' + (more === 1 ? '' : 's') + '</span>' : '') + '</td>' +
          '<td class="tiny">' + esc(emStamp(a.at)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  return '<div class="card" style="margin-bottom:16px">' + headH +
    '<div class="st-legend"><span><i style="background:' + EM_BLUE + '"></i>Opened</span>' +
    '<span><i style="background:' + EM_GREEN + '"></i>Clicked</span></div></div>' +
    '<div class="card-b">' + stats + '<div style="margin-top:14px">' + chart + '</div></div>' +
    '<div class="card-h"><div class="seg">' + seg('contacts', 'Contacts', nPeople) + seg('campaigns', 'Emails', camps.size) + '</div>' +
    '<div class="spacer"></div><span class="tiny muted">clickers first, then most recent</span></div>' + list + '</div>';
}

/* ------------------------------------------------------------ bounces + unsubscribes
   Failed sends come split by the receiving server's reply (sync: failKind):
     h hard bounce - the address does not exist; never send to it again
     q soft bounce - full inbox, temporary; may deliver next time
     k blocked     - refused as spam / by policy; a sender-reputation signal
     t throttled   - we sent too fast: the provider or GHL's sending limit refused it
     f other
   Unsubscribes are contacts with email Do-Not-Disturb, the reason GHL stored,
   and the date from their activity log. Each is pinned to the last email the
   person received before it - the one that tipped them over.             */
const C_H = 'h'.charCodeAt(0), C_Q = 'q'.charCodeAt(0), C_K = 'k'.charCodeAt(0), C_T = 't'.charCodeAt(0);
function emFailed(s) { return s === C_F || s === C_H || s === C_Q || s === C_K || s === C_T; }
const EM_FAIL = { t: 'Throttled: sent too fast / sending limit', q: 'Soft bounce: full inbox', h: 'Hard bounce: address does not exist',
  k: 'Blocked: spam filter / reputation', f: 'Other failure' };
const EM_UNSUB = {
  n: 'No longer wants these emails', l: 'Clicked the unsubscribe link', p: 'Provider: permanent bounce / spam',
  s: 'Marked as spam', x: 'Never signed up', m: 'Other / set by staff'
};
const EM_RED = '#c0392b', EM_AMBER = '#b8860b';

/** build the per-contact facts the health and fatigue views need (once, at load) */
function emDecodeHealth(D) {
  const E = D.E, n = E.n, nc = D.conts.length;
  const byC = Array.from({ length: nc }, () => []);
  for (let i = 0; i < n; i++) byC[E.ci[i]].push(i);
  E.prior7 = new Uint8Array(n);        /* emails this contact got in the 7 days before this one */
  E.unsubEv = new Uint8Array(n);       /* the email after which they unsubscribed */
  E.afterUnsub = new Uint8Array(n);    /* sent more than a day after they unsubscribed */
  E.afterHard = new Uint8Array(n);     /* sent to an address that had already hard-bounced */
  byC.forEach((list, ci) => {
    list.sort((x, y) => E.sent[x] - E.sent[y]);
    let lo = 0;
    for (let j = 0; j < list.length; j++) {
      while (E.sent[list[j]] - E.sent[list[lo]] > 7 * 86400) lo++;
      E.prior7[list[j]] = Math.min(255, j - lo);
    }
    const ua = D.conts[ci].unsubAt;
    if (ua) {
      let last = -1;
      for (const i of list) { if (E.sent[i] <= ua) last = i; else if (E.sent[i] > ua + 86400) E.afterUnsub[i] = 1; }
      if (last >= 0) E.unsubEv[last] = 1;
    }
    let hardAt = 0;
    for (const i of list) {
      if (hardAt && E.sent[i] > hardAt) E.afterHard[i] = 1;
      if (!hardAt && E.st[i] === C_H) hardAt = E.sent[i];
    }
  });
}

/** everything list-health, over the current selection */
function emHealthStats(sel) {
  const D = emData, E = D.E;
  const h = { sent: sel.idx.length, fail: { t: 0, h: 0, q: 0, k: 0, f: 0 }, tDays: new Map(), failed: 0, unsub: 0, uReason: {}, months: new Map(),
    camps: new Map(), afterUnsub: 0, afterUnsubPeople: new Set(), afterHard: 0, afterHardPeople: new Set(), spam: 0 };
  for (const i of sel.idx) {
    const s = E.st[i], ci = E.ci[i];
    const mo = emDayIso(E.day[i]).slice(0, 7);
    let m = h.months.get(mo);
    if (!m) { m = { n: 0, f: 0, hb: 0, u: 0 }; h.months.set(mo, m); }
    m.n++;
    let k = h.camps.get(E.ki[i]);
    if (!k) { k = { ki: E.ki[i], n: 0, f: 0, u: 0 }; h.camps.set(E.ki[i], k); }
    k.n++;
    if (emFailed(s)) {
      h.failed++; m.f++; k.f++;
      h.fail[String.fromCharCode(s)]++;
      if (s === C_H) m.hb++;
      if (s === C_T) h.tDays.set(E.day[i], (h.tDays.get(E.day[i]) || 0) + 1);
    }
    if (E.unsubEv[i]) {
      h.unsub++; m.u++; k.u++;
      const r = D.conts[ci].unsub || 'm';
      h.uReason[r] = (h.uReason[r] || 0) + 1;
      if (r === 's' || r === 'p') h.spam++;
    }
    if (E.afterUnsub[i]) { h.afterUnsub++; h.afterUnsubPeople.add(ci); }
    if (E.afterHard[i]) { h.afterHard++; h.afterHardPeople.add(ci); }
  }
  return h;
}

/** monthly columns - one measure per chart, never two axes */
function emMonthChart(months, val, fmt, tip, colour) {
  const keys = [...months.keys()].sort();
  if (keys.length < 2) return '<div class="tiny muted">Needs at least two months in the date range.</div>';
  const vals = keys.map(k => val(months.get(k)));
  const max = Math.max(...vals, 0.0001);
  const W = 720, H = 160, L = 40, B = 22, T = 10, bw = (W - L) / keys.length;
  const bars = keys.map((k, j) => {
    const v = vals[j], hgt = (H - B - T) * v / max;
    return '<g><title>' + esc(tip(k, months.get(k))) + '</title>' +
      '<rect x="' + (L + j * bw + 1.5).toFixed(1) + '" y="' + (H - B - hgt).toFixed(1) + '" width="' + Math.max(2, bw - 3).toFixed(1) +
      '" height="' + Math.max(0, hgt).toFixed(1) + '" rx="3" fill="' + colour + '"/>' +
      '<rect x="' + (L + j * bw).toFixed(1) + '" y="' + T + '" width="' + bw.toFixed(1) + '" height="' + (H - B - T) + '" fill="transparent"/></g>';
  }).join('');
  const every = Math.max(1, Math.ceil(keys.length / 10));
  const xl = keys.map((k, j) => (j % every === 0 ? '<text x="' + (L + j * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) +
    '" text-anchor="middle" class="em-ax">' + esc(new Date(k + '-01T12:00:00Z').toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })) +
    '</text>' : '')).join('');
  const yl = '<text x="' + (L - 6) + '" y="' + (T + 8) + '" text-anchor="end" class="em-ax">' + esc(fmt(max)) + '</text>' +
    '<text x="' + (L - 6) + '" y="' + (H - B) + '" text-anchor="end" class="em-ax">0</text>' +
    '<line x1="' + L + '" x2="' + W + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="rgba(16,24,40,.12)"/>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="em-trend" role="img">' + yl + bars + xl + '</svg>';
}

function emHealthCard(h) {
  const D = emData;
  const del = h.sent - h.failed;
  const fr = pct(h.failed, h.sent), hr = pct(h.fail.h, h.sent);
  const per1k = (x, n) => (n ? Math.round(x / n * 10000) / 10 : 0);
  const stat = (v, l, tone) => '<div class="' + (tone || '') + '"><b>' + v + '</b><span>' + l + '</span></div>';
  const tone = (v, ok, warn) => (v <= ok ? 'ok' : v <= warn ? '' : 'bad');
  const kpis = '<div class="em-cq">' +
    stat(fr + '%', 'bounce / failure rate (' + h.failed.toLocaleString() + ')', tone(fr, 2, 5)) +
    stat(hr + '%', 'hard bounces - dead addresses (' + h.fail.h.toLocaleString() + ')', tone(hr, 0.5, 2)) +
    stat(pct(h.fail.t, h.sent) + '%', 'throttled - sent too fast (' + h.fail.t.toLocaleString() + ')', tone(pct(h.fail.t, h.sent), 0.5, 2)) +
    stat(h.unsub.toLocaleString(), 'unsubscribed after these emails', '') +
    stat(per1k(h.unsub, del) + '', 'unsubscribes per 1,000 delivered', tone(per1k(h.unsub, del), 2, 5)) +
    stat(per1k(h.spam, del) + '', 'spam reports per 1,000 delivered', tone(per1k(h.spam, del), 1, 3)) +
    '</div>';
  const reasons = (obj, names, total, colour) => '<div class="wb-bars">' + Object.keys(names).filter(k => obj[k])
    .sort((a, b) => obj[b] - obj[a]).map(k => '<div class="wb-bar"><div class="wb-bl"><span>' + esc(names[k]) + '</span><b>' +
      obj[k].toLocaleString() + '<i>' + Math.round(obj[k] / total * 100) + '%</i></b></div><div class="wb-track"><span style="width:' +
      (obj[k] / total * 100).toFixed(1) + '%;background:' + colour + '"></span></div></div>').join('') + '</div>';
  const topUnsub = [...h.camps.values()].filter(k => k.u && k.n >= 100)
    .map(k => Object.assign(k, { r: per1k(k.u, k.n - k.f) })).sort((a, b) => b.r - a.r).slice(0, 8);
  return '<div class="card" style="margin-top:16px"><div class="card-h"><h3>List health: bounces &amp; unsubscribes</h3><div class="spacer"></div>' +
    '<button class="btn btn-sm btn-gold" data-act="em-analysis">Full analysis &amp; recommendations</button></div>' +
    '<div class="card-b">' + kpis + '</div>' +
    '<div class="two em-cq-two"><div class="card-b"><h4 class="em-h4">Bounce / failure rate by month</h4>' +
      emMonthChart(h.months, m => (m.n ? m.f / m.n * 100 : 0), v => v.toFixed(1) + '%',
        (k, m) => k + ': ' + m.f + ' of ' + m.n.toLocaleString() + ' failed (' + pct(m.f, m.n) + '%), ' + m.hb + ' hard bounces', EM_RED) +
      (h.failed ? '<h4 class="em-h4" style="margin-top:14px">Why they failed</h4>' + reasons(h.fail, EM_FAIL, h.failed, EM_RED) : '') +
    '</div><div class="card-b"><h4 class="em-h4">Unsubscribes by month</h4>' +
      emMonthChart(h.months, m => m.u, v => String(Math.round(v)),
        (k, m) => k + ': ' + m.u + ' unsubscribed (' + per1k(m.u, m.n) + ' per 1,000 sent)', EM_AMBER) +
      (h.unsub ? '<h4 class="em-h4" style="margin-top:14px">What they said</h4>' + reasons(h.uReason, EM_UNSUB, h.unsub, EM_AMBER) : '') +
    '</div></div>' +
    (topUnsub.length ? '<div class="card-b"><h4 class="em-h4">Emails people unsubscribed after</h4>' +
      '<div class="tiny muted">The last email each person received before unsubscribing. Sends with 100+ recipients, highest rate first.</div></div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr><th>Email</th><th>Sent</th><th>Recipients</th><th>Unsubscribed</th><th>Per 1,000</th></tr></thead><tbody>' +
      topUnsub.map(k => '<tr><td><a href="#" class="n" data-act="em-camp" data-v="' + k.ki + '">' + esc(D.camps[k.ki].subject) + '</a></td>' +
        '<td class="tiny muted">' + esc(emDayLabel(D.camps[k.ki].day)) + '</td><td>' + k.n.toLocaleString() + '</td><td>' + k.u + '</td>' +
        '<td><span class="pill ' + (k.r > 5 ? 'bad' : k.r > 2 ? 'warn' : 'ok') + '">' + k.r + '</span></td></tr>').join('') +
      '</tbody></table></div>' : '') +
    '</div>';
}

/* ------------------------------------------------------------ the analysis pop-up
   Every number here is computed from the current filters; the verdicts compare
   them with the thresholds mailbox providers and ESPs publish:
     bounce < 2%            (most ESPs review accounts above ~5%)
     spam reports < 0.1%    (Google/Yahoo bulk-sender rule: never above 0.3%)
     unsubscribes < 0.5%    per send is typical for a healthy list           */
function emAnalysis() {
  const D = emData, E = D.E, sel = emSelect(), a = emAggregate(sel), rec = emRecommend(a), h = emHealthStats(sel);
  const r = sel.range, bots = emF.bots;
  const del = h.sent - h.failed;
  const openRate = pct(a.opened, a.delivered), clickRate = pct(a.clicks, a.delivered);
  const per1k = (x, n) => (n ? Math.round(x / n * 10000) / 10 : 0);
  const verdict = (tone, text) => '<span class="pill ' + tone + '">' + text + '</span>';

  /* frequency: how much does one more email this week cost? */
  const FB = ['0', '1', '2', '3', '4-5', '6+'];
  const fb = FB.map(k => ({ k, n: 0, o: 0, u: 0, f: 0 }));
  for (const i of sel.idx) {
    const p = E.prior7[i], b = fb[p >= 6 ? 5 : p >= 4 ? 4 : p];
    b.n++; if (emIsOpen(E, i, bots)) b.o++; if (E.unsubEv[i]) b.u++; if (emFailed(E.st[i])) b.f++;
  }
  const fbr = fb.map(b => Object.assign(b, { or: pct(b.o, b.n - b.f), ur: per1k(b.u, b.n - b.f) }));
  const lowF = fbr.filter((b, j) => j <= 1 && b.n >= 200), highF = fbr.filter((b, j) => j >= 3 && b.n >= 200);
  const lowOR = lowF.length ? lowF.reduce((s, b) => s + b.o, 0) / lowF.reduce((s, b) => s + b.n - b.f, 0) * 100 : null;
  const highOR = highF.length ? highF.reduce((s, b) => s + b.o, 0) / highF.reduce((s, b) => s + b.n - b.f, 0) * 100 : null;
  const lowUR = lowF.length ? lowF.reduce((s, b) => s + b.u, 0) / lowF.reduce((s, b) => s + b.n - b.f, 0) * 1000 : null;
  const highUR = highF.length ? highF.reduce((s, b) => s + b.u, 0) / highF.reduce((s, b) => s + b.n - b.f, 0) * 1000 : null;
  const weeks = Math.max(1, (r.to - r.from + 1) / 7);
  const perWeek = a.contacts.size ? Math.round(a.sent / a.contacts.size / weeks * 10) / 10 : 0;
  const fatigue = lowOR != null && highOR != null ? (lowOR - highOR) / lowOR * 100 : null;

  /* inactive: plenty of chances, never opened */
  let inactive = 0, inactiveSends = 0;
  a.people.forEach(p => { if (p.n >= 10 && p.o === 0) { inactive++; inactiveSends += p.n; } });

  /* worst send slots, for "avoid" */
  const slots = [];
  for (let di = 0; di < 7; di++) for (let hh = 0; hh < 24; hh++) {
    const n = a.sendN[di][hh];
    if (n >= rec.minN) slots.push({ di, hh, n, r: a.sendO[di][hh] / n * 100, c: a.sendC[di][hh] / n * 100 });
  }
  slots.sort((x, y) => y.r - x.r);
  const slotName = (s) => EM_DAYS[s.di] + ' ' + emHourLabel(s.hh).replace('a', ' AM').replace('p', ' PM');

  /* ---------- recommendations, worst first ---------- */
  const recs = [];
  const fr = pct(h.failed, h.sent), hard = pct(h.fail.h, h.sent), spam1k = per1k(h.spam, del), un1k = per1k(h.unsub, del);
  if (h.afterUnsubPeople.size) recs.push(['bad', '<b>' + h.afterUnsubPeople.size + ' people were emailed after they unsubscribed</b> (' +
    h.afterUnsub.toLocaleString() + ' emails). That is a CAN-SPAM problem and the fastest route to spam reports. Check the bulk-action ' +
    'lists: contacts with email DND must be excluded.']);
  if (h.afterHardPeople.size) recs.push(['bad', '<b>' + h.afterHardPeople.size + ' addresses kept getting emails after a hard bounce</b> (' +
    h.afterHard.toLocaleString() + ' sends). A hard bounce means the address does not exist; remove them - repeat bounces hurt delivery to everyone else.']);
  if (h.fail.t > h.failed * 0.3 && h.fail.t >= 50) {
    const worst = [...h.tDays.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([d, n]) => emDayLabel(d) + ' (' + n.toLocaleString() + ')').join(', ');
    recs.push(['bad', '<b>' + Math.round(h.fail.t / h.failed * 100) + '% of failed emails (' + h.fail.t.toLocaleString() +
      ') were throttled - not bad addresses.</b> Microsoft refused too many connections at once, or the GHL/Mailgun sending limit for ' +
      'phcinvest.com was hit, and the retries ran out. These people never got the email. Worst days: ' + worst + '. ' +
      'Send big lists in batches (GHL bulk action: "send in batches", e.g. 200 every 10-15 minutes) instead of all at once, and resend to the throttled contacts.']);
  }
  const realBounce = pct(h.fail.h + h.fail.q + h.fail.k + h.fail.f, h.sent);
  if (realBounce > 2) recs.push([realBounce > 5 ? 'bad' : 'warn', 'Bounce rate (not counting throttling) is <b>' + realBounce + '%</b> (aim under 2%): ' +
    h.fail.h.toLocaleString() + ' hard, ' + h.fail.q.toLocaleString() + ' soft, ' + h.fail.k.toLocaleString() + ' blocked. Clean the hard bounces; verify new lists before importing.']);
  if (h.fail.k > h.failed * 0.25 && h.fail.k > 20) recs.push(['warn', '<b>' + h.fail.k.toLocaleString() + ' emails were blocked as spam or by policy.</b> ' +
    'That points at sender reputation or content, not bad addresses - check SPF/DKIM/DMARC on the sending domain and tone down sales-heavy subject lines.']);
  if (spam1k > 1) recs.push([spam1k > 3 ? 'bad' : 'warn', 'Spam reports run at <b>' + spam1k + ' per 1,000</b> (Google and Yahoo want under 1, and block above 3).']);
  if (fatigue != null && fatigue > 15) recs.push(['warn', '<b>Sending too often.</b> Contacts who already had 3+ emails that week open ' +
    highOR.toFixed(1) + '% of the time, against ' + lowOR.toFixed(1) + '% for those who had 0-1 - ' + Math.round(fatigue) + '% fewer opens' +
    (highUR != null && lowUR != null && highUR > lowUR ? ', and they unsubscribe ' + (highUR / Math.max(lowUR, 0.01)).toFixed(1) + 'x as often' : '') +
    '. Cap at about 2 emails per contact per week.']);
  else if (fatigue != null) recs.push(['ok', 'No sign of email fatigue yet: open rates hold up when contacts get several emails in a week (' +
    lowOR.toFixed(1) + '% vs ' + highOR.toFixed(1) + '%).']);
  if (inactive) recs.push(['warn', '<b>' + inactive.toLocaleString() + ' contacts got 10+ emails and never opened one</b> (' +
    inactiveSends.toLocaleString() + ' emails). Send them one re-engagement email, then stop emailing those who still do not open - it lifts open rates and protects the domain.']);
  if (h.uReason.x) recs.push(['warn', '<b>' + h.uReason.x + ' people said they never signed up.</b> Find which list or form they came from - that source is adding people without consent.']);
  if (rec.best) recs.push(['ok', '<b>Send on ' + slotName({ di: rec.best.di, hh: rec.best.h }) + ' CT.</b> Emails sent then were opened ' +
    pct(rec.best.o, rec.best.n) + '% of the time against ' + openRate + '% overall (' + rec.best.n.toLocaleString() + ' emails).']);
  if (un1k <= 5 && fr <= 2 && spam1k <= 1) recs.push(['ok', 'Deliverability looks healthy: bounces ' + fr + '%, unsubscribes ' + un1k + ' and spam reports ' + spam1k + ' per 1,000.']);

  const fbTable = '<table class="tbl"><thead><tr><th>Emails that contact had in the previous 7 days</th><th>Emails</th><th>Open rate</th><th>Unsubscribes per 1,000</th></tr></thead><tbody>' +
    fbr.filter(b => b.n).map(b => '<tr><td>' + b.k + '</td><td>' + b.n.toLocaleString() + '</td><td><b>' + b.or + '%</b></td><td>' + b.ur + '</td></tr>').join('') +
    '</tbody></table>';
  const slotTable = (list) => '<table class="tbl"><thead><tr><th>Send time (CT)</th><th>Emails</th><th>Open rate</th><th>Click rate</th></tr></thead><tbody>' +
    list.map(s => '<tr><td>' + slotName(s) + '</td><td>' + s.n.toLocaleString() + '</td><td><b>' + s.r.toFixed(1) + '%</b></td><td>' + s.c.toFixed(1) + '%</td></tr>').join('') +
    '</tbody></table>';

  const sec = (t, body) => '<div class="em-an-sec"><h4>' + t + '</h4>' + body + '</div>';
  openModal({
    title: 'Email analysis & recommendations',
    wide: true,
    body: '<div class="tiny muted" style="margin-bottom:12px">' + esc(emDayLabel(r.from)) + ' &ndash; ' + esc(emDayLabel(r.to)) + ' &middot; ' +
      a.sent.toLocaleString() + ' emails to ' + a.contacts.size.toLocaleString() + ' contacts &middot; uses the filters on the page' +
      (bots ? '' : ' &middot; scanner clicks left out') + '</div>' +
      '<div class="em-an">' +
      sec('What to do', '<ul class="em-recs">' + recs.map(x => '<li class="' + x[0] + '">' + x[1] + '</li>').join('') + '</ul>') +
      sec('When to send', (slots.length
        ? '<div class="em-an-two"><div><div class="tiny muted">Best send times (each with ' + rec.minN.toLocaleString() + '+ emails)</div>' + slotTable(slots.slice(0, 5)) +
          '</div><div><div class="tiny muted">Weakest send times</div>' + slotTable(slots.slice(-3).reverse()) + '</div></div>' +
          '<p class="tiny">Best day overall: <b>' + (rec.days[0] ? rec.days[0].k + ' (' + rec.days[0].rate + '%)' : '-') + '</b> &middot; best hour: <b>' +
          (rec.hours[0] ? emHourLabel(rec.hours[0].h) + ' (' + rec.hours[0].rate + '%)' : '-') + '</b>' +
          (rec.peak && rec.peak.v ? ' &middot; people read most on <b>' + EM_DAYS[rec.peak.di] + ' ' + emHourLabel(rec.peak.h) + '&ndash;' + emHourLabel((rec.peak.h + 2) % 24) + '</b>' : '') + '.</p>'
        : '<p class="tiny muted">Not enough emails in this range to rank send times - widen the dates.</p>')) +
      sec('Are we sending too many?', '<p>Each contact gets about <b>' + perWeek + ' emails a week</b> in this range. ' +
        (fatigue == null ? 'Not enough data to measure fatigue.' : fatigue > 15
          ? verdict('warn', 'fatigue: ' + Math.round(fatigue) + '% fewer opens') + ' when a contact already had 3+ that week.'
          : verdict('ok', 'no clear fatigue') + ' - opens hold up with more emails per week.') + '</p>' + fbTable) +
      sec('Bounces', '<p>' + verdict(fr <= 2 ? 'ok' : fr <= 5 ? 'warn' : 'bad', fr + '% bounced') + ' ' + h.failed.toLocaleString() + ' of ' + h.sent.toLocaleString() +
        ' emails failed: <b>' + h.fail.t + '</b> throttled (sent too fast - our side), <b>' + h.fail.h + '</b> hard (dead address), <b>' + h.fail.q +
        '</b> soft (full inbox), <b>' + h.fail.k + '</b> blocked (spam filter / reputation), <b>' + h.fail.f + '</b> other. ' +
        'Real bounces, leaving out throttling: <b>' + pct(h.fail.h + h.fail.q + h.fail.k + h.fail.f, h.sent) + '%</b> (benchmark: under 2%).</p>' +
        (h.afterHardPeople.size ? '<p>' + verdict('bad', h.afterHardPeople.size + ' dead addresses still emailed') + '</p>' : '')) +
      sec('Unsubscribes', '<p>' + verdict(un1k <= 2 ? 'ok' : un1k <= 5 ? 'warn' : 'bad', un1k + ' per 1,000') + ' ' + h.unsub + ' people unsubscribed after these emails; ' +
        h.spam + ' of them through a spam report (' + spam1k + ' per 1,000 - keep it under 1).</p>' +
        '<div class="wb-bars">' + Object.keys(EM_UNSUB).filter(k => h.uReason[k]).sort((x, y) => h.uReason[y] - h.uReason[x]).map(k =>
          '<div class="wb-bar"><div class="wb-bl"><span>' + EM_UNSUB[k] + '</span><b>' + h.uReason[k] + '<i>' + Math.round(h.uReason[k] / h.unsub * 100) + '%</i></b></div>' +
          '<div class="wb-track"><span style="width:' + (h.uReason[k] / h.unsub * 100).toFixed(1) + '%;background:' + EM_AMBER + '"></span></div></div>').join('') + '</div>' +
        (h.afterUnsubPeople.size ? '<p>' + verdict('bad', h.afterUnsubPeople.size + ' people emailed after unsubscribing') + '</p>' : '')) +
      sec('Engagement', '<p>Opened <b>' + openRate + '%</b> &middot; clicked <b>' + clickRate + '%</b> &middot; click-to-open <b>' + pct(a.clicks, a.opened) + '%</b>' +
        ' &middot; ' + a.openers.size.toLocaleString() + ' people opened at least one, ' + a.clickers.size.toLocaleString() + ' clicked. ' +
        inactive.toLocaleString() + ' contacts had 10+ emails and opened none.</p>') +
      '</div>',
    footer: '<button class="btn" data-act="modal-close">Close</button>'
  });
}

/* ------------------------------------------------------------ campaign picker
   Search + tick several. Typing filters the list in place (no repaint); a
   tick repaints the page with the panel left open where it was.         */
let emPickOpen = false, emPickQ = '';
function emPicker(r) {
  const D = emData, E = D.E;
  const counts = new Map();
  for (let i = 0; i < E.n; i++) {
    const d = E.day[i];
    if (d >= r.from && d <= r.to) counts.set(E.ki[i], (counts.get(E.ki[i]) || 0) + 1);
  }
  const chosen = new Set(emF.camps);
  const list = [...counts.keys()].concat(emF.camps.filter(k => !counts.has(k)))
    .map(ki => ({ ki, c: D.camps[ki], n: counts.get(ki) || 0 }))
    .sort((x, y) => (chosen.has(y.ki) - chosen.has(x.ki)) || (y.c.day - x.c.day) || (y.n - x.n));
  const label = !emF.camps.length ? 'All emails (' + counts.size + ')'
    : emF.camps.length === 1 ? D.camps[emF.camps[0]].subject : emF.camps.length + ' emails selected';
  const q = emPickQ.toLowerCase();
  return '<div class="wb-f em-pick"><span>Emails / campaigns</span>' +
    '<button class="inp sort-sel em-pick-btn" data-act="em-pick" title="' + esc(label) + '">' + esc(label) + ' <span class="wb-caret">&#9662;</span></button>' +
    (emPickOpen ? '<div class="em-pick-panel">' +
      '<input class="inp" data-empick="q" placeholder="Search subjects..." value="' + esc(emPickQ) + '">' +
      '<div class="em-pick-act"><button class="btn btn-sm" data-act="em-pick-shown">Select shown</button>' +
        '<button class="btn btn-sm" data-act="em-pick-none">Clear</button>' +
        '<span class="tiny muted">' + emF.camps.length + ' selected</span>' +
        '<button class="btn btn-sm btn-gold" data-act="em-pick-done">Done</button></div>' +
      '<div class="em-pick-list">' + list.map(x => {
        const txt = (emDayIso(x.c.day) + ' ' + x.c.subject).toLowerCase();
        return '<label class="em-pick-row"' + (q && txt.indexOf(q) < 0 ? ' hidden' : '') + ' data-txt="' + esc(txt) + '">' +
          '<input type="checkbox" data-empick-cb="' + x.ki + '"' + (chosen.has(x.ki) ? ' checked' : '') + '>' +
          '<span class="em-pick-d">' + emDayIso(x.c.day) + '</span><span class="em-pick-s">' + esc(x.c.subject) + '</span>' +
          '<i>' + x.n.toLocaleString() + '</i></label>';
      }).join('') + '</div></div>' : '') +
  '</div>';
}
function emPickFilterDom() {
  const q = emPickQ.toLowerCase();
  document.querySelectorAll('.em-pick-row').forEach(row => { row.hidden = !!q && row.dataset.txt.indexOf(q) < 0; });
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
  const st = (i) => (E.bot[i] ? 'scanner click' : ({ c: 'clicked', o: 'opened', d: 'delivered', f: 'failed', h: 'hard bounce', q: 'soft bounce', k: 'blocked', t: 'throttled', s: 'sent' })[String.fromCharCode(E.st[i])] || 'other');
  const lines = [['sent_at_central', 'subject', 'source', 'name', 'email', 'status', 'opened', 'clicked', 'last_open_or_click_central', 'first_ever_open',
    'unsubscribed', 'unsubscribe_reason', 'unsubscribed_after_this_email']
    .map(q).join(',')];
  sel.idx.forEach(i => {
    const c = D.conts[E.ci[i]], k = D.camps[E.ki[i]], fo = D.firstOpen[E.ci[i]];
    lines.push([emStamp(E.sent[i]), k.subject, k.source, c.name, c.email, st(i),
      emIsOpen(E, i, emF.bots) ? 'yes' : 'no', emIsClick(E, i, emF.bots) ? 'yes' : 'no',
      E.dl[i] >= 0 ? emStamp(E.sent[i] + E.dl[i]) : '', fo !== 0x7fffffff ? emDayIso(fo) : '',
      c.unsubAt ? emStamp(c.unsubAt) : (c.unsub ? 'yes' : ''), c.unsub ? EM_UNSUB[c.unsub] || '' : '', E.unsubEv[i] ? 'yes' : ''].map(q).join(','));
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
    case 'em-clear': emF = { preset: '90', from: '', to: '', camps: [], source: 'all', status: 'all', audience: 'all', q: '', bots: false }; emPickQ = ''; emShow = 200; emRerender(); return;
    case 'em-tab': emPeopleView = v; emShow = 200; emRerender(); return;
    case 'em-more': emShow += 300; emRerender(); return;
    case 'em-camp':
      closeModal(); emF.camps = [Number(v)]; emPeopleView = 'contacts'; emShow = 200;
      if (location.hash.indexOf('#/email/24h') === 0) location.hash = '#/email'; else render();
      return;
    case 'em-person': emPerson(Number(v)); return;
    case 'em-csv': emCsv(); return;
    case 'em-l24': emL24 = v; emRerender(); return;
    case 'em-analysis': emAnalysis(); return;
    case 'em-pick': emPickOpen = !emPickOpen; emRerender(); return;
    case 'em-pick-done': emPickOpen = false; emRerender(); return;
    case 'em-pick-none': emF.camps = []; emShow = 200; emRerender(); return;
    case 'em-pick-shown': {
      const add = [...document.querySelectorAll('.em-pick-row:not([hidden]) [data-empick-cb]')].map(x => Number(x.dataset.empickCb));
      emF.camps = [...new Set(emF.camps.concat(add))]; emShow = 200; emRerender(); return;
    }
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
/* the picker: a tick repaints, keeping the panel's search and scroll */
document.addEventListener('change', e => {
  const el = e.target;
  if (!(el.dataset && el.dataset.empickCb != null)) return;
  const k = Number(el.dataset.empickCb);
  emF.camps = el.checked ? [...new Set(emF.camps.concat(k))] : emF.camps.filter(x => x !== k);
  emShow = 200;
  const box = document.querySelector('.em-pick-list'), top = box ? box.scrollTop : 0;
  emRerender();
  const nb = document.querySelector('.em-pick-list'); if (nb) nb.scrollTop = top;
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset && el.dataset.empick === 'q') { emPickQ = el.value; emPickFilterDom(); }
});
/* click outside the open panel closes it */
document.addEventListener('click', e => {
  if (!emPickOpen || e.target.closest('.em-pick')) return;
  emPickOpen = false;
  const pnl = document.querySelector('.em-pick-panel'); if (pnl) pnl.remove();
});
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
