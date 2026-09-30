# Going live — Firebase + Vercel

The app is already written for this. Nothing is missing except **six values from your Firebase project**, pasted into one file.

Until they're filled in, the app runs in local demo mode (data in your browser, no login). The moment they're there, it switches to the live shared database with per-person logins — no code change.

---

## What I need from you

**Just this one block.** Everything else below I can do, or walk you through in a few minutes.

```js
apiKey:            "AIza..."
authDomain:        "pheenyx-pipeline.firebaseapp.com"
projectId:         "pheenyx-pipeline"
storageBucket:     "pheenyx-pipeline.firebasestorage.app"
messagingSenderId: "123456789012"
appId:             "1:123456789012:web:abc123..."
```

Plus:

| | |
|---|---|
| **Team emails** | who should be able to sign in (name + email each). Mine to seed: `info@phcinvest.com` |
| **Domain** | the Vercel URL is fine to start (`pheenyx-pipeline.vercel.app`). If you want `forms.phcinvest.com`, tell me the domain and where its DNS lives. |

These six values are **safe to share and safe to commit** — they identify the project, they don't grant access. Access is controlled by `firestore.rules` (in this folder) plus login. That's how every Firebase web app works.

---

## Step 1 — Create the Firebase project (5 min)

1. <https://console.firebase.google.com> → **Create a project**
   - Name: `pheenyx-pipeline`
   - Google Analytics: **off** (not needed)
2. In the project, click the **`</>` (Web)** icon to add a web app
   - Nickname: `pipeline-web`
   - **Don't** tick Firebase Hosting (we're using Vercel)
3. You'll land on *"Add Firebase SDK"* — the `firebaseConfig = { ... }` block on that screen is exactly the six values above. **Copy it and send it to me**, or paste it straight into `assets/js/config.js` yourself.

> Already have it later? Console → ⚙ **Project settings** → **General** → *Your apps* → **Config**.

## Step 2 — Turn on the two services

**Authentication** → *Get started* → **Email/Password** → toggle **Enable** → Save.
(Leave "Email link / passwordless" off.)

**Firestore Database** → *Create database*
- Mode: **Production mode**
- Location: pick one near you and leave it — it can't be changed later. `nam5 (us-central)` is a fine default.

## Step 3 — Paste in the security rules

Firestore → **Rules** tab → select everything → paste the contents of **`firestore.rules`** from this folder → **Publish**.

This is the part that matters, so here's what it does:

- **A lead with your form link** (not signed in) can *read* the form and *create* a submission. They cannot read your contacts, see anyone else's submission, or edit anything. Their submission is also checked on the server: the form must exist and be live, and the card must land in the stage that form actually points at — so nobody can forge a lead into a different pipeline.
- **A signed-in team member** whose email is in the `team` list gets full access.
- **Everything else is denied.**

⚠️ Line 30 of that file has `['info@phcinvest.com']` as the bootstrap admin — the account that works before anyone has been added to the team. Change it if a different account owns the project.

## Step 4 — Paste your config

Open `assets/js/config.js`, fill in the six values, save, reload the page. The sidebar badge flips from **"Local demo data"** to **"Live database"**.

## Step 5 — Create the nine team accounts (one command)

The accounts and the allow-list are already written up in `tools/team.json` — the nine `@phcinvest.com` addresses with a generated temporary password each (see [TEAM-PASSWORDS.md](TEAM-PASSWORDS.md)).

1. Firebase console → ⚙ **Project settings → Service accounts → Generate new private key**. Save the downloaded file as **`tools/service-account.json`**.
   ⚠️ This one is a real secret — it grants full database access. It's gitignored; don't email it or commit it.
2. Then:

```
npm install
node tools/provision-team.js
```

It creates each Firebase Auth account, writes the `/team` allow-list rows the rules check, adds everyone to the app's assignable-people list, and prints the handout table. Safe to re-run — existing accounts get their password reset to the file's value instead of erroring. Check first with `node tools/provision-team.js --dry-run`.

3. Send each person **only their own row** from the table. They sign in directly — they do *not* need "First time here?". Ask them to change their password via **Forgot password** on the sign-in page.
4. You'll land on an empty dashboard — a fresh database has no pipelines. **Settings → Load demo pipelines** puts the three pipelines and two forms in so you can see it working, then rename or delete freely. (Or build your own: Pipelines → + New pipeline.)

**Later changes:** add or remove people under **Settings → Team**. Someone added there sets their own password via **First time here?**. Removing someone cuts off their data access immediately, even if their password still works. No reset or import can wipe the team list — that's enforced in `store.js`, so you can't accidentally lock everyone out.

Anyone who signs up without being on the team sees a "Not on the team yet" screen and no data.

## Step 6 — Deploy to Vercel

Easiest, no git needed:

```
npm i -g vercel
cd "GHL Pipeline webpage"
vercel
```

Answer the prompts (link to your account, accept the defaults — it's a static site, no build step). Then:

```
vercel --prod
```

You get `https://<project>.vercel.app`. **One more thing:** Firebase console → Authentication → **Settings** → *Authorized domains* → **Add domain** → your Vercel domain. Logins will fail until you do.

Prefer clicking? <https://vercel.com/new> → drag this folder in. Or connect a GitHub repo and every push deploys.

### Custom domain

Vercel project → **Settings → Domains** → add `forms.phcinvest.com` → Vercel shows you one CNAME record to add at your registrar. Add that domain to Firebase's authorized domains too.

---

## After that, your form links look like

```
https://forms.phcinvest.com/#/f/fm_investor
```

Anyone, anywhere, on any device. They submit → within a second the card appears on the right pipeline stage and the follow-up task appears on every signed-in team member's dashboard. Share the link by email, put it behind a button, or use the **Share → Copy embed code** iframe inside a GHL funnel page.

---

## Cost

Free tier (Firebase "Spark") covers this comfortably: 50k document reads and 20k writes per day, 1 GiB stored. One form submission is 4 writes. Vercel's free Hobby tier covers the hosting. You'd need thousands of leads a day before anything costs money, and Firebase won't silently bill you — the free plan simply stops rather than charging.

## If something doesn't work

| Symptom | Cause |
|---|---|
| Sidebar still says "Local demo data" | `apiKey` or `projectId` empty in `config.js` |
| *"Email/password sign-in is not enabled"* | Step 2, Authentication |
| Sign-in fails only on the live URL | Vercel domain not in Firebase → Auth → Settings → Authorized domains |
| Signed in but "Not on the team yet" | Your email isn't in `team` and isn't line 30 of `firestore.rules` |
| Dashboard empty on a new project | Normal — Settings → Load demo pipelines, or create your own |
| Form says "could not send" | Rules not published (Step 3), or the form is paused |

---

## Optional: also push each lead into GoHighLevel

Not built yet, and deliberately not in the browser — a GHL token in client-side JavaScript can be read by anyone who opens the page. It belongs in a small serverless function (`/api/ghl.js`, which Vercel hosts for free alongside this).

When you want it, I need:

- GHL **Location ID**
- a **Private Integration Token** (GHL → Settings → Private Integrations — scopes: `contacts.write`, `opportunities.write`)
- for each form here, the **GHL pipeline id + stage id** it should also create the opportunity in
- whether a lead already in GHL should be updated or duplicated

Then a submission writes to Firestore *and* creates the contact + opportunity in GHL, and the GHL id gets stored on the contact so the two stay linked.
