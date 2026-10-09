/* Pheenyx Capital - Pipeline Workflow
   api/_webinars.js
   ------------------------------------------------------------------
   Pure helpers for the ClickMeeting data: which brand a webinar belongs
   to, and how to collapse 174 conferences into the handful of topics a
   human thinks in. No network, no Firebase - unit-tested by
   test/webinars.test.js.                                              */

/* My Expansive Life: LinkedIn, personal brand, career, visibility.
   Pheenyx Capital: investing, real estate, retirement, deals, tax. */
const MXL_TERMS = [
  'linkedin', 'personal brand', 'visibility', 'storytelling', 'tell your story',
  'career', 'profile', 'connections', 'content', 'audience', 'ai-savvy',
  'ai savvy', 'relevant on linkedin', 'sell without selling', 'open doors',
  'expansive', 'grind', 'badge of honor', 'betting on yourself', 'made for more'
];
const PHX_TERMS = [
  'invest', 'investor', 'investing', 'real estate', 'multifamily', 'deal',
  'montrose', 'arlington', 'berkeley lake', '401', 'ira', 'retirement',
  'depreciation', 'tax', 'wealth', 'capital', 'acquisition', 'portfolio',
  'due diligence', 'underwrit', 'equity', 'passive', 'cash flow', 'syndicat',
  'raised', 'fund', 'asset', 'property', 'roi', 'accredited'
];

const lower = (s) => String(s == null ? '' : s).toLowerCase();

/** count how many distinct terms from a list appear in the title */
function score(title, terms) {
  const t = lower(title);
  let n = 0;
  terms.forEach(k => { if (t.indexOf(k) >= 0) n++; });
  return n;
}

/**
 * Which brand ran this webinar.
 * Titles genuinely overlap - "How I Used LinkedIn to Build a Real Estate
 * Portfolio" is both - so this returns a guess plus its confidence, and the
 * UI lets a human override it. Never silently pick for an even split.
 * @returns {{brand:'mxl'|'phx'|'unknown', confident:boolean, mxl:number, phx:number}}
 */
function brandOf(title) {
  const m = score(title, MXL_TERMS);
  const p = score(title, PHX_TERMS);
  if (m === 0 && p === 0) return { brand: 'unknown', confident: false, mxl: m, phx: p };
  if (m === p) return { brand: 'unknown', confident: false, mxl: m, phx: p };
  return {
    brand: m > p ? 'mxl' : 'phx',
    confident: Math.abs(m - p) >= 2,
    mxl: m, phx: p
  };
}

/** the key that collapses repeat runs of the same webinar into one topic */
function topicKeyOf(name) {
  return lower(name)
    .replace(/ /g, ' ')            /* ClickMeeting titles carry nbsp */
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

const isUpcoming = (c, now) => {
  const t = new Date(c.ends_at || c.starts_at).getTime();
  return !isNaN(t) && t >= (now || Date.now());
};

/** collapse the conference list into topics, newest first */
function groupTopics(conferences, overrides, now) {
  const map = {};
  (conferences || []).forEach(c => {
    const name = String(c.name || 'Untitled').replace(/ /g, ' ').trim();
    const key = topicKeyOf(name);
    if (!key) return;
    if (!map[key]) {
      const g = brandOf(name);
      map[key] = {
        key, name,
        brand: (overrides && overrides[key]) || g.brand,
        autoBrand: g.brand, confident: g.confident, overridden: !!(overrides && overrides[key]),
        runs: [], first: null, last: null, upcoming: 0
      };
    }
    const topic = map[key];
    topic.runs.push({
      id: c.id, startsAt: c.starts_at, endsAt: c.ends_at,
      status: c.status, roomType: c.room_type,
      upcoming: isUpcoming(c, now)
    });
    if (isUpcoming(c, now)) topic.upcoming++;
  });

  return Object.keys(map).map(k => {
    const t = map[k];
    t.runs.sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));
    t.last = t.runs[0] ? t.runs[0].startsAt : null;
    t.first = t.runs[t.runs.length - 1] ? t.runs[t.runs.length - 1].startsAt : null;
    t.count = t.runs.length;
    return t;
  }).sort((a, b) => new Date(b.last || 0) - new Date(a.last || 0));
}

/* Where a registrant says they came from. The forms ask "How did you hear
   about the webinar?", but plenty leave it blank - so fall back to the
   referrer, which recovers Instagram, LinkedIn and Gmail traffic that would
   otherwise all read as Unknown. */
