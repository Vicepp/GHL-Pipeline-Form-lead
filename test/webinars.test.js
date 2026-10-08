/* Tests for api/_webinars.js - brand classification, topic grouping and
   attendance reconciliation.  Run:  node test/webinars.test.js
   Titles below are real ones from the Pheenyx ClickMeeting account.      */

const { brandOf, topicKeyOf, groupTopics, reconcile } = require('../api/_webinars');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label +
    (ok ? '' : '\n        got:  ' + JSON.stringify(got) + '\n        want: ' + JSON.stringify(want)));
};
const truthy = (label, got) => eq(label, !!got, true);

console.log('\n--- brand: real titles from the account ---');
eq('LinkedIn storytelling is MXL', brandOf('LinkedIn Unlocked: The Power of Storytelling').brand, 'mxl');
eq('Sell Without Selling is MXL', brandOf('Sell Without Selling: How to Attract Clients on LinkedIn by Just Telling Your Story').brand, 'mxl');
eq('AI for personal brand is MXL', brandOf('Getting AI-Savvy - How to use ai to scale your business/personal brand').brand, 'mxl');
eq('Due Diligence is Pheenyx', brandOf('Due Diligence 101: How We Pressure-Tested Montrose Berkeley Lake').brand, 'phx');
eq('Retirement account is Pheenyx', brandOf('How to Invest Using Your Retirement Account').brand, 'phx');
eq('Depreciation is Pheenyx', brandOf('Depreciation: How It Can Lower Your Tax Bill How Does Montrose Berkeley Lake Play a Role?').brand, 'phx');
eq('a bare title is unknown, never guessed', brandOf('Webinar Event').brand, 'unknown');
eq('TEST is unknown', brandOf('TEST').brand, 'unknown');

console.log('\n--- brand: the genuinely ambiguous ones admit it ---');
const er = brandOf('From ER Shifts to $153M: How I Used LinkedIn to Build a Real Estate Portfolio and Buy Back My Time');
eq('an overlapping title is flagged low-confidence', er.confident, false);
truthy('and still reports both scores', er.mxl > 0 && er.phx > 0);
eq('a one-term lead is not called confident', brandOf('The Big Reveal: Meet Our Biggest Deal Yet').confident, false);
truthy('a clear title is confident', brandOf('Inside a Real Deal: A Behind the Scenes Look at Multifamily Investing').confident);

console.log('\n--- topic keys collapse repeat runs ---');
eq('nbsp and case are ignored',
  topicKeyOf('LinkedIn Unlocked: The Power of Storytelling'),
  topicKeyOf('linkedin unlocked the power of storytelling'));
eq('curly and straight quotes match',
  topicKeyOf('The Investor’s Identity Shift'), topicKeyOf("The Investor's Identity Shift"));
truthy('different topics do not collide',
  topicKeyOf('Why 2026 is a Perfect Time to Invest') !== topicKeyOf('Investing Made Simple'));

console.log('\n--- grouping ---');
const now = new Date('2026-10-08T12:00:00Z').getTime();
const confs = [
  { id: 1, name: 'LinkedIn Unlocked: The Step-by-Step System', starts_at: '2026-02-22T18:00:00-05:00', ends_at: '2026-02-22T19:00:00-05:00', status: 'inactive' },
  { id: 2, name: 'LinkedIn Unlocked: The Step-by-Step System', starts_at: '2026-02-21T18:00:00-05:00', ends_at: '2026-02-21T19:00:00-05:00', status: 'inactive' },
  { id: 3, name: 'LinkedIn Unlocked: The Step-by-Step System ', starts_at: '2026-02-20T18:00:00-05:00', ends_at: '2026-02-20T19:00:00-05:00', status: 'inactive' },
  { id: 4, name: 'Due Diligence 101: Montrose', starts_at: '2026-09-24T18:00:00-05:00', ends_at: '2026-09-24T19:00:00-05:00', status: 'inactive' },
  { id: 5, name: 'Depreciation and Your Tax Bill', starts_at: '2026-10-27T18:00:00-05:00', ends_at: '2026-10-27T19:00:00-05:00', status: 'active' }
];
const topics = groupTopics(confs, {}, now);
eq('five conferences become three topics', topics.length, 3);
const li = topics.find(t => /LinkedIn/.test(t.name));
eq('repeat runs collapse into one topic', li.count, 3);
eq('runs are newest first', li.runs.map(r => r.id), [1, 2, 3]);
eq('last run is the most recent', String(li.last).slice(0, 10), '2026-02-22');
eq('first run is the earliest', String(li.first).slice(0, 10), '2026-02-20');
eq('topics are ordered by most recent', topics[0].name, 'Depreciation and Your Tax Bill');
eq('a future webinar counts as upcoming', topics[0].upcoming, 1);
eq('a past one does not', topics.find(t => /Due Diligence/.test(t.name)).upcoming, 0);

