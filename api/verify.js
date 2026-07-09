// api/verify.js
// Called by the plugin's ui.html on every license check.

const { getKeyRecord, getDevices, addDevice } = require('./_store');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ valid: false, reason: 'method_not_allowed' }); return; }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) { res.status(429).json({ valid: false, reason: 'rate_limited' }); return; }

  const { key, deviceId } = req.body || {};

  if (!key || typeof key !== 'string') {
    res.status(400).json({ valid: false, reason: 'missing_key' });
    return;
  }
  if (!deviceId || typeof deviceId !== 'string') {
    res.status(400).json({ valid: false, reason: 'missing_device_id' });
    return;
  }

  const record = await getKeyRecord(key);

  if (!record) { res.status(200).json({ valid: false, reason: 'unknown_key' }); return; }
  if (!record.active) { res.status(200).json({ valid: false, reason: 'revoked' }); return; }
  if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) {
    res.status(200).json({ valid: false, reason: 'expired' });
    return;
  }

  const knownDevices = await getDevices(key);
  const isNewDevice = !knownDevices.includes(deviceId);
  const maxDevices = record.maxDevices || null;

  if (isNewDevice && maxDevices && knownDevices.length >= maxDevices) {
    res.status(200).json({
      valid: false,
      reason: 'device_limit_reached',
      deviceCount: knownDevices.length,
      maxDevices,
    });
    return;
  }

  if (isNewDevice) {
    await addDevice(key, deviceId);
  }

  const deviceCount = isNewDevice ? knownDevices.length + 1 : knownDevices.length;

  res.status(200).json({
    valid: true,
    owner: record.owner || null,
    expiresAt: record.expiresAt || null,
    deviceCount,
    maxDevices,
  });
};
