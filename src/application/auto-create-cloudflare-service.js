// Direct Cloudflare key lifecycle; HTTP transport is injected for testability.
function createCloudflareKeyService({ https }) {
async function createCloudflareToken({ parentToken, tokenName }) {
  const body = JSON.stringify({
    name: tokenName,
    policies: [{
      effect: 'allow',
      permission_groups: [
        { id: 'c8fed203ed3043cba015a93ad1616f1f' },
        { id: '82e64a83756745bbbb1c9c2701bf816b' },
      ],
      resources: { 'com.cloudflare.api.account.*': '*' },
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${parentToken}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) resolve({ value: json.result.value, name: json.result.name, id: json.result.id });
          else reject(new Error(json.errors?.[0]?.message || 'Cloudflare API error'));
        } catch { reject(new Error('Failed to parse Cloudflare response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deleteCloudflareToken({ parentToken, tokenId }) {
  if (!parentToken || !tokenId) throw new Error('Cloudflare 删除测试 Token 缺少 parentToken 或 tokenId');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/user/tokens/${encodeURIComponent(tokenId)}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${parentToken}` },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300 && json.success !== false) return resolve(json);
          reject(new Error(json.errors?.[0]?.message || `Cloudflare 删除失败（HTTP ${res.statusCode}）`));
        } catch { reject(new Error('Cloudflare 删除接口返回了无效 JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Zhipu (智谱AI) — atomic-capability orchestration ──────────────
// Orchestrates the zhipu API key creation flow by composing generic
// extension atoms (navigate / exec / network-capture-*). The extension
// knows nothing about zhipu — all platform specifics live here.
//
// Flow: navigate → arm network capture → dismiss popups → click "create"
//       → fill name → click "confirm" → read captured API response → extract key.

// Selectors derived from the proven Playwright script (src/scripts/auto-create-key.mjs).
  return { createCloudflareToken, deleteCloudflareToken };
}

module.exports = { createCloudflareKeyService };