console.log('\n--- a human override beats the guess ---');
const key = topicKeyOf('From ER Shifts to $153M: How I Used LinkedIn to Build a Real Estate Portfolio');
const overrides = {};
overrides[key] = 'mxl';
const ov = groupTopics(
  [{ id: 9, name: 'From ER Shifts to $153M: How I Used LinkedIn to Build a Real Estate Portfolio', starts_at: '2026-05-07T18:00:00-05:00', ends_at: '2026-05-07T19:00:00-05:00' }],
  overrides, now);
eq('override applied', ov[0].brand, 'mxl');
eq('and marked as overridden', ov[0].overridden, true);
eq('while still reporting what it would have guessed', ov[0].autoBrand, 'phx');

console.log('\n--- attendance reconciliation ---');
const regs = [
  { email: 'A@Example.com', visitor_nickname: 'Ada Lovelace', registration_date: '2026-09-18T02:12:23-05:00', geo: { city: 'Abuja', country: 'NG' }, fields: { 'Phone Number': '0814' } },
  { email: 'b@example.com', visitor_nickname: 'Bob Stone', registration_date: '2026-09-19T02:12:23-05:00' },
  { email: 'c@example.com', visitor_nickname: 'Cara Diaz', registration_date: '2026-09-20T02:12:23-05:00' },
  { email: 'b@example.com', visitor_nickname: 'Bob Stone again', registration_date: '2026-09-21T02:12:23-05:00' }
];
const atts = [
  { role: 'host', nickname: 'Nkem', email: 'nkem@phcinvest.com', start_date: '2026-09-24T17:47:00-05:00', end_date: '2026-09-24T18:44:00-05:00' },
  { role: 'listener', nickname: 'Ada Lovelace', email: 'a@example.com', start_date: '2026-09-24T18:00:00-05:00', end_date: '2026-09-24T18:30:00-05:00', city: 'Lagos', country_iso3: 'NGA' },
  { role: 'listener', nickname: 'Walk In', email: 'w@example.com', start_date: '2026-09-24T18:05:00-05:00', end_date: '2026-09-24T18:35:00-05:00' }
];
const r = reconcile(regs, atts);
eq('registered counts unique people, not rows', r.registered, 3);
eq('attended counts only listeners who showed', r.attended, 2);
eq('no-shows are registrants who did not come', r.noShow, 2);
eq('walk-ins are counted separately', r.walkIns, 1);
eq('attendance rate is against registrations', r.rate, 33);
truthy('the host is never counted as a lead', !r.people.some(p => /nkem@phcinvest/.test(p.email)));
truthy('email matching ignores case', r.people.find(p => p.email === 'a@example.com').attended === true);
eq('minutes watched are captured', r.people.find(p => p.email === 'a@example.com').minutes, 30);
eq('a no-show is marked', r.people.find(p => p.email === 'c@example.com').attended, false);
eq('a walk-in has no registration date', r.people.find(p => p.email === 'w@example.com').registeredAt, null);
eq('registration answers are kept', r.people.find(p => p.email === 'a@example.com').fields['Phone Number'], '0814');

console.log('\n--- nothing blows up on empty or junk ---');
let threw = null;
[[null, null], [[], []], [undefined, undefined], [[{}], [{}]]].forEach(pair => {
  try { reconcile(pair[0], pair[1]); } catch (e) { threw = e.message; }
});
eq('reconcile survives junk', threw, null);
eq('empty reconcile is all zeroes', reconcile([], []).attended, 0);
eq('grouping survives an empty list', groupTopics([], {}, now).length, 0);
eq('grouping survives an entry with no name', groupTopics([{ id: 1 }], {}, now).length, 1);

console.log('\n========================================');
console.log(fail ? fail + ' FAILED, ' + pass + ' passed' : 'ALL ' + pass + ' PASSED');
console.log('========================================\n');
process.exit(fail ? 1 : 0);
