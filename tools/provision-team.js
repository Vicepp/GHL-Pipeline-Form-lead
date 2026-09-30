#!/usr/bin/env node
/* Pheenyx Capital - Pipeline Workflow
   tools/provision-team.js
   ------------------------------------------------------------------
   Creates the Firebase Auth accounts AND the /team allow-list rows for
   everyone in tools/team.json, in one command. Safe to re-run: existing
   accounts get their password reset to the one in the file rather than
   erroring.

   Usage
   -----
     1. Firebase console -> Project settings -> Service accounts
        -> Generate new private key  -> save it as tools/service-account.json
     2. npm install
     3. node tools/provision-team.js
        node tools/provision-team.js --dry-run     (show what it would do)
        node tools/provision-team.js --list        (print the handout table)

   tools/service-account.json and tools/team.json are both gitignored.
   Delete them once everyone has signed in and changed their password.   */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEAM_FILE = path.join(__dirname, 'team.json');
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'service-account.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LIST_ONLY = argv.includes('--list');

function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }

/* ------------------------------------------------------------- inputs */
if (!fs.existsSync(TEAM_FILE)) die('Missing ' + path.relative(ROOT, TEAM_FILE));
let team;
try { team = JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8')); }
catch (e) { die('tools/team.json is not valid JSON: ' + e.message); }
if (!Array.isArray(team) || !team.length) die('tools/team.json should be a non-empty array.');

team = team.map(r => ({
  email: String(r.email || '').trim().toLowerCase(),
  name: String(r.name || '').trim(),
  password: String(r.password || '')
}));

const bad = team.filter(r => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
if (bad.length) die('Invalid email(s): ' + bad.map(b => b.email || '(blank)').join(', '));
const weak = team.filter(r => r.password.length < 6);
if (weak.length) die('Firebase requires at least 6 characters. Too short for: ' + weak.map(w => w.email).join(', '));
const dupes = team.map(r => r.email).filter((e, i, a) => a.indexOf(e) !== i);
if (dupes.length) die('Duplicate email(s) in team.json: ' + dupes.join(', '));

/* --------------------------------------------------------- handout table */
function printTable() {
  const w1 = Math.max(5, ...team.map(r => r.email.length));
  const w2 = Math.max(4, ...team.map(r => r.name.length));
  const line = '  ' + '-'.repeat(w1 + w2 + 14 + 6);
  console.log('\n  Send each person their own row. Ask them to change it after signing in.\n');
  console.log(line);
  console.log('  ' + 'EMAIL'.padEnd(w1) + '  ' + 'NAME'.padEnd(w2) + '  ' + 'TEMP PASSWORD');
  console.log(line);
  team.forEach(r => console.log('  ' + r.email.padEnd(w1) + '  ' + r.name.padEnd(w2) + '  ' + r.password));
  console.log(line + '\n');
}
if (LIST_ONLY) { printTable(); process.exit(0); }

/* ------------------------------------------------------------ firebase */
if (!DRY && !fs.existsSync(KEY_FILE)) {
  die('No service account key found at ' + path.relative(ROOT, KEY_FILE) + '\n' +
      '  Firebase console -> Project settings -> Service accounts -> Generate new private key,\n' +
      '  save it as tools/service-account.json, then run this again.\n' +
      '  (Or run with --dry-run to see what it would do.)');
}

let admin = null, auth = null, db = null;
if (!DRY) {
  try { admin = require('firebase-admin'); }
  catch (e) { die('firebase-admin is not installed. Run:  npm install'); }
  const sa = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  auth = admin.auth();
  db = admin.firestore();
  console.log('\n  Project: ' + sa.project_id);
}

/* ---------------------------------------------------------------- run */
(async function main() {
  console.log('\n  ' + team.length + ' account' + (team.length === 1 ? '' : 's') + ' to provision' + (DRY ? '  (DRY RUN - nothing will change)' : '') + '\n');

  const results = [];
  for (const person of team) {
    const label = person.email.padEnd(26);
    if (DRY) { console.log('  would create/update  ' + label); results.push({ ...person, action: 'dry-run' }); continue; }

    let action = 'created';
    try {
      let user;
      try {
        user = await auth.getUserByEmail(person.email);
        await auth.updateUser(user.uid, {
          password: person.password,
          displayName: person.name || user.displayName || undefined,
          emailVerified: true,
          disabled: false
        });
        action = 'password reset';
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
        user = await auth.createUser({
          email: person.email,
          password: person.password,
          displayName: person.name || undefined,
          emailVerified: true
        });
      }

      /* the allow-list row is what firestore.rules actually checks */
      await db.collection('team').doc(person.email).set({
        email: person.email,
        name: person.name || '',
        uid: user.uid,
        createdAt: new Date().toISOString()
      }, { merge: true });

      console.log('  ' + (action === 'created' ? 'created         ' : 'password reset  ') + label + '  uid=' + user.uid);
      results.push({ ...person, action, uid: user.uid });
    } catch (e) {
      console.log('  FAILED          ' + label + '  ' + (e.message || e));
      results.push({ ...person, action: 'failed', error: e.message || String(e) });
    }
  }

  /* make sure the assignable-people list in the app knows these names */
  if (!DRY) {
    try {
      const ref = db.collection('org').doc('settings');
      const snap = await ref.get();
      const cur = snap.exists ? (snap.data().owners || []) : [];
      const names = team.map(r => r.name).filter(n => n && n.toLowerCase() !== 'main account');
      const owners = Array.from(new Set(cur.concat(names)));
      await ref.set({ owners }, { merge: true });
      console.log('\n  Assignable people in the app: ' + owners.join(', '));
    } catch (e) {
      console.log('\n  (could not update the assignable-people list: ' + e.message + ')');
    }
  }

  const failed = results.filter(r => r.action === 'failed');
  console.log('\n  ' + (results.length - failed.length) + ' of ' + results.length + ' done' + (failed.length ? ', ' + failed.length + ' FAILED' : ''));
  if (!DRY && !failed.length) printTable();
  if (!DRY) {
    console.log('  Everyone can now sign in directly at your app URL - they do NOT need');
    console.log('  "First time here?", their account already exists.\n');
    console.log('  Anyone can change their own password later via "Forgot password".\n');
  }
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('\n  Unexpected failure: ' + (e.stack || e) + '\n'); process.exit(1); });
