/* Pheenyx Capital - Pipeline Workflow
   calendly.js : the Calendly Calls page (#/calendly).

   Reads what tools/calendly-sync.js publishes to Firestore - every booking,
   who booked it and what they answered, cancellations and reschedules, and
   the Notetaker recap + transcript of recorded calls - and turns it into
   one filterable set, with the time analysis (busiest week / weekday / hour,
   time spent on calls, trends) and a journey view that lines a person's
   calls up against their webinars, emails and tracker record.

   Loaded after app.js and email.js and reuses their helpers (shell, tile,
   gauge, wbBars, emCal, emHeatmap ...). Times are Central, like the rest.

   Live: once loaded, the page listens to calendlyAnalytics/meta. The sync
   runs every 15 minutes; a new version reloads the data in place.

   Internal meetings (every attendee @phcinvest.com) live in calendlyPrivate,
   which only the owner and CALENDLY_LEADERS in firestore.rules can read.
   For everyone else that read is refused and the Team tab simply is not shown. */

const CAL_ST = ['held', 'noshow', 'up', 'resched', 'cancel'];
const CAL_LBL = { held: 'Completed', noshow: 'No-show', up: 'Upcoming', resched: 'Rescheduled', cancel: 'Canceled' };
const CAL_COL = { held: '#0f9d63', noshow: '#7c3b52', up: '#3366cc', resched: '#b8860b', cancel: '#c0392b' };
const CAL_HOURS = '#16223a';
const CAL_LOC = { zoom: 'Zoom', outbound_call: 'Phone call', inbound_call: 'They call in', custom: 'Other / custom',
  google_conference: 'Google Meet', microsoft_teams_conference: 'Teams', physical: 'In person', '': 'Not set' };

let calRaw = null, calMeta = null, calLoading = false, calError = null;
let calPrivOk = false, calWatching = false;
let calF = { preset: '365', from: '', to: '', status: 'all', loc: 'all', source: 'all', q: '' };
let calTab = 'meetings';       /* meetings | people | journey | recorded | team | upcoming */
let calShow = 150, calSort = 'recent', calGrain = 'auto', calJourney = 'both';
let calRecQ = '', calRecScope = 'team';   /* recorded tab: team | internal | all */
const calTr = {};               /* recapId -> transcript text (loaded on demand) */
let calTrLoading = 0, calTrOf = 0;

/* ------------------------------------------------------------ loading */
async function calLoad(force) {
  if ((calRaw && !force) || calLoading) return;
  if (!window.FsRead) { calError = 'local'; render(); return; }
  calLoading = true; calError = null; render();
  try {
    const { fs, doc, getDoc } = window.FsRead;
    const meta = await getDoc(doc(fs, 'calendlyAnalytics', 'meta'));
    if (!meta.exists()) { calError = 'empty'; calLoading = false; render(); return; }
    await calApply(meta.data());
    calWatch();
  } catch (e) {
    calError = /permission/i.test(e.message)
      ? 'The database refused the read. The calendlyAnalytics rule in firestore.rules has not been published yet.'
      : e.message;
  }
  calLoading = false;
  render();
  if (typeof openContactId !== 'undefined' && openContactId && S.contact(openContactId)) openContact(openContactId);
}

async function calApply(m) {
  const { fs, doc, getDoc } = window.FsRead;
  const get = (coll, id) => getDoc(doc(fs, coll, id)).then(s => (s.exists() ? JSON.parse(s.data().d || '[]') : []));
  const all = (coll, ids) => Promise.all((ids || []).map(id => get(coll, id))).then(a => [].concat(...a));
  const ch = m.chunks || {};
  const [ev, inv, rc] = await Promise.all([all('calendlyAnalytics', ch.events), all('calendlyAnalytics', ch.invitees),
    all('calendlyAnalytics', ch.recaps)]);
  let priv = [];
  try {
    const pm = await getDoc(doc(fs, 'calendlyPrivate', 'meta'));
    if (pm.exists()) priv = await all('calendlyPrivate', (pm.data().chunks || {}).recaps);
    calPrivOk = true;
  } catch (e) { calPrivOk = false; }   /* not a leader - the Team tab stays hidden */
  calMeta = m;
  calRaw = calBuild(m, ev, inv, rc, priv);
}

/** live: a new published version reloads in place; a plain sync tick just updates "synced" */
function calWatch() {
  if (calWatching || !window.FsRead || !window.FsRead.onSnapshot) return;
  calWatching = true;
  const { fs, doc, onSnapshot } = window.FsRead;
  onSnapshot(doc(fs, 'calendlyAnalytics', 'meta'), snap => {
    if (!snap.exists() || !calMeta) return;
    const m = snap.data();
    const onPage = location.hash.indexOf('#/calendly') === 0;
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (m.version !== calMeta.version) {
      calApply(m).then(() => {
        if (onPage && !typing && !document.querySelector('.veil')) emRerender();
        if (onPage) toast('Calendly updated - ' + (m.counts ? m.counts.events.toLocaleString() + ' bookings' : 'new data'), 'ok');
      }).catch(() => {});
    } else {
      calMeta = m;
      const s = document.querySelector('[data-cal-synced]');
      if (s) s.textContent = 'synced ' + ago(m.syncedAt);
    }
  }, () => { calWatching = false; });
}

/* ------------------------------------------------------------ model */
const calSec = (iso) => (iso ? Date.parse(iso) / 1000 : 0);
function calSrc(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^webinar/i.test(s)) return 'Webinar/Event';
  if (/linked/i.test(s)) return 'LinkedIn';
  if (/referr|friend|colleague/i.test(s)) return 'Referral';
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function calBuild(m, ev, inv, rc, priv) {
  const now = Date.now() / 1000;
  const invByEv = new Map();
  inv.forEach(v => { if (!invByEv.has(v.ev)) invByEv.set(v.ev, []); invByEv.get(v.ev).push(v); });
  const recaps = rc.concat(priv).map(r => {
    const s = calSec(r.start), en = calSec(r.end), c = emCal(s || 0);
    const ext = (r.att || []).filter(a => !/@phcinvest\.com$/.test(a.e));
    return Object.assign({}, r, { s, en, min: Math.max(0, Math.round((en - s) / 60)), day: c.day, dow: c.dow, hour: c.hour, ext });
  }).sort((a, b) => b.s - a.s);
  const recByEv = new Map();
  recaps.forEach(r => { if (r.ev) recByEv.set(r.ev, r); });

  const B = ev.map(e => {
    const vs = invByEv.get(e.id) || [];
    const v = vs.find(x => x.status === 'active') || vs[0] || null;
    const s = calSec(e.start), en = calSec(e.end), cr = calSec(e.created) || s;
    let st;
    if (e.status === 'canceled') st = v && v.rescheduled ? 'resched' : 'cancel';
    else if (s > now) st = 'up';
    else if (v && v.noShow) st = 'noshow';
    else st = 'held';
    const qa = v ? v.qa || [] : [];
    const ans = (re) => { const x = qa.find(q => re.test(q[0])); return x ? String(x[1] || '').trim() : ''; };
    const c = emCal(s), mk = emCal(cr);
    return {
      id: e.id, e, v, vs, s, en, cr, st, rec: recByEv.get(e.id) || null,
      min: Math.max(0, Math.round((en - s) / 60)), lead: (s - cr) / 86400,
      email: v ? v.email : '', name: v ? (v.name || v.email) : '(no invitee)',
      day: c.day, dow: c.dow, hour: c.hour, mday: mk.day, mdow: mk.dow, mhour: mk.hour,
      src: calSrc(ans(/hear about/i)), state: ans(/^state/i), tz: v ? v.tz : '',
      phone: ans(/phone/i) || (v && v.phone) || '', note: ans(/prepare|share anything/i),
      loc: e.loc || '', gone: !!e.gone,
      key: ((v ? v.name + ' ' + v.email : '') + ' ' + ans(/prepare|share anything/i)).toLowerCase()
    };
  }).sort((a, b) => a.s - b.s);

  /* people: everyone who booked, plus outside attendees of recorded meetings */
  const people = new Map();
  const person = (email, name) => {
    const k = String(email || '').toLowerCase();
    if (!k) return null;
    let p = people.get(k);
    if (!p) { p = { email: k, name: name || k, b: [], recs: [] }; people.set(k, p); }
    if ((!p.name || p.name === k) && name && name !== k) p.name = name;
    return p;
  };
  B.forEach(b => { const p = person(b.email, b.name); if (p) p.b.push(b); });
  recaps.forEach(r => r.ext.forEach(a => { const p = person(a.e, a.n !== a.e ? a.n : ''); if (p) p.recs.push(r); }));
  people.forEach(p => {
    p.first = Math.min(...p.b.map(b => b.cr).concat(p.recs.map(r => r.s)).filter(Boolean));
    p.firstBook = p.b.length ? Math.min(...p.b.map(b => b.cr)) : 0;
    p.last = Math.max(0, ...p.b.filter(b => b.st !== 'cancel' && b.st !== 'resched').map(b => b.s), ...p.recs.map(r => r.s));
    p.n = { held: 0, noshow: 0, up: 0, resched: 0, cancel: 0 };
    p.b.forEach(b => p.n[b.st]++);
    p.min = p.b.filter(b => b.st === 'held').reduce((x, b) => x + b.min, 0);
    /* a recorded meeting not tied to a booking still counts as time with them */
    p.recMin = p.recs.filter(r => !r.ev).reduce((x, r) => x + r.min, 0);
    const lastB = p.b[p.b.length - 1];
    p.src = (p.b.find(b => b.src) || {}).src || '';
    p.phone = (p.b.slice().reverse().find(b => b.phone) || {}).phone || '';
    p.state = (p.b.find(b => b.state) || {}).state || '';
    p.tz = lastB ? lastB.tz : '';
  });

  let minDay = Infinity, maxDay = -Infinity;
  B.forEach(b => { if (b.day < minDay) minDay = b.day; if (b.day > maxDay) maxDay = b.day; });
  return { B, recaps, people, minDay, maxDay, byId: new Map(B.map(b => [b.id, b])), recById: new Map(recaps.map(r => [r.id, r])) };
}

/* ------------------------------------------------------------ filtering */
function calRange() {
  const D = calRaw, today = emCal(Date.now() / 1000).day, end = Math.max(today, D.maxDay);
  if (calF.preset === 'custom') return { from: calF.from ? emDayNum(calF.from) : D.minDay, to: calF.to ? emDayNum(calF.to) : end };
  if (calF.preset === 'all') return { from: D.minDay, to: end };
  if (calF.preset === 'ytd') return { from: emDayNum(new Date().getFullYear() + '-01-01'), to: end };
  if (calF.preset === 'upcoming') return { from: today, to: end };
  return { from: today - Number(calF.preset) + 1, to: end };
}
function calSelect() {
  const r = calRange(), q = calF.q.trim().toLowerCase();
  const out = calRaw.B.filter(b => {
    if (b.day < r.from || b.day > r.to) return false;
    if (calF.status === 'recorded' ? !(b.st === 'held' && b.rec) : calF.status === 'lost' ? !(b.st === 'cancel' || b.st === 'resched' || b.st === 'noshow')
      : calF.status !== 'all' && b.st !== calF.status) return false;
    if (calF.loc !== 'all' && b.loc !== calF.loc) return false;
    if (calF.source !== 'all' && (b.src || '(not asked)') !== calF.source) return false;
    if (q && b.key.indexOf(q) < 0) return false;
    return true;
  });
  return { B: out, range: r };
}

