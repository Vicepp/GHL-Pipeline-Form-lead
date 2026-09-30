# Pheenyx Capital — Pipeline Workflow

A form is wired to one pipeline + one stage. Somebody submits it → they appear on that board and on the dashboard as a pending task.

- **Data:** Cloud Firestore (shared, live) — or local browser storage until it's configured
- **Logins:** Firebase Auth, one account per team member; public forms need no login
- **Hosting:** Vercel (static, no build step)

**→ To go live, follow [SETUP.md](SETUP.md).** It lists the six Firebase values I need from you and the console clicks around them.
**→ To pull leads in from GoHighLevel, see [GHL-SETUP.md](GHL-SETUP.md)** — including exactly what to bring so we can test it in stages.
**→ Team logins:** nine `@phcinvest.com` accounts are pre-written in `tools/team.json`; `node tools/provision-team.js` creates them all. Passwords in [TEAM-PASSWORDS.md](TEAM-PASSWORDS.md).

## Run it locally

Double-click **`start.cmd`**, or:

```
python -m http.server 8080
```

then open <http://localhost:8080/>. With no Firebase config it runs in **local demo mode** — seeded pipelines, no login, data in your browser. Good for shaping the UI before anything is live.

## How a form is linked to a pipeline

All on the webpage. Nothing to edit in files.

1. **Forms → + New form** (also in the sidebar and on each pipeline card).
2. Panel **"1. Where do these leads go?"** *is* the link:
   - **Pipeline** — which board
   - **Lands in stage** — which column the card is created in
   - **Tags**, **Assign follow-up to**, **Follow-up task title** (`{{name}}` → the person's name), **Task due in days**
3. Panel **"3. Questions"** — add questions, and set what each one **maps to**:
   - *Contact name / email / phone* — so the card and task know who to call
   - *Opportunity value ($)* — totals per stage and on the dashboard
   - *Opportunity title* — what the card is called (e.g. a property address)
   - *Notes* / *Just store the answer* — kept on the contact record
4. **Save form** → **Share** gives the public link and an embed snippet.

One submission always creates three things:

| | |
|---|---|
| **Contact** | every answer stored, searchable under Contacts |
| **Pipeline card** | in the pipeline + stage that form points at |
| **Pending task** | on the dashboard, assigned and dated |

## What's in it

- **Dashboard** — pending outreach (overdue / due today), new leads, open value, the pending task queue with Done/Snooze, form→pipeline routing chart, activity feed, recent submissions with each person's pipeline and stage.
- **Pipelines** — create/rename/delete pipelines; add/rename/reorder/delete stages; drag cards between stages; add a lead manually. Deleting a stage moves its cards to the first stage rather than losing them; deleting a pipeline unroutes its forms instead of orphaning them.
- **Forms** — in-page builder, live/paused, preview as a lead, share link, embed code.
- **Contacts** — search, and a panel per person: answers, pipeline/stage, quick stage move, tasks.
- **Settings** — company name, assignable people, team access (add a member → they set their own password), export/import, seed/reset.

## Security model

`firestore.rules` is the whole of it:

- **Not signed in** (a lead with your form link): may read the form and *create* a submission. Cannot read contacts, list anything, or edit. The submission is validated server-side — the form must exist and be live, and the card must land in the stage that form actually points at, so a lead can't be forged into another pipeline.
- **Signed in and on the `team` list:** full access.
- **Everything else:** denied.

## Files

| File | What it is |
|---|---|
| `index.html` | shell — loads everything |
| `assets/js/config.js` | **your Firebase config goes here** |
| `assets/js/store.js` | data model + the two back ends (Firestore / localStorage) |
| `assets/js/app.js` | routing, views, interactions |
| `assets/js/boot.js` | loads the Firebase SDK, wires auth, starts the app |
| `assets/css/app.css` | all styling (design tokens at the top) |
| `firestore.rules` | security rules — paste into the Firebase console |
| `api/ghl-inbound.js` | serverless endpoint GoHighLevel posts leads to |
| `api/_normalize.js` | maps a GHL payload onto one of your forms |
| `test/normalize.test.js` | `npm test` — 46 cases over real GHL payload shapes |
| `tools/provision-team.js` | creates the team's Auth accounts + allow-list in one command |
| `tools/team.json` | the nine approved emails and their temp passwords (gitignored) |
| `vercel.json` | hosting config |
| `start.cmd` | local preview server |

Swapping backends is contained: `store.js` exposes one adapter (`put / patch / del / batch`) and the views never know which one is behind it. That's the seam a GoHighLevel push would hook into.
