const fetch = require('node-fetch');
const crypto = require('crypto');

const BUCKET_NAME = 'okit-sync';
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

function normalizeConfig(config) {
  const normalized = { ...config };
  normalized.accountId = String(normalized.accountId || '').trim();
  normalized.r2AccessKeyId = String(normalized.r2AccessKeyId || '').trim();
  normalized.r2SecretAccessKey = String(normalized.r2SecretAccessKey || '').trim();
  return normalized;
}

function assertConfig(config) {
  if (!config.accountId) throw new Error('请配置 Account ID');
  if (!ACCOUNT_ID_RE.test(config.accountId)) {
    throw new Error('R2 Account ID 格式不正确，请填写 Cloudflare R2 S3 API 页面显示的 32 位 Account ID，不要填写 cf_account_id 或普通 API Token');
  }
  if (!config.r2AccessKeyId || !config.r2SecretAccessKey) {
    throw new Error('请配置 R2 Access Key ID 和 Secret Access Key');
  }
}

function signRequest(method, host, path, config, extraHeaders, payloadHash) {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = date.slice(0, 8);

  const headerEntries = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
    ...extraHeaders,
  };
  const sortedKeys = Object.keys(headerEntries).sort();
  const signedHeaders = sortedKeys.join(';');
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headerEntries[k]}`).join('\n');

  const canonicalRequest = [
    method, path, '',
    canonicalHeaders, '', signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${shortDate}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const signingKey = [shortDate, 'auto', 's3', 'aws4_request']
    .reduce((k, msg) => crypto.createHmac('sha256', k).update(msg).digest(), 'AWS4' + config.r2SecretAccessKey);

  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${config.r2AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...extraHeaders,
    },
  };
}

async function s3ListBuckets(config) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const { headers } = signRequest('GET', host, '/', config, {}, 'UNSIGNED-PAYLOAD');

  const res = await fetch(`https://${host}/`, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 认证失败 (${res.status}): 请检查 Account ID、Access Key ID 和 Secret Access Key 是否正确`);
  }
  const text = await res.text();
  return [...text.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
}

async function s3CreateBucket(config) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const body = `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></CreateBucketConfiguration>`;
  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex');
  const { headers } = signRequest('PUT', host, `/${BUCKET_NAME}`, config, {}, contentSha256);

  const res = await fetch(`https://${host}/${BUCKET_NAME}`, {
    method: 'PUT',
    body,
    headers: { ...headers, 'Content-Type': 'application/xml' },
  });
  // 409 = bucket already exists, which is fine
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`R2 create bucket failed: ${res.status} ${text}`);
  }
}

async function s3PutObject(config, key, body) {
  const host = `${BUCKET_NAME}.${config.accountId}.r2.cloudflarestorage.com`;
  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex');
  const { headers } = signRequest('PUT', host, `/${key}`, config, {}, contentSha256);

  const res = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    body,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed: ${res.status} ${text}`);
  }
}

async function s3GetObject(config, key) {
  const host = `${BUCKET_NAME}.${config.accountId}.r2.cloudflarestorage.com`;
  const { headers } = signRequest('GET', host, `/${key}`, config, {}, 'UNSIGNED-PAYLOAD');

  const res = await fetch(`https://${host}/${key}`, { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 GET failed: ${res.status} ${text}`);
  }
  const text = await res.text();
  return JSON.parse(text);
}

async function testConnection(config) {
  config = normalizeConfig(config);
  assertConfig(config);
  const buckets = await s3ListBuckets(config);
  const found = buckets.includes(BUCKET_NAME);
  if (!found) await s3CreateBucket(config);
  return `Cloudflare R2 连接成功 (Bucket: ${BUCKET_NAME})`;
}

async function pushSync(config, userId, encryptedBlob) {
  config = normalizeConfig(config);
  assertConfig(config);
  await s3CreateBucket(config);
  const key = `sync/${userId}.json`;
  await s3PutObject(config, key, JSON.stringify(encryptedBlob));
}

async function pullSync(config, userId) {
  config = normalizeConfig(config);
  assertConfig(config);
  const key = `sync/${userId}.json`;
  return await s3GetObject(config, key);
}

module.exports = { name: 'Cloudflare R2', testConnection, pushSync, pullSync };