/* ------------------------------------------------------------ aggregates */
const calGrid = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
const calLive = (st) => st === 'held' || st === 'up' || st === 'noshow';
const calLost = (st) => st === 'cancel' || st === 'resched' || st === 'noshow';
function calAgg(sel) {
  const a = {
    n: sel.B.length, st: { held: 0, noshow: 0, up: 0, resched: 0, cancel: 0 }, recorded: 0, min: 0,
    meet: calGrid(), made: calGrid(), dowN: new Array(7).fill(0), dowMin: new Array(7).fill(0),
    dowTot: new Array(7).fill(0), dowLost: new Array(7).fill(0), hourN: new Array(24).fill(0), hourMin: new Array(24).fill(0),
    hourTot: new Array(24).fill(0), hourLost: new Array(24).fill(0),
    days: new Map(), src: new Map(), state: new Map(), tz: new Map(), loc: new Map(),
    lead: [0, 1, 2, 3, 4, 5].map(() => ({ n: 0, held: 0, lost: 0 })), cancelBy: { invitee: 0, host: 0 },
    cancelAhead: [], people: new Set(), newPeople: new Set(), madeDays: new Map()
  };
  const r = sel.range;
  for (const b of sel.B) {
    a.st[b.st]++;
    if (b.st === 'held') { a.min += b.min; if (b.rec) a.recorded++; a.dowMin[b.dow] += b.min; a.hourMin[b.hour] += b.min; }
    if (calLive(b.st)) { a.meet[b.dow][b.hour]++; a.dowN[b.dow]++; a.hourN[b.hour]++; }
    a.made[b.mdow][b.mhour]++;
    a.madeDays.set(b.mday, (a.madeDays.get(b.mday) || 0) + 1);
    if (b.st !== 'up') {
      a.dowTot[b.dow]++; a.hourTot[b.hour]++;
      if (calLost(b.st)) { a.dowLost[b.dow]++; a.hourLost[b.hour]++; }
    }
    let d = a.days.get(b.day);
    if (!d) { d = { held: 0, noshow: 0, up: 0, resched: 0, cancel: 0, min: 0 }; a.days.set(b.day, d); }
    d[b.st]++; if (b.st === 'held') d.min += b.min;
    const bump = (map, k) => {
      let x = map.get(k);
      if (!x) { x = { k, n: 0, held: 0, lost: 0, min: 0 }; map.set(k, x); }
      x.n++; if (b.st === 'held') { x.held++; x.min += b.min; } if (calLost(b.st)) x.lost++;
    };
    bump(a.src, b.src || '(not asked)');
    if (b.state) bump(a.state, b.state);
    bump(a.tz, b.tz || 'unknown');
    bump(a.loc, CAL_LOC[b.loc] || b.loc);
    if (b.st !== 'up') {
      const L = b.lead, li = L < 1 ? 0 : L < 3 ? 1 : L < 8 ? 2 : L < 15 ? 3 : L < 31 ? 4 : 5;
      a.lead[li].n++; if (b.st === 'held') a.lead[li].held++; if (calLost(b.st)) a.lead[li].lost++;
    }
    if (b.st === 'cancel' || b.st === 'resched') {
      const c = b.e.cancel || {};
      if (c.type === 'host') a.cancelBy.host++; else a.cancelBy.invitee++;
      if (c.at) a.cancelAhead.push((b.s - calSec(c.at)) / 3600);
    }
    if (b.email) {
      a.people.add(b.email);
      const p = calRaw.people.get(b.email);
      if (p && emCal(p.firstBook).day >= r.from) a.newPeople.add(b.email);
    }
  }
  a.decided = a.n - a.st.up;
  a.lost = a.st.cancel + a.st.resched + a.st.noshow;
  return a;
}

const calWeekOf = (d) => d - ((new Date(d * 864e5).getUTCDay() + 6) % 7);
const calMonthOf = (d) => { const x = new Date(d * 864e5); return x.getUTCFullYear() * 12 + x.getUTCMonth(); };
const calMonthLabel = (k) => new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
const calHrs = (min) => (min >= 600 ? Math.round(min / 60) : Math.round(min / 6) / 10) + 'h';
const calDur = (min) => (min < 60 ? min + ' min' : Math.floor(min / 60) + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : ''));
const calShortDay = (d) => new Date(d * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** the busiest week / month / day / weekday / hour / slot, all from one pass */
function calBusiest(a, r) {
  const weeks = new Map(), months = new Map();
  let bestDay = null;
  a.days.forEach((v, d) => {
    const n = v.held + v.up + v.noshow;
    const w = weeks.get(calWeekOf(d)) || { n: 0, min: 0 }; w.n += n; w.min += v.min; weeks.set(calWeekOf(d), w);
    const m = months.get(calMonthOf(d)) || { n: 0, min: 0 }; m.n += n; m.min += v.min; months.set(calMonthOf(d), m);
    if (!bestDay || n > bestDay.n) bestDay = { d, n };
  });
  const top = (map, f) => { let best = null; map.forEach((v, k) => { if (!best || f(v) > f(best.v)) best = { k, v }; }); return best; };
  const wk = top(weeks, v => v.n), wkMin = top(weeks, v => v.min), mo = top(months, v => v.n);
  const nWeeks = Math.max(1, Math.round((Math.min(r.to, emCal(Date.now() / 1000).day) - r.from + 1) / 7));
  let slot = null;
  a.meet.forEach((row, di) => row.forEach((v, h) => { if (!slot || v > slot.v) slot = { di, h, v }; }));
  let mslot = null;
  a.made.forEach((row, di) => row.forEach((v, h) => { if (!mslot || v > mslot.v) mslot = { di, h, v }; }));
  const dow = a.dowN.indexOf(Math.max(...a.dowN)), hour = a.hourN.indexOf(Math.max(...a.hourN));
  const quietDow = a.dowN.indexOf(Math.min(...a.dowN.slice(0, 5)));
  const live = a.st.held + a.st.up + a.st.noshow;
  return { weeks, months, wk, wkMin, mo, bestDay, slot, mslot, dow, hour, quietDow, nWeeks, perWeek: live / nWeeks,
    activeWeeks: [...weeks.values()].filter(w => w.n).length };
}

/* ------------------------------------------------------------ charts */
/** meetings per day / week / month, stacked by outcome, with call hours on a second axis */
function calSeries(a, r) {
  const span = r.to - r.from + 1;
  const grain = calGrain !== 'auto' ? calGrain : span <= 45 ? 'day' : span <= 420 ? 'week' : 'month';
  const keyOf = grain === 'day' ? (d) => d : grain === 'week' ? calWeekOf : calMonthOf;
  const buckets = new Map();
  for (let d = r.from; d <= r.to; d++) {
    const k = keyOf(d);
    if (!buckets.has(k)) buckets.set(k, { k, held: 0, noshow: 0, up: 0, resched: 0, cancel: 0, min: 0 });
  }
  a.days.forEach((v, d) => {
    const b = buckets.get(keyOf(d));
    if (!b) return;
    CAL_ST.forEach(s => { b[s] += v[s]; }); b.min += v.min;
  });
  const pts = [...buckets.values()].sort((x, y) => x.k - y.k);
  if (pts.length < 2) return '';
  const W = 760, H = 250, L = 34, R = 40, T = 14, Bm = 28;
  const tot = (p) => CAL_ST.reduce((x, s) => x + p[s], 0);
  const ymax = Math.max(4, ...pts.map(tot));
  const hmax = Math.max(1, ...pts.map(p => p.min / 60));
  const bw = (W - L - R) / pts.length;
  const y = (v) => T + (H - T - Bm) * (1 - v / ymax);
  const yh = (v) => T + (H - T - Bm) * (1 - v / hmax);
  const lab = (p) => grain === 'month' ? calMonthLabel(p.k) : (grain === 'week' ? 'Week of ' : '') + emDayLabel(p.k);
  const bars = pts.map((p, i) => {
    let acc = 0;
    const x = L + i * bw + Math.max(0.5, bw * 0.12), w = Math.max(1, bw * 0.76);
    const segs = CAL_ST.map(s => {
      if (!p[s]) return '';
      const y1 = y(acc + p[s]), y0 = y(acc); acc += p[s];
      return '<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0.5, y0 - y1).toFixed(1) +
        '" fill="' + CAL_COL[s] + '" rx="1.5"/>';
    }).join('');
    return segs + '<rect x="' + (L + i * bw).toFixed(1) + '" y="' + T + '" width="' + bw.toFixed(1) + '" height="' + (H - T - Bm) +
      '" fill="transparent"><title>' + esc(lab(p) + '\n' + tot(p) + ' booking' + (tot(p) === 1 ? '' : 's') + '\n' +
      CAL_ST.filter(s => p[s]).map(s => CAL_LBL[s] + ': ' + p[s]).join('\n') + '\nTime on completed calls: ' + calDur(p.min)) + '</title></rect>';
  }).join('');
  const line = pts.length > 1 ? '<polyline fill="none" stroke="' + CAL_HOURS + '" stroke-width="1.6" stroke-dasharray="4 3" points="' +
    pts.map((p, i) => (L + (i + 0.5) * bw).toFixed(1) + ',' + yh(p.min / 60).toFixed(1)).join(' ') + '"/>' : '';
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = Math.round(ymax * f), yy = y(ymax * f);
    return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="rgba(16,24,40,.07)"/>' +
      '<text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end" class="em-ax">' + v + '</text>' +
      '<text x="' + (W - R + 6) + '" y="' + (yy + 4) + '" class="em-ax">' + (Math.round(hmax * f * 10) / 10) + 'h</text>';
  }).join('');
  const every = Math.max(1, Math.ceil(pts.length / 9));
  const xl = pts.map((p, i) => (i % every === 0 ? '<text x="' + (L + (i + 0.5) * bw).toFixed(1) + '" y="' + (H - 8) +
    '" text-anchor="middle" class="em-ax">' + esc(grain === 'month' ? calMonthLabel(p.k) : calShortDay(p.k)) + '</text>' : '')).join('');
  const g = (v, l) => '<button class="seg-btn ' + (calGrain === v ? 'on' : '') + '" data-act="cal-grain" data-v="' + v + '">' + l + '</button>';
  return '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Meetings over time</h3><div class="spacer"></div>' +
    '<div class="seg">' + g('auto', 'Auto') + g('day', 'Day') + g('week', 'Week') + g('month', 'Month') + '</div></div>' +
    '<div class="card-b"><div class="st-legend" style="margin-bottom:8px">' +
      CAL_ST.filter(s => pts.some(p => p[s])).map(s => '<span><i style="background:' + CAL_COL[s] + '"></i>' + CAL_LBL[s] + '</span>').join('') +
      '<span><i style="background:' + CAL_HOURS + ';height:2px"></i>Hours on calls (right axis)</span></div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="em-trend" role="img" aria-label="Meetings per ' + grain + ' by outcome">' +
    grid + bars + line + xl + '</svg>' +
    '<div class="tiny muted">Per ' + grain + ' of the meeting date, Central. Hover a bar for the breakdown.</div></div></div>';
}

