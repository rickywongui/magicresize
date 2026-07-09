// api/_store.js
// Shared helpers for reading/writing license data in Vercel KV.
// Keys are stored dynamically here (not in a static keys.json anymore),
// so the dashboard can create/edit/delete them without a redeploy.

const { kv } = require('@vercel/kv');

const ALL_KEYS_SET = 'all-license-keys';

async function listKeys() {
  return (await kv.smembers(ALL_KEYS_SET)) || [];
}

async function getKeyRecord(key) {
  return await kv.get(`license:${key}`);
}

async function setKeyRecord(key, record) {
  await kv.set(`license:${key}`, record);
  await kv.sadd(ALL_KEYS_SET, key);
}

async function deleteKeyRecord(key) {
  await kv.del(`license:${key}`);
  await kv.del(`devices:${key}`);
  await kv.del(`device_last_seen:${key}`);
  await kv.srem(ALL_KEYS_SET, key);
}

async function getDevices(key) {
  return (await kv.smembers(`devices:${key}`)) || [];
}

async function getLastSeenMap(key) {
  return (await kv.hgetall(`device_last_seen:${key}`)) || {};
}

async function addDevice(key, deviceId) {
  await kv.sadd(`devices:${key}`, deviceId);
  await kv.hset(`device_last_seen:${key}`, { [deviceId]: new Date().toISOString() });
}

async function releaseDevice(key, deviceId) {
  if (deviceId) {
    await kv.srem(`devices:${key}`, deviceId);
  } else {
    await kv.del(`devices:${key}`);
    await kv.del(`device_last_seen:${key}`);
  }
}

function checkAdminAuth(req) {
  const secret = (req.query && req.query.secret) || (req.body && req.body.secret) ||
    req.headers['x-admin-secret'];
  return !!process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

module.exports = {
  listKeys,
  getKeyRecord,
  setKeyRecord,
  deleteKeyRecord,
  getDevices,
  getLastSeenMap,
  addDevice,
  releaseDevice,
  checkAdminAuth,
};
