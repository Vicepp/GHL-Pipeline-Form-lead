# Getting leads from GoHighLevel into these pipelines

## First — you may not need any of this

There are two ways to get a GHL lead onto a board here, and one is much less work.

| | **A. Use our form, inside GHL** | **B. Use GHL's form, post it here** |
|---|---|---|
| Setup | None. Already built. | A webhook + 4 env vars |
| How | Forms → Share → **Copy embed code** → paste the iframe into a GHL funnel or website page | GHL workflow → Webhook action → our endpoint |
| Lead lands in | Our pipelines | Our pipelines |
| GHL pipelines used? | No | **No** — GHL forms only, never GHL pipelines or stages |
| Lead also a GHL contact? | **No** | **Yes** — so GHL's own SMS/email automations still fire |
| Use when | this app is where the pipeline lives | you need GHL's own automations (SMS, email sequences, calendars) to fire off the same submission |

**Pick B if the lead must exist in GHL too** — for texts, nurture sequences, or because your team already works in GHL. Pick A if you just wanted a form and GHL was incidental. B is built and described below.

---

## How B works

```
Lead fills your GHL form
        │
        ▼
GHL Workflow  ──POST──▶  /api/ghl-inbound?form=fm_investor&key=SECRET
                                   │
                                   ▼
                          reads that form in Firestore
                          (its pipeline, stage, tags, assignee, task rule)
                                   │
                                   ▼
              Contact  +  card on that stage  +  follow-up task
```

**The routing stays on the website.** The webhook URL just names a **receiver** you created here — a form record with its *Source* set to *In GoHighLevel*. Nobody fills a receiver in; its *Pipeline* and *Lands in stage* dropdowns decide where the GHL lead goes, and its field labels say how to read the payload. Change the dropdown, the GHL leads follow — no redeploy, no code.

**No GHL pipeline is touched.** The only GHL-side setup is a workflow with a *Form Submitted* trigger and a *Webhook* action.

**Why a webhook rather than the GHL API:** a webhook is GHL pushing each submission the instant it happens — no API token to manage, no rate limits, and GHL retries by itself if we're briefly unreachable. Polling the API would mean a token, a schedule, and leads showing up minutes late. There is nothing to gain from it here.

**Field matching:** whatever GHL posts is flattened and matched against that form's question labels. A GHL field called *"Capital you are looking to deploy"* fills the question with that label. It also understands the usual aliases (`first_name`+`last_name`, `full_name`, `email_address`, `mobile_phone`, `customData`, `customFields[{name,value}]`, snake_case keys). Anything it can't place is still saved on the contact under `ghlExtras`, and the whole raw payload is kept on `raw`, so nothing is lost and we can tighten the mapping after seeing one real submission.

**Retries:** GHL re-fires webhooks on failure. The same person, on the same form, within 5 minutes, is treated as a retry and ignored — so you don't get triplicate cards.

---

## What to bring me so we can test

Work down this list. **You can stop at any stage and we'll test what's done** — each stage works on its own.

### Stage 1 — the database (nothing GHL yet)

- [ ] **Firebase web config** — the 6 values. Console → ⚙ Project settings → General → Your apps → Config.
- [ ] **Email/Password** enabled: Authentication → Get started → Email/Password → Enable
- [ ] **Firestore created** in Production mode
- [ ] **Rules published** — paste `firestore.rules` into Firestore → Rules → Publish
- [ ] **Team emails** — who gets a login

→ *We can then test:* sign in, build a form, submit it, watch the card and task appear. All of it, from your machine. **This needs no GHL and no Vercel.**

### Stage 2 — the public URL

- [ ] A **Vercel account** (free; sign in with GitHub or email)
- [ ] Whether you want the free `*.vercel.app` URL or a domain like `forms.phcinvest.com` — if a domain, tell me **which registrar holds the DNS**

→ *We can then test:* open a form link on your phone, submit, see it land on the board on your laptop.

### Stage 3 — the GHL connection

- [ ] **A Firebase service account** — Console → ⚙ Project settings → **Service accounts** → **Generate new private key**. It downloads a `.json` file. I need three values from inside it:
  - `project_id`
  - `client_email` (looks like `firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com`)
  - `private_key` (the long `-----BEGIN PRIVATE KEY-----...` block)

  ⚠️ **This one is a real secret** — unlike the web config, it grants full database access. Don't paste it in chat, email, or commit it. It goes into Vercel → Settings → Environment Variables and nowhere else. If you'd rather, paste it into Vercel yourself and just tell me it's done — I never need to see it.