/** cumulative bookings made vs. calls completed - is the pipeline of calls growing? */
function calCumulative(a, r) {
  const today = emCal(Date.now() / 1000).day;
  const days = [];
  let made = 0, held = 0;
  const step = Math.max(1, Math.ceil((r.to - r.from + 1) / 160));
  for (let d = r.from; d <= Math.min(r.to, today); d++) {
    made += a.madeDays.get(d) || 0;
    held += (a.days.get(d) || {}).held || 0;
    if ((d - r.from) % step === 0 || d === Math.min(r.to, today)) days.push({ d, made, held });
  }
  if (days.length < 3) return '';
  const W = 760, H = 170, L = 40, R = 10, T = 10, Bm = 24;
  const ymax = Math.max(1, made, held);
  const x = (i) => L + (W - L - R) * i / (days.length - 1);
  const y = (v) => T + (H - T - Bm) * (1 - v / ymax);
  const pl = (k, col) => '<polyline fill="none" stroke="' + col + '" stroke-width="2" points="' + days.map((p, i) => x(i).toFixed(1) + ',' + y(p[k]).toFixed(1)).join(' ') + '"/>';
  const every = Math.max(1, Math.ceil(days.length / 8));
  return '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Running total</h3><div class="spacer"></div>' +
    '<div class="st-legend"><span><i style="background:#3366cc"></i>Bookings made</span><span><i style="background:#0f9d63"></i>Calls completed</span></div></div>' +
    '<div class="card-b"><svg viewBox="0 0 ' + W + ' ' + H + '" class="em-trend" role="img" aria-label="Cumulative bookings and completed calls">' +
    [0, 0.5, 1].map(f => '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(ymax * f) + '" y2="' + y(ymax * f) + '" stroke="rgba(16,24,40,.07)"/>' +
      '<text x="' + (L - 6) + '" y="' + (y(ymax * f) + 4) + '" text-anchor="end" class="em-ax">' + Math.round(ymax * f) + '</text>').join('') +
    days.map((p, i) => (i % every === 0 ? '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle" class="em-ax">' + esc(calShortDay(p.d)) + '</text>' : '')).join('') +
    pl('made', '#3366cc') + pl('held', '#0f9d63') + '</svg>' +
    '<div class="tiny muted">The gap between the lines is bookings that were canceled, rescheduled or are still to come.</div></div></div>';
}

/* ------------------------------------------------------------ insights */
function calInsights(a, bz) {
  const out = [];
  const rate = (x, n) => (n ? Math.round(x / n * 100) : 0);
  const showRate = rate(a.st.held, a.decided);
  if (a.decided >= 10) {
    out.push({ k: showRate >= 75 ? 'ok' : showRate >= 55 ? 'warn' : 'bad', t: '<b>' + showRate + '% of booked calls go ahead</b> (' + a.st.held + ' of ' +
      a.decided + ' past bookings). ' + a.st.cancel + ' were canceled and ' + a.st.resched + ' rescheduled.' });
  }
  /* weekday: where calls fall through most and least (10+ bookings) */
  const dw = a.dowTot.map((n, i) => ({ i, n, r: rate(a.dowTot[i] - a.dowLost[i], n) })).filter(x => x.n >= 10).sort((x, y) => y.r - x.r);
  if (dw.length >= 2 && dw[0].r - dw[dw.length - 1].r >= 8) {
    out.push({ k: 'ok', t: '<b>' + EM_DAYS[dw[0].i] + ' calls hold best</b>: ' + dw[0].r + '% go ahead, against ' + dw[dw.length - 1].r + '% on ' +
      EM_DAYS[dw[dw.length - 1].i] + '. Offer more ' + EM_DAYS[dw[0].i] + ' slots.' });
  }
  /* lead time */
  const near = a.lead[0].n + a.lead[1].n, nearOk = a.lead[0].held + a.lead[1].held;
  const far = a.lead[3].n + a.lead[4].n + a.lead[5].n, farOk = a.lead[3].held + a.lead[4].held + a.lead[5].held;
  if (near >= 10 && far >= 10) {
    const rn = rate(nearOk, near), rf = rate(farOk, far);
    out.push({ k: rf < rn - 8 ? 'warn' : 'ok', t: rf < rn - 8
      ? '<b>Calls booked a week or more out fall through more</b>: ' + rf + '% go ahead vs ' + rn + '% for calls booked within 2 days. ' +
        'Shorten the booking window, or add a reminder / reconfirmation for far-out bookings.'
      : '<b>How far ahead people book barely matters</b>: ' + rn + '% of calls booked within 2 days go ahead, ' + rf + '% of those a week+ out.' });
  }
  /* sources */
  const src = [...a.src.values()].filter(x => x.k !== '(not asked)' && x.n >= 5).sort((x, y) => y.n - x.n);
  if (src.length) {
    const s0 = src[0];
    out.push({ k: 'ok', t: '<b>' + esc(s0.k) + ' brings the most calls</b>: ' + s0.n + ' bookings, ' + rate(s0.held, s0.n - 0) + '% completed.' +
      (src[1] ? ' Next: ' + esc(src[1].k) + ' (' + src[1].n + ').' : '') });
  }
  if (bz.slot && bz.slot.v) {
    out.push({ k: 'ok', t: '<b>Busiest moment: ' + EM_DAYS[bz.slot.di] + ' ' + emHourLabel(bz.slot.h) + '&ndash;' + emHourLabel((bz.slot.h + 1) % 24) +
      ' CT</b> (' + bz.slot.v + ' calls). People book most on ' + (bz.mslot ? EM_DAYS[bz.mslot.di] + ' around ' + emHourLabel(bz.mslot.h) : '-') +
      ' - a good time for reminders and follow-up nudges.' });
  }
  if (a.st.held >= 10) {
    const cov = rate(a.recorded, a.st.held);
    if (cov < 60) out.push({ k: 'warn', t: '<b>Only ' + cov + '% of completed calls have a Notetaker recording.</b> Turn Notetaker on for the 30 Minute Meeting ' +
      'so every call gets a transcript, summary and action items here.' });
  }
  if (a.decided >= 20 && !a.st.noshow) {
    out.push({ k: 'warn', t: '<b>No call has ever been marked a no-show in Calendly</b>, so "completed" means "not canceled". Marking no-shows ' +
      '(Calendly &rarr; Meetings &rarr; Mark as no-show) makes the show rate here exact.' });
  }
  const repeat = [...a.people].filter(e => (calRaw.people.get(e) || { b: [] }).b.filter(b => b.st === 'held').length >= 2).length;
  if (a.people.size >= 10) out.push({ k: 'ok', t: '<b>' + repeat + ' people</b> have had two or more completed calls - your warmest relationships. ' +
    'See the People tab, sorted by most calls.' });
  return out;
}

/* ------------------------------------------------------------ cross-links */
/** email -> tracker contact id */
function calTrackerIdx() {
  const m = new Map();
  (S.db().contacts || []).forEach(c => { const e = String(c.email || '').trim().toLowerCase(); if (e && !m.has(e)) m.set(e, c.id); });
  return m;
}
/** email -> { sent, opened, clicked } from the Email Campaigns data, if loaded */
let calEmIdxFor = null, calEmIdx = null;
function calEmailIdx() {
  if (typeof emData === 'undefined' || !emData) return null;
  if (calEmIdxFor === emData) return calEmIdx;
  const D = emData, E = D.E, per = new Map();
  for (let i = 0; i < E.n; i++) {
    const c = D.conts[E.ci[i]];
    if (!c || !c.email) continue;
    let x = per.get(c.email);
    if (!x) { x = { sent: 0, opened: 0, clicked: 0, lastOpen: 0 }; per.set(c.email, x); }
    x.sent++;
    if (emIsOpen(E, i, false)) { x.opened++; const at = E.sent[i] + Math.max(0, E.dl[i]); if (at > x.lastOpen) x.lastOpen = at; }
    if (emIsClick(E, i, false)) x.clicked++;
  }
  calEmIdxFor = emData; calEmIdx = per;
  return per;
}
function calWebIdx() {
  if (typeof wbTopics === 'undefined' || !wbTopics) return null;
  const idx = wbAttendeeIndex(wbTopics);
  return Object.keys(idx).length ? idx : null;
}

/* ------------------------------------------------------------ the page */
function calSel(name, label, opts, cur) {
  return '<label class="wb-f"><span>' + esc(label) + '</span><select class="inp sort-sel" data-calf="' + name + '">' +
    opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
    '</select></label>';
}
function calStatusPill(b) {
  const extra = b.st === 'held' && b.rec ? ' &middot; recorded' : '';
  return '<span class="pill" style="background:' + CAL_COL[b.st] + '1a;color:' + CAL_COL[b.st] + ';border-color:transparent">' +
    CAL_LBL[b.st] + extra + '</span>' + (b.gone ? ' <span class="pill" title="Calendly no longer has this booking - it is kept in our archive">archived</span>' : '');
}
const calStamp = (sec) => (sec ? emStamp(sec) : '-');

