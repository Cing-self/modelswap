const { VaultStore } = require('../../vault/store');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {
  QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint,
  isQianfanCodingAnthropicEndpoint,
  qianfanCodingErrorCode,
  qianfanCodingErrorMessage,
} = require('./qianfan-coding');
const {
  getAnthropicAuthMode,
  getAuthenticatedResourceFailureMessage,
  getProbeModels,
  requiresInferenceProbe,
  isModelAccessFailure,
} = require('./endpoint-profiles');
const { appendLog: appendVaultLog } = require('./log-writer');

const store = new VaultStore();

/** Safely find files by name using Node.js fs (no shell, no command injection). */
function safeFindFiles(baseDir, targetNames, maxDepth) {
  const results = [];
  const nameSet = new Set(Array.isArray(targetNames) ? targetNames : [targetNames]);
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && nameSet.has(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(fullPath, depth + 1);
      }
    }
  }
  walk(baseDir, 0);
  return results;
}

// List all vault entries
async function listVault(req, res) {
  try {
    const entries = await store.list();
    const secrets = entries.map(entry => ({
      ...entry,
      group: normalizeVaultGroup(entry.group, entry.key),
    }));
    res.json({ secrets, totalBindings: 0 });
  } catch (error) {
    console.error('Error listing vault:', error);
    res.status(500).json({ error: 'Failed to list vault' });
  }
}

async function setVault(req, res) {
  try {
    const { key, value, desc, group, expiresAt, originalKey } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: 'key and value are required' });
    }
    const isEditMove = originalKey && originalKey !== key;

    if (isEditMove) {
      const oldValue = await store.get(originalKey);
      if (oldValue === null) {
        return res.status(404).json({ error: 'Original secret not found' });
      }

      const existingTarget = await store.get(key);
      if (existingTarget !== null) {
        return res.status(409).json({ error: 'Target secret already exists' });
      }
    }

    await store.set(key, value, normalizeVaultGroup(group, key), expiresAt, desc);
    if (isEditMove) {
      await store.delete(originalKey);
    }
    appendVaultLog('vault-set', key, true);
    res.json({ success: true, key, desc: desc || '' });

    // Auto-sync scheduler: debounced encrypted push (fire-and-forget)
    require('./sync-scheduler').markDirty('secrets');
  } catch (error) {
    console.error('Error setting vault:', error);
    appendVaultLog('vault-set', req.body.key || '', false, error.message);
    res.status(500).json({ error: 'Failed to set secret' });
  }
}

async function deleteVault(req, res) {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const deleted = await store.delete(key);
    if (deleted) {
      appendVaultLog('vault-delete', key, true);
      res.json({ success: true });
      require('./sync-scheduler').markDirty('secrets');
    } else {
      res.status(404).json({ error: 'Secret not found' });
    }
  } catch (error) {
    console.error('Error deleting vault:', error);
    appendVaultLog('vault-delete', req.body.key || '', false, error.message);
    res.status(500).json({ error: 'Failed to delete secret' });
  }
}

async function exportVault(req, res) {
  try {
    const secrets = await store.exportAll();
    const bindings = await store.getBindings();
    const data = { secrets, bindings, exportedAt: new Date().toISOString() };
    res.setHeader('Content-Disposition', 'attachment; filename="okit-vault-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
  } catch (error) {
    console.error('Error exporting vault:', error);
    res.status(500).json({ error: 'Failed to export vault' });
  }
}

async function importVault(req, res) {
  try {
    const { secrets } = req.body;
    if (!Array.isArray(secrets) || secrets.length === 0) {
      return res.status(400).json({ error: 'No secrets provided' });
    }
    let imported = 0;
    let skipped = 0;
    for (const s of secrets) {
      if (!s.key) { skipped++; continue; }
      const existing = await store.get(s.key);
      if (existing) { skipped++; continue; }
      if (s.value) {
        await store.set(s.key, s.value, s.group, s.expiresAt, s.desc);
        imported++;
      } else {
        skipped++;
      }
    }
    res.json({ success: true, imported, skipped, total: secrets.length });
    if (imported > 0) require('./sync-scheduler').markDirty('secrets');
  } catch (error) {
    console.error('Error importing vault:', error);
    res.status(500).json({ error: 'Failed to import vault' });
  }
}

async function getVaultValue(req, res) {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const value = await store.get(key);
    if (value === null) return res.status(404).json({ error: 'Secret not found' });
    res.json({ value });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get secret' });
  }
}

