// Capture parsing and redacted diagnostics, independent from browser transport.
function createCaptureExtractor(deps) {
  const { CREDENTIAL_PAIR_PLATFORMS, keyFromText, isAssetData, isValidExtractionForPlatform } = deps;
function extractKeyFromCaptures(entries, platform) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Look at response bodies (responsePreview), prefer JSON bodies
  const candidates = [];
  for (const e of entries) {
    const body = e.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    // Mistral's admin session responses also contain generic key-like fields.
    // Only its API-key billing endpoint can contain a credential candidate.
    if (platform === 'mistral' && !/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(e.url || '')) continue;
    candidates.push({
      body,
      url: e.url || '',
      method: String(e.method || '').toUpperCase(),
      timestamp: Number(e.timestamp) || 0,
      status: e.responseStatus,
    });
  }

  // 1. Try parsing JSON bodies and pluck known key fields.
  //    For zhipu, the response has separate "api_key" and "api_secret" fields
  //    that must be joined as "api_key.api_secret".
  //    IMPORTANT: prefer POST responses (create API) over GET (list API), since
  //    the list API returns masked secrets while the create API has the full key.
  const sortedCandidates = [...candidates].sort((a, b) => {
    // The post-create secret is returned by the mutation. Page bootstrap
    // requests can also contain fields named `key` (for example, a session
    // public key), so they must never win over the create response.
    const aMutation = /^(POST|PUT|PATCH)$/i.test(a.method) ? 0 : 1;
    const bMutation = /^(POST|PUT|PATCH)$/i.test(b.method) ? 0 : 1;
    return aMutation - bMutation || b.timestamp - a.timestamp;
  });
  for (const c of sortedCandidates) {
    let data;
    try { data = JSON.parse(c.body); } catch { continue; }

    if (CREDENTIAL_PAIR_PLATFORMS.has(platform)) {
      const pair = findCredentialPair(data);
      if (pair) return serializeCredentialPair(pair);
    }

    // Moonshot's create response also carries an unrelated `key` identifier;
    // locate the actual sk-prefixed secret by shape before generic field-name
    // traversal can select that identifier.
    if (platform === 'moonshot') {
      const moonshotKey = findStringMatching(data, /^sk-[A-Za-z0-9_-]{16,}$/);
      if (moonshotKey) return moonshotKey;
    }

    // Diagnostic only: never log an API response body because this path is
    // expected to contain a newly-created secret.
    if (/api_key|api_secret|apikey|secret/i.test(c.body)) {
      console.log(`[auto-create] key-containing response captured from ${c.url.slice(0, 80)}`);
    }

    // Several providers return a key as two fields. Z.AI's live API may name
    // these apiKeyId/apiKeySecret rather than apiKey/secretKey, so keep the
    // accepted aliases explicit and pair them only within this captured
    // creation response. Masked list values are rejected below.
    const keyId = findFieldValue(data, [
      'api_key', 'apikey', 'api_key_id', 'apikeyid', 'key_id', 'keyid', 'key',
    ]);
    const secret = findFieldValue(data, [
      'api_secret', 'apikeysecret', 'api_key_secret', 'apikey_secret',
      'secret_key', 'secretkey', 'signature_secret', 'signaturesecret', 'secret',
    ]);
    if (keyId && secret && !isAssetData(keyId) && !isAssetData(secret)) {
      const joined = isValidExtractionForPlatform(keyId + '.' + secret, platform);
      if (joined) return joined;
    }

    // Generic: single key-like field
    const found = isValidExtractionForPlatform(findKeyField(data), platform);
    if (found) return found;

    // Z.AI may return the complete API key in a provider-specific field rather
    // than a field literally named key or secret. Inspect only JSON string
    // values from this captured create response for its documented id.secret
    // structure; URLs and other non-JSON text are deliberately excluded.
    if (platform === 'zai-global') {
      const joined = findIdSecretValue(data);
      if (joined && !isAssetData(joined)) return joined;
    }
  }

  // 2. Regex fallback over raw bodies (catches embedded JSON or JWTs)
  for (const c of candidates) {
    const m = c.body.match(/"(?:key|api_key|apiKey|token|value|secret)"\s*:\s*"([^"]{20,})"/);
    const quotedKey = isValidExtractionForPlatform(m && m[1], platform);
    if (quotedKey) return quotedKey;
  }
  for (const c of candidates) {
    const m = c.body.match(/eyJ[a-zA-Z0-9\-_]{50,}/);
    const jwtKey = isValidExtractionForPlatform(m && m[0], platform);
    if (jwtKey) return jwtKey;
  }
  // zhipu: full key format is 32-hex-dot-alphanumeric (e.g. xxxx.i2IC1jQ...)
  for (const c of candidates) {
    const m = c.body.match(/\b([a-f0-9]{32}\.[a-zA-Z0-9]{6,})\b/);
    const zhipuKey = isValidExtractionForPlatform(m && m[1], platform);
    if (zhipuKey) return zhipuKey;
  }
  for (const c of candidates) {
    // zhipu captured example: 32-char hex like a7cb939127954e91bd78d1cac4a1ee8f
    const m = c.body.match(/\b([a-f0-9]{32})\b/);
    const hexKey = isValidExtractionForPlatform(m && m[1], platform);
    if (hexKey) return hexKey;
  }

  return null;
}