function viewCalendly() {
  if (!calRaw && !calLoading && !calError) calLoad();
  const head = title('Calendly Calls', calMeta
    ? 'Every booking, recap and transcript &middot; <span data-cal-synced>synced ' + esc(ago(calMeta.syncedAt)) + '</span> &middot; live &middot; Central time'
    : 'Every booking, recap and transcript') +
    (calRaw ? '<button class="btn btn-sm" data-act="cal-csv">Export CSV</button>' : '') +
    '<button class="btn btn-sm" data-act="cal-reload">Reload</button>';

  if (calError === 'local') {
    shell('calendly', head, '<div class="card"><div class="empty">Calendly analytics needs the live database.<br>' +
      '<span class="tiny muted">It is read from Firestore, so it does not show in local demo mode.</span></div></div>');
    return;
  }
  if (calError === 'empty') {
    shell('calendly', head, '<div class="card"><div class="empty"><div class="big">&#9742;</div>No Calendly data has been synced yet.<br>' +
      '<span class="tiny muted">Run <code>node tools/calendly-sync.js</code> on the computer that has the Calendly token.</span></div></div>');
    return;
  }
  if (calError) { shell('calendly', head, '<div class="card"><div class="empty">Could not load Calendly data.<br><span class="tiny muted">' + esc(calError) + '</span></div></div>'); return; }
  if (!calRaw) { shell('calendly', head, '<div class="card"><div class="empty">Loading every booking and recap&hellip;</div></div>'); return; }

  const D = calRaw, sel = calSelect(), r = sel.range, a = calAgg(sel), bz = calBusiest(a, r);

  /* ---------- filters ---------- */
  const srcs = [...new Set(D.B.map(b => b.src || '(not asked)'))].sort();
  const locs = [...new Set(D.B.map(b => b.loc))];
  const filters = '<div class="card em-filters" style="margin-bottom:16px"><div class="card-b wb-filters">' +
    calSel('preset', 'Meeting date', [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months'],
      ['ytd', 'This year'], ['all', 'All time'], ['upcoming', 'Upcoming only'], ['custom', 'Custom dates']], calF.preset) +
    '<label class="wb-f"><span>From</span><input type="date" class="inp sort-sel" data-calf="from" value="' + emDayIso(r.from) + '"></label>' +
    '<label class="wb-f"><span>To</span><input type="date" class="inp sort-sel" data-calf="to" value="' + emDayIso(r.to) + '"></label>' +
    calSel('status', 'Outcome', [['all', 'Every booking'], ['held', 'Completed'], ['recorded', 'Completed & recorded'], ['up', 'Upcoming'],
      ['lost', 'Fell through (any)'], ['cancel', 'Canceled'], ['resched', 'Rescheduled'], ['noshow', 'No-show']], calF.status) +
    (locs.length > 1 ? calSel('loc', 'Where', [['all', 'Anywhere']].concat(locs.map(l => [l, CAL_LOC[l] || l])), calF.loc) : '') +
    calSel('source', 'Heard about us', [['all', 'Any source']].concat(srcs.map(s => [s, s])), calF.source) +
    '<label class="wb-f"><span>Search</span><input class="inp sort-sel" data-calf="q" placeholder="name, email or note" value="' + esc(calF.q) + '"></label>' +
    '<button class="btn btn-sm" data-act="cal-clear">Clear</button></div></div>';

  const archived = calMeta && calMeta.counts && calMeta.counts.archivedOnly;
  const banner = archived ? '<div class="em-banner" style="background:var(--info-bg);color:#1e3a8a">' + archived.toLocaleString() +
    ' booking(s) here are no longer in Calendly - they are kept from our own archive.</div>' : '';

  /* ---------- tiles ---------- */
  const showRate = a.decided ? Math.round(a.st.held / a.decided * 100) : 0;
  const tiles = '<div class="tiles">' +
    tile({ tone: 'lav', icon: '&#128197;', label: 'Bookings', value: a.n.toLocaleString(),
      delta: { text: a.people.size.toLocaleString() + ' people' },
      foot: a.newPeople.size.toLocaleString() + ' booking for the first time &middot; ' + a.st.up + ' upcoming' }) +
    tile({ tone: 'mint', icon: '&#10003;', label: 'Calls completed', value: a.st.held.toLocaleString(),
      delta: { dir: showRate >= 75 ? 'up' : showRate >= 55 ? '' : 'down', text: showRate + '% go ahead' },
      foot: a.recorded + ' recorded with Notetaker' }) +
    tile({ tone: 'cream', icon: '&#9201;', label: 'Time on calls', value: calHrs(a.min),
      delta: { text: (a.st.held ? Math.round(a.min / a.st.held) : 0) + ' min avg' },
      foot: (Math.round(a.min / bz.nWeeks / 6) / 10) + 'h a week on average' }) +
    tile({ tone: 'pink', icon: '&#10007;', label: 'Fell through', value: a.lost.toLocaleString(),
      delta: { dir: a.decided && a.lost / a.decided > 0.3 ? 'down' : '', text: (a.decided ? Math.round(a.lost / a.decided * 100) : 0) + '%' },
      foot: a.st.cancel + ' canceled &middot; ' + a.st.resched + ' rescheduled &middot; ' + a.cancelBy.invitee + ' by them, ' + a.cancelBy.host + ' by us' }) +
    '</div>';

  /* ---------- busiest ---------- */
  const bx = (label, val, sub) => '<div><span>' + esc(label) + '</span><b>' + val + '</b><span>' + sub + '</span></div>';
  const busy = '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Busiest times</h3><div class="spacer"></div>' +
    '<span class="tiny muted">completed + upcoming calls, Central</span></div><div class="card-b"><div class="em-cq cal-busy">' +
    bx('Busiest week', bz.wk && bz.wk.v.n ? esc(calShortDay(bz.wk.k)) : '-', bz.wk ? bz.wk.v.n + ' calls &middot; ' + calHrs(bz.wk.v.min) : '') +
    bx('Most hours in a week', bz.wkMin && bz.wkMin.v.min ? calHrs(bz.wkMin.v.min) : '-', bz.wkMin ? 'week of ' + esc(calShortDay(bz.wkMin.k)) : '') +
    bx('Busiest month', bz.mo && bz.mo.v.n ? esc(calMonthLabel(bz.mo.k)) : '-', bz.mo ? bz.mo.v.n + ' calls &middot; ' + calHrs(bz.mo.v.min) : '') +
    bx('Busiest single day', bz.bestDay && bz.bestDay.n ? esc(calShortDay(bz.bestDay.d)) : '-', bz.bestDay ? bz.bestDay.n + ' calls' : '') +
    bx('Busiest weekday', a.dowN[bz.dow] ? EM_DAYS[bz.dow] : '-', a.dowN[bz.dow] + ' calls &middot; ' + calHrs(a.dowMin[bz.dow])) +
    bx('Busiest hour', a.hourN[bz.hour] ? emHourLabel(bz.hour) + '&ndash;' + emHourLabel((bz.hour + 1) % 24) : '-', a.hourN[bz.hour] + ' calls') +
    bx('Busiest moment', bz.slot && bz.slot.v ? EM_DAYS[bz.slot.di] + ' ' + emHourLabel(bz.slot.h) : '-', bz.slot ? bz.slot.v + ' calls in that hour' : '') +
    bx('People book most', bz.mslot && bz.mslot.v ? EM_DAYS[bz.mslot.di] + ' ' + emHourLabel(bz.mslot.h) : '-', 'when the booking is made') +
    bx('Calls per week', (Math.round(bz.perWeek * 10) / 10).toString(), 'average over ' + bz.nWeeks + ' weeks') +
    bx('Quietest weekday', EM_DAYS[bz.quietDow], a.dowN[bz.quietDow] + ' calls (Mon-Fri)') +
    '</div></div></div>';

  /* ---------- insights ---------- */
  const ins = calInsights(a, bz);
  const insCard = '<div class="card"><div class="card-h"><h3>What the data says</h3></div><div class="card-b">' +
    (ins.length ? '<ul class="em-recs">' + ins.map(x => '<li class="' + x.k + '">' + x.t + '</li>').join('') + '</ul>'
      : '<div class="tiny muted">Widen the date range - there is not enough here to judge.</div>') + '</div></div>';
  const gauges = '<div class="card gauges" style="margin-top:16px"><div class="card-b">' +
    gauge(showRate, 'Go-ahead rate', a.st.held + ' of ' + a.decided + ' past bookings', '#0f9d63') +
    gauge(a.st.held ? a.recorded / a.st.held * 100 : 0, 'Recorded', a.recorded + ' of ' + a.st.held + ' completed calls', '#3366cc') +
    '</div></div>';

  /* ---------- heatmaps ---------- */
  const liveN = a.st.held + a.st.up + a.st.noshow;
  const heatMeet = '<div class="card" style="margin-top:16px"><div class="card-h"><h3>When calls happen</h3><div class="spacer"></div>' +
    '<span class="tiny muted">' + liveN + ' calls by day &amp; hour</span></div><div class="card-b">' +
    emHeatmap(a.meet, { tip: (di, h, v) => EM_DAYS[di] + ' ' + emHourLabel(h) + '-' + emHourLabel((h + 1) % 24) + ': ' + v + ' call' + (v === 1 ? '' : 's'),
      show: (v) => v || '', low: 'none', high: 'busiest' }) + '</div></div>';
  const heatMade = '<div class="card" style="margin-top:16px"><div class="card-h"><h3>When people book</h3><div class="spacer"></div>' +
    '<span class="tiny muted">the moment the booking was made</span></div><div class="card-b">' +
    emHeatmap(a.made, { tip: (di, h, v) => EM_DAYS[di] + ' ' + emHourLabel(h) + ': ' + v + ' booking' + (v === 1 ? '' : 's') + ' made',
      show: (v) => v || '', low: 'none', high: 'most' }) + '</div></div>';

  /* ---------- bars ---------- */
  const hrs = (min) => Math.round(min / 6) / 10;
  const dowBars = wbBars('Calls by weekday', EM_DAYS.map((k, i) => ({ k: k + ' (' + hrs(a.dowMin[i]) + 'h)', n: a.dowN[i] })).sort((x, y) => y.n - x.n),
    liveN, 'count, hours completed');
  const hourBars = wbBars('Calls by hour of day', a.hourN.map((n, h) => ({ k: emHourLabel(h) + ' CT', n })).filter(x => x.n).sort((x, y) => y.n - x.n),
    liveN, 'start hour');
  const dowRate = wbRateBars('Go-ahead rate by weekday', a.dowTot.map((n, i) => ({ k: EM_DAYS[i], n, a: n - a.dowLost[i],
    rate: n ? Math.round((n - a.dowLost[i]) / n * 100) : 0 })).filter(x => x.n >= 3), 'past bookings that went ahead');
  const leadNames = ['Same day', '1-2 days ahead', '3-7 days ahead', '1-2 weeks ahead', '2-4 weeks ahead', 'Over a month ahead'];
  const leadRate = wbRateBars('Booked how far ahead &rarr; went ahead', a.lead.map((x, i) => ({ k: leadNames[i], n: x.n, a: x.held,
    rate: x.n ? Math.round(x.held / x.n * 100) : 0 })).filter(x => x.n), 'lead time vs go-ahead');
  const srcRate = wbRateBars('Where they heard about us &rarr; went ahead', [...a.src.values()].sort((x, y) => y.n - x.n)
    .map(x => ({ k: x.k + ' (' + x.n + ')', n: x.n - 0, a: x.held, rate: x.n ? Math.round(x.held / x.n * 100) : 0 })), '"How did you hear about us?"');
  const tot = (m) => [...m.values()].reduce((x, y) => x + y.n, 0);
  const stateBars = wbBars('Where they are (state)', [...a.state.values()].sort((x, y) => y.n - x.n), tot(a.state), 'from the booking form');
  const tzBars = wbBars('Time zone', [...a.tz.values()].sort((x, y) => y.n - x.n).map(x => ({ k: x.k.replace(/_/g, ' '), n: x.n })), a.n, 'the invitee\'s own');
  const locBars = wbBars('How the call happens', [...a.loc.values()].sort((x, y) => y.n - x.n), a.n, '');
  const ahead = a.cancelAhead.slice().sort((x, y) => x - y);
  const aheadB = [['Under 2 hours before', 2], ['2-24 hours before', 24], ['1-3 days before', 72], ['3+ days before', Infinity]];
  let lo = -Infinity;
  const cancelBars = wbBars('When they cancel or reschedule', aheadB.map(([k, hi]) => { const n = ahead.filter(h => h > lo && h <= hi).length; lo = hi; return { k, n }; })
    .filter(x => x.n), ahead.length, 'time before the call');

  /* ---------- time on calls ---------- */
  const recIn = D.recaps.filter(x => x.day >= r.from && x.day <= r.to);
  const extRec = recIn.filter(x => !x.internal && !x.ev), intRec = recIn.filter(x => x.internal);
  const sumMin = (arr) => arr.reduce((s, x) => s + x.min, 0);
  const timeCard = '<div class="card" style="margin-top:16px"><div class="card-h"><h3>Time on calls</h3><div class="spacer"></div>' +
    '<span class="tiny muted">scheduled length, in this date range</span></div><div class="card-b"><div class="em-cq cal-time">' +
    bx('Booked calls (Calendly)', calHrs(a.min), a.st.held + ' completed &middot; ' + (a.st.held ? Math.round(a.min / a.st.held) : 0) + ' min avg') +
    bx('Other recorded calls with outsiders', calHrs(sumMin(extRec)), extRec.length + ' meetings (partners, PMs, interviews)') +
    (calPrivOk ? bx('Internal team meetings', calHrs(sumMin(intRec)), intRec.length + ' recorded (leaders only)') : '') +
    bx('Upcoming booked time', calHrs(sel.B.filter(b => b.st === 'up').reduce((s, b) => s + b.min, 0)), a.st.up + ' calls on the calendar') +
    '</div></div></div>';

  /* ---------- tabs ---------- */
  const tabs = [['meetings', 'Meetings', sel.B.length], ['upcoming', 'Upcoming', D.B.filter(b => b.st === 'up').length],
    ['people', 'People', a.people.size], ['journey', 'Webinar & email journey', null],
    ['recorded', 'Recorded calls', D.recaps.filter(x => !x.internal).length]]
    .concat(calPrivOk ? [['team', 'Team meetings', D.recaps.filter(x => x.internal).length]] : []);
  if (!tabs.some(t => t[0] === calTab)) calTab = 'meetings';
  const tabBar = '<div class="seg cal-tabs">' + tabs.map(([v, l, n]) => '<button class="seg-btn ' + (calTab === v ? 'on' : '') +
    '" data-act="cal-tab" data-v="' + v + '">' + l + (n != null ? ' <b>' + n.toLocaleString() + '</b>' : '') + '</button>').join('') + '</div>';
  const body = calTab === 'people' ? calPeopleTab(sel) : calTab === 'journey' ? calJourneyTab(sel) : calTab === 'recorded' ? calRecordedTab(false)
    : calTab === 'team' ? calTeamTab(r) : calTab === 'upcoming' ? calUpcomingTab() : calMeetingsTab(sel);
  const listCard = '<div class="card" style="margin-top:16px"><div class="card-h">' + tabBar + '<div class="spacer"></div>' +
    '<span class="tiny muted">' + esc(emDayLabel(r.from)) + ' &ndash; ' + esc(emDayLabel(r.to)) + '</span></div>' + body + '</div>';

  const y = window.scrollY;
  shell('calendly', head, banner + filters + (sel.B.length ? tiles + busy +
    '<div class="two dash-mid"><div>' + calSeries(a, r) + calCumulative(a, r) + '</div><div>' + insCard + gauges + timeCard + '</div></div>' +
    '<div class="two em-heats"><div>' + heatMeet + '</div><div>' + heatMade + '</div></div>' +
    '<div class="two" style="margin-top:16px"><div>' + dowBars + hourBars + dowRate + '</div><div>' + leadRate + cancelBars + srcRate + '</div></div>' +
    '<div class="two" style="margin-top:16px"><div>' + stateBars + '</div><div>' + tzBars + locBars + '</div></div>'
    : '<div class="card"><div class="empty">No bookings match these filters.</div></div>') + listCard);
  if (emKeepScroll) window.scrollTo(0, y);
}

