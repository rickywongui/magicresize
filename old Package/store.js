// lib/store.js
// Same data model as before, just backed by standard Redis (via Render's
// managed Key Value service) instead of Vercel KV. Node's `redis` client
// stores plain strings, so objects are JSON-encoded/decoded here.

const { createClient } = require('redis');

let client;

async function getClient() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis error:', err));
    await client.connect();
  }
  return client;
}

const ALL_KEYS_SET = 'all-license-keys';

async function listKeys() {
  const c = await getClient();
  return (await c.sMembers(ALL_KEYS_SET)) || [];
}

async function getKeyRecord(key) {
  const c = await getClient();
  const raw = await c.get(`license:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function setKeyRecord(key, record) {
  const c = await getClient();
  await c.set(`license:${key}`, JSON.stringify(record));
  await c.sAdd(ALL_KEYS_SET, key);
}

async function deleteKeyRecord(key) {
  const c = await getClient();
  await c.del(`license:${key}`);
  await c.del(`devices:${key}`);
  await c.del(`device_last_seen:${key}`);
  await c.sRem(ALL_KEYS_SET, key);
}

async function getDevices(key) {
  const c = await getClient();
  return (await c.sMembers(`devices:${key}`)) || [];
}

async function getLastSeenMap(key) {
  const c = await getClient();
  return (await c.hGetAll(`device_last_seen:${key}`)) || {};
}

async function addDevice(key, deviceId) {
  const c = await getClient();
  await c.sAdd(`devices:${key}`, deviceId);
  await c.hSet(`device_last_seen:${key}`, deviceId, new Date().toISOString());
}

async function releaseDevice(key, deviceId) {
  const c = await getClient();
  if (deviceId) {
    await c.sRem(`devices:${key}`, deviceId);
    await c.hDel(`device_last_seen:${key}`, deviceId);
  } else {
    await c.del(`devices:${key}`);
    await c.del(`device_last_seen:${key}`);
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
