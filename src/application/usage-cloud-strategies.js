// Cloud-control-plane usage strategies (AK/SK or management credentials).
function createUsageCloudStrategies(deps) {
  const { resolveCredentialPair, resolveVaultKey, httpRequest, accountBalanceResult, managementCredentialNotice, round1, epochToISO } = deps;
async function resolveVolcCredentials() {
  const credentials = await resolveCredentialPair({
    combined: ['VOLCENGINE_BILLING_CREDENTIALS', 'VOLCENGINE_CREDENTIALS'],
    accessKey: ['VOLC_ARK_AK', 'VOLCENGINE_ACCESS_KEY'],
    secretKey: ['VOLC_ARK_SK', 'VOLCENGINE_SECRET_KEY'],
  });
  return credentials;
}

async function queryVolcengineBalance() {
  const credentials = await resolveVolcCredentials();
  if (!credentials) return managementCredentialNotice('火山引擎', ['VOLCENGINE_BILLING_CREDENTIALS（请按文档手动录入）', 'VOLCENGINE_ACCESS_KEY', 'VOLCENGINE_SECRET_KEY'], 'https://console.volcengine.com/iam/keymanage/');
  const result = await callVolcApi(credentials.accessKey, credentials.secretKey, 'QueryBalanceAcct', {
    service: 'billing',
    version: '2022-01-01',
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) return {
    supported: true,
    windows: [],
    error: '火山引擎 AK/SK 无费用中心查询权限。请给当前 IAM 用户授予 BillingCenterReadOnlyAccess（仅查询余额），或按需授予 BillingCenterFullAccess；无需再创建主账号 Access Key。',
  };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };
  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: '火山引擎余额接口返回了无效 JSON' }; }
  const root = data.Result || data.result || data;
  const parsed = accountBalanceResult(root.AvailableBalance ?? root.availableBalance, 'CNY', data);
  return parsed || { supported: true, windows: [], error: '火山引擎余额接口暂未返回可识别余额' };
}

async function queryVolcengineUsage(plan = 'coding') {
  // Resolve only explicitly named Volcengine credentials. A local Vault name
  // is not provider-side synchronization, so KMS entries must never be
  // treated as Volcengine AK/SK merely because their old name looks similar.
  const combined = await resolveVolcCredentials();
  let ak = combined?.accessKey || await resolveVaultKey('VOLC_ARK_AK') || await resolveVaultKey('VOLC_ARK_AK-default');
  let sk = combined?.secretKey || await resolveVaultKey('VOLC_ARK_SK') || await resolveVaultKey('VOLC_ARK_SK-default');
  if (!ak || !sk) return { supported: true, windows: [], error: '未找到火山引擎 AK/SK，请按文档手动添加 VOLCENGINE_BILLING_CREDENTIALS，或分别添加 VOLC_ARK_AK 和 VOLC_ARK_SK' };

  if (plan === 'agent') {
    // Agent Plan exposes absolute quota windows through GetAFPUsage.
    const afpResult = await callVolcApi(ak, sk, 'GetAFPUsage');
    if (afpResult.error) return { supported: true, windows: [], error: afpResult.error };
    if (afpResult.status === 403) return { supported: true, windows: [], error: 'AK/SK 无 ark 服务权限，请授予 ArkReadOnlyAccess' };
    if (afpResult.status !== 200) return { supported: true, windows: [], error: `HTTP ${afpResult.status}` };

    const afpData = JSON.parse(afpResult.body);
    const result = afpData.Result || {};
    const windows = [];
    const tiers = [
      { key: 'AFPFiveHour', label: '5h' },
      { key: 'AFPWeekly', label: 'weekly' },
      { key: 'AFPMonthly', label: 'monthly' },
    ];
    for (const tier of tiers) {
      const w = result[tier.key];
      if (w && w.Quota > 0) {
        windows.push({
          label: tier.label,
          usedPercent: round1((w.Used / w.Quota) * 100),
          resetAt: w.ResetTime ? epochToISO(w.ResetTime) : null,
        });
      }
    }
    return windows.length
      ? { supported: true, windows, raw: afpData }
      : { supported: true, windows: [], error: '当前账号未开通火山引擎 Agent Plan，或接口未返回额度' };
  }

  // Coding Plan exposes percentage windows through GetCodingPlanUsage.
  const cpResult = await callVolcApi(ak, sk, 'GetCodingPlanUsage');
  if (cpResult.error) return { supported: true, windows: [], error: cpResult.error };
  if (cpResult.status !== 200) {
    if (cpResult.status === 403) return { supported: true, windows: [], error: 'AK/SK 无 ark 服务权限' };
    return { supported: true, windows: [], error: `HTTP ${cpResult.status}` };
  }

  const cpData = JSON.parse(cpResult.body);
  const cpResult2 = cpData.Result || {};
  const quotaUsage = cpResult2.QuotaUsage || [];
  const windows = quotaUsage.map(q => ({
    label: q.Level === 'session' ? '5h' : q.Level === 'weekly' ? 'weekly' : q.Level === 'monthly' ? 'monthly' : q.Level,
    // Percent is a 0-1 decimal, multiply by 100.
    usedPercent: round1((q.Percent || 0) * 100),
    resetAt: q.ResetTimestamp ? epochToISO(q.ResetTimestamp) : null,
  })).filter(w => w.usedPercent !== null);

  return windows.length
    ? { supported: true, windows, raw: cpData }
    : { supported: true, windows: [], error: '当前账号未开通火山引擎 Coding Plan，或接口未返回额度' };
}

// Volcengine Signature V4 signer + API caller.
function callVolcApi(ak, sk, action, options = {}) {
  const crypto = require('crypto');
  return new Promise(resolve => {
    const now = new Date();
    const xDate = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const shortDate = xDate.slice(0, 8);
    const region = options.region || 'cn-beijing';
    const service = options.service || 'ark';
    const host = 'open.volcengineapi.com';
    const version = options.version || '2024-01-01';
    const canonicalQuery = `Action=${action}&Region=${region}&Version=${version}`;
    const body = '';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const signedHeaders = 'host;x-content-sha256;x-date';
    const canonicalHeaders = `host:${host}\nx-content-sha256:${bodyHash}\nx-date:${xDate}\n`;
    const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
    const credentialScope = `${shortDate}/${region}/${service}/request`;
    const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    // Volcengine variant: kDate = HMAC(SK, date) — no prefix, no AWS4.
    const kDate = crypto.createHmac('sha256', sk).update(shortDate).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = require('https').request(`https://${host}/?${canonicalQuery}`, {
      method: 'POST',
      headers: { Host: host, 'X-Date': xDate, 'X-Content-Sha256': bodyHash, Authorization: authorization, 'Content-Type': 'application/json' },
      timeout: 10000,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}

function queryConsoleOnlyUsage(label, url, detail) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    refreshPolicy: 'never',
    notice: detail || `${label}当前没有公开的个人余额查询接口，请在控制台 Billing/用量页面查看。`,
    action: { label: `打开${label}控制台`, url },
  };
}

// ── Dispatcher ───────────────────────────────────────────────

  return { queryVolcengineBalance, queryVolcengineUsage, queryConsoleOnlyUsage };
}

module.exports = { createUsageCloudStrategies };
