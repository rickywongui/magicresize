// server.js
// A single Express app serving:
//   POST   /api/verify           — called by the Figma plugin
//   GET    /api/keys             — list all keys (dashboard)
//   POST   /api/keys             — create a key (dashboard)
//   PATCH  /api/keys             — update a key (dashboard)
//   DELETE /api/keys             — delete a key (dashboard)
//   POST   /api/release-device   — free a device slot (dashboard)
//   GET    /dashboard.html       — the admin dashboard itself
//
// Start locally with: npm install && npm start
// On Render: this is your Web Service's start command (see README).

const express = require('express');
const path = require('path');
const {
  listKeys,
  getKeyRecord,
  setKeyRecord,
  deleteKeyRecord,
  getDevices,
  getLastSeenMap,
  addDevice,
  releaseDevice,
  checkAdminAuth,
} = require('./lib/store');

const app = express();
app.use(express.json());

// Allow the plugin (running from Figma's own origin) to call /api/verify.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate limiting for /api/verify (basic, per-process) ────────────────────
const attempts = new Map();
const MAX_ATTEMPTS_PER_MINUTE = 20;
function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (attempts.get(ip) || []).filter((t) => t > windowStart);
  timestamps.push(now);
  attempts.set(ip, timestamps);
  return timestamps.length > MAX_ATTEMPTS_PER_MINUTE;
}

// ─── Plugin-facing endpoint ─────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ valid: false, reason: 'rate_limited' });

  const { key, deviceId } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ valid: false, reason: 'missing_key' });
  if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ valid: false, reason: 'missing_device_id' });

  const record = await getKeyRecord(key);
  if (!record) return res.status(200).json({ valid: false, reason: 'unknown_key' });
  if (!record.active) return res.status(200).json({ valid: false, reason: 'revoked' });
  if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }

  const knownDevices = await getDevices(key);
  const isNewDevice = !knownDevices.includes(deviceId);
  const maxDevices = record.maxDevices || null;

  if (isNewDevice && maxDevices && knownDevices.length >= maxDevices) {
    return res.status(200).json({
      valid: false,
      reason: 'device_limit_reached',
      deviceCount: knownDevices.length,
      maxDevices,
    });
  }

  if (isNewDevice) await addDevice(key, deviceId);

  const deviceCount = isNewDevice ? knownDevices.length + 1 : knownDevices.length;
  res.status(200).json({
    valid: true,
    owner: record.owner || null,
    expiresAt: record.expiresAt || null,
    deviceCount,
    maxDevices,
  });
});

// ─── Admin: keys CRUD ───────────────────────────────────────────────────────
function generateKey() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MR-${part()}-${part()}-${new Date().getFullYear()}`;
}

app.get('/api/keys', async (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  const keys = await listKeys();
  const results = await Promise.all(
    keys.map(async (key) => {
      const record = await getKeyRecord(key);
      const devices = await getDevices(key);
      const lastSeen = await getLastSeenMap(key);
      return {
        key,
        ...record,
        deviceCount: devices.length,
        devices: devices.map((id) => ({ deviceId: id, lastSeen: lastSeen[id] || null })),
      };
    })
  );
  results.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.status(200).json(results);
});

app.post('/api/keys', async (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  const { owner, maxDevices, expiresAt, key: providedKey } = req.body || {};
  const key = providedKey || generateKey();

  const existing = await getKeyRecord(key);
  if (existing) return res.status(409).json({ error: 'key_already_exists' });

  const record = {
    owner: owner || null,
    active: true,
    maxDevices: typeof maxDevices === 'number' ? maxDevices : 1,
    expiresAt: expiresAt || null,
    createdAt: new Date().toISOString(),
  };

  await setKeyRecord(key, record);
  res.status(201).json({ key, ...record });
});

app.patch('/api/keys', async (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  const { key, owner, active, maxDevices, expiresAt } = req.body || {};
  if (!key) return res.status(400).json({ error: 'missing_key' });

  const existing = await getKeyRecord(key);
  if (!existing) return res.status(404).json({ error: 'key_not_found' });

  const updated = {
    ...existing,
    ...(owner !== undefined ? { owner } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(maxDevices !== undefined ? { maxDevices } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };

  await setKeyRecord(key, updated);
  res.status(200).json({ key, ...updated });
});

app.delete('/api/keys', async (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'missing_key' });

  await deleteKeyRecord(key);
  res.status(200).json({ deleted: key });
});

// ─── Admin: release a device slot ──────────────────────────────────────────
app.post('/api/release-device', async (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  const { key, deviceId } = req.body || {};
  if (!key) return res.status(400).json({ error: 'missing_key' });

  const record = await getKeyRecord(key);
  if (!record) return res.status(404).json({ error: 'key_not_found' });

  await releaseDevice(key, deviceId);
  res.status(200).json({ released: deviceId || 'all', key });
});

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send(`
    <h1>Magic Resizer License Server</h1>
    <p>✅ Server is running</p>
    <p>Available endpoints:</p>
    <ul>
      <li>POST /api/verify</li>
      <li>GET /api/keys</li>
      <li>POST /api/keys</li>
      <li>PATCH /api/keys</li>
      <li>DELETE /api/keys</li>
      <li>POST /api/release-device</li>
    </ul>
  `);
});

app.listen(PORT, () => console.log(`License server running on port ${PORT}`));
