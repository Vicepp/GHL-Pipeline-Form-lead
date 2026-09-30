/* Pheenyx Capital - Pipeline Workflow : configuration
   ---------------------------------------------------
   PASTE YOUR FIREBASE WEB CONFIG BELOW.

   Firebase console -> Project settings -> General -> "Your apps"
   -> Web app -> SDK setup and configuration -> Config.

   These values are meant to be public (they identify the project, they do
   not grant access). Access is controlled by Firestore rules + Auth, which
   live in firestore.rules.

   While apiKey is empty the app runs in LOCAL DEMO MODE: data is saved in
   this browser only, no login required. Fill it in and the app switches to
   the live shared database automatically.                                */

window.PHX_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyAmkk9pZZ6fKs3EM6BnfPNa0bfYNV2Xq1k',
    authDomain: 'ghl-phc-pipeline.firebaseapp.com',
    projectId: 'ghl-phc-pipeline',
    storageBucket: 'ghl-phc-pipeline.firebasestorage.app',
    messagingSenderId: '631070090454',
    appId: '1:631070090454:web:6f6a3b3b29bae6c1f49577',
    measurementId: 'G-526ZZTB36Y'   /* Analytics - not used by this app */
  },

  /* Shown in the browser tab and the sidebar until Settings overrides it */
  brand: { name: 'Pheenyx Capital', tagline: 'Pipeline Workflow' },

  /* Bootstrap admin(s). These emails can set their own password on the
     sign-in page ("First time here?") before anyone has been added to the
     team list - otherwise the very first login would be impossible.
     MUST match ownerEmails() in firestore.rules, or they will be able to
     create an account but see no data. */
  owners: ['info@phcinvest.com'],

  /* Firebase JS SDK versions to try, in order. Leave as-is unless a
     version is unavailable in your region. */
  sdkVersions: ['11.0.2', '10.14.1', '10.12.2']
};