async function testApiKey(req, res) {
  const { baseUrl, type, protocol, keyValue, vaultKey } = req.body;
  if (!baseUrl) {
    return res.status(400).json({ success: false, message: '缺少 baseUrl' });
  }

  let resolvedKey = keyValue;
  if (!resolvedKey && vaultKey) {
    try {
      await store.reload();
      resolvedKey = await store.get(vaultKey);
    } catch (err) {
      console.error('resolveVaultKey error:', err);
    }
  }
  if (!resolvedKey) {
    // ChatGPT/Codex OAuth endpoints don't use an API key — the access token
    // lives in ~/.codex/auth.json. Probe that path before giving up so the
    // UI can show a meaningful status for the openai-codex provider.
    if (isCodexOAuthEndpoint(baseUrl)) {
      return probeCodexOAuth(res);
    }
    return res.json({ success: false, message: '无可用密钥，请先绑定 API Key' });
  }

  try {
    let url;
    const headers = {};

    if (type === 'anthropic') {
      const isZaiAnthropic = isZaiAnthropicEndpoint(baseUrl);
      const isMiniMaxAnthropic = isMiniMaxAnthropicEndpoint(baseUrl);
      const isQianfanCodingAnthropic = isQianfanCodingAnthropicEndpoint(baseUrl);
      const isZenAnthropic = /^https?:\/\/opencode\.ai\/zen\/?$/i.test(String(baseUrl || '').trim());
      if (isZaiAnthropic) {
        // Z.AI's Anthropic-compatible coding endpoint expects a GLM model
        // and the platform's standard Bearer authentication. The generic
        // Claude probe (claude-haiku + x-api-key) is not a valid Z.AI probe.
        headers['Authorization'] = `Bearer ${resolvedKey}`;
        headers['accept-language'] = 'en-US,en';
      } else if (isMiniMaxAnthropic) {
        // MiniMax documents X-Api-Key for its Anthropic-compatible API.
        // Prefer the read-only model list below so an unavailable inference
        // entitlement is not mistaken for an invalid endpoint or credential.
        headers['X-Api-Key'] = resolvedKey;
      } else if (getAnthropicAuthMode(baseUrl) === 'bearer') {
        headers['Authorization'] = `Bearer ${resolvedKey}`;
      } else {
        headers['x-api-key'] = resolvedKey;
      }
      headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';

      // Z.AI exposes a read-only model-list endpoint for its Anthropic
      // compatibility layer. Use it as the connection probe first so a
      // valid key is not reported as disconnected merely because the account
      // has no inference balance (business error 1113).
      if (isZaiAnthropic) {
        const modelsResult = await httpRequest(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
          method: 'GET',
          headers,
          timeout: 10000,
        });
        if (modelsResult.error) return res.json({ success: false, message: `连接失败: ${modelsResult.error}` });
        if (modelsResult.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        if (modelsResult.status === 200) {
          let modelCount = 0;
          try { modelCount = JSON.parse(modelsResult.body).data?.length || 0; } catch {}
          return res.json({
            success: true,
            message: `端点连接成功，Key 有效，可读取 ${modelCount} 个模型；实际对话调用仍需 Z.AI 账户资源包`,
          });
        }
        if (modelsResult.status === 429 && zaiErrorCode(modelsResult.body) === '1113') {
          return res.json({ success: false, message: '端点可达，但 Z.AI 账户余额或资源包不足（1113），请充值或开通对应资源包后重试' });
        }
        // If a deployment does not expose /v1/models, continue with the
        // protocol-compatible one-token message probe below.
      }

      if (isMiniMaxAnthropic) {
        const modelsResult = await httpRequest(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
          method: 'GET',
          headers,
          timeout: 10000,
        });
        if (modelsResult.error) return res.json({ success: false, message: `连接失败: ${modelsResult.error}` });
        if (modelsResult.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        if (modelsResult.status === 200) {
          let modelCount = 0;
          try { modelCount = JSON.parse(modelsResult.body).data?.length || 0; } catch {}
          return res.json({
            success: true,
            message: `MiniMax Anthropic 端点连接成功，Key 有效，可读取 ${modelCount} 个模型`,
          });
        }
        // Older deployments may not expose the model list. Fall back to the
        // protocol-compatible one-token message probe below.
      }

      if (isZenAnthropic) {
        // Zen multiplexes both protocols on this host and exposes a readable
        // /v1/models. Probe the list first: the generic Claude message probe
        // uses a PAID model, which the free-tier "public" key can never pass
        // — that would wrongly report a valid free key as invalid.
        const modelsResult = await httpRequest(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
          method: 'GET',
          headers,
          timeout: 10000,
        });
        if (modelsResult.error) return res.json({ success: false, message: `连接失败: ${modelsResult.error}` });
        if (modelsResult.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        if (modelsResult.status === 200) {
          let modelCount = 0;
          try { modelCount = JSON.parse(modelsResult.body).data?.length || 0; } catch {}
          return res.json({
            success: true,
            message: `Zen Anthropic 端点连接成功，Key 有效，可读取 ${modelCount} 个模型`,
          });
        }
        // Fall back to the protocol-compatible probe below.
      }

      const result = await probeAnthropicWireApi(
        baseUrl,
        headers,
        isZaiAnthropic
          ? ['glm-4.7']
          : isQianfanCodingAnthropic
            ? [QIANFAN_CODING_PROBE_MODEL]
            : undefined,
      );
      if (result.error) return res.json({ success: false, message: `连接失败: ${result.error}` });
      if (isQianfanCodingAnthropic) {
        const codingCode = qianfanCodingErrorCode(result.body);
        const codingMessage = qianfanCodingErrorMessage(codingCode);
        if (codingMessage) return res.json({ success: false, message: codingMessage });
        if (result.status === 401) return res.json({ success: false, message: '百度千帆 Token Plan API Key 无效' });
        if (result.status === 200) return res.json({ success: true, message: '百度千帆 Token Plan Anthropic 端点连接成功，Key 有效' });
        if (result.status === 400) return res.json({ success: true, message: '百度千帆 Token Plan Anthropic 端点可达，Key 已通过鉴权' });
        return res.json({ success: false, message: `HTTP ${result.status}: ${truncateBody(result.body)}` });
      }
      if (result.status === 200 || result.status === 400) return res.json({ success: true, message: '连接成功，Key 有效' });
      if (isModelAccessFailure(result.status, result.body)) {
        return res.json({ success: true, message: '端点连接成功，Key 已通过鉴权；当前套餐不包含探测模型，请以套餐模型列表为准' });
      }
      if (result.status === 401) return res.json({ success: false, message: 'API Key 无效' });
      if (isZaiAnthropic && (result.status === 429 || zaiErrorCode(result.body) === '1113')) {
        return res.json({ success: false, message: '端点可达，但 Z.AI 账户余额或资源包不足（1113），请充值或开通对应资源包后重试' });
      }
      const resourceFailureMessage = getAuthenticatedResourceFailureMessage(result.status, result.body);
      if (resourceFailureMessage) return res.json({ success: true, message: resourceFailureMessage });
      return res.json({ success: false, message: `HTTP ${result.status}: ${truncateBody(result.body)}` });
    } else {
      // Qianfan Coding Plan has its own credential scope and does not accept
      // the regular V2 API key. Probe its documented chat endpoint directly so
      // the UI can distinguish a key-scope error from a generic 401 failure.
      headers['Authorization'] = `Bearer ${resolvedKey}`;
      headers['content-type'] = 'application/json';
      if (isQianfanCodingEndpoint(baseUrl)) {
        const codingResult = await probeQianfanCodingApi(baseUrl, headers);
        if (codingResult.error) return res.json({ success: false, message: `连接失败: ${codingResult.error}` });
        const codingCode = qianfanCodingErrorCode(codingResult.body);
        const codingMessage = qianfanCodingErrorMessage(codingCode);
        if (codingMessage) return res.json({ success: false, message: codingMessage });
        if (codingResult.status === 401) return res.json({ success: false, message: '百度千帆 Token Plan API Key 无效' });
        if (codingResult.status === 200) return res.json({ success: true, message: '百度千帆 Token Plan 连接成功，Key 有效' });
        if (codingResult.status === 400) return res.json({ success: true, message: '百度千帆 Token Plan 端点可达，Key 已通过鉴权' });
        return res.json({ success: false, message: `HTTP ${codingResult.status}: ${truncateBody(codingResult.body)}` });
      }

      // Some providers expose a read-only /models route even when billable
      // inference is unavailable. For those endpoints, validate the actual
      // wire protocol directly and leave model listing to the sync action.
      if (requiresInferenceProbe(baseUrl)) {
        const probeResult = await probeOpenAIWireApi(baseUrl, headers, protocol);
        if (probeResult.error) return res.json({ success: false, message: `连接失败: ${probeResult.error}` });
        if (probeResult.status === 200 || probeResult.status === 400) {
          return res.json({ success: true, message: '连接成功，Key 有效，并已完成推理探测' });
        }
        if (isModelAccessFailure(probeResult.status, probeResult.body)) {
          return res.json({ success: true, message: 'Key 有效；当前探测模型不可用，请以平台模型列表为准' });
        }
        const resourceFailureMessage = getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body);
        if (resourceFailureMessage) return res.json({ success: true, message: resourceFailureMessage });
        if (probeResult.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        return res.json({ success: false, message: `HTTP ${probeResult.status}: ${truncateBody(probeResult.body)}` });
      }

      // openai compatible — try /models first, fallback to the selected wire API probe
      url = baseUrl.replace(/\/+$/, '') + '/models';
      let result = await httpRequest(url, { method: 'GET', headers, timeout: 10000 });

      if (result.error) {
        // Connection failed entirely, try the selected generation endpoint as fallback.
        result = await probeOpenAIWireApi(baseUrl, headers, protocol);
        if (result.error) return res.json({ success: false, message: `连接失败: ${result.error}` });
        if (result.status === 200 || result.status === 400) return res.json({ success: true, message: '连接成功，Key 有效' });
        if (isModelAccessFailure(result.status, result.body)) {
          return res.json({ success: true, message: '端点连接成功，Key 已通过鉴权；当前套餐不包含探测模型，请以套餐模型列表为准' });
        }
        const resourceFailureMessage = getAuthenticatedResourceFailureMessage(result.status, result.body);
        if (resourceFailureMessage) return res.json({ success: true, message: resourceFailureMessage });
        if (result.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        return res.json({ success: false, message: `HTTP ${result.status}: ${truncateBody(result.body)}` });
      }

      if (result.status === 401) return res.json({ success: false, message: 'API Key 无效' });
      if (result.status === 200) {
        let modelCount = 0;
        try { const d = JSON.parse(result.body); modelCount = d.data?.length || 0; } catch {}
        return res.json({ success: true, message: `连接成功，可用 ${modelCount} 个模型` });
      }
      if (result.status === 404 || result.status === 403 || result.status === 405) {
        // /models not available, try the selected generation endpoint.
        const probeResult = await probeOpenAIWireApi(baseUrl, headers, protocol);
        if (probeResult.error) return res.json({ success: false, message: `连接失败: ${probeResult.error}` });
        if (probeResult.status === 200 || probeResult.status === 400) return res.json({ success: true, message: '连接成功，Key 有效' });
        if (isModelAccessFailure(probeResult.status, probeResult.body)) {
          return res.json({ success: true, message: '端点连接成功，Key 已通过鉴权；当前套餐不包含探测模型，请以套餐模型列表为准' });
        }
        const resourceFailureMessage = getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body);
        if (resourceFailureMessage) return res.json({ success: true, message: resourceFailureMessage });
        if (probeResult.status === 401) return res.json({ success: false, message: 'API Key 无效' });
        return res.json({ success: false, message: `HTTP ${probeResult.status}: ${truncateBody(probeResult.body)}` });
      }
      return res.json({ success: false, message: `HTTP ${result.status}: ${truncateBody(result.body)}` });
    }
  } catch (err) {
    res.json({ success: false, message: `连接失败: ${err.message}` });
  }
}

