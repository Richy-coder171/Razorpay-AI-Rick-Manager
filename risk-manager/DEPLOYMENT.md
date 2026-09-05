# Deployment Guide — Hosted Demo

This guide stands up the **public demo link** for judging:

- **Backend** → [Render](https://render.com) (a long-running Express server with
  in-memory rate limiting is a poor fit for serverless; Render's free web
  service is the right shape)
- **Database** → [MongoDB Atlas](https://mongodb.com/atlas) free tier —
  REQUIRED for the hosted instance. A free host's container filesystem is not
  guaranteed to persist between requests; silently losing the hash-chained
  audit log mid-demo would undercut the exact feature this project showcases.
- **Frontend** → [Vercel](https://vercel.com) or Netlify (static Vite build)

Local `npm run dev` (or `docker compose up --build`) remains the fallback and
is always documented in the main README.

---

## 0. Prerequisites

- GitHub repo containing `risk-manager/` **as the repo root** (the configs
  below assume it; if `risk-manager/` is a subfolder, adjust the `cd` paths)
- Accounts: Render, Vercel (or Netlify), MongoDB Atlas — all have free tiers
- No real payment credentials anywhere; demo keys only (demo/test mode)

## 1. MongoDB Atlas (do this first)

1. Create a free **M0** cluster
2. Database Access → add a database user (username + password)
3. Network Access → allow `0.0.0.0/0` (Render's egress IPs are dynamic on the
   free tier)
4. Get the connection string:
   `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/risk-manager`
5. Keep it secret — it is set ONLY as a Render environment variable, never
   committed

## 2. Backend on Render

1. Render Dashboard → **New → Blueprint** → pick the repo (Render reads
   `render.yaml` automatically)
2. Set the secret env vars the blueprint marks `sync: false`:
   - `MONGODB_URI` — the Atlas URI from step 1
   - `CORS_ORIGINS` — your Vercel frontend URL(s) (set AFTER step 3, or edit
     and redeploy)
3. Deploy. Verify: `https://<backend>.onrender.com/api/health` returns
   `"status": "ok"` **and `"db_driver": "mongo"**.

   > Free-tier note: the first request after idle takes ~30–60s (cold start).
   > Open `/api/health` once before judging.

## 3. Frontend on Vercel

1. Vercel → **Add New Project** → import the repo
2. **Root Directory: the repo root** (NOT `frontend/`) — the build needs the
   sibling `shared/` package (`file:../shared` dependency). The frontend
   `prebuild` script builds `shared/` automatically when its `dist/` is absent.
3. Build Command: `cd frontend && npm install && npm run build`
   Output Directory: `frontend/dist`
4. Environment variable: `VITE_API_BASE_URL = https://<backend>.onrender.com/api`
   (set it in the Vercel dashboard before the first build — Vite embeds
   VITE_* values at build time)
5. Deploy. Put the resulting URL into the backend's `CORS_ORIGINS` and
   redeploy the backend.

## 4. Verify the hosted stack (do not skip)

From any machine (or CI):

```bash
cd risk-manager/backend
SMOKE_BASE_URL=https://<backend>.onrender.com npm run smoke
```

All 22 checks must pass — including the **populated Mongo hash chain**
verification. A passing local run does not confirm the hosted instance works.

Then click through the hosted frontend once: all 9 pages, run one simulation
per module, check the Audit page renders records from the hosted backend.

## 5. Update the README

Put the hosted demo URL at the top of the README **only after** step 4
passes. If it never passes before the deadline, ship without it — a broken
link in front of a judge is worse than no link.

---

## Cost

All three services have free tiers sufficient for the demo: Render free web
service (spins down when idle), Atlas M0 (512 MB), Vercel Hobby. No card
required for any of them beyond account verification.
