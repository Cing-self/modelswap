// Wire-compatible encrypted blob and sync-code serialization.
const crypto = require('crypto');

const SYNC_CODE_PREFIX = 'modelswap-sync:';
const SYNC_CODE_SALT = 'modelswap-sync-code-salt';

function deriveSyncCodeKey(password) {
  return crypto.pbkdf2Sync(password, SYNC_CODE_SALT, 100000, 32, 'sha256');
}

function encryptPayload(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    nonce: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decryptPayload(encrypted, key) {
  const iv = Buffer.from(encrypted.nonce, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
  );
}

function encryptSyncCodePayload(payload, password) {
  const blob = { v: 1, ...encryptPayload(payload, deriveSyncCodeKey(password)) };
  return `${SYNC_CODE_PREFIX}${Buffer.from(JSON.stringify(blob)).toString('base64url')}`;
}

function decryptSyncCodePayload(code, password) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(SYNC_CODE_PREFIX)) throw new Error('同步码格式不正确');
  let blob;
  try {
    blob = JSON.parse(
      Buffer.from(raw.slice(SYNC_CODE_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw new Error('同步码格式不正确');
  }
  try {
    return decryptPayload(blob, deriveSyncCodeKey(password));
  } catch {
    throw new Error('同步密码不正确，无法解密同步码');
  }
}

module.exports = {
  decryptPayload,
  decryptSyncCodePayload,
  encryptPayload,
  encryptSyncCodePayload,
};
