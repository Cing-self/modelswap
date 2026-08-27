function createUsageVaultService({ pathExists, readFile, providersPath, createVaultStore }) {
  async function loadProviders() {
    if (!(await pathExists(providersPath))) return [];
    try {
      const data = JSON.parse(await readFile(providersPath, 'utf-8'));
      return Array.isArray(data.providers) ? data.providers : [];
    } catch { return []; }
  }
  async function resolveVaultKey(vaultKey) {
    if (!vaultKey) return undefined;
    try { return await createVaultStore().get(vaultKey); } catch { return undefined; }
  }
  async function resolveFirstVaultKey(names) {
    for (const name of names) { const value = await resolveVaultKey(name); if (value) return value; }
    return undefined;
  }
  async function resolveCredentialPair(pairNames) {
    const combined = await resolveFirstVaultKey(pairNames.combined || []);
    if (combined) try {
      const value = JSON.parse(combined);
      const accessKey = value.accessKey || value.accessKeyId || value.access_key_id || value.secretId;
      const secretKey = value.secretKey || value.secretAccessKey || value.secret_access_key || value.secretKeyId;
      if (accessKey && secretKey) return { accessKey, secretKey };
    } catch {}
    const accessKey = await resolveFirstVaultKey(pairNames.accessKey || []);
    const secretKey = await resolveFirstVaultKey(pairNames.secretKey || []);
    return accessKey && secretKey ? { accessKey, secretKey } : undefined;
  }
  return { loadProviders, resolveVaultKey, resolveFirstVaultKey, resolveCredentialPair };
}
module.exports = { createUsageVaultService };
