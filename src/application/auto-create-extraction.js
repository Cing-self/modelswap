// Pure credential extraction helpers. They deliberately receive captured data
// as values and have no browser, filesystem, HTTP, or transport dependency.
function isAssetData(value) {
  if (!value) return true;
  if (value.startsWith('iVBOR') || value.startsWith('/9j/') || value.startsWith('R0lGOD')) return true;
  if (value.startsWith('AAEA') || value.startsWith('d09G') || value.startsWith('T1Rc')) return true;
  if (/^\d+\.\d/.test(value)) return true;
  if (value.includes('h117.') || value.includes('V296.')) return true;
  if (/[＊*•]/.test(value) || value.includes(' ')) return true;
  return value.includes('flex') || value.includes('gap-') || value.includes('pointer') || value.includes('globalRuntime');
}

function isValidZhipuApiKey(value) {
  return typeof value === 'string' && !/[*…]|\.{3}/.test(value) && /^[a-f0-9]{32}\.[a-zA-Z0-9]{6,}$/.test(value);
}

function isValidExtractionForPlatform(value, platform) {
  if (!value || isAssetData(value)) return null;
  return platform === 'zhipu' ? (isValidZhipuApiKey(value) ? value : null) : value;
}

function normalizeCredentialFieldName(name) {
  return String(name || '').replace(/[_-]/g, '').toLowerCase();
}

function findCredentialPair(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) { const pair = findCredentialPair(item, depth + 1); if (pair) return pair; }
    return null;
  }
  const fields = Object.entries(value);
  const fieldValue = names => {
    const wanted = new Set(names.map(normalizeCredentialFieldName));
    const match = fields.find(([name, candidate]) => wanted.has(normalizeCredentialFieldName(name))
      && typeof candidate === 'string' && candidate.length >= 8 && !isAssetData(candidate));
    return match?.[1] || null;
  };
  const accessKey = fieldValue(['accessKey', 'accessKeyId', 'access_key', 'access_key_id', 'secretId', 'secret_id', 'SecretId', 'id']);
  const secretKey = fieldValue(['secretKey', 'secretAccessKey', 'accessKeySecret', 'access_key_secret', 'secret_access_key', 'secret', 'SecretKey', 'sk']);
  if (accessKey && secretKey) return { accessKey, secretKey };
  for (const child of Object.values(value)) { const pair = findCredentialPair(child, depth + 1); if (pair) return pair; }
  return null;
}

function serializeCredentialPair(pair) {
  return pair?.accessKey && pair?.secretKey ? JSON.stringify({ accessKey: pair.accessKey, secretKey: pair.secretKey }) : null;
}

function parseCredentialPairText(text) {
  try { return text ? findCredentialPair(JSON.parse(String(text))) : null; } catch { return null; }
}

function findFieldValue(obj, fieldNames, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const lowerNames = fieldNames.map(field => field.toLowerCase());
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length >= 8 && lowerNames.includes(key.toLowerCase())) return value;
  }
  for (const value of Object.values(obj)) { const found = findFieldValue(value, fieldNames, depth + 1); if (found) return found; }
  return null;
}

function findKeyField(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const names = ['apikey', 'api_key', 'apikeysecret', 'accesskey', 'access_key', 'key', 'token', 'value', 'secret', 'secret_key', 'secretkey'];
  const entries = Object.entries(obj);
  for (const name of names) {
    const match = entries.find(([key, value]) => String(key).toLowerCase() === name && typeof value === 'string' && value.length >= 20);
    if (match) return match[1];
  }
  for (const value of Object.values(obj)) { const found = findKeyField(value, depth + 1); if (found) return found; }
  return null;
}

function findStringMatching(obj, pattern, depth = 0) {
  if (depth > 8 || obj == null) return null;
  if (typeof obj === 'string') return pattern.test(obj) && !isAssetData(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) { const found = findStringMatching(value, pattern, depth + 1); if (found) return found; }
  return null;
}

function findIdSecretValue(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === 'string') return obj.match(/^([^\.\s]{8,128}\.[^\.\s]{8,256})$/)?.[1] || null;
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) { const found = findIdSecretValue(value, depth + 1); if (found) return found; }
  return null;
}

module.exports = {
  isAssetData, isValidZhipuApiKey, isValidExtractionForPlatform,
  normalizeCredentialFieldName, findCredentialPair, serializeCredentialPair,
  parseCredentialPairText, findFieldValue, findKeyField, findStringMatching,
  findIdSecretValue,
};
