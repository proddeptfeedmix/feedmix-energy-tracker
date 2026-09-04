# Feedmix Energy Tracker

A free, mobile-friendly web app for tracking significant electrical loads and
energy consumption across your plants, built to support DOE Philippines
electrical load reporting requirements.

Runs as a static site on **GitHub Pages** — no server to maintain — backed
by a free **Supabase** project as the shared database. There is **no
token to type in anywhere**: the site talks to Supabase using its public
"anon" key (safe to expose — that's how Supabase is designed to work),
and everything sensitive — password checks, password hashing — happens
inside the database itself, never in the browser.

## What it does
- Any number of plants, each with up to 10 machines (name, category,
  rated kW). Admins can **add and delete plants and machines** at any
  time from the Admin screen.
- Two ways to log operating hours: real-time Start/Stop event logging, or
  manual shift-based total-hours entry.
- Manual entry of actual measured power (kW) per machine per day.
- Energy (kWh) = operating hours × power (uses the actual reading for that
  day if one was entered, otherwise falls back to rated kW).
- **Real-time dashboard** — showing which machines are currently running,
  each plant's energy total for today, and a Today / This Week / This
  Month running-hours rollup per machine. Updates instantly when anyone,
  on any device, logs data (with a slower background refresh as a
  fallback), not just on a timer.
- **Logs** — full, filterable history (by plant, machine, and date range)
  of every Start/Stop event, shift-hours entry, and power reading. Admins
  can edit or delete any row; technicians can fix their own entries (e.g.
  a missed Stop tap). Every edit is stamped "Edited by <user>" so nothing
  is silently rewritten.
- On-demand PDF report (per plant, per machine, total hours & kWh) for any
  date range.
- Login with two roles: **admin** (sees everything, manages plants,
  machines, and users) and **technician** (can only enter data for their
  assigned plant). Admins can add, disable/enable, and delete users.

## 1. Create your Supabase project (one-time)

1. Go to [supabase.com](https://supabase.com), sign up free, and create a
   new project (pick any name/region/password — you won't need that
   database password for anything below).
2. Once it's ready, open **SQL Editor → New query**, paste in the entire
   contents of `supabase/schema.sql` from this repo, and click **Run**.
   This creates all the tables, security rules, and the 4 sample plants
   with default logins.
3. Open **Project Settings → API**. You'll need two values from this page
   in the next step:
   - **Project URL**
   - **anon public** key (NOT the `service_role` key — never put that one
     in client-side code)

## 2. Deploy the site (one-time)

1. Create a **public** GitHub repository (e.g. `feedmix-energy-tracker`)
   and push all files in this folder to it (root of the `main` branch).
2. Edit `js/config.js` and set `supabaseUrl` / `supabaseAnonKey` to the
   two values from step 1.3 above, then commit that change. There's no
   in-app setup screen — the app reads this file directly.
3. In the repo: **Settings → Pages → Source → Deploy from branch → main /
   (root)**. GitHub will give you a URL like
   `https://<your-username>.github.io/feedmix-energy-tracker/`.

That's it — no personal access tokens, no per-device setup, for anyone.

## 3. First login

Open the Pages URL on any device (desktop or phone) and sign in with a
seeded account:
   - `admin` / `admin123` — full access, all plants
   - `tech1` / `tech123` … `tech4` / `tech123` — one per plant

**Change these default passwords immediately** via Admin → Users: add
each person their own account, then delete the default `tech1`–`tech4`
accounts, and change the `admin` password by deleting it and creating a
replacement admin account first (so you're never locked out).

### Already deployed before Logs/rollups were added?

Open **SQL Editor → New query** in your Supabase project and run just
this snippet once (it's also included, idempotently, if you re-run the
full `supabase/schema.sql`):

```sql
alter table events add column if not exists edited_at timestamptz;
alter table events add column if not exists edited_by text;
alter table shifts add column if not exists edited_at timestamptz;
alter table shifts add column if not exists edited_by text;
alter table readings add column if not exists edited_at timestamptz;
alter table readings add column if not exists edited_by text;
```

Then pull the latest `index.html`, `style.css`, `js/app.js`, and
`js/data.js` into your GitHub Pages repo — no other setup changes needed.

## 4. Day-to-day use

- **Dashboard** — see which machines are running right now, today's kWh
  per plant, and a Today / This Week / This Month running-hours rollup
  for each machine, updating live as data comes in.
- **Data Entry** (technicians see only their plant; admin can pick any):
  - Tap **Start**/**Stop** on a machine for real-time run logging, or
  - Enter a **shift's total hours** directly if you didn't log start/stop.
  - Enter an **actual power reading (kW)** whenever you measure one; if
    none is entered for a day, the app uses the machine's rated kW.
- **Logs** — browse the full history of run events, shift hours, and
  power readings for a plant/machine/date range. Fix a mistake with
  **Edit** (admins can edit any row; technicians only their own), or
  **Delete** it outright — both require the standard confirm dialog for
  deletes, and edits are stamped with who made the change.
- **Reports** — pick a plant (or All Plants) and a date range, then
  **Generate PDF Report** to download a report with per-machine and
  per-plant totals for that period.
- **Admin**:
  - **Plants** — add a new plant any time, or delete one (this also
    deletes its machines and all of its logged history — you'll be asked
    to confirm).
  - **Machines** — add a machine to any plant (max 10 per plant), or
    delete one (also deletes its logged history — confirmed before it
    happens).
  - **Users** — add a user, disable/enable a login without deleting it,
    or delete it outright. You can't disable or delete the account you're
    currently signed in as, to avoid locking yourself out.

## Notes & limitations (kept intentionally simple)

- This is a lightweight internal tool, not a hardened enterprise system.
  The operational tables (plants, machines, events, shifts, readings) are
  writable by anyone with the site link, same trust model as sharing a
  login — that's appropriate for a small trusted internal team, not a
  public-facing product.
- Password hashes are never exposed to the browser: logins and new-user
  creation go through database functions (`login`, `admin_add_user` in
  `supabase/schema.sql`) that hash/check passwords server-side.
- Data lives in your Supabase project's Postgres database. Supabase's
  free tier is generous for a tool this size; there's no separate hosting
  cost beyond that.
- The dashboard uses Supabase Realtime to update instantly when data
  changes, with a 45-second background refresh as a fallback if the
  realtime connection ever drops.
- Everything client-facing (HTML/CSS/JS) is still deployed purely through
  GitHub Pages — no backend server to run or maintain yourself.
