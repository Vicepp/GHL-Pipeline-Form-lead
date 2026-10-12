/* The ClickMeeting proxy's access gate.
   Reading a /team row has to be done AS the caller - firestore.rules needs
   request.auth - so this pins that the ID token is actually forwarded.
   Run: node test/clickmeeting-auth.test.js                               */
process.env.FIREBASE_PROJECT_ID = 'ghl-phc-pipeline';
process.env.FIREBASE_API_KEY = 'AIza-test';
process.env.CLICKMEETING_API_KEY = 'cm-test';
process.env.OWNER_EMAILS = 'info@phcinvest.com';

const handler = require('../api/clickmeeting.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + n); };

let calls = [];
function stubFetch(opts) {
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    if (/identitytoolkit/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ users: [{ email: opts.email }] }) };
    }
    if (/documents\/team\//.test(url)) {
      return { ok: opts.onTeam, status: opts.onTeam ? 200 : 403, json: async () => ({}), text: async () => '{}' };
    }
    /* ClickMeeting */
    return { ok: true, status: 200, text: async () => '[]' };
  };
}
const run = (headers, query) => new Promise(async done => {
  const res = { _s: 0, _b: '', setHeader() {}, status(c) { this._s = c; return this; },
    send(b) { this._b = b; done({ status: this._s, body: JSON.parse(b) }); return this; } };
  await handler({ method: 'GET', query, headers, body: {} }, res);
});

(async () => {
  /* --- a team member who is NOT the hardcoded owner --- */
  calls = []; stubFetch({ email: 'grace@phcinvest.com', onTeam: true });
  let r = await run({ authorization: 'Bearer TOKEN123' }, { action: 'list' });
  const teamCall = calls.find(c => /documents\/team\//.test(c.url));
  ok('a team read is attempted for a non-owner', !!teamCall);
  ok('it carries the caller\u2019s ID token',
    teamCall && teamCall.init.headers && teamCall.init.headers.Authorization === 'Bearer TOKEN123');
  ok('it no longer relies on the api key alone', teamCall && !/[?&]key=/.test(teamCall.url));
  ok('a listed team member is let through', r.status === 200);

  /* --- somebody genuinely not on the team --- */
  calls = []; stubFetch({ email: 'stranger@example.com', onTeam: false });
  r = await run({ authorization: 'Bearer TOKEN123' }, { action: 'list' });
  ok('a stranger is refused', r.status === 403);
  ok('and told how to be added', /Settings - Team/.test(r.body.error));

  /* --- the bootstrap owner needs no team row --- */
  calls = []; stubFetch({ email: 'info@phcinvest.com', onTeam: false });
  r = await run({ authorization: 'Bearer TOKEN123' }, { action: 'list' });
  ok('the owner still works without a team row', r.status === 200);
  ok('and skips the team read entirely', !calls.some(c => /documents\/team\//.test(c.url)));

  /* --- no token at all --- */
  calls = []; stubFetch({ email: 'x@y.com', onTeam: true });
  r = await run({}, { action: 'list' });
  ok('no token is still refused', r.status === 401);

  /* --- health check stays open, and leaks nothing --- */
  r = await run({}, { action: 'health' });
  ok('health needs no sign-in', r.status === 200);
  ok('health returns booleans only',
    Object.values(r.body.configured).every(v => typeof v === 'boolean'));
  ok('health never echoes a key value', !JSON.stringify(r.body).includes('cm-test'));

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL ' + pass + ' PASSED');
  process.exit(fail ? 1 : 0);
})();