// Reuse the same connection probe from non-HTTP provider flows (for example,
// automatic background revalidation before a model switch). Keeping this
// adapter here avoids duplicating the provider-specific probe rules above.
async function testApiKeyResult(payload) {
  let result;
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      result = body;
      return this;
    },
  };
  await testApiKey({ body: payload }, response);
  return result || { success: false, message: '连接测试没有返回结果' };
}

function isZaiAnthropicEndpoint(baseUrl) {
  return /^https?:\/\/api\.z\.ai\/api\/anthropic\/?$/i.test(String(baseUrl || '').trim());
}

function isMiniMaxAnthropicEndpoint(baseUrl) {
  return /^https?:\/\/api\.minimax(?:i\.com|\.io)\/anthropic\/?$/i.test(String(baseUrl || '').trim());
}

function isCodexOAuthEndpoint(baseUrl) {
  return /^https?:\/\/chatgpt\.com\/backend-api\/codex\/?/i.test(String(baseUrl || '').trim());
}

// Probe the ChatGPT/Codex OAuth token stored at ~/.codex/auth.json. The token
// is validated against the Codex backend models endpoint. Returns a meaningful
// message for each outcome (logged in, token expired, not logged in).
async function probeCodexOAuth(res) {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    await fs.ensureDir(path.dirname(authPath));
    if (!await fs.pathExists(authPath)) {
      return res.json({ success: false, message: '尚未登录 ChatGPT，请先点击 OAuth 登录' });
    }
    const content = await fs.readFile(authPath, 'utf-8');
    const data = JSON.parse(content);
    if (data.auth_mode !== 'chatgpt' || !data.tokens?.access_token) {
      return res.json({ success: false, message: '尚未登录 ChatGPT，请先点击 OAuth 登录' });
    }
    const accessToken = data.tokens.access_token;
    const result = await httpRequest('https://chatgpt.com/backend-api/codex/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'ChatGPT-Account-Id': data.account_id || '' },
      timeout: 10000,
    });
    if (result.error) return res.json({ success: false, message: `连接失败: ${result.error}` });
    if (result.status === 401 || result.status === 403) {
      return res.json({ success: false, message: 'OAuth Token 已过期，请重新登录 ChatGPT' });
    }
    if (result.status === 200) {
      let modelCount = 0;
      try { modelCount = JSON.parse(result.body).data?.length || 0; } catch {}
      return res.json({ success: true, message: `ChatGPT OAuth 连接成功，可用 ${modelCount} 个模型` });
    }
    // Some Codex backends respond 404 to /models; treat reachability + valid
    // token as success if the endpoint at least does not reject auth.
    if (result.status === 404 || result.status === 405) {
      return res.json({ success: true, message: 'ChatGPT OAuth 连接成功，Token 有效' });
    }
    return res.json({ success: false, message: `HTTP ${result.status}` });
  } catch (err) {
    return res.json({ success: false, message: `连接失败: ${err.message}` });
  }
}

