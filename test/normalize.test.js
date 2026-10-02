/* Tests for api/_normalize.js - the GoHighLevel payload mapper.
   Run:  npm test          (no dependencies needed)

   GHL does not send one fixed schema, so each case below is a different
   real-world shape the webhook can arrive in. */

const { mapToForm, norm, toNumber, personName, index } = require('../api/_normalize');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const okay = JSON.stringify(got) === JSON.stringify(want);
  if (okay) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + '\n        got:  ' + JSON.stringify(got) + '\n        want: ' + JSON.stringify(want)); }
}
function truthy(label, got) { eq(label, !!got, true); }

/* the seeded Investor Interest Form from store.js */
const investorForm = {
  id: 'fm_investor', name: 'Investor Interest Form',
  pipelineId: 'pl_investor', stageId: 'st_i1',
  tags: ['investor', 'inbound'], assignTo: 'Chris',
  taskTemplate: 'Call {{name}} - new investor enquiry', taskDueDays: 1,
  fields: [
    { id: 'q1', label: 'Full name', type: 'text', map: 'name' },
    { id: 'q2', label: 'Email', type: 'email', map: 'email' },
    { id: 'q3', label: 'Phone', type: 'phone', map: 'phone' },
    { id: 'q4', label: 'Capital you are looking to deploy', type: 'select', map: 'value' },
    { id: 'q5', label: 'Are you an accredited investor?', type: 'select', map: 'none' },
    { id: 'q6', label: 'What are you hoping to achieve?', type: 'textarea', map: 'notes' }
  ]
};

console.log('\n--- helpers ---');
eq('norm slugifies labels', norm('Are you an accredited investor?'), 'are_you_an_accredited_investor');
eq('norm handles mixed junk', norm('  Capital you are looking to deploy  '), 'capital_you_are_looking_to_deploy');
eq('toNumber strips currency', toNumber('$250,000.00'), 250000);
eq('toNumber rejects text', toNumber('not a number'), 0);
eq('toNumber rejects negatives', toNumber('-500'), 0);

console.log('\n--- case 1: GHL "Form Submitted" with first/last + customData ---');
const p1 = {
  contact_id: 'ghlC001',
  first_name: 'Marcus',
  last_name: 'Feldman',
  email: 'marcus.feldman@northbridge.co',
  phone: '+13125550142',
  tags: 'webinar, linkedin',
  location: { id: 'loc_abc', name: 'Pheenyx Capital' },
  customData: {
    'Capital you are looking to deploy': '250000',
    'Are you an accredited investor?': 'Yes',
    'What are you hoping to achieve?': 'Passive income and depreciation.'
  }
};
const m1 = mapToForm(investorForm, p1);
eq('c1 name from first+last', m1.name, 'Marcus Feldman');
eq('c1 email', m1.email, 'marcus.feldman@northbridge.co');
eq('c1 phone', m1.phone, '+13125550142');
eq('c1 value parsed', m1.value, 250000);
eq('c1 notes', m1.notes, 'Passive income and depreciation.');
eq('c1 accredited answer kept', m1.answers['Are you an accredited investor?'], 'Yes');
eq('c1 ghl contact id', m1.ghlContactId, 'ghlC001');
eq('c1 tags from GHL', m1.tags, ['webinar', 'linkedin']);
eq('c1 every question filled', m1.unmatched, []);
eq('c1 title defaults to name', m1.title, 'Marcus Feldman');

console.log('\n--- case 2: full_name, nested contact, tags as array, custom field pairs ---');
const p2 = {
  type: 'ContactCreate',
  contact: { id: 'ghlC002', full_name: 'Priya Raghavan', email: 'priya.r@avenuecap.io', phone: '(646) 555-0188' },
  tags: ['investor-list', 'hot'],
  customFields: [
    { id: 'cf1', name: 'Capital you are looking to deploy', value: '$100,000' },
    { id: 'cf2', name: 'Are you an accredited investor?', value: 'Not sure' }
  ]
};
const m2 = mapToForm(investorForm, p2);
eq('c2 name from nested full_name', m2.name, 'Priya Raghavan');
eq('c2 email from nested contact', m2.email, 'priya.r@avenuecap.io');
eq('c2 phone from nested contact', m2.phone, '(646) 555-0188');
eq('c2 value from custom field pair', m2.value, 100000);
eq('c2 select from custom field pair', m2.answers['Are you an accredited investor?'], 'Not sure');
eq('c2 tags array joined', m2.tags, ['investor-list', 'hot']);
eq('c2 ghl id from nested contact', m2.ghlContactId, 'ghlC002');

