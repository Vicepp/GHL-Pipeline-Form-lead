# Option B — do this in order

GHL form → webhook → these pipelines. The lead ends up in **both** GoHighLevel and here.

Everything is already built. This is the setup, start to finish. There are **4 checkpoints** — stop at any of them and tell me what you see; you don't have to finish in one sitting.

Already on your machine: Node 24, npm, git, Python. Nothing else to install except the Vercel CLI in step 7.

---

## Two things to get straight first

**Send me freely** (these identify the project, they don't grant access):
- the 6 Firebase web config values
- your Vercel URL once it exists
- the GHL payload screenshot
- any error message or JSON response you get

**Never send me, or anyone** (these are real keys):
- `tools/service-account.json` — grants full database access
- your `INBOUND_SECRET`
- the team's passwords

You paste those into your own machine and Vercel. I never need to see them. **I have no internet access from this session**, so *you* run the live tests — paste me the output and I'll read it and fix whatever's off.

---

# Part 1 — Firebase (the database)

### Step 1. Create the project
<https://console.firebase.google.com> → **Create a project**
- Name: `pheenyx-pipeline`
- Google Analytics: **off**

### Step 2. Add a web app and copy the config
Click the **`</>`** (Web) icon → nickname `pipeline-web` → **do not** tick Firebase Hosting (we use Vercel).

The next screen shows `const firebaseConfig = { ... }` with 6 values.

**→ Send me that block**, or paste the values straight into `assets/js/config.js` yourself.

> Need it again later: ⚙ **Project settings → General → Your apps → Config**

### Step 3. Turn on email logins
**Authentication → Get started → Email/Password → Enable → Save**
(leave "Email link / passwordless" off)

### Step 4. Create the database
**Firestore Database → Create database**
- **Production mode**
- Location: `nam5 (us-central)` is fine — **this cannot be changed later**

### Step 5. Publish the security rules
**Firestore → Rules** tab → select everything in the box → paste the entire contents of **`firestore.rules`** from this folder → **Publish**.

This is the step that keeps your investor data private. Skip it and either nothing works, or everything is public.

### Step 6. Create the team's nine accounts

**6a.** ⚙ **Project settings → Service accounts → Generate new private key** → it downloads a `.json` file → move it into this folder as:

```
tools/service-account.json
```

⚠️ Real secret. It's gitignored. Don't email it, don't commit it.

**6b.** In a terminal, in this folder:

```
npm install
node tools/provision-team.js
```

That creates all nine `@phcinvest.com` accounts, writes the allow-list the rules check, adds everyone to the assignable-people list, and prints the handout table.

Want to see what it will do first: `node tools/provision-team.js --dry-run`

**6c.** Send each person **only their own row** from [TEAM-PASSWORDS.md](TEAM-PASSWORDS.md). Tell them to change it via **Forgot password** on the sign-in page.

> ## ✅ Checkpoint 1 — the app works for real
> With `config.js` filled in, reload <http://localhost:8080/>
> - sidebar badge says **"Live database"**, not "Local demo data"
> - you get a **Sign in** screen → sign in as `info@phcinvest.com`
> - dashboard is empty (normal, new database) → **Settings → Load demo pipelines**
> - **Dashboard → Open a form as a lead** → fill it → the person appears on the board and in Pending tasks
> - open the same URL in a private window, sign in as someone else → same data
>
> **Tell me if anything here misbehaves.** Everything after this point is about making it reachable from outside your machine.

---

# Part 2 — Vercel (the public URL)

### Step 7. Deploy

```
npm i -g vercel
vercel login
vercel
```

Accept the defaults (it's a static site, no build step). Then:

```
vercel --prod
```

You get a URL like `https://pheenyx-pipeline.vercel.app`. **→ Send it to me.**

> Prefer clicking? <https://vercel.com/new> → drag this whole folder in.

### Step 8. Let Firebase trust that URL
**Firebase → Authentication → Settings → Authorized domains → Add domain** → your `.vercel.app` domain.

**Logins will fail on the live site until you do this.** It's the single most common thing people miss.

### Step 9. Invent your inbound secret
Any long random string — a password generator is fine, 30+ characters. Write it down somewhere you'll find it. This is what stops strangers posting fake leads at your endpoint.

### Step 10. Add the four environment variables
Vercel → your project → **Settings → Environment Variables**. Open `tools/service-account.json` and copy from it:

| Name | Value |
|---|---|
| `INBOUND_SECRET` | the random string from step 9 |
| `FIREBASE_PROJECT_ID` | `project_id` from the json |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the json |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the json — the whole thing, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` |

Then **redeploy** (`vercel --prod` again) — env vars only take effect on a new deployment.

> ## ✅ Checkpoint 2 — the public form works for anyone
> - open your Vercel URL on your **phone** → sign in
> - **Forms → Share → Copy** the form link → open that link on your phone in a private tab (no login needed)
> - submit it → the lead appears on your laptop's board within a second
>
> If that works, the hard part is done.

---

# Part 3 — GoHighLevel

> **No GHL pipelines or stages are involved anywhere in this.** The only thing needed
> on the GHL side is a workflow with a **Form Submitted** trigger and a **Webhook** action.
> Nothing here reads GHL opportunities, creates them, or moves anything between GHL stages.
> The pipelines and stages live only on this website.
>
> **Webhook, not API — and that's the right choice.** A webhook is GHL *pushing* each
> submission the moment it happens: instant, no GHL API token needed, and GHL retries
> automatically if we're briefly down. Polling the GHL API instead would mean a token to
> manage, leads arriving minutes late, and rate limits. Nothing to gain.

### Step 11. Check the endpoint before touching GHL
Open this in a browser, with your real secret pasted in:

```
https://YOUR-APP.vercel.app/api/ghl-inbound?form=fm_investor&key=YOUR_SECRET
```

A plain visit (GET) creates nothing — it reports back what it *would* do:

```json
{ "ok": true,
  "form": "Investor Interest Form",
  "willCreateIn": { "pipeline": "Investor Relations", "stage": "New Lead" },
  "questionsOnThisForm": ["Full name", "Email", "Phone", "..."] }
```

**→ Paste me whatever comes back**, good or bad. If it's an error, the message says exactly which of steps 5/6/10 is wrong.

### Step 12. Fake a lead (still no GHL)
PowerShell, in this folder:

```powershell
$body = @{
  contact_id = "test001"
  first_name = "Test"
  last_name  = "Lead"
  email      = "test.lead@example.com"
  phone      = "+13125550199"
  customData = @{ "Capital you are looking to deploy" = "250000" }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Uri "https://YOUR-APP.vercel.app/api/ghl-inbound?form=fm_investor&key=YOUR_SECRET" `
  -Body $body
```

Then check the dashboard — "Test Lead" in **New Lead**, with a follow-up task. Run it twice inside 5 minutes and the second should answer `"duplicate": true`.

### Step 13. Make a receiver for each GHL form

For every GHL form you want feeding this, you create one **receiver** record here. Nobody fills a receiver in — it's just the rule that says *"leads from this GHL form go to this pipeline and stage, and here's how to read their fields."*

**Forms → + New form**, then:

1. **Where is this form filled in? → In GoHighLevel (GHL posts the data here)**
   The public-headline fields disappear; it's not a page anyone visits.
2. **Pipeline** and **Lands in stage** — where the GHL leads should appear here.
3. **Fields to capture** — give each field **the same label as the field in your GHL form**. Name, email and phone are recognised automatically (`first_name`, `full_name`, `email`, `phone` and the usual variants), so you normally only need to add your custom questions.
4. **Save**, then **Webhook** on the Forms list gives you the URL for step 14.

There's already one seeded to copy: **GHL - Lead Intake** → Investor Relations → New Lead.

Tell me each GHL form's name and where it should land, and I'll set the receivers up for you instead.

### Step 14. Wire the GHL workflow
GHL → **Automation → Workflows → Create Workflow**
1. Trigger: **Form Submitted** → pick your form
2. **+ Add Action → Webhook**
   - Method: **POST**
   - URL: from **Forms → Share → Inbound webhook URL** here, with `YOUR_INBOUND_SECRET` swapped for your real secret
3. Click **Test Webhook**

### Step 15. The one thing I really need
When you click **Test Webhook**, GHL shows you the payload it sends.

**→ Screenshot that, or copy the JSON, and send it to me.**

This is the most valuable thing in this whole document. GHL names fields differently depending on how the form was built, and that payload tells me the exact names. With it I map every field precisely instead of guessing. Without it, expect a few fields to arrive empty on the first real lead.

### Step 16. Go live
Publish the workflow → submit your GHL form for real → watch the card appear here.

> ## ✅ Checkpoint 3 — a real GHL lead lands here
> The contact exists in **GHL** (so your SMS/email sequences fire) **and** on the board here with a follow-up task.
>
> If a field is empty: GHL → your workflow → the Webhook action → **Execution logs**. It shows the response our endpoint returned, including `mapped` and `couldNotFill`. **Paste me that** and I'll fix the mapping.

---

# Optional, later

### Custom domain
Vercel → **Settings → Domains** → add `forms.phcinvest.com` → Vercel gives you one CNAME record for your registrar. Then add that domain to Firebase → Auth → Authorized domains too.

**→ Tell me the subdomain you want and which registrar holds the DNS**, and I'll walk it through.

### Pushing changes back to GHL — *not doing this*
You've said you don't want GHL pipelines involved, so this is deliberately **not** built and not planned: nothing here will ever create a GHL opportunity or move a GHL stage. Noted here only so nobody adds it by accident later. Data flows one way — GHL form → this website.

---

# The short version — what lands in my inbox

| When | Send me |
|---|---|
| Step 2 | the 6 Firebase config values |
| Checkpoint 1 | "works" — or what broke |
| Step 7 | your Vercel URL |
| Step 11 | the JSON the endpoint returns |
| Step 13 | which GHL form → which pipeline + stage |
| **Step 15** | **the GHL Test Webhook payload** ← most important |
| Any failure | the exact error text or Execution log |

Never send: the service-account json, the inbound secret, the team's passwords.