function zaiErrorCode(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    const code = parsed?.error?.code ?? parsed?.code;
    return code === undefined || code === null ? '' : String(code);
  } catch {
    return '';
  }
}

async function probeOpenAIWireApi(baseUrl, headers, protocol, probeModel) {
  // Coding Plan endpoints reject the generic gpt-4o-mini model. Profiles
  // provide one or more plan-specific candidates in priority order.
  const normalizedProtocol = protocol === 'responses' ? 'responses' : 'chat';
  const models = probeModel ? [probeModel] : getProbeModels(baseUrl);
  let result;
  for (const model of models) {
    if (normalizedProtocol === 'responses') {
      const url = baseUrl.replace(/\/+$/, '') + '/responses';
      const body = JSON.stringify({ model, max_output_tokens: 1, input: 'hi' });
      result = await httpRequest(url, { method: 'POST', headers, body, timeout: 10000 });
    } else {
      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      result = await httpRequest(url, { method: 'POST', headers, body, timeout: 10000 });
    }
    if (!isModelAccessFailure(result.status, result.body)) return result;
  }
  return result;
}

async function probeAnthropicWireApi(baseUrl, headers, probeModels) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const models = probeModels?.length ? probeModels : getProbeModels(baseUrl);
  let result;
  for (const model of models) {
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    result = await httpRequest(url, { method: 'POST', headers, body, timeout: 10000 });
    if (!isModelAccessFailure(result.status, result.body)) return result;
  }
  return result;
}

