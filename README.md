# Platinum Intake Board

Partner application deadlines for Platinum Education consultants, with:

- a **Deadline alert** box for any deadline inside 30 days
- upcoming deadlines and a deadline calendar by intake
- an **Industry news** feed: every morning the server checks GOV.UK (DfE, Student Loans Company, HM Treasury) and legislation.gov.uk for new policies, laws and funding that affect students eligible for UK student finance. International/visa and school-only items are filtered out, and new items wait in the admin panel until you publish them
- a password-protected **Admin panel** to add and edit partners, deadlines, campuses and logos

No dependencies: plain Node.js (18+).

## Run locally

```bash
ADMIN_PASSWORD=choose-a-password npm start
# open http://localhost:3000
```

On first start the board is copied from `board.json` (23 partners, as exported on 29 Oct 2026) into `data/board.json`. All edits after that are saved in `data/`.

## Deploy on Railway

1. New project → Deploy from GitHub repo → pick this repo. Railway runs `npm start` automatically.
2. Add a **Volume** to the service, mounted at `/data`.
3. Set variables:
   - `ADMIN_PASSWORD` – the admin password (required to edit)
   - `DATA_DIR` = `/data`
   - `SESSION_SECRET` – any long random string (optional, recommended)
4. Settings → Networking → Generate domain.

Without a volume, edits are lost whenever the service redeploys.

## Other hosts

Any host that runs Node and keeps a writable disk works (Render with a disk, Fly.io with a volume, a VPS). Static-only hosts such as GitHub Pages or Netlify will not work, because the admin panel needs the server.

## Files

- `server.js` – web server and API (`/api/board`, `/api/login`, `/api/partners/:id`, `/api/meta`, `/api/assets`)
- `index.html` – the board and admin panel
- `news.js` – the daily news scanner and its filtering rules (set `NEWS_SCAN=off` to switch it off)
- `board.json` – starting partners and deadlines (only used on first start)
- `assets.json` – partner logos and the Platinum logo, stored as text
- `data/` – live data (created on first run, not committed)
