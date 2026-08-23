const crypto = require('crypto');
const https = require('https');

const HOST = 'open.volcengineapi.com';
const UNSIGNABLE_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function uriEscape(value) {
  return encodeURIComponent(String(value)).replace(/[*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
  return Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null)
    .sort()
    .flatMap(key => {
      const values = Array.isArray(params[key]) ? [...params[key]].sort() : [params[key]];
      return values.map(value => `${uriEscape(key)}=${uriEscape(value)}`);
    })
    .join('&');
}

/**
 * Native implementation of the Volcengine SDK's Signature V4 request shape.
 * Keeping this deterministic and dependency-free avoids shipping the SDK's
 * obsolete axios/protobuf dependency tree in the local OKIT server.
 */
function createSignedRequest({ accessKey, secretKey, action, version, query = {}, body, region = 'cn-beijing', service = 'kms', now = new Date() }) {
  if (!accessKey || !secretKey) throw new Error('请配置 AccessKey 和 SecretKey');

  const method = body === undefined ? 'GET' : 'POST';
  const params = { ...query, Action: action, Version: version };
  const queryString = canonicalQuery(params);
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const xDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const shortDate = xDate.slice(0, 8);
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['X-Content-Sha256'] = sha256(bodyText);
  }
  headers['X-Date'] = xDate;

  const signedNames = Object.keys(headers)
    .map(key => key.toLowerCase())
    .filter(key => !UNSIGNABLE_HEADERS.has(key))
    .sort();
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = signedNames.map(key => `${key}:${lowerHeaders[key]}`).join('\n');
  const signedHeaders = signedNames.join(';');
  const bodyHash = headers['X-Content-Sha256'] || sha256('');
  const canonicalRequest = `${method}\n/\n${queryString}\n${canonicalHeaders}\n\n${signedHeaders}\n${bodyHash}`;
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const kDate = hmac(secretKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.Authorization = `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { method, path: `/?${queryString}`, headers, bodyText, canonicalRequest };
}

async function requestOpenApi(options) {
  const signed = createSignedRequest(options);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path: signed.path,
      method: signed.method,
      headers: signed.headers,
      timeout: 10000,
    }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch {
          reject(new Error(`火山引擎接口返回了无效 JSON（HTTP ${res.statusCode || 0}）`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('火山引擎接口请求超时')));
    if (signed.bodyText) req.write(signed.bodyText);
    req.end();
  });
}

module.exports = { createSignedRequest, requestOpenApi };