function probeQianfanCodingApi(baseUrl, headers) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({
    model: QIANFAN_CODING_PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  return httpRequest(url, { method: 'POST', headers, body, timeout: 10000 });
}

function truncateBody(body) {
  if (!body) return '';
  const s = typeof body === 'string' ? body : String(body);
  if (s.length <= 200) return s;
  return s.slice(0, 200) + '...';
}

function httpRequest(url, options) {
  return new Promise((resolve) => {
    const parsed = new (require('url').URL)(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    if (options.body) req.write(options.body);
    req.setTimeout(options.timeout || 10000, () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    req.end();
  });
}

// ── Vault group migration ────────────────────────────────────
// Remaps freeform group names to canonical "{平台} · {地域}" format.
// Matching is based on key name prefixes for 国内/国际 split.

function normalizeVaultGroup(group, key) {
  const value = String(group || '').trim();
  const normalizedKey = String(key || '').toUpperCase();

  // Kimi Coding Plan was previously assigned to the international Kimi group
  // and then temporarily to Moonshot. It is a mainland Kimi product, so repair
  // those persisted values when the key identity makes the product unambiguous.
  if (normalizedKey.startsWith('KIMI_CODE_') && [
    'Kimi 国际',
    'Kimi · 国际',
    'Moonshot',
    'Kimi 国内',
    'Kimi · 国内',
    'Kimi',
  ].includes(value)) return 'Kimi';

  const aliases = {
    '智谱AI': '智谱AI · 国内',
    '智谱 AI': '智谱AI · 国内',
    '智谱AI（国内）': '智谱AI · 国内',
    '智谱 AI（国内站）': '智谱AI · 国内',
    'Z.AI': '智谱AI · 国际',
    'Z.AI（国际）': '智谱AI · 国际',
    'Z.AI（国际站）': '智谱AI · 国际',
    'Kimi 国际': 'Moonshot',
    'Kimi · 国际': 'Moonshot',
    'Kimi 国内': 'Kimi',
    'Kimi · 国内': 'Kimi',
    '小米 MiMo Token Plan': '小米 MiMo',
    'StepFun': '阶跃星辰',
    'litellm': 'LiteLLM',
    'LiteLLM (本地)': 'LiteLLM',
    'LiteLLM（本地）': 'LiteLLM',
  };
  return aliases[value] || value;
}

function resolveCanonicalGroup(key) {
  const k = String(key || '').toUpperCase();

  // ── 国际大厂 ──
  if (k.startsWith('OPENAI_API_KEY') || k === 'OPENAI_API_KEY') return 'OpenAI';
  if (k.startsWith('ANTHROPIC')) return 'Anthropic';
  if (k.startsWith('XAI_')) return 'xAI';
  if (k.startsWith('MISTRAL_')) return 'Mistral';

  // ── 智谱/Z.AI (国内国际分站,key 不通用) ──
  if (k.startsWith('ZAI_API_KEY') || k.startsWith('ZAI_')) return '智谱AI · 国际';
  if (k.startsWith('ZHIPU_') || k.startsWith('OKIT-ZHIPU') || k.startsWith('BIGMODEL_')) return '智谱AI · 国内';

  // ── MiniMax (国内国际分站) ──
  if (k.startsWith('MINIMAX_GLOBAL') || k.startsWith('OKIT-MINIMAX-GLOBAL')) return 'MiniMax · 国际';
  if (k.startsWith('MINIMAX_') || k.startsWith('OKIT-MINIMAX')) return 'MiniMax · 国内';

  // ── Kimi / Moonshot ──
  // Kimi is the mainland API platform; Moonshot is the international API
  // platform. Kimi Coding Plan belongs to the mainland Kimi product.
  if (k.startsWith('MOONSHOT_GLOBAL')) return 'Moonshot';
  if (k.startsWith('MOONSHOT_')) return 'Moonshot';
  if (k.startsWith('KIMI_CODE_')) return 'Kimi';
  if (k.startsWith('KIMI_')) return 'Kimi';

  // ── 仅国内 ──
  if (k.startsWith('DEEPSEEK_') || k === 'OKIT-DEEPSEEK' || k.startsWith('DEEPSEEK')) return 'DeepSeek';
  if (k.startsWith('DASHSCOPE_')) return '阿里云百炼';
  if (k.startsWith('QIANFAN_') || k.startsWith('QIANFAN')) return '百度千帆';
  if (k.startsWith('VOLCENGINE_') || k === 'OKIT-VOLCENGINE' || k.startsWith('VOLC_')) return '火山引擎';
  if (k.startsWith('TENCENT_') || k.startsWith('TECENT_') || k.startsWith('TENCENT')) return '腾讯云';
  if (k.startsWith('STEPFUN_')) return '阶跃星辰';
  if (k.startsWith('XIAOMI_MIMO') || k.startsWith('XIAOMI_')) return '小米 MiMo';

  // ── 聚合/代理 ──
  if (k.startsWith('OPENROUTER_')) return 'OpenRouter';
  if (k.startsWith('SILICONFLOW_')) return '硅基流动';
  if (k.startsWith('OPENCODE_')) return 'OpenCode Go';
  if (k.startsWith('LITELLM_')) return 'LiteLLM';

  // ── 基础设施 ──
  if (k.startsWith('CF_') || k.startsWith('CLOUDFLARE')) return 'Cloudflare';

  // ── 无法归类 ──
  return null;
}

async function migrateGroups(req, res) {
  try {
    await store.reload();
    const data = await store.load();
    const changes = [];
    let migrated = 0;

    for (const s of data.secrets) {
      const canonical = resolveCanonicalGroup(s.key) || normalizeVaultGroup(s.group, s.key);
      if (canonical && canonical !== s.group) {
        const from = s.group || '(ungrouped)';
        s.group = canonical;
        changes.push({ key: s.key, from, to: canonical });
        migrated++;
      }
    }

    if (migrated > 0) {
      await store.save();
      appendVaultLog('migrate-groups', '', true, `${migrated} keys regrouped`);
      require('./sync-scheduler').markDirty('secrets');
    }

    res.json({ success: true, migrated, changes });
  } catch (error) {
    appendVaultLog('migrate-groups', '', false, error.message);
    res.status(500).json({ error: error.message });
  }
}

module.exports = { listVault, setVault, deleteVault, exportVault, importVault, getVaultValue, testApiKey, testApiKeyResult, migrateGroups };