/* ------------------------------------------------------------ tabs */
function calMore(n) {
  return n > calShow ? '<div class="card-b"><button class="btn btn-sm" data-act="cal-more">Show more (' + (n - calShow) + ' left)</button></div>' : '';
}
function calMeetingRow(b) {
  return '<tr><td class="tiny" style="white-space:nowrap">' + esc(calStamp(b.s)) + '<div class="muted">' + calDur(b.min) + ' &middot; ' + esc(CAL_LOC[b.loc] || b.loc) + '</div></td>' +
    '<td><a href="#" class="n" data-act="cal-person" data-v="' + esc(b.email) + '">' + esc(b.name) + '</a><div class="tiny muted">' + esc(b.email) + '</div></td>' +
    '<td>' + calStatusPill(b) + '</td>' +
    '<td class="tiny">' + (b.src ? '<span class="pill gold">' + esc(b.src) + '</span>' : '<span class="muted">-</span>') + '</td>' +
    '<td class="tiny muted">' + esc(calStamp(b.cr)) + '<div>' + (b.lead < 1 ? 'same day' : Math.round(b.lead) + ' day' + (Math.round(b.lead) === 1 ? '' : 's') + ' ahead') + '</div></td>' +
    '<td class="tiny em-subj" title="' + esc(b.note) + '">' + esc(b.note) + '</td>' +
    '<td><button class="btn btn-sm" data-act="cal-meeting" data-v="' + b.id + '">Open</button></td></tr>';
}
function calMeetingsTab(sel) {
  const rows = sel.B.slice().sort((x, y) => y.s - x.s);
  return '<div class="scroll-x"><table class="tbl"><thead><tr><th>Meeting</th><th>Who</th><th>Outcome</th><th>Heard via</th><th>Booked</th><th>Their note</th><th></th></tr></thead><tbody>' +
    rows.slice(0, calShow).map(calMeetingRow).join('') + '</tbody></table></div>' + calMore(rows.length);
}
function calUpcomingTab() {
  const rows = calRaw.B.filter(b => b.st === 'up').sort((x, y) => x.s - y.s);
  if (!rows.length) return '<div class="empty">Nothing booked ahead.</div>';
  const tr = calTrackerIdx();
  let lastDay = null;
  return '<div class="scroll-x"><table class="tbl"><tbody>' + rows.map(b => {
    const dh = b.day !== lastDay ? '<tr><td colspan="5" class="cal-dayhead">' + esc(new Date(b.day * 864e5).toLocaleDateString('en-US',
      { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })) + '</td></tr>' : '';
    lastDay = b.day;
    const p = calRaw.people.get(b.email);
    const before = p ? p.n.held : 0;
    return dh + '<tr><td class="tiny" style="white-space:nowrap"><b>' + esc(new Date(b.s * 1000).toLocaleTimeString('en-US', { timeZone: EM_TZ, hour: 'numeric', minute: '2-digit' })) +
      '</b> CT<div class="muted">' + calDur(b.min) + ' &middot; ' + esc(CAL_LOC[b.loc] || b.loc) + '</div></td>' +
      '<td><a href="#" class="n" data-act="cal-person" data-v="' + esc(b.email) + '">' + esc(b.name) + '</a><div class="tiny muted">' + esc(b.email) +
        (b.phone ? ' &middot; ' + esc(b.phone) : '') + '</div></td>' +
      '<td class="tiny">' + (before ? '<span class="pill ok">' + before + ' call' + (before === 1 ? '' : 's') + ' before</span>' : '<span class="wb-new">FIRST CALL</span>') +
        (tr.has(b.email) ? ' <a href="#" class="pill info" data-act="contact" data-id="' + tr.get(b.email) + '">in tracker</a>' : '') + '</td>' +
      '<td class="tiny em-subj" title="' + esc(b.note) + '">' + esc(b.note) + '</td>' +
      '<td><button class="btn btn-sm" data-act="cal-meeting" data-v="' + b.id + '">Open</button></td></tr>';
  }).join('') + '</tbody></table></div>';
}