console.log('\n--- case 3: snake_case field keys instead of labels ---');
const p3 = {
  contact_id: 'ghlC003',
  full_name: 'Dale Whitmore',
  email_address: 'dwhitmore@gmail.com',
  mobile_phone: '704-555-0119',
  data: {
    capital_you_are_looking_to_deploy: '50000',
    are_you_an_accredited_investor: 'No',
    what_are_you_hoping_to_achieve: 'Learning for now.'
  }
};
const m3 = mapToForm(investorForm, p3);
eq('c3 name', m3.name, 'Dale Whitmore');
eq('c3 email alias', m3.email, 'dwhitmore@gmail.com');
eq('c3 phone alias', m3.phone, '704-555-0119');
eq('c3 value from snake_case key', m3.value, 50000);
eq('c3 notes from snake_case key', m3.notes, 'Learning for now.');
eq('c3 nothing unmatched', m3.unmatched, []);

console.log('\n--- case 4: sparse payload, only an email ---');
const m4 = mapToForm(investorForm, { email: 'someone@example.com' });
eq('c4 falls back to Unnamed lead', m4.name, 'Unnamed lead');
eq('c4 email still captured', m4.email, 'someone@example.com');
eq('c4 value zero not NaN', m4.value, 0);
truthy('c4 reports what it could not fill', m4.unmatched.length >= 4);

console.log('\n--- case 5: unknown extra fields are kept, noise is dropped ---');
const p5 = {
  contact_id: 'ghlC005', full_name: 'Ray Kessler', email: 'ray@kesslerprop.com',
  utm_source: 'facebook', utm_campaign: 'q4-retarget',
  workflow: { id: 'wf1', name: 'Investor Intake' },
  location: { id: 'loc_abc' },
  date_added: '2026-09-29T10:00:00Z',
  'Preferred contact time': 'Evenings',
  'How did you hear about us': 'Referral from Sonia'
};
const m5 = mapToForm(investorForm, p5);
truthy('c5 keeps an unmapped question', m5.extras.preferred_contact_time === 'Evenings');
truthy('c5 keeps the second one', m5.extras.how_did_you_hear_about_us === 'Referral from Sonia');
eq('c5 drops utm noise', 'utm_source' in m5.extras, false);
eq('c5 drops workflow noise', 'workflow_name' in m5.extras, false);
eq('c5 drops date noise', 'date_added' in m5.extras, false);

console.log('\n--- case 6: a form whose title comes from an address field ---');
const sellerForm = {
  id: 'fm_seller', name: 'Off-Market Deal Submission',
  pipelineId: 'pl_acq', stageId: 'st_a1', tags: ['seller'],
  fields: [
    { id: 'q1', label: 'Your name', map: 'name' },
    { id: 'q2', label: 'Email', map: 'email' },
    { id: 'q3', label: 'Property address', map: 'title' },
    { id: 'q4', label: 'Asking price', map: 'value' }
  ]
};
const m6 = mapToForm(sellerForm, {
  first_name: 'Tanya', last_name: 'Brooks', email: 'tanya.brooks@realtysouth.com',
  customData: { 'Property address': '4821 Kingsley Ave', 'Asking price': '1,450,000' }
});
eq('c6 card titled by address', m6.title, '4821 Kingsley Ave');
eq('c6 contact still named', m6.name, 'Tanya Brooks');
eq('c6 price parsed with commas', m6.value, 1450000);

console.log('\n--- case 7: hostile / malformed input must not throw ---');
const weird = [
  null, undefined, {}, [], 'a string', 42,
  { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } },
  { email: { nested: 'object' } },
  { tags: 12345 },
  { first_name: 'x'.repeat(5000), email: 'y'.repeat(5000) + '@z.com' }
];
let threw = null;
weird.forEach((w, i) => { try { mapToForm(investorForm, w); } catch (e) { threw = i + ': ' + e.message; } });
eq('c7 nothing throws on junk input', threw, null);
const mLong = mapToForm(investorForm, { first_name: 'x'.repeat(5000), email: 'y'.repeat(300) + '@z.com' });
truthy('c7 name is capped at 120', mLong.name.length <= 120);
truthy('c7 email is capped at 160', mLong.email.length <= 160);
eq('c7 empty payload still returns a usable record', mapToForm(investorForm, {}).name, 'Unnamed lead');