- [ ] **An inbound secret** — invent any long random string (e.g. from a password generator). Goes in Vercel as `INBOUND_SECRET`, and into the webhook URL. This is what stops strangers posting fake leads at the endpoint.
- [ ] **Which GHL form feeds which pipeline** — for each GHL form: its name, and which pipeline + stage here it should land in.
- [ ] **A screenshot of one real GHL webhook payload** (or the GHL form's field names). GHL's *Test Webhook* button shows what it sends. This is the single most useful thing you can bring — it tells me the exact field names to map, instead of guessing.
- [ ] GHL access to create a workflow (Automation → Workflows). If you'd rather I not touch your GHL, send me the payload screenshot and I'll give you the exact URL to paste.

### The four Vercel environment variables, in one place

```
INBOUND_SECRET         = <the long random string you invent>
FIREBASE_PROJECT_ID    = <project_id from the service account json>
FIREBASE_CLIENT_EMAIL  = <client_email from the service account json>
FIREBASE_PRIVATE_KEY   = <private_key from the service account json>
```

Vercel → your project → **Settings → Environment Variables** → add each → then **redeploy** (env vars only take effect on a new deploy).

> For `FIREBASE_PRIVATE_KEY`, paste the whole value including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Vercel keeps the line breaks; the code also handles the `\n`-escaped form, so either way works.

---

## Testing it, in three steps

### Test 1 — is the endpoint wired? (browser only, no GHL)

Open this in a browser, with your real secret:

```
https://<your-app>.vercel.app/api/ghl-inbound?form=fm_investor&key=YOUR_SECRET
```

A `GET` doesn't create anything — it reports back what it *would* do:

```json
{
  "ok": true,
  "message": "Wiring is good. Point your GoHighLevel webhook here with POST.",
  "form": "Investor Interest Form",
  "willCreateIn": { "pipeline": "Investor Relations", "stage": "New Lead" },
  "assignsTo": "Chris",
  "taskDueInDays": 1,
  "questionsOnThisForm": ["Full name", "Email", "Phone", "..."]
}
```

If you see that, the secret, the env vars, Firestore and the form routing are all correct. Any error message tells you which one isn't.

### Test 2 — fake a lead (still no GHL)

In PowerShell:

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
  -Uri "https://<your-app>.vercel.app/api/ghl-inbound?form=fm_investor&key=YOUR_SECRET" `
  -Body $body
```

The response tells you what it mapped and what it couldn't:

```json
{ "ok": true, "lead": { "name": "Test Lead", "value": 250000 },
  "mapped": ["Full name","Email","Phone","Capital you are looking to deploy"],
  "couldNotFill": ["Are you an accredited investor?"] }
```

Then look at the dashboard — "Test Lead" should be in **New Lead** with a follow-up task. Run it twice within 5 minutes and the second one should come back `"duplicate": true`.

### Test 3 — the real thing

1. GHL → **Automation → Workflows → Create Workflow**
2. Trigger: **Form Submitted** → choose your form
3. **+ Add Action → Webhook**
   - Method: **POST**
   - URL: the one from **Forms → Share → Inbound webhook URL** (with your secret swapped in)
4. Click **Test Webhook** in GHL — *screenshot the payload it shows*, that's the mapping reference
5. Publish the workflow, submit your GHL form for real, and watch the card appear here

GHL keeps a log per workflow action: open the workflow → the Webhook action → **Execution logs** shows the response our endpoint returned, including `mapped` / `couldNotFill`. That's where to look first if a field is empty.

---

## If something doesn't work

| Response | Meaning |
|---|---|
| `401 Bad or missing key` | `key=` doesn't match `INBOUND_SECRET`, or you added the env var without redeploying |
| `400 Add ?form=<formId>` | the URL is missing the `form=` part |
| `404 No form "..."` | that form id doesn't exist — copy the URL from Forms → Share |
| `409 not connected to a pipeline` | that form's Pipeline/Stage dropdowns are empty — set them in the builder |
| `500 service account env vars are not set` | one of the three `FIREBASE_*` vars is missing or misspelled |
| `500 Could not save the lead` | usually a bad `FIREBASE_PRIVATE_KEY` (truncated, or quotes included) |
| Lead appears, fields empty | field names don't match the question labels — send me the payload from GHL's Execution log and I'll map them exactly |
| Nothing appears at all | check GHL's workflow Execution logs — if there's no entry, the workflow isn't published or the trigger didn't fire |

---

## The other direction — not doing this

Data flows **one way**: GHL form → this website. Nothing here creates a GHL opportunity, reads a
GHL pipeline, or moves anything between GHL stages — by decision, not by omission. The pipelines
and stages live only on this site. Recorded here so it doesn't get added by accident later.