function extractNewestNamedKeyFromCaptures(entries, tokenName, platform) {
  const matches = [];
  const wantedPrefix = `${tokenName}-`;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const fields = Object.entries(value);
    const field = aliases => fields.find(([name]) => aliases.includes(name.replace(/[_-]/g, '').toLowerCase()))?.[1];
    const name = field(['name', 'displayname', 'keyname']);
    if (typeof name === 'string' && name.startsWith(wantedPrefix)) {
      const candidate = field(['key', 'apikey', 'token', 'value', 'secret']);
      const key = typeof candidate === 'string' ? keyFromText(candidate, platform) : null;
      if (key) {
        const created = field(['createdat', 'created', 'creationdate', 'updatedat']);
        matches.push({ key, name, created: Date.parse(String(created || '')) || 0 });
      }
    }
    fields.forEach(([, child]) => visit(child));
  };

  for (const entry of entries || []) {
    if (platform.id === 'mistral' && !/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(entry.url || '')) continue;
    try { visit(JSON.parse(entry.responsePreview || '')); } catch {}
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0] || null;
}

function capturesContainMistralKeyRecords(entries) {
  const looksLikeKeyRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).map(key => key.replace(/[_-]/g, '').toLowerCase());
    if (keys.includes('apikeyid') || keys.includes('keyid')) return true;
    const hasIdentity = keys.includes('id') && (keys.includes('name') || keys.includes('keyname'));
    const hasKeyMetadata = keys.some(key => [
      'createdat', 'expiresat', 'expirationdate', 'lastusedat', 'workspaceid', 'ownerid', 'isactive', 'status',
    ].includes(key));
    return hasIdentity && hasKeyMetadata;
  };
  const containsRecord = value => {
    if (Array.isArray(value)) return value.some(item => looksLikeKeyRecord(item) || containsRecord(item));
    if (!value || typeof value !== 'object') return false;
    return looksLikeKeyRecord(value) || Object.values(value).some(containsRecord);
  };

  return (entries || []).some(entry => {
    if (!/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(entry.url || '')) return false;
    if (String(entry.method || 'GET').toUpperCase() !== 'GET') return false;
    try { return containsRecord(JSON.parse(entry.responsePreview || '')); } catch { return false; }
  });
}

