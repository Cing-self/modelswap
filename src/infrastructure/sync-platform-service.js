// Sync platform boundary: vault-reference resolution and remote transports.
const crypto = require('crypto');

const SECRET_FIELD_PATTERNS = /ecret|oken|Key|Id$/;
const SKIP_FIELDS = /databaseId|bucketName|region/i;
const VAULT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;
const PLATFORM_SECRET_FIELDS = {
  cloudflare: ['apiToken', 'storeId'],
  'cloudflare-d1': ['apiToken'],
  'cloudflare-kv': ['apiToken'],
  'cloudflare-r2': ['accountId', 'r2AccessKeyId', 'r2SecretAccessKey'],
  volcengine: ['accessKey', 'secretKey'],
  supabase: ['projectId', 'apiKey', 'apiToken'],
  webdav: ['password'],
  lan: ['token'],
  icloud: [],
};
const VALID_ADAPTERS = new Set([
  'cloudflare',
  'cloudflare-d1',
  'cloudflare-kv',
  'cloudflare-r2',
  'supabase',
  'volcengine',
  'webdav',
  'lan',
  'icloud',
]);

function createSyncPlatformService({ loadAdapter, createVaultStore, appendLog }) {
  function isVaultRefField(platform, key, value) {
    const allowedFields = platform ? PLATFORM_SECRET_FIELDS[platform] : null;
    if (allowedFields && !allowedFields.includes(key)) return false;
    return (
      typeof value === 'string' &&
      SECRET_FIELD_PATTERNS.test(key) &&
      !SKIP_FIELDS.test(key) &&
      VAULT_KEY_PATTERN.test(value)
    );
  }

  async function collectPlatformVaultSecrets(platConfig, platform) {
    const refs = [];
    for (const [field, value] of Object.entries(platConfig || {})) {
      if (isVaultRefField(platform, field, value)) {
        refs.push({ field, value, key: value });
      }
    }
    if (refs.length === 0) return [];

    const allSecrets = await createVaultStore().exportAll();
    const selected = [];
    const missing = [];
    for (const ref of refs) {
      const secret = allSecrets.find((item) => item.key === ref.key);
      if (!secret) missing.push(ref.value);
      else selected.push(secret);
    }
    if (missing.length > 0) {
      throw new Error(`配置引用的密钥不存在：${missing.join(', ')}`);
    }

    const seen = new Set();
    return selected
      .filter((secret) => {
        if (seen.has(secret.key)) return false;
        seen.add(secret.key);
        return true;
      })
      .map((secret) => ({
        key: secret.key,
        value: secret.value,
        desc: secret.desc || '',
        group: secret.group || '',
        expiresAt: secret.expiresAt || '',
        updatedAt: secret.updatedAt,
      }));
  }

  async function resolveVaultRefs(platConfig, platform) {
    const resolved = { ...platConfig };
    const allowedFields = platform ? PLATFORM_SECRET_FIELDS[platform] : null;
    const store = createVaultStore();
    for (const [key, value] of Object.entries(resolved)) {
      if (allowedFields && !allowedFields.includes(key)) continue;
      if (
        typeof value === 'string' &&
        SECRET_FIELD_PATTERNS.test(key) &&
        !SKIP_FIELDS.test(key)
      ) {
        if (!VAULT_KEY_PATTERN.test(value)) continue;
        const actual = await store.get(value);
        if (!actual) {
          throw new Error(`密钥 "${value}" 不存在，请先在密钥管理中添加`);
        }
        resolved[key] = actual;
      }
    }
    return resolved;
  }

  async function testConnection(config, platform) {
    const platConfig = config.sync?.platforms?.[platform];
    if (!platConfig) throw new Error(`平台 ${platform} 未配置`);
    const resolved = await resolveVaultRefs(platConfig, platform);
    const result = await loadAdapter(platform).testConnection(resolved);
    appendLog('platform-test', platform, true, result);
    return result;
  }

  function resolveSyncKeys(config) {
    const password = config.sync?.password;
    if (!password) throw new Error('请先设置同步密码');
    const key = crypto.pbkdf2Sync(password, 'okit-sync-salt', 100000, 32, 'sha256');
    return { userId: key.slice(0, 16).toString('hex'), encryptionKey: key };
  }

  async function listEnabledSyncTargets(config) {
    const { userId, encryptionKey } = resolveSyncKeys(config);
    const targets = [];
    for (const [id, platConfig] of Object.entries(config.sync?.platforms || {})) {
      if (!platConfig?.enabled) continue;
      targets.push({ id, resolvedConfig: await resolveVaultRefs(platConfig, id) });
    }
    if (targets.length === 0) throw new Error('请先启用一个同步平台');
    return { targets, userId, encryptionKey };
  }

  async function resolvePrimaryTarget(config) {
    const { targets } = await listEnabledSyncTargets(config);
    const preferred = config.sync?.syncPlatform;
    return targets.find((target) => target.id === preferred) || targets[0];
  }

  function adapterFor(name) {
    if (!name || !/^[a-z0-9-]+$/.test(name) || !VALID_ADAPTERS.has(name)) {
      throw new Error(`Invalid platform adapter: ${name}`);
    }
    return loadAdapter(name);
  }

  return {
    adapterFor,
    collectPlatformVaultSecrets,
    listEnabledSyncTargets,
    resolvePrimaryTarget,
    resolveSyncKeys,
    resolveVaultRefs,
    testConnection,
  };
}

module.exports = { createSyncPlatformService };
