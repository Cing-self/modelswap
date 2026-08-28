/**
 * Normalize unknown promise-rejection values at HTTP boundaries. JavaScript
 * permits `throw undefined` and `Promise.reject('text')`; controller code
 * must never turn either into a second exception while composing a response.
 */
const INTERNAL_ERROR = 'Internal server error';

function readProperty(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return value[key]; } catch { return undefined; }
}

function safeStatus(value) {
  const status = readProperty(value, 'status');
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

function safeCode(value) {
  const code = readProperty(value, 'code');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : undefined;
}

function redactSensitive(text) {
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[ _-]?key|token|secret|password|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    .slice(0, 280);
}

function safeClientMessage(value) {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : readProperty(value, 'message');
  return typeof message === 'string' && message.trim() ? redactSensitive(message.trim()) : undefined;
}

function describeRejection(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (value instanceof Error) return `error:${value.name || 'Error'}`;
  return typeof value;
}

function normalizeApiError(value) {
  const status = safeStatus(value) || 500;
  const code = status >= 500 ? 'INTERNAL_ERROR' : (safeCode(value) || 'REQUEST_FAILED');
  return {
    status,
    code,
    // Server faults intentionally never echo an arbitrary dependency's
    // message. A valid 4xx can keep its product-facing validation message.
    error: status >= 500 ? INTERNAL_ERROR : (safeClientMessage(value) || 'Request failed'),
    kind: describeRejection(value),
  };
}

function sendApiError(res, value, requestId) {
  const normalized = normalizeApiError(value);
  // Keep the operator signal correlated but never print rejection content,
  // which can contain an Authorization header or a fixture/API key.
  console.error(`[api-error] request=${requestId || 'untracked'} status=${normalized.status} code=${normalized.code} kind=${normalized.kind}`);
  return res.status(normalized.status).json({ error: normalized.error, code: normalized.code });
}

function modelDiscoveryFailure() {
  // Warmup results are sent back to the renderer. Do not feed an arbitrary
  // rejected value into that response; its structured code is the diagnostic.
  return { code: 'MODEL_DISCOVERY_FAILED', error: 'Model discovery failed' };
}

module.exports = { describeRejection, normalizeApiError, sendApiError, modelDiscoveryFailure };
