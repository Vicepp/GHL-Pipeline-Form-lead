/* Pheenyx Capital - Pipeline Workflow
   boot.js : the only ES module. Loads the Firebase SDK, wires auth,
             initialises the store, then starts the UI.

   Runs after the classic scripts (module scripts are deferred), so
   window.Store and window.App already exist by the time this executes. */

const CFG = window.PHX_CONFIG || {};
const fbCfg = CFG.firebase || {};
const HAS_FIREBASE = !!(fbCfg.apiKey && fbCfg.projectId);

/** a hung network request must never leave the page on the loading splash */
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error('Timed out loading ' + label)), ms))]);
}

/** try each SDK version until one imports cleanly */
async function loadSdk() {
  const versions = CFG.sdkVersions && CFG.sdkVersions.length ? CFG.sdkVersions : ['11.0.2'];
  let lastErr = null;
  for (const v of versions) {
    const base = 'https://www.gstatic.com/firebasejs/' + v + '/';
    try {
      const [appMod, authMod, fsMod] = await withTimeout(Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore.js')
      ]), 9000, 'Firebase SDK ' + v);
      return { v, appMod, authMod, fsMod };
    } catch (e) { lastErr = e; console.warn('Firebase SDK ' + v + ' failed to load', e); }
  }
  throw lastErr || new Error('No Firebase SDK version could be loaded');
}

/** last-resort fallback: show *something* rather than a spinner forever */
function offlineAuthStub() {
  return {
    enabled: false, user: () => null,
    signIn: async () => { throw new Error('Cannot reach Firebase right now.'); },
    signUp: async () => { throw new Error('Cannot reach Firebase right now.'); },
    reset: async () => { throw new Error('Cannot reach Firebase right now.'); },
    signOut: async () => {}
  };
}
async function bailToLocal(msg) {
  if (window.App && window.App.started) return;
  await window.Store.initLocal();
  window.Auth = offlineAuthStub();
  window.App.start();
  if (msg) window.App.toast(msg, 'bad');
}

function authMessage(code) {
  const map = {
    'auth/invalid-email': 'That email address is not valid.',
    'auth/missing-password': 'Enter your password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Use "First time here?" to set your password.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
    'auth/email-already-in-use': 'That account already exists - just sign in.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase yet.',
    'auth/network-request-failed': 'Network problem reaching Firebase.'
  };
  return map[code] || ('Sign-in failed (' + code + ')');
}

(async function boot() {
  if (!HAS_FIREBASE) {
    /* ---------------- local demo mode ---------------- */
    await window.Store.initLocal();
    window.Auth = {
      enabled: false, user: () => null,
      signIn: async () => {}, signUp: async () => {}, reset: async () => {}, signOut: async () => {}
    };
    window.App.start();
    return;
  }

  /* whatever else happens, the page is showing something within 30s */
  setTimeout(() => bailToLocal('Firebase did not respond - showing local data. Reload to retry.'), 30000);

  /* ------------------- firebase mode ------------------- */
  let sdk;
  try { sdk = await loadSdk(); }
  catch (e) {
    await bailToLocal('Could not reach Firebase - running on local data for now.');
    return;
  }

  const { initializeApp } = sdk.appMod;
  const {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword,
    createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
    setPersistence, browserLocalPersistence
  } = sdk.authMod;
  const {
    getFirestore, doc, setDoc, updateDoc, deleteDoc, writeBatch,
    collection, onSnapshot, getDoc
  } = sdk.fsMod;

  const app = initializeApp(fbCfg);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  try { await setPersistence(auth, browserLocalPersistence); } catch (e) { /* private mode */ }

  window.Auth = {
    enabled: true,
    _user: null,
    user() { return this._user; },
    async signIn(email, pw) {
      try { await signInWithEmailAndPassword(auth, email.trim(), pw); }
      catch (e) { throw new Error(authMessage(e.code)); }
    },
    async signUp(email, pw) {
      /* Allowed for an email already on the team list, or for a bootstrap
         owner from config.owners - without that exception the very first
         account could never be created and the project would be locked. */
      const key = email.trim().toLowerCase();
      const isOwner = (CFG.owners || []).map(s => String(s).toLowerCase()).indexOf(key) >= 0;
      let invited = isOwner;
      if (!invited) {
        try { invited = (await getDoc(doc(fs, 'team', key))).exists(); } catch (e) { invited = false; }
      }
      if (!invited) throw new Error('That email has not been added to the team yet. Ask an admin to add it in Settings.');
      try { await createUserWithEmailAndPassword(auth, key, pw); }
      catch (e) { throw new Error(authMessage(e.code)); }
    },
    async reset(email) {
      try { await sendPasswordResetEmail(auth, email.trim()); }
      catch (e) { throw new Error(authMessage(e.code)); }
    },
    async signOut() { await signOut(auth); },
    /* a short-lived ID token, so a server endpoint can prove who is asking
       without us ever shipping a long-lived secret to the browser */
    async token() {
      const u = auth.currentUser;
      return u ? await u.getIdToken() : null;
    }
  };

  await window.Store.initFirebase({
    fs, doc, setDoc, updateDoc, deleteDoc, writeBatch, collection, onSnapshot
  });

  let started = false;
  const first = () => { if (!started) { started = true; window.App.start(); } };
  onAuthStateChanged(auth, (user) => {
    window.Auth._user = user ? { uid: user.uid, email: user.email } : null;
    window.Store.setAuthed(!!user);
    if (!started) first(); else window.App.render();
  });
  /* if Auth is slow to report, show the sign-in screen anyway */
  setTimeout(first, 8000);
})();
