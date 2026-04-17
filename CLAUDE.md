# UHT — Undeniable Hit Theory

SMS music voting platform. Subscribers get a weekly song drop via SMS and vote HIT or DENIED. Votes feed a "Hit Theory" leaderboard. A WordPress site is the public-facing marketing/admin layer; this Node app is the backend + admin panel.

## Stack

- **Runtime:** Node.js, Express 5, CommonJS (`"type": "commonjs"`)
- **DB:** PostgreSQL via `pg`
- **SMS:** Twilio (inbound webhook + outbound drops)
- **Scheduling:** `node-cron` (Friday 10am drop)
- **Deploy:** Railway (backend), WordPress site handles the marketing frontend
- **Uploads:** `multer`
- **Entry point:** `server.js` at repo root (not `src/server.js` despite the header comment)

## Repo layout

```
server.js                 # main Express app — ALL routes live here (~89KB)
db.js                     # pg Pool using DATABASE_URL
scheduler.js              # weekly Friday SMS drop (cron + manual trigger)
curator-scheduler.js      # curator-specific drop logic
sms-formatter.js          # outbound SMS message templating
public/                   # static HTML (index.html, admin.html, uht-admin.html, uht-radio.html)
components/               # single React component (UHTYouTubeModal.jsx) — not yet wired in
patch-*.js                # one-off migration/patch scripts — run once, then ignore
*-migration.js            # DB migration scripts
import_subscribers.js     # CSV import utility (currently untracked)
```

## Environment

Required in `.env`:

```
DATABASE_URL=postgres://...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1...
```

Optional: `PORT` (default 3000), `ALLOWED_ORIGIN` (default `*`).

## Key routes (as of 2026-04-16)

**WordPress bridge** — called server-side by the `uht-platform.php` plugin:
- `GET  /api/genres` — genre chip selector
- `GET  /api/curators` — curator list
- `POST /api/subscribe` — new subscriber
- `GET  /api/check_subscriber` — lookup by phone
- `POST /api/send_code` / `POST /api/verify_code` — SMS verification

**Twilio webhook:**
- `POST /sms` — inbound HIT / DENIED votes

**Curator + genre submissions:**
- `GET/POST/PATCH/DELETE /api/curator-submissions[/:id]`
- `GET/POST/PATCH/DELETE /api/genre-submissions[/:id]`
- `GET /api/curator-submissions/by-curator/:curatorId`

**Follows:**
- `POST/DELETE /api/follows`
- `GET /api/follows/check`
- `GET /api/follows/curator/:id`

**Drops:**
- `POST /api/drop/send` — manual trigger of Friday drop
- `GET  /drop/:genre` — public drop page
- `GET  /drop/curator/:slug` — per-curator drop page

**Ops:**
- `GET /health` — returns `{status, version}`
- `GET /admin` — serves `public/admin.html`

> Heads up: `/api/follows` and `/api/genre-submissions` are currently registered more than once in `server.js`. When editing those, check for duplicates before adding handlers.

## Running locally

```bash
npm install
node server.js    # boots on PORT (default 3000)
```

No build step, no TypeScript, no test suite yet (`npm test` is a placeholder).

## Deploy

- `git push origin main` → Railway auto-deploys the backend.
- Frontend lives on WordPress; the PHP plugin `uht-platform.php` proxies to this Node backend.
- There's a separate family of plugins in `~/Downloads/uht-*` — those are historical WordPress plugin builds, not part of this repo.

## Working conventions

- **Brand voice:** "HIT" and "DENIED" in caps for the two vote outcomes. Silver Glider Line phone: +1 (844) 261-6758.
- **Style:** No exclamation points in user-facing copy. Professional, confident tone.
- **Changes:** Prefer small, reviewable edits. Inspect actual state before theorizing (grep for existing routes before adding one; check DB schema before assuming columns).
- **Commits:** No strict convention yet — clear imperative subject lines are fine.
- **Secrets:** Never commit `.env` or `.env.save`. Railway holds production secrets.

## Known tech debt (don't auto-fix, flag it)

- `server.js` is ~89KB and contains every route — due for a split into `routes/`.
- Duplicate route handlers for `/api/follows` and `/api/genre-submissions`.
- Several `patch-*.js` one-off scripts sitting at repo root.
- `components/UHTYouTubeModal.jsx` is a lone React file with no bundler — either wire it in or remove.
- No automated tests.

## When helping on this repo

1. Before adding a route, `grep -n "app\\.\\(get\\|post\\|put\\|patch\\|delete\\)" server.js` to see what's there.
2. Before assuming a DB column exists, check the migration files (`*-migration.js`) or ask.
3. When editing `server.js`, show the edit in context — the file is large enough that blind inserts are risky.
4. Deploy = `git push origin main`. Don't push for the user; surface the diff and let them push.