function calPeopleTab(sel) {
  const emails = [...new Set(sel.B.map(b => b.email).filter(Boolean))];
  const ps = emails.map(e => calRaw.people.get(e)).filter(Boolean);
  const sorters = {
    recent: (x, y) => y.last - x.last,
    calls: (x, y) => (y.n.held - x.n.held) || (y.b.length - x.b.length),
    time: (x, y) => (y.min + y.recMin) - (x.min + x.recMin),
    lost: (x, y) => (y.n.cancel + y.n.resched) - (x.n.cancel + x.n.resched),
    first: (x, y) => y.firstBook - x.firstBook,
    name: (x, y) => String(x.name).localeCompare(String(y.name))
  };
  ps.sort(sorters[calSort] || sorters.recent);
  const tr = calTrackerIdx();
  return '<div class="em-toolbar">' + calSel('sort', 'Sort people', [['recent', 'Most recent call'], ['calls', 'Most completed calls'],
      ['time', 'Most time together'], ['lost', 'Most cancels / reschedules'], ['first', 'Newest bookers'], ['name', 'Name']], calSort) + '</div>' +
    '<div class="scroll-x"><table class="tbl"><thead><tr><th>Person</th><th>Bookings</th><th>Completed</th><th>Fell through</th><th>Recorded</th>' +
    '<th>Time together</th><th>First booked</th><th>Last call</th><th></th></tr></thead><tbody>' +
    ps.slice(0, calShow).map(p => '<tr><td><a href="#" class="n" data-act="cal-person" data-v="' + esc(p.email) + '">' + esc(p.name) + '</a>' +
        '<div class="tiny muted">' + esc(p.email) + (p.state ? ' &middot; ' + esc(p.state) : '') + '</div></td>' +
      '<td>' + p.b.length + '</td>' +
      '<td>' + (p.n.held ? '<b>' + p.n.held + '</b>' : '<span class="muted">0</span>') + (p.n.up ? ' <span class="pill info">+' + p.n.up + ' upcoming</span>' : '') + '</td>' +
      '<td class="tiny">' + (p.n.cancel + p.n.resched + p.n.noshow ? p.n.cancel + ' canceled, ' + p.n.resched + ' resched.' : '<span class="muted">-</span>') + '</td>' +
      '<td>' + (p.recs.length ? '<span class="pill ok">' + p.recs.length + '</span>' : '<span class="muted tiny">0</span>') + '</td>' +
      '<td class="tiny">' + calDur(p.min + p.recMin) + '</td>' +
      '<td class="tiny muted">' + (p.firstBook ? esc(emDayLabel(emCal(p.firstBook).day)) : '-') + '</td>' +
      '<td class="tiny">' + (p.last ? esc(calStamp(p.last)) : '-') + '</td>' +
      '<td>' + (tr.has(p.email) ? '<a href="#" class="pill info" data-act="contact" data-id="' + tr.get(p.email) + '">in tracker</a>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>' + calMore(ps.length);
}

/** webinars x calls x emails x tracker, by email */
function calJourneyTab(sel) {
  const web = calWebIdx(), em = calEmailIdx(), tr = calTrackerIdx();
  const loadBits = [];
  if (!web) {
    const running = typeof wbStatsRun !== 'undefined' && wbStatsRun;
    loadBits.push(running ? 'Loading webinar attendance&hellip; ' + wbStatsDone + ' of ' + wbStatsOf + ' webinars'
      : '<button class="btn btn-sm btn-gold" data-act="cal-load-web">Load webinar attendance</button> <span class="tiny muted">pulls every webinar\'s attendees from ClickMeeting (a minute or two)</span>');
  }
  if (!em) {
    loadBits.push(typeof emLoading !== 'undefined' && emLoading ? 'Loading email engagement&hellip;'
      : '<button class="btn btn-sm btn-gold" data-act="cal-load-em">Load email engagement</button> <span class="tiny muted">opens and clicks from Email Campaigns</span>');
  }
  /* everyone: bookers in range, plus (for the follow-up list) webinar attendees */
  const r = sel.range;
  const inRange = new Set(sel.B.map(b => b.email).filter(Boolean));
  const keys = new Set(inRange);
  if (web) Object.keys(web).forEach(e => { if (web[e].attendedCount) keys.add(e); });
  const rows = [...keys].map(e => {
    const p = calRaw.people.get(e), w = web ? web[e] : null, m = em ? em.get(e) : null;
    return { e, p, w, m, name: (p && p.name) || (w && w.name) || e, booked: !!(p && p.b.length), held: p ? p.n.held : 0,
      web: w ? w.attendedCount : 0, webReg: w ? w.webinars.length : 0, opened: m ? m.opened : 0, clicked: m ? m.clicked : 0, tracker: tr.get(e) };
  });
  const bookers = rows.filter(x => inRange.has(x.e));
  const webAtt = rows.filter(x => x.web);
  const both = bookers.filter(x => x.web);
  const webNoCall = webAtt.filter(x => !x.booked);
  const emBook = bookers.filter(x => x.opened);
  const inTr = bookers.filter(x => x.tracker);
  const pc = (x, n) => (n ? Math.round(x / n * 100) : 0);
  const stats = '<div class="card-b"><div class="em-cq">' +
    '<div><b>' + (web ? both.length : '-') + '</b><span>booked a call <i>and</i> attended a webinar' + (web ? ' (' + pc(both.length, bookers.length) + '% of bookers)' : '') + '</span></div>' +
    '<div><b>' + (web ? pc(webAtt.filter(x => x.booked).length, webAtt.length) + '%' : '-') + '</b><span>of webinar attendees have ever booked a call' + (web ? ' (' + webAtt.filter(x => x.booked).length + ' of ' + webAtt.length + ')' : '') + '</span></div>' +
    '<div class="' + (webNoCall.length ? 'bad' : '') + '"><b>' + (web ? webNoCall.length : '-') + '</b><span>attended a webinar, never booked - follow up</span></div>' +
    '<div><b>' + (em ? emBook.length : '-') + '</b><span>bookers who also opened our emails' + (em ? ' (' + pc(emBook.length, bookers.length) + '%)' : '') + '</span></div>' +
    '<div><b>' + inTr.length + '</b><span>bookers already in the tracker (' + pc(inTr.length, bookers.length) + '%)</span></div>' +
    '</div>' + (loadBits.length ? '<div class="cal-loadbits">' + loadBits.map(x => '<div>' + x + '</div>').join('') + '</div>' : '') + '</div>';
  const pick = { both, webnocall: webNoCall, email: emBook, tracker: inTr, notracker: bookers.filter(x => !x.tracker), all: bookers };
  const list = (pick[calJourney] || both).slice().sort((x, y) => (y.held + y.web + y.clicked) - (x.held + x.web + x.clicked) || (y.opened - x.opened));
  const seg = (v, l, n) => '<button class="seg-btn ' + (calJourney === v ? 'on' : '') + '" data-act="cal-journey" data-v="' + v + '">' + l + ' <b>' + n + '</b></button>';
  return stats + '<div class="em-toolbar"><div class="seg" style="flex-wrap:wrap">' +
      seg('both', 'Webinar + call', both.length) + seg('webnocall', 'Webinar, no call', webNoCall.length) + seg('email', 'Call + emails', emBook.length) +
      seg('tracker', 'In tracker', inTr.length) + seg('notracker', 'Not in tracker', pick.notracker.length) + seg('all', 'All bookers', bookers.length) + '</div></div>' +
    '<div class="scroll-x"><table class="tbl"><thead><tr><th>Person</th><th>Calls</th><th>Webinars</th><th>Emails</th><th>Tracker</th></tr></thead><tbody>' +
    (list.length ? list.slice(0, calShow).map(x => '<tr><td>' + (x.booked ? '<a href="#" class="n" data-act="cal-person" data-v="' + esc(x.e) + '">' + esc(x.name) + '</a>' : '<b>' + esc(x.name) + '</b>') +
        '<div class="tiny muted">' + esc(x.e) + '</div></td>' +
      '<td class="tiny">' + (x.booked ? '<b>' + x.held + '</b> completed of ' + x.p.b.length + ' booked' + (x.p.recs.length ? ' &middot; ' + x.p.recs.length + ' recorded' : '') : '<span class="pill warn">never booked</span>') + '</td>' +
      '<td class="tiny">' + (x.w ? '<b>' + x.web + '</b> attended of ' + x.webReg + (x.w.minutes ? ' &middot; ' + x.w.minutes + ' min' : '') +
        '<div class="muted em-subj" title="' + esc(x.w.webinars.map(w => w.name).join(', ')) + '">' + esc(x.w.webinars.filter(w => w.attended).map(w => w.name).join(', ')) + '</div>'
        : '<span class="muted">' + (web ? 'none' : 'not loaded') + '</span>') + '</td>' +
      '<td class="tiny">' + (x.m ? x.m.sent + ' sent &middot; <b>' + x.opened + '</b> opened &middot; <b>' + x.clicked + '</b> clicked' : '<span class="muted">' + (em ? 'none' : 'not loaded') + '</span>') + '</td>' +
      '<td>' + (x.tracker ? '<a href="#" class="pill info" data-act="contact" data-id="' + x.tracker + '">open</a>' : '<span class="muted tiny">-</span>') + '</td></tr>').join('')
      : '<tr><td colspan="5"><div class="empty tiny">' + (web || calJourney === 'tracker' || calJourney === 'notracker' || calJourney === 'all' ? 'Nobody here.' : 'Load webinar attendance above to fill this in.') + '</div></td></tr>') +
    '</tbody></table></div>' + calMore(list.length) +
    '<div class="card-b tiny muted">Matched by email address. Webinar attendance covers the webinars loaded from ClickMeeting; ' +
    'the date filter applies to calls, not webinars.</div>';
}

function calRecordedTab() {
  const scope = calPrivOk ? calRecScope : 'team';
  const all = calRaw.recaps.filter(x => (scope === 'all' ? true : scope === 'internal' ? x.internal : !x.internal));
  const q = calRecQ.trim().toLowerCase();
  const hits = all.filter(x => !q || (x.name + ' ' + x.summary + ' ' + x.actions + ' ' + x.att.map(a => a.n + ' ' + a.e).join(' ')).toLowerCase().indexOf(q) >= 0 ||
    (calTr[x.id] && typeof calTr[x.id] === 'string' && calTr[x.id].toLowerCase().indexOf(q) >= 0));
  const haveAll = all.every(x => typeof calTr[x.id] === 'string' || !x.trChars);
  const snip = (x) => {
    if (!q) return esc(String(x.summary || '').replace(/\*\*/g, '').slice(0, 180)) + (x.summary && x.summary.length > 180 ? '…' : '');
    const src = typeof calTr[x.id] === 'string' && calTr[x.id].toLowerCase().indexOf(q) >= 0 ? calTr[x.id] : x.summary + ' ' + x.actions;
    const i = src.toLowerCase().indexOf(q);
    if (i < 0) return '';
    const s = src.slice(Math.max(0, i - 70), i + q.length + 90);
    return '…' + esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => '<mark>' + m + '</mark>') + '…';
  };
  const sc = (v, l) => '<button class="seg-btn ' + (scope === v ? 'on' : '') + '" data-act="cal-recscope" data-v="' + v + '">' + l + '</button>';
  return '<div class="em-toolbar cal-rectools">' +
      (calPrivOk ? '<div class="seg">' + sc('team', 'With outsiders') + sc('internal', 'Internal') + sc('all', 'All') + '</div>' : '') +
      '<label class="wb-f"><span>Search recaps</span><input class="inp sort-sel" data-calrec="q" placeholder="topic, name, anything said" value="' + esc(calRecQ) + '"></label>' +
      (haveAll ? '<span class="pill ok">searching inside transcripts too</span>'
        : calTrLoading ? '<span class="tiny muted">Loading transcripts&hellip; ' + (calTrOf - calTrLoading) + ' of ' + calTrOf + '</span>'
        : '<button class="btn btn-sm" data-act="cal-tr-all">Search inside every transcript</button>') +
    '</div>' +
    '<div class="scroll-x"><table class="tbl"><thead><tr><th>Meeting</th><th>Who was there</th><th>' + (q ? 'Match' : 'Summary') + '</th><th></th></tr></thead><tbody>' +
    (hits.length ? hits.slice(0, calShow).map(x => '<tr><td style="min-width:180px"><a href="#" class="n" data-act="cal-recap" data-v="' + x.id + '">' + esc(x.name) + '</a>' +
        '<div class="tiny muted">' + esc(calStamp(x.s)) + ' &middot; ' + calDur(x.min) + (x.internal ? ' &middot; internal' : x.ev ? ' &middot; booked call' : '') + '</div></td>' +
      '<td class="tiny">' + esc(x.att.filter(a => !a.host).slice(0, 4).map(a => (a.n && a.n !== a.e ? a.n : a.e.split('@')[0])).join(', ')) +
        (x.att.length > 5 ? ' +' + (x.att.length - 5) : '') + '</td>' +
      '<td class="tiny cal-snip">' + snip(x) + '</td>' +
      '<td><button class="btn btn-sm" data-act="cal-recap" data-v="' + x.id + '">Open</button></td></tr>').join('')
      : '<tr><td colspan="4"><div class="empty tiny">No recorded meetings match.</div></td></tr>') +
    '</tbody></table></div>' + calMore(hits.length);
}

/** internal meetings: who is in them, how much time, which recurring meetings eat the week */
function calTeamTab(r) {
  const rec = calRaw.recaps.filter(x => x.internal && x.day >= r.from && x.day <= r.to);
  if (!rec.length) return '<div class="empty">No internal meetings recorded in this date range.</div>';
  const staff = new Map(), series = new Map(), weeks = new Map();
  rec.forEach(x => {
    x.att.forEach(a => {
      const k = a.e;
      const s = staff.get(k) || { k, name: a.n && a.n !== a.e ? a.n : a.e.split('@')[0], n: 0, min: 0, last: 0 };
      s.n++; s.min += x.min; s.last = Math.max(s.last, x.s);
      if (a.n && a.n !== a.e) s.name = a.n;
      staff.set(k, s);
    });
    const nm = x.name.replace(/\s+/g, ' ').trim();
    const se = series.get(nm) || { k: nm, n: 0, min: 0, people: 0, last: 0 };
    se.n++; se.min += x.min; se.people = Math.max(se.people, x.att.length); se.last = Math.max(se.last, x.s);
    series.set(nm, se);
    const w = calWeekOf(x.day);
    weeks.set(w, (weeks.get(w) || 0) + x.min);
  });
  const tot = rec.reduce((s, x) => s + x.min, 0);
  const wk = [...weeks.entries()].sort((x, y) => y[1] - x[1])[0];
  const personHours = rec.reduce((s, x) => s + x.min * x.att.length, 0);
  return '<div class="card-b"><div class="em-cq">' +
      '<div><b>' + rec.length + '</b><span>internal meetings recorded</span></div>' +
      '<div><b>' + calHrs(tot) + '</b><span>of meeting time</span></div>' +
      '<div><b>' + calHrs(personHours) + '</b><span>person-hours (time &times; people in the room)</span></div>' +
      '<div><b>' + (wk ? calHrs(wk[1]) : '-') + '</b><span>busiest week' + (wk ? ': ' + esc(calShortDay(wk[0])) : '') + '</span></div>' +
      '<div><b>' + series.size + '</b><span>different meetings</span></div></div></div>' +
    '<div class="two" style="padding:0 16px 16px"><div><h4 class="em-h4">Team members</h4><div class="scroll-x"><table class="tbl"><thead><tr><th>Person</th><th>Meetings</th><th>Hours</th><th>Last</th></tr></thead><tbody>' +
      [...staff.values()].sort((x, y) => y.min - x.min).map(s => '<tr><td class="n">' + esc(s.name) + '<div class="tiny muted">' + esc(s.k) + '</div></td><td>' + s.n +
        '</td><td>' + calHrs(s.min) + '</td><td class="tiny muted">' + esc(calStamp(s.last)) + '</td></tr>').join('') + '</tbody></table></div></div>' +
    '<div><h4 class="em-h4">Meetings by name</h4><div class="scroll-x"><table class="tbl"><thead><tr><th>Meeting</th><th>Times</th><th>Hours</th><th>Last</th></tr></thead><tbody>' +
      [...series.values()].sort((x, y) => y.min - x.min).map(s => '<tr><td class="n">' + esc(s.k) + '<div class="tiny muted">up to ' + s.people + ' people</div></td><td>' + s.n +
        '</td><td>' + calHrs(s.min) + '</td><td class="tiny muted">' + esc(calStamp(s.last)) + '</td></tr>').join('') + '</tbody></table></div></div></div>' +
    '<div class="card-b tiny muted" style="padding-top:0">Only the owner and Calendly leaders can see this tab and these transcripts. Open any of them from Recorded calls &rarr; Internal.</div>';
}

/* ------------------------------------------------------------ pop-ups */
/** the recap markdown Calendly writes: **bold**, "- " bullets, blank-line paragraphs */
function calMd(s) {
  const lines = String(s || '').split(/\r?\n/);
  let html = '', inList = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  lines.forEach(l => {
    const m = l.match(/^\s*[-*]\s+(.*)$/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(m[1]) + '</li>'; return; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += '<p>' + inline(l) + '</p>';
  });
  if (inList) html += '</ul>';
  return '<div class="cal-md">' + html + '</div>';
}

function calRecapBlock(x) {
  if (!x) return '';
  return '<div class="em-an-sec"><h4>Notetaker recap &middot; ' + esc(x.name) + '</h4>' +
    (x.summary ? '<div class="tiny muted" style="margin-bottom:4px">Summary</div>' + calMd(x.summary) : '') +
    (x.actions ? '<div class="tiny muted" style="margin:10px 0 4px">Action items</div>' + calMd(x.actions) : '') +
    (x.discussion ? '<details style="margin-top:10px"><summary class="tiny"><b>Discussion notes</b></summary>' + calMd(x.discussion) + '</details>' : '') +
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      (x.trChars ? '<button class="btn btn-sm btn-gold" data-act="cal-tr" data-v="' + x.id + '">Read transcript (' + Math.round(x.trChars / 1000) + 'k chars)</button>' : '') +
      (x.app ? '<a class="btn btn-sm" href="' + esc(x.app) + '" target="_blank" rel="noopener">Open in Calendly</a>' : '') +
    '</div></div>';
}

function calMeeting(id) {
  const b = calRaw.byId.get(id);
  if (!b) return;
  const e = b.e, v = b.v || {};
  const tr = calTrackerIdx().get(b.email);
  const reschedFrom = v.oldInv ? calRaw.B.find(x => x.vs.some(i => i.id === v.oldInv)) : null;
  const reschedTo = b.vs.map(i => i.newInv).filter(Boolean).map(n => calRaw.B.find(x => x.vs.some(i => i.id === n))).find(Boolean);
  const qa = (v.qa || []).filter(q => q[1]);
  openModal({
    title: b.name + ' - ' + calStamp(b.s), wide: true,
    body: '<div class="kvlist" style="margin-bottom:16px">' +
        kvRow('Outcome', calStatusPill(b)) +
        kvRow('When', esc(calStamp(b.s)) + ' CT &middot; ' + calDur(b.min) + (b.tz && b.tz !== EM_TZ ? ' <span class="tiny muted">(their time zone: ' + esc(b.tz) + ')</span>' : '')) +
        kvRow('Meeting', esc(e.name) + ' &middot; ' + esc(CAL_LOC[b.loc] || b.loc) + ' &middot; host ' + esc((e.hosts || []).map(h => h.n).join(', '))) +
        kvRow('Email', b.email ? '<a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>' : '-') +
        kvRow('Phone', b.phone ? '<a href="tel:' + esc(b.phone) + '">' + esc(b.phone) + '</a>' : '-') +
        kvRow('Booked', esc(calStamp(b.cr)) + ' &middot; ' + (b.lead < 1 ? 'same day' : Math.round(b.lead) + ' days ahead')) +
        (e.cancel ? kvRow(b.st === 'resched' ? 'Rescheduled' : 'Canceled', 'by ' + esc(e.cancel.by || e.cancel.type) + ' (' + esc(e.cancel.type) + ') ' +
          esc(calStamp(calSec(e.cancel.at))) + (e.cancel.reason ? '<br><i>&ldquo;' + esc(e.cancel.reason) + '&rdquo;</i>' : '')) : '') +
        (reschedFrom ? kvRow('Moved from', '<a href="#" data-act="cal-meeting" data-v="' + reschedFrom.id + '">' + esc(calStamp(reschedFrom.s)) + '</a>') : '') +
        (reschedTo ? kvRow('Moved to', '<a href="#" data-act="cal-meeting" data-v="' + reschedTo.id + '">' + esc(calStamp(reschedTo.s)) + '</a>') : '') +
        (v.utm && Object.keys(v.utm).length ? kvRow('Tracking', Object.entries(v.utm).map(([k, x]) => '<span class="pill">' + esc(k.replace('utm_', '')) + ': ' + esc(x) + '</span>').join(' ')) : '') +
        (e.guests && e.guests.length ? kvRow('Guests', esc(e.guests.join(', '))) : '') +
        kvRow('Tracker', tr ? '<a href="#" class="pill info" data-act="contact" data-id="' + tr + '">open contact</a>' : '<span class="muted">not in the tracker</span>') +
      '</div>' +
      (qa.length ? '<div class="em-an-sec"><h4>Their answers</h4><div class="kvlist">' + qa.map(q => kvRow(q[0], esc(q[1]))).join('') + '</div></div>' : '') +
      (b.rec ? calRecapBlock(b.rec) : (b.st === 'held' ? '<div class="em-an-sec tiny muted">No Notetaker recording for this call.</div>' : '')),
    footer: '<button class="btn left" data-act="cal-person" data-v="' + esc(b.email) + '">Everything with ' + esc(b.name.split(' ')[0]) + '</button>' +
      '<button class="btn" data-act="modal-close">Close</button>'
  });
}

function calPerson(email) {
  const p = calRaw.people.get(email);
  if (!p) return;
  const web = calWebIdx(), em = calEmailIdx(), w = web && web[email], m = em && em.get(email);
  const tr = calTrackerIdx().get(email);
  /* one timeline: bookings, recorded meetings not tied to a booking, webinars */
  const items = p.b.map(b => ({ t: b.s, html: '<b>' + esc(b.e.name) + '</b> ' + calStatusPill(b) + ' <span class="muted">' + calDur(b.min) + '</span>',
    act: '<button class="btn btn-sm" data-act="cal-meeting" data-v="' + b.id + '">Open</button>' }))
    .concat(p.recs.filter(r => !r.ev).map(r => ({ t: r.s, html: '<b>' + esc(r.name) + '</b> <span class="pill ok">recorded meeting</span> <span class="muted">' + calDur(r.min) + '</span>',
      act: '<button class="btn btn-sm" data-act="cal-recap" data-v="' + r.id + '">Open</button>' })))
    .sort((x, y) => y.t - x.t);
  const lastQa = (p.b.slice().reverse().find(b => b.v && b.v.qa && b.v.qa.length) || {}).v;
  openModal({
    title: p.name, wide: true,
    body: '<div class="em-cq" style="margin-bottom:14px">' +
        '<div><b>' + p.n.held + '</b><span>completed calls of ' + p.b.length + ' booked</span></div>' +
        '<div><b>' + calDur(p.min + p.recMin) + '</b><span>time together</span></div>' +
        '<div><b>' + p.recs.length + '</b><span>recorded meetings</span></div>' +
        '<div><b>' + (w ? w.attendedCount : web ? 0 : '-') + '</b><span>webinars attended' + (w && w.minutes ? ' (' + w.minutes + ' min)' : '') + '</span></div>' +
        '<div><b>' + (m ? m.opened + '/' + m.sent : em ? '0' : '-') + '</b><span>emails opened' + (m && m.clicked ? ', ' + m.clicked + ' clicked' : '') + '</span></div>' +
      '</div>' +
      '<div class="kvlist" style="margin-bottom:14px">' +
        kvRow('Email', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>') +
        kvRow('Phone', p.phone ? '<a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + '</a>' : '-') +
        kvRow('Heard via', esc(p.src || '-')) + kvRow('State / time zone', esc([p.state, p.tz].filter(Boolean).join(' · ') || '-')) +
        kvRow('First booked', p.firstBook ? esc(calStamp(p.firstBook)) : '-') +
        kvRow('Tracker', tr ? '<a href="#" class="pill info" data-act="contact" data-id="' + tr + '">open contact</a>' : '<span class="muted">not in the tracker</span>') +
        (w ? kvRow('Webinars', w.webinars.map(x => '<span class="pill ' + (x.attended ? 'ok' : '') + '">' + esc(x.name) + (x.attended ? '' : ' (missed)') + '</span>').join(' ')) : '') +
      '</div>' +
      (lastQa ? '<div class="em-an-sec"><h4>Latest booking answers</h4><div class="kvlist">' + lastQa.qa.filter(q => q[1]).map(q => kvRow(q[0], esc(q[1]))).join('') + '</div></div>' : '') +
      '<div class="em-an-sec"><h4>Timeline</h4><div class="scroll-x" style="max-height:46vh;overflow-y:auto"><table class="tbl"><tbody>' +
        items.map(x => '<tr><td class="tiny muted" style="white-space:nowrap">' + esc(calStamp(x.t)) + '</td><td class="tiny">' + x.html + '</td><td>' + x.act + '</td></tr>').join('') +
      '</tbody></table></div></div>',
    footer: '<button class="btn" data-act="modal-close">Close</button>'
  });
}

function calRecapModal(id) {
  const x = calRaw.recById.get(id);
  if (!x) return;
  const booking = x.ev ? calRaw.byId.get(x.ev) : null;
  openModal({
    title: x.name, wide: true,
    body: '<div class="kvlist" style="margin-bottom:12px">' +
        kvRow('When', esc(calStamp(x.s)) + ' CT &middot; ' + calDur(x.min)) +
        kvRow('Attendees', x.att.map(a => (a.e && !/@phcinvest\.com$/.test(a.e) && calRaw.people.has(a.e)
          ? '<a href="#" class="pill gold" data-act="cal-person" data-v="' + esc(a.e) + '">' + esc(a.n && a.n !== a.e ? a.n : a.e) + '</a>'
          : '<span class="pill' + (a.host ? ' info' : '') + '" title="' + esc(a.e) + '">' + esc(a.n && a.n !== a.e ? a.n : a.e) + (a.host ? ' (host)' : '') + '</span>')).join(' ')) +
        (booking ? kvRow('Booking', '<a href="#" data-act="cal-meeting" data-v="' + booking.id + '">' + esc(booking.name) + ' - booked ' + esc(calStamp(booking.cr)) + '</a>') : '') +
        (x.internal ? kvRow('Visibility', '<span class="pill warn">internal - leaders only</span>') : '') +
      '</div>' + calRecapBlock(x),
    footer: '<button class="btn" data-act="modal-close">Close</button>'
  });
}

async function calFetchTr(id) {
  if (typeof calTr[id] === 'string') return calTr[id];
  const x = calRaw.recById.get(id);
  const { fs, doc, getDoc } = window.FsRead;
  const coll = x && x.internal ? 'calendlyPrivate' : 'calendlyAnalytics';
  const s = await getDoc(doc(fs, coll, 'tr_' + id));
  if (!s.exists()) throw new Error('Transcript not published yet - it arrives with the next sync.');
  let text = s.data().t || '';
  for (let i = 1; i < (s.data().parts || 1); i++) {
    const p = await getDoc(doc(fs, coll, 'tr_' + id + '_' + i));
    if (p.exists()) text += p.data().t || '';
  }
  calTr[id] = text;
  return text;
}
let calTrQ = '';
async function calTranscript(id) {
  const x = calRaw.recById.get(id);
  openModal({ title: 'Transcript - ' + (x ? x.name : ''), wide: true, body: '<div class="empty">Loading transcript&hellip;</div>' });
  let text;
  try { text = await calFetchTr(id); } catch (e) {
    openModal({ title: 'Transcript', body: '<div class="empty">' + esc(e.message) + '</div>', footer: '<button class="btn" data-act="modal-close">Close</button>' });
    return;
  }
  calTrQ = calRecQ;
  openModal({
    title: 'Transcript - ' + (x ? x.name + ' · ' + calStamp(x.s) : ''), wide: true,
    body: '<div class="cal-trbar"><input class="inp" data-caltr="q" placeholder="Find in transcript" value="' + esc(calTrQ) + '">' +
      '<span class="tiny muted" data-caltr="count"></span></div>' +
      '<div class="cal-tr" data-caltr="body">' + calTrHtml(text, calTrQ) + '</div>',
    footer: '<button class="btn left" data-act="cal-tr-dl" data-v="' + id + '">Download .txt</button>' +
      '<button class="btn left" data-act="cal-tr-copy" data-v="' + id + '">Copy</button>' +
      (x ? '<button class="btn" data-act="cal-recap" data-v="' + id + '">Back to recap</button>' : '') +
      '<button class="btn" data-act="modal-close">Close</button>'
  });
  calTrCount();
}
function calTrHtml(text, q) {
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  return String(text).split(/\r?\n/).filter(l => l.trim()).map(l => {
    const m = l.match(/^([^:]{1,60}):\s*(.*)$/);
    let who = m ? m[1] : '', said = m ? m[2] : l;
    said = esc(said);
    if (re) said = said.replace(re, s => '<mark>' + s + '</mark>');
    return '<p' + (re && said.indexOf('<mark>') < 0 ? ' class="dim"' : '') + '>' + (who ? '<b>' + esc(who) + ':</b> ' : '') + said + '</p>';
  }).join('');
}
function calTrCount() {
  const n = document.querySelectorAll('[data-caltr="body"] mark').length;
  const c = document.querySelector('[data-caltr="count"]');
  if (c) c.textContent = calTrQ ? n + ' match' + (n === 1 ? '' : 'es') : '';
  const first = document.querySelector('[data-caltr="body"] mark');
  if (first) first.scrollIntoView({ block: 'center' });
}

async function calLoadAllTr() {
  const scope = calPrivOk ? calRecScope : 'team';
  const todo = calRaw.recaps.filter(x => x.trChars && typeof calTr[x.id] !== 'string' &&
    (scope === 'all' ? true : scope === 'internal' ? x.internal : !x.internal));
  calTrOf = todo.length; calTrLoading = todo.length;
  emRerender();
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const x = todo[i++];
      try { await calFetchTr(x.id); } catch (e) { calTr[x.id] = ''; }
      calTrLoading--;
      if (calTrLoading % 25 === 0) emRerender();
    }
  }));
  calTrLoading = 0;
  emRerender();
}

