# Magic Resizer — License Dashboard

A complete, self-hostable license system for your Figma plugin:
- Create/revoke/delete license keys from a web dashboard (no more editing JSON files)
- Each key locks to a machine after first use (`maxDevices`, default 1)
- See exactly which devices are using each key, and release a device slot when someone gets a new machine
- Everything backed by Vercel KV — no separate database to manage

## What's in this package

```
api/
  _store.js          shared KV read/write helpers (not a route, used by the others)
  verify.js           called by the plugin — checks a key + device, enforces limits
  keys.js              admin CRUD — list/create/update/delete keys (dashboard uses this)
  release-device.js    admin action — frees a device slot on a key
dashboard.html          the web dashboard itself (open this in a browser once deployed)
package.json            declares the @vercel/kv dependency
```

## 1. Deploy

```bash
npm install -g vercel
cd magic-resizer-dashboard
vercel deploy
```

## 2. Add Vercel KV

In your Vercel project → **Storage** tab → **Create Database** → **KV**.
Vercel auto-injects the required env vars — nothing to copy manually.

## 3. Set your admin secret

Vercel project → **Settings** → **Environment Variables**:
```
ADMIN_SECRET = something-long-and-random
```
Redeploy after adding this (`vercel deploy --prod`) so the function picks it up.

## 4. Open the dashboard

Visit `https://your-project.vercel.app/dashboard.html`, enter your `ADMIN_SECRET`,
and you're in. From here you can:
- **+ New License** — creates a key (auto-generated like `MR-AB12-CD34-2026`, or type your own),
  set the owner name, max devices (1 by default), and an optional expiry date
- **Revoke / Activate** — instantly disables or re-enables a key
- **Release device** — clears a key's activated device(s) so it can be used on a new machine
- **Delete** — permanently removes a key and its device history
- **Copy** — copies the key string to send to whoever it's for

## 5. Point your plugin at this deployment

In your plugin's **`ui.html`**, find:
```js
var LICENSE_ENDPOINT = 'https://your-project.vercel.app/api/verify';
```
Replace with your real deployed URL, e.g. `https://magic-resizer-license.vercel.app/api/verify`.

In your plugin's **`manifest.json`**, update `networkAccess.allowedDomains` to match:
```json
"networkAccess": {
  "allowedDomains": [
    "https://magic-resizer-license.vercel.app",
    "https://cdnjs.cloudflare.com"
  ]
}
```

## How the one-machine-per-license flow works

1. You create a key in the dashboard for someone (e.g. `owner: "Jane"`, `maxDevices: 1`) and send them the key.
2. They enter it in the plugin the first time → it locks to their machine.
3. If they (or someone they gave the plugin source to) tries that same key on a
   different machine, the plugin shows: *"This license is already active on
   another machine. Contact [you] for your own license key."*
4. To give someone a new laptop access again: open the dashboard, find their key,
   click **Release device**. Their next check-in re-activates on the new machine.
5. To give a *different person* access: create them their own key — don't reuse
   one person's key for someone else.

## Security notes

- The dashboard and all `/api/*` admin routes require `ADMIN_SECRET`. Don't
  share that value — anyone with it can create/revoke/delete any key.
- `dashboard.html` stores the secret in `sessionStorage` (cleared when the tab
  closes), not `localStorage`, so it doesn't persist indefinitely on a shared
  computer.
- As before: this stops casual re-sharing and gives you a real kill switch,
  but someone reading the plugin's source could still strip the license check
  out entirely. It raises the bar; it isn't unbreakable.