/** Find a field value by checking a list of candidate field names (case-insensitive). */
function findFieldValue(obj, fieldNames, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const lowerNames = fieldNames.map(f => f.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length >= 8 && lowerNames.includes(k.toLowerCase())) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findFieldValue(v, fieldNames, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Recursively search a JSON object for a key-like field. */
function findKeyField(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const KEY_NAMES = ['apikey', 'api_key', 'apikeysecret', 'accesskey', 'access_key', 'key', 'token', 'value', 'secret', 'secret_key', 'secretkey'];
  const entries = Object.entries(obj);
  // A Kimi response can contain both the one-time API key and an unrelated
  // short-lived `key` identifier. Prefer explicit API-key/secret fields over
  // the generic identifier regardless of JSON property order.
  for (const keyName of KEY_NAMES) {
    const match = entries.find(([k, v]) => String(k).toLowerCase() === keyName && typeof v === 'string' && v.length >= 20);
    if (match) return match[1];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findKeyField(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findStringMatching(obj, pattern, depth = 0) {
  if (depth > 8 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') return pattern.test(obj) && !isAssetData(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) {
    const found = findStringMatching(value, pattern, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Find a Z.AI id.secret value in JSON data without logging or otherwise
 * exposing the response. The two segments cannot contain whitespace or a
 * second dot, matching Z.AI's documented split('.') authentication format. */
function findIdSecretValue(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') {
    const match = obj.match(/^([^.\s]{8,128}\.[^.\s]{8,256})$/);
    return match ? match[1] : null;
  }
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) {
    const found = findIdSecretValue(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Safe diagnostics for a failed one-time-secret extraction. Provider API
 * responses may contain credentials, so this reports field paths, lengths and
 * coarse shapes only — never a response value or a response body.
 */
function describeCapturedSecretFields(entries) {
  const summaries = [];
  const visit = (value, path = '', depth = 0, output = []) => {
    if (depth > 6 || output.length >= 16 || value === null || value === undefined) return output;
    if (typeof value === 'string') {
      const field = path.split('.').pop() || '';
      if (/api.?key|secret|token|access.?key|credential|^key(?:id)?$/i.test(field)) {
        output.push({
          field: path,
          length: value.length,
          shape: /^[a-f0-9]{32}\./i.test(value) ? 'id.secret'
            : /^sk-/i.test(value) ? 'sk-prefix'
              : /^[a-f0-9]{32}$/i.test(value) ? 'hex-id'
                : 'other',
        });
      }
      return output;
    }
    if (typeof value !== 'object') return output;
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, path ? `${path}.${key}` : key, depth + 1, output);
      if (output.length >= 16) break;
    }
    return output;
  };

  for (const entry of entries || []) {
    const body = entry?.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    let data;
    try { data = JSON.parse(body); } catch { continue; }
    const fields = visit(data);
    if (!fields.length) continue;
    let path = String(entry.url || '');
    try { path = new URL(path).pathname; } catch {}
    summaries.push({ method: String(entry.method || 'GET').toUpperCase(), status: entry.responseStatus || 0, path: path.slice(0, 120), fields });
    if (summaries.length >= 6) break;
  }
  return summaries;
}

/** Safe shape-only diagnostics for captured responses. Never include response
 * values, headers, request bodies, or any credential-bearing text. */
function describeCapturedResponses(entries) {
  return (entries || []).slice(-12).map((entry) => {
    const body = String(entry?.responsePreview || '');
    let jsonKeys = [];
    if (body && !body.startsWith('base64:')) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          jsonKeys = Object.keys(parsed).slice(0, 24);
        }
      } catch {}
    }
    let path = String(entry?.url || '');
    try { path = new URL(path).pathname; } catch {}
    return {
      method: String(entry?.method || 'GET').toUpperCase(),
      status: Number(entry?.responseStatus) || 0,
      path: path.slice(0, 160),
      bodyLength: body.length,
      jsonKeys,
    };
  });
}

/** Safe MiniMax creation-result diagnostics. The backend wraps business
 * failures in base_resp and omits the token; expose only the numeric code and
 * short human-readable status, never arbitrary response fields or secrets. */
function describeMinimaxBackendResults(entries) {
  return (entries || [])
    .filter(entry => /\/backend\/token(?:[/?#]|$)/i.test(entry?.url || '')
      && String(entry?.method || '').toUpperCase() === 'POST')
    .map(entry => {
      let parsed = null;
      try { parsed = JSON.parse(entry.responsePreview || ''); } catch {}
      const base = parsed?.base_resp;
      if (!base || typeof base !== 'object') return null;
      const statusCode = base.status_code ?? base.code ?? null;
      const rawMessage = base.status_msg ?? base.message ?? '';
      const statusMessage = String(rawMessage || '')
        .replace(/sk-(?:api-)?[A-Za-z0-9_-]{12,}/gi, '[REDACTED]')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200);
      return { statusCode, statusMessage };
    })
    .filter(Boolean);
}

/** Return only whether a provider redacted a returned secret. This is
 * deliberately boolean-only: diagnostics must never surface credentials. */
function capturesContainMaskedSecret(entries) {
  const visit = (value, field = '', depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return false;
    if (typeof value === 'string') {
      return /secret|signature/i.test(field) && /[＊*•]/.test(value);
    }
    if (typeof value !== 'object') return false;
    return Object.entries(value).some(([key, nested]) => visit(nested, key, depth + 1));
  };
  for (const entry of entries || []) {
    const body = entry?.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    try {
      if (visit(JSON.parse(body))) return true;
    } catch {}
  }
  return false;
}
  return { extractKeyFromCaptures, extractNewestNamedKeyFromCaptures, capturesContainMistralKeyRecords, describeCapturedSecretFields, describeCapturedResponses, describeMinimaxBackendResults, capturesContainMaskedSecret };
}
module.exports = { createCaptureExtractor };