/** a card for the tracker's contact pop-up: this person's calls */
function calContactCard(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !window.FsRead) return '';
  const head = '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Calendly calls</h3><div class="spacer"></div>';
  if (!calRaw) {
    return head + '</div><div class="card-b tiny">' + (calLoading ? 'Loading Calendly history&hellip;'
      : '<button class="btn btn-sm" data-act="cal-load-contact">Load Calendly history</button>') + '</div></div>';
  }
  const p = calRaw.people.get(e);
  if (!p) return head + '</div><div class="card-b tiny muted">No Calendly bookings or recorded calls with this email.</div></div>';
  const rows = p.b.slice().sort((x, y) => y.s - x.s).slice(0, 8);
  return head + '<button class="btn btn-sm" data-act="cal-person" data-v="' + esc(e) + '">Full history</button></div>' +
    '<div class="card-b tiny" style="padding-bottom:6px">' + p.n.held + ' completed of ' + p.b.length + ' booked &middot; ' + calDur(p.min + p.recMin) +
      ' together &middot; ' + p.recs.length + ' recorded</div>' +
    '<table class="tbl"><tbody>' + rows.map(b => '<tr><td class="tiny">' + esc(calStamp(b.s)) + '</td><td>' + calStatusPill(b) + '</td>' +
      '<td>' + (b.rec ? '<button class="btn btn-sm" data-act="cal-recap" data-v="' + b.rec.id + '">Recap</button>' : '') +
      ' <button class="btn btn-sm" data-act="cal-meeting" data-v="' + b.id + '">Open</button></td></tr>').join('') + '</tbody></table></div>';
}

