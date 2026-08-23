const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// iCloud Drive root on macOS. Files placed here are automatically synced
// to iCloud by the system. No API, no credentials — just filesystem I/O.
const ICLOUD_ROOT = path.join(
  os.homedir(),
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs',
);

const SYNC_DIR = path.join(ICLOUD_ROOT, 'okit-sync');
const SECRETS_DIR = path.join(SYNC_DIR, 'secrets');

function isSupported() {
  return process.platform === 'darwin' && fs.existsSync(ICLOUD_ROOT);
}

function assertPlatform() {
  if (!isSupported()) {
    throw new Error(
      'iCloud 同步仅支持 macOS 且需要已登录 iCloud Drive。' +
      'Linux/Windows 用户请使用 WebDAV 或其他平台。',
    );
  }
}

// iCloud config has no fields — the user just enables it. We keep the
// config object for interface compatibility but it's effectively empty.
function normalizeConfig(config) {
  return { ...config };
}

function assertConfig(config) {
  assertPlatform();
}

async function testConnection(config) {
  config = normalizeConfig(config);
  assertConfig(config);
  await fs.ensureDir(SYNC_DIR);
  await fs.ensureDir(SECRETS_DIR);
  return 'iCloud 连接成功，数据将同步到 iCloud Drive 的 okit-sync 文件夹';
}

async function pushSync(config, userId, encryptedBlob) {
  config = normalizeConfig(config);
  assertConfig(config);
  await fs.ensureDir(SYNC_DIR);
  const filePath = path.join(SYNC_DIR, `sync-${userId}.json`);
  await fs.writeJson(filePath, encryptedBlob, { spaces: 2 });
}

async function pullSync(config, userId) {
  config = normalizeConfig(config);
  assertConfig(config);
  const filePath = path.join(SYNC_DIR, `sync-${userId}.json`);
  if (!(await fs.pathExists(filePath))) return null;
  return await fs.readJson(filePath);
}

module.exports = { name: 'iCloud', testConnection, pushSync, pullSync };
