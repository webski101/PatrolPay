# Deploying the PatrolPay dashboard to Vercel

This deploys a **read-only, publicly shareable** copy of the dashboard. It reads
on-chain state (ReceiptPaid events, contract balance, device stats) directly from
the BOT Chain RPC via a serverless function — no private keys, no device process,
nothing from your `.env` except the public `CONTRACT_ADDRESS`.

The local setup (`dashboard.js`, `device.js`, the audit log) is unchanged and
keeps working exactly as before. The robot still runs on your machine; the
Vercel page just watches the chain.

## What gets deployed

| File | Role |
|---|---|
| `public/index.html` | The dashboard UI (static) |
| `api/state.js` | Serverless function: polls BOT Chain RPC, returns JSON at `/api/state` |
| `vercel.json` | Tells Vercel: no build step, serve `public/`, no install needed |

## Steps (vercel.com import flow)

1. **Push this repo to GitHub** (public or private — both work). Make sure
   `.env` is NOT in the repo; it is already covered by `.gitignore`.

2. Go to **https://vercel.com/new** and sign in (the "Continue with GitHub"
   option is simplest).

3. Under **Import Git Repository**, find the PatrolPay repo and click
   **Import**. If it isn't listed, click "Adjust GitHub App Permissions" and
   grant Vercel access to the repo.

4. On the **Configure Project** screen:
   - **Framework Preset:** `Other` (Vercel usually picks this automatically —
     `vercel.json` already pins the build settings, so leave Build Command,
     Output Directory, and Install Command untouched).
   - Expand **Environment Variables** and add:

     | Name | Value |
     |---|---|
     | `CONTRACT_ADDRESS` | `0x788A699605b6ca1F9a47aE57ec6eB6468f5B7120` (your deployed contract) |
     | `RPC_URL` | `https://rpc.bohr.life` (optional — this is the default) |

     ⚠️ Only these two. Never add any `*_PRIVATE_KEY` variable — the dashboard
     is read-only and must stay that way.

5. Click **Deploy**. The first deployment takes under a minute (there is no
   build step).

6. Open the deployment URL. Sanity checks:
   - `https://<your-project>.vercel.app/` shows the dashboard.
   - `https://<your-project>.vercel.app/api/state` returns JSON with
     `"rpcOk": true`.
   - If the robot (`npm run device`) is running anywhere, the ledger fills with
     PAID rows within a few seconds and the status pill shows PATROLLING.

## Notes & troubleshooting

- **Changing the env vars later:** Project → Settings → Environment Variables,
  then **Deployments → ⋯ → Redeploy** (env changes only apply to new deployments).
- **Empty ledger:** the function looks back ~40,000 blocks (~8 hours at 0.75s
  blocks). If the robot hasn't run in that window, the ledger is empty but
  budget/earnings/receipt totals still show (they come from contract state, not
  events).
- **Serverless differences vs. the local dashboard** (by design):
  - The audit-chain check needs the local `audit-log.jsonl`, so the strip
    points to the repo/video for the tamper-evidence demo instead.
  - Rejected forgeries never emit events (reverted txs), so the feed shows only
    PAID rows; the "Forgeries blocked" card links to a real reverted forgery tx
    on the explorer instead.
  - Responses are edge-cached for 3s (`s-maxage=3, stale-while-revalidate=10`)
    to keep RPC load low no matter how many people open the page.