function calCsv() {
  const sel = calSelect();
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['meeting_central', 'minutes', 'outcome', 'name', 'email', 'phone', 'state', 'timezone', 'heard_via', 'booked_central', 'days_ahead',
    'canceled_by', 'cancel_reason', 'location', 'recorded', 'recap_summary', 'note'].map(q).join(',')];
  sel.B.slice().sort((x, y) => x.s - y.s).forEach(b => {
    const c = b.e.cancel || {};
    lines.push([calStamp(b.s), b.min, CAL_LBL[b.st], b.name, b.email, b.phone, b.state, b.tz, b.src, calStamp(b.cr), Math.round(b.lead * 10) / 10,
      c.type || '', c.reason || '', CAL_LOC[b.loc] || b.loc, b.rec ? 'yes' : '', b.rec ? String(b.rec.summary || '').replace(/\*\*/g, '') : '', b.note].map(q).join(','));
  });
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calendly_' + emDayIso(sel.range.from) + '_to_' + emDayIso(sel.range.to) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(sel.B.length.toLocaleString() + ' bookings exported', 'ok');
}

/* ------------------------------------------------------------ events */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act^="cal-"]');
  if (!t) return;
  e.preventDefault();
  const v = t.dataset.v;
  switch (t.dataset.act) {
    case 'cal-reload': calRaw = null; calError = null; calLoad(true); return;
    case 'cal-clear': calF = { preset: '365', from: '', to: '', status: 'all', loc: 'all', source: 'all', q: '' }; calShow = 150; emRerender(); return;
    case 'cal-tab': calTab = v; calShow = 150; emRerender(); return;
    case 'cal-more': calShow += 300; emRerender(); return;
    case 'cal-grain': calGrain = v; emRerender(); return;
    case 'cal-journey': calJourney = v; calShow = 150; emRerender(); return;
    case 'cal-recscope': calRecScope = v; calShow = 150; emRerender(); return;
    case 'cal-csv': calCsv(); return;
    case 'cal-meeting': calMeeting(v); return;
    case 'cal-person': calPerson(v); return;
    case 'cal-recap': calRecapModal(v); return;
    case 'cal-tr': calTranscript(v); return;
    case 'cal-tr-all': calLoadAllTr(); return;
    case 'cal-tr-copy': if (navigator.clipboard) navigator.clipboard.writeText(calTr[v] || '').then(() => toast('Transcript copied', 'ok')); return;
    case 'cal-tr-dl': {
      const x = calRaw.recById.get(v);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([calTr[v] || ''], { type: 'text/plain' }));
      a.download = ((x ? emDayIso(x.day) + ' ' + x.name : v).replace(/[^\w .-]+/g, '').trim() || 'transcript') + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return;
    }
    case 'cal-load-web':
      (async () => { if (!wbTopics) await wbLoadTopics(); if (wbTopics) await wbLoadAllStats(); })();
      return;
    case 'cal-load-em': emLoad(); return;
    case 'cal-load-contact': calLoad(); if (openContactId) openContact(openContactId); return;
  }
});
function calOnField(el) {
  const k = el.dataset.calf;
  if (k === 'sort') calSort = el.value;
  else if (k === 'from' || k === 'to') {
    const r = calRange();
    calF.from = calF.from || emDayIso(r.from); calF.to = calF.to || emDayIso(r.to);
    calF[k] = el.value; calF.preset = 'custom';
  } else calF[k] = el.value;
  if (k === 'preset' && el.value !== 'custom') { calF.from = ''; calF.to = ''; }
  calShow = 150;
  emRerender();
}
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.calf && el.dataset.calf !== 'q') calOnField(el);
});
let calQTimer = null;
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset) return;
  const which = el.dataset.calf === 'q' ? 'calf' : el.dataset.calrec === 'q' ? 'calrec' : el.dataset.caltr === 'q' ? 'caltr' : null;
  if (!which) return;
  clearTimeout(calQTimer);
  calQTimer = setTimeout(() => {
    if (which === 'caltr') {
      calTrQ = el.value;
      const body = document.querySelector('[data-caltr="body"]');
      const id = (document.querySelector('[data-act="cal-tr-dl"]') || {}).dataset;
      if (body && id && calTr[id.v] != null) { body.innerHTML = calTrHtml(calTr[id.v], calTrQ); calTrCount(); }
      return;
    }
    if (which === 'calf') calF.q = el.value; else calRecQ = el.value;
    calShow = 150;
    emRerender();
    const box = document.querySelector(which === 'calf' ? '[data-calf="q"]' : '[data-calrec="q"]');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }, 300);
});
