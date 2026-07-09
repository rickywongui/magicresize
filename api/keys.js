// api/keys.js
// Admin endpoint the dashboard talks to. All requests must include a
// "secret" (query param for GET, body field for POST/PATCH/DELETE) matching
// the ADMIN_SECRET environment variable.
//
// GET    /api/keys?secret=...                → list all keys + device info
// POST   /api/keys { secret, owner, ... }     → create a new key
// PATCH  /api/keys { secret, key, ... }       → update a key (revoke, extend, etc.)
// DELETE /api/keys { secret, key }            → permanently remove a key

const {
  listKeys,
  getKeyRecord,
  setKeyRecord,
  deleteKeyRecord,
  getDevices,
  getLastSeenMap,
  checkAdminAuth,
} = require('./_store');

function generateKey() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MR-${part()}-${part()}-${new Date().getFullYear()}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!checkAdminAuth(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET') {
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
    // Newest first
    results.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.status(200).json(results);
    return;
  }

  if (req.method === 'POST') {
    const { owner, maxDevices, expiresAt, key: providedKey } = req.body || {};
    const key = providedKey || generateKey();

    const existing = await getKeyRecord(key);
    if (existing) {
      res.status(409).json({ error: 'key_already_exists' });
      return;
    }

    const record = {
      owner: owner || null,
      active: true,
      maxDevices: typeof maxDevices === 'number' ? maxDevices : 1,
      expiresAt: expiresAt || null,
      createdAt: new Date().toISOString(),
    };

    await setKeyRecord(key, record);
    res.status(201).json({ key, ...record });
    return;
  }

  if (req.method === 'PATCH') {
    const { key, owner, active, maxDevices, expiresAt } = req.body || {};
    if (!key) { res.status(400).json({ error: 'missing_key' }); return; }

    const existing = await getKeyRecord(key);
    if (!existing) { res.status(404).json({ error: 'key_not_found' }); return; }

    const updated = {
      ...existing,
      ...(owner !== undefined ? { owner } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(maxDevices !== undefined ? { maxDevices } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    await setKeyRecord(key, updated);
    res.status(200).json({ key, ...updated });
    return;
  }

  if (req.method === 'DELETE') {
    const { key } = req.body || {};
    if (!key) { res.status(400).json({ error: 'missing_key' }); return; }
    await deleteKeyRecord(key);
    res.status(200).json({ deleted: key });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};
