# Magic Resizer — License System (Render version)

Same license system as before (create/revoke keys, one-machine-per-license,
device release, web dashboard) — restructured to run as a plain Express app
on Render instead of Vercel serverless functions.

## What's in this package

```
server.js         Express app with all routes (/api/verify, /api/keys, /api/release-device)
lib/store.js      Redis read/write helpers (uses Render's managed Redis)
public/
  dashboard.html  the admin dashboard — served at /dashboard.html
package.json      dependencies (express, redis)
render.yaml       optional one-click Blueprint (see Option A below)
```

## Option A — Deploy with the Blueprint (fastest)

1. Push this folder to a GitHub repo.
2. In Render: **New** → **Blueprint** → select your repo. Render reads
   `render.yaml` and sets up both the web service and a Redis (Key Value)
   instance automatically, wiring `REDIS_URL` between them for you.
3. You'll be prompted to set `ADMIN_SECRET` (marked `sync: false` so Render
   asks you for it rather than storing it in the repo) — enter a long random
   string.
4. Deploy. Render gives you a URL like `https://magic-resizer-license.onrender.com`.

## Option B — Manual setup (if you'd rather not use a Blueprint)

### 1. Create the Redis instance
Render dashboard → **New** → **Key Value** (Render's managed Redis).
Pick the free plan. Once created, copy its **Internal Connection String**
(starts with `redis://...`) — use the internal one if your web service is
also on Render, it's faster and free; the external one works too if needed.

### 2. Create the Web Service
Render dashboard → **New** → **Web Service** → connect this repo (or upload
the folder via Render's manual deploy option).
- **Build Command**: `npm install`
- **Start Command**: `npm start`

### 3. Set environment variables
On the Web Service → **Environment**:
```
REDIS_URL     = <paste the connection string from step 1>
ADMIN_SECRET  = <a long random string you choose>
```

### 4. Deploy
Render builds and starts it automatically. You'll get a URL like:
```
https://magic-resizer-license.onrender.com
```

## Using it

- **Dashboard**: `https://magic-resizer-license.onrender.com/dashboard.html`
  — log in with your `ADMIN_SECRET`, create/revoke/release keys from there.
- **Plugin endpoint**: `https://magic-resizer-license.onrender.com/api/verify`

## Point your plugin at this deployment

In your plugin's `ui.html`:
```js
var LICENSE_ENDPOINT = 'https://magic-resizer-license.onrender.com/api/verify';
```

In your plugin's `manifest.json`:
```json
"networkAccess": {
  "allowedDomains": [
    "https://magic-resizer-license.onrender.com",
    "https://cdnjs.cloudflare.com"
  ]
}
```

## One thing worth knowing about Render's free tier

Free Web Services on Render **spin down after inactivity** and take a few
seconds to wake back up on the next request. That means the first license
check after idle time will be slightly slow (a few seconds), not broken —
just a cold start. If that's not acceptable, Render's paid "Starter" tier
keeps the service always-on.

## Everything else is unchanged

- One key = one machine by default (`maxDevices: 1`)
- Sharing the plugin source doesn't share access — a second machine on the
  same key gets blocked and told to contact you
- Release a device from the dashboard when someone gets a new machine
- Revoke instantly disables a key; Delete removes it and its history entirely