console.log('\n--- case 8: form with no fields at all ---');
const m8 = mapToForm({ id: 'f', name: 'Bare', pipelineId: 'p', stageId: 's', tags: [] },
  { full_name: 'Ken Obi', email: 'ken.obi@outlook.com', phone: '2145550166' });
eq('c8 still fills the record fields', [m8.name, m8.email, m8.phone], ['Ken Obi', 'ken.obi@outlook.com', '2145550166']);
eq('c8 answers empty', m8.answers, {});

console.log('\n--- case 9: a real GHL location, hundreds of custom fields ---');
/* GHL's standard webhook sends every custom field defined in the location as
   a top-level key, nearly all empty - and some are labelled exactly like the
   contact's own fields. Field names below are from a live webhook.site capture. */
const ghlBlizzard = {
  'LEAD CAPTURE & CONVERSION { Leads from Webinars/Events} ': '',
  'Attach any relevant photos or documents related to the service request (if applicable).': '',
  '1000 Post Engagements per week': '',
  'Cancelled Calls This Week': '1',
  'Billing Address - Full Address': '',
  'Multi Line 3hbq': '',
  'What would you like to see more of from us in 2026?': '',
  '{- Content scheduling & publishing} ': '',
  'What best describes your primary profession??': '',
  '16 leads/week from lead magent': '',
  '1 Deal Review Meetings per week': '',
  'CONVERSION FUNNEL {Calls from IG}': '',
  'LEAD CAPTURE & CONVERSION {Leads from Paid Ads}': '',
  'Single Line 1315n': '',
  /* the dangerous ones: custom fields labelled like the real contact fields,
     deliberately placed BEFORE them in key order */
  'Email': 'old-crm-import@wrong.example',
  'Phone': '+10000000000',
  'Full Name': 'Imported Placeholder',
  /* the contact's actual details, as GHL sends them */
  contact_id: 'ghlReal123',
  first_name: 'Johnson',
  last_name: 'Adebayo',
  email: 'johnson.adebayo@example.com',
  phone: '+2348012345678',
  location: { id: 'loc_1', name: 'Pheenyx Capital' }
};
const m9 = mapToForm(investorForm, ghlBlizzard);
eq('c9 real email beats a custom field named Email', m9.email, 'johnson.adebayo@example.com');
eq('c9 real phone beats a custom field named Phone', m9.phone, '+2348012345678');
eq('c9 real name beats a custom field named Full Name', m9.name, 'Johnson Adebayo');
eq('c9 company name never becomes the lead name', m9.name !== 'Pheenyx Capital', true);
eq('c9 ghl contact id', m9.ghlContactId, 'ghlReal123');
truthy('c9 empty custom fields dropped', Object.keys(m9.extras).every(k => m9.extras[k] !== ''));
truthy('c9 non-empty custom field kept', m9.extras.cancelled_calls_this_week === '1');
truthy('c9 extras stay bounded', Object.keys(m9.extras).length <= 25);

console.log('\n--- case 10: 500 custom fields does not blow up ---');
const huge = { contact_id: 'c500', full_name: 'Scale Test', email: 'scale@example.com' };
for (let i = 0; i < 500; i++) huge['Custom question number ' + i + '?'] = i % 7 === 0 ? 'answer ' + i : '';
const t0 = Date.now();
const m10 = mapToForm(investorForm, huge);
const ms = Date.now() - t0;
eq('c10 identity still correct', [m10.name, m10.email], ['Scale Test', 'scale@example.com']);
truthy('c10 extras capped (' + Object.keys(m10.extras).length + ')', Object.keys(m10.extras).length <= 25);
truthy('c10 fast enough (' + ms + 'ms)', ms < 1000);

console.log('\n--- case 11: the real Pheenyx GHL payload (captured 2026-10-02) ---');
/* Trimmed from a live webhook.site capture of the Pheenyx Capital location.
   GHL's standard webhook sends ~250 custom fields as top-level keys, almost
   all empty, wrapped in routing and analytics metadata. Note there is NO
   phone key at all, and customData is empty - this form's answers ARE the
   top-level custom fields. */
