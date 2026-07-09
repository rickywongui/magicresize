// api/release-device.js
// Frees up a key's device slot(s) so it can be activated on a new machine.
//
// POST { secret, key }              → releases ALL devices for that key
// POST { secret, key, deviceId }    → releases just that one device

const { checkAdminAuth, releaseDevice, getKeyRecord } = require('./_store');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  if (!checkAdminAuth(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { key, deviceId } = req.body || {};
  if (!key) { res.status(400).json({ error: 'missing_key' }); return; }

  const record = await getKeyRecord(key);
  if (!record) { res.status(404).json({ error: 'key_not_found' }); return; }

  await releaseDevice(key, deviceId);
  res.status(200).json({ released: deviceId || 'all', key });
};