const SOURCE_CANON = [
  [/linked\s*in/i, 'LinkedIn'], [/you\s*tube/i, 'YouTube'], [/face\s*book/i, 'Facebook'],
  [/insta/i, 'Instagram'], [/whats\s*app/i, 'WhatsApp'], [/tik\s*tok/i, 'TikTok'],
  [/^e-?mail/i, 'Email'], [/news\s*letter/i, 'Email'], [/web\s*site/i, 'Website'],
  [/google/i, 'Google'], [/twitter|^x$/i, 'X'], [/friend|word of mouth|referr/i, 'Referral'],
  [/podcast/i, 'Podcast'], [/event|conference/i, 'Event']
];
const REFERER_CANON = [
  [/instagram/i, 'Instagram'], [/linkedin/i, 'LinkedIn'], [/facebook|fb\.me/i, 'Facebook'],
  [/youtube|youtu\.be/i, 'YouTube'], [/android\.gm|mail\.google|outlook|mail\./i, 'Email'],
  [/whatsapp/i, 'WhatsApp'], [/tiktok/i, 'TikTok'], [/t\.co|twitter|x\.com/i, 'X'],
  [/google\./i, 'Google'], [/clickmeeting/i, 'Direct']
];
function canon(value, table) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  for (const row of table) if (row[0].test(v)) return row[1];
  return v;
}
function sourceOf(r) {
  const f = (r && r.fields) || {};
  const key = Object.keys(f).find(k => /hear about|how did you|source|referr|find us/i.test(k));
  const answered = key ? canon(f[key], SOURCE_CANON) : '';
  if (answered) return answered;
  const ref = r && r.http_referer;
  if (ref) {
    const fromRef = canon(ref, REFERER_CANON);
    if (fromRef && fromRef !== ref) return fromRef;
    try { return new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { /* android-app:// etc */ }
  }
  return 'Unknown';
}

/** registrations + attendees for one run -> who showed up and who did not */
function reconcile(registrations, attendees) {
  const norm = (e) => lower(e).trim();
  /* the host and presenters are staff, not leads */
  const real = (attendees || []).filter(a => lower(a.role) === 'listener');
  const came = {};
  real.forEach(a => {
    const k = norm(a.email);
    if (!k) return;
    const mins = (new Date(a.end_date) - new Date(a.start_date)) / 60000;
    const prev = came[k];
    came[k] = {
      email: k, name: a.nickname || '',
      minutes: Math.max(0, Math.round((prev ? prev.minutes : 0) + (isNaN(mins) ? 0 : mins))),
      city: a.city || (prev && prev.city) || '', country: a.country_iso3 || (prev && prev.country) || ''
    };
  });

  const people = [];
  const seen = {};
  (registrations || []).forEach(r => {
    const k = norm(r.email);
    if (!k || seen[k]) return;
    seen[k] = true;
    const a = came[k];
    people.push({
      email: k,
      name: (r.visitor_nickname || (a && a.name) || k).trim(),
      registeredAt: r.registration_date || null,
      attended: !!a,
      minutes: a ? a.minutes : 0,
      city: (a && a.city) || (r.geo && r.geo.city) || '',
      country: (a && a.country) || (r.geo && r.geo.country) || '',
      source: sourceOf(r),
      referer: r.http_referer || '',
      fields: r.fields || {}
    });
  });
  /* somebody can attend without registering - they are still a lead */
  Object.keys(came).forEach(k => {
    if (seen[k]) return;
    people.push({
      email: k, name: came[k].name || k, registeredAt: null, attended: true,
      minutes: came[k].minutes, city: came[k].city, country: came[k].country,
      source: 'Walk-in', referer: '', fields: {}, walkIn: true
    });
  });

  const registered = people.filter(p => p.registeredAt).length;
  /* The rate answers "of the people who signed up, how many turned up?" -
     so walk-ins must stay out of the numerator. Counting them would inflate
     it, and a webinar with more walk-ins than registrants would read as
     over 100% attendance. */
  const showedUp = people.filter(p => p.registeredAt && p.attended).length;
  return {
    people,
    registered,
    attended: people.filter(p => p.attended).length,
    noShow: people.filter(p => p.registeredAt && !p.attended).length,
    walkIns: people.filter(p => p.walkIn).length,
    rate: registered ? Math.round(showedUp / registered * 100) : 0
  };
}

module.exports = { brandOf, topicKeyOf, groupTopics, reconcile, isUpcoming, sourceOf, canon,
  MXL_TERMS, PHX_TERMS };