const pheenyxReal = {
  'LEAD CAPTURE & CONVERSION { Leads from Webinars/Events} ': '',
  'Cancelled Calls This Week': '1',
  'Billing Address - Full Address': '',
  'Billing Address - Full Name': '',
  'Billing Address - Phone Number': '',
  'Source 5 speaking engagements per week': '1',
  'Source 30 podcasts per week': '3',
  ' Type of Service Needed (Check all that apply):': '',
  'Any SOP this week': 'No',
  'Submission Date': '2026-09-25',
  'Or Paste the SOP Link here': 'https://phcinvest-my.sharepoint.com/:w:/p/grace/IQCC',
  '1. What were your top 3 achievements this week?\n\n': '1. Booking of investors calls',
  '2. What went well?\n\n': 'Everything I set to do went well',
  'Do you manage any social media platforms?\n\n': 'Adetutu Lawson',
  ' ': '',
  '   ': '',
  'X': '',
  contact_id: 'nU1NJKsxRYHKIgFpMtCD',
  first_name: 'Adetutu',
  last_name: 'Lawson',
  full_name: 'Adetutu Lawson',
  email: 'adetutu@phcinvest.com',
  tags: '',
  country: 'US',
  timezone: 'America/Chicago',
  date_created: '2026-01-23T20:32:24.928Z',
  contact_source: 'WEEKLY CHECKIN FORM - Copy',
  full_address: '',
  contact_type: 'lead',
  location: { name: 'Pheenyx Capital Investment', country: 'US', fullAddress: '', id: 'WDlWQO8FeXaMieIvPOrw' },
  workflow: { id: '2274e1df-2327-412a-9687-a593380ab2f7', name: 'New Workflow : 1790779314885' },
  triggerData: {},
  contact: {
    attributionSource: { sessionSource: 'Direct traffic', url: 'https://api.leadconnectorhq.com/widget/form/7w8', medium: 'form', ip: '91.132.137.126', userAgent: 'Mozilla/5.0' },
    lastAttributionSource: { sessionSource: 'Direct traffic', medium: 'form', ip: '105.127.10.136' }
  },
  attributionSource: { sessionSource: 'Direct traffic', medium: 'form', ip: '105.127.10.136', gaClientId: 'GA1.1.148' },
  customData: {}
};
const m11 = mapToForm(investorForm, pheenyxReal);
eq('c11 name from the contact, not the location', m11.name, 'Adetutu Lawson');
eq('c11 email', m11.email, 'adetutu@phcinvest.com');
eq('c11 phone empty when GHL sends none', m11.phone, '');
eq('c11 a billing-address field is not mistaken for the phone', m11.phone, '');
eq('c11 ghl contact id', m11.ghlContactId, 'nU1NJKsxRYHKIgFpMtCD');
eq('c11 captures which GHL form it came from', m11.ghlFormName, 'WEEKLY CHECKIN FORM - Copy');
eq('c11 no tags when GHL sends an empty string', m11.tags, []);
eq('c11 reports exactly which questions it could not fill', m11.unmatched,
  ['Phone', 'Capital you are looking to deploy', 'Are you an accredited investor?', 'What are you hoping to achieve?']);
truthy('c11 Full name and Email were filled',
  m11.matched.indexOf('Full name') >= 0 && m11.matched.indexOf('Email') >= 0);
/* the filter used to eat these two because they start with noise words */
truthy('c11 keeps "Source 5 speaking engagements per week"', m11.extras.source_5_speaking_engagements_per_week === '1');
truthy('c11 keeps "Source 30 podcasts per week"', m11.extras.source_30_podcasts_per_week === '3');
truthy('c11 keeps a real free-text answer',
  m11.extras['2_what_went_well'] === 'Everything I set to do went well');
truthy('c11 drops analytics noise', !Object.keys(m11.extras).some(k => /attributionsource|gaclientid|useragent/.test(k)));
truthy('c11 drops the workflow and location envelope',
  !Object.keys(m11.extras).some(k => /^(workflow_|location_)/.test(k)));
truthy('c11 drops the ~250 empty custom fields', Object.keys(m11.extras).every(k => m11.extras[k] !== ''));
truthy('c11 blank-named keys ignored', !('' in m11.extras));

console.log('\n========================================');
console.log(fail ? fail + ' FAILED, ' + pass + ' passed' : 'ALL ' + pass + ' PASSED');
console.log('========================================\n');
process.exit(fail ? 1 : 0);
