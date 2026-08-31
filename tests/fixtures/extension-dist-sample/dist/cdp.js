/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */
const attached = new Set();
const networkCaptures = new Map();
/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url) {
    if (!url)
        return true; // empty/undefined = tab still loading, allow it
    return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}
export async function ensureAttached(tabId, aggressiveRetry = false) {
    // Verify the tab URL is debuggable before attempting attach
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!isDebuggableUrl(tab.url)) {
            // Invalidate cache if previously attached
            attached.delete(tabId);
            throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
        }
    }
    catch (e) {
        // Re-throw our own error, catch only chrome.tabs.get failures
        if (e instanceof Error && e.message.startsWith('Cannot debug tab'))
            throw e;
        attached.delete(tabId);
        throw new Error(`Tab ${tabId} no longer exists`);
    }
    if (attached.has(tabId)) {
        // Verify the debugger is still actually attached by sending a harmless command
        try {
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: '1', returnByValue: true,
            });
            return; // Still attached and working
        }
        catch {
            // Stale cache entry — need to re-attach
            attached.delete(tabId);
        }
    }
    // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
    // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
    // Normal commands: 2 retries, 500ms delay (fast fail for non-operate use)
    // Operate commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
    const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
    const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
        try {
            // Force detach first to clear any stale state from other extensions
            try {
                await chrome.debugger.detach({ tabId });
            }
            catch { /* ignore */ }
            await chrome.debugger.attach({ tabId }, '1.3');
            lastError = '';
            break; // Success
        }
        catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            if (attempt < MAX_ATTACH_RETRIES) {
                console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                // Re-verify tab URL before retrying (it may have changed)
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (!isDebuggableUrl(tab.url)) {
                        lastError = `Tab URL changed to ${tab.url} during retry`;
                        break; // Don't retry if URL became un-debuggable
                    }
                }
                catch {
                    lastError = `Tab ${tabId} no longer exists`;
                    break;
                }
            }
        }
    }
    if (lastError) {
        // Log detailed diagnostics for debugging extension conflicts
        let finalUrl = 'unknown';
        let finalWindowId = 'unknown';
        try {
            const tab = await chrome.tabs.get(tabId);
            finalUrl = tab.url ?? 'undefined';
            finalWindowId = String(tab.windowId);
        }
        catch { /* tab gone */ }
        console.warn(`[opencli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);
        const hint = lastError.includes('chrome-extension://')
            ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
            : '';
        throw new Error(`attach failed: ${lastError}${hint}`);
    }
    attached.add(tabId);
    try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    }
    catch {
        // Some pages may not need explicit enable
    }
}
export async function evaluate(tabId, expression, aggressiveRetry = false) {
    // Retry the entire evaluate (attach + command).
    // Normal: 2 retries. Operate: 3 retries (tolerates extension interference).
    const MAX_EVAL_RETRIES = aggressiveRetry ? 3 : 2;
    for (let attempt = 1; attempt <= MAX_EVAL_RETRIES; attempt++) {
        try {
            await ensureAttached(tabId, aggressiveRetry);
            const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
            });
            if (result.exceptionDetails) {
                const errMsg = result.exceptionDetails.exception?.description
                    || result.exceptionDetails.text
                    || 'Eval error';
                throw new Error(errMsg);
            }
            return result.result?.value;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Only retry on attach/debugger errors, not on JS eval errors
            const isNavigateError = msg.includes('Inspected target navigated') || msg.includes('Target closed');
            const isAttachError = isNavigateError || msg.includes('attach failed') || msg.includes('Debugger is not attached')
                || msg.includes('chrome-extension://');
            if (isAttachError && attempt < MAX_EVAL_RETRIES) {
                attached.delete(tabId); // Force re-attach on next attempt
                // SPA navigations recover quickly; debugger detach needs longer
                const retryMs = isNavigateError ? 200 : 500;
                await new Promise(resolve => setTimeout(resolve, retryMs));
                continue;
            }
            throw e;
        }
    }
    throw new Error('evaluate: max retries exhausted');
}
export const evaluateAsync = evaluate;
/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(tabId, options = {}) {
    await ensureAttached(tabId);
    const format = options.format ?? 'png';
    // For full-page screenshots, get the full page dimensions first
    if (options.fullPage) {
        // Get full page metrics
        const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        if (size) {
            // Set device metrics to full page size
            await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
                mobile: false,
                width: Math.ceil(size.width),
                height: Math.ceil(size.height),
                deviceScaleFactor: 1,
            });
        }
    }
    try {
        const params = { format };
        if (format === 'jpeg' && options.quality !== undefined) {
            params.quality = Math.max(0, Math.min(100, options.quality));
        }
        const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
        return result.data;
    }
    finally {
        // Reset device metrics if we changed them for full-page
        if (options.fullPage) {
            await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => { });
        }
    }
}
/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(tabId, files, selector) {
    await ensureAttached(tabId);
    // Enable DOM domain (required for DOM.querySelector and DOM.setFileInputFiles)
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    // Get the document root
    const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument');
    // Find the file input element
    const query = selector || 'input[type="file"]';
    const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: query,
    });
    if (!result.nodeId) {
        throw new Error(`No element found matching selector: ${query}`);
    }
    // Set files directly via CDP — Chrome reads from local filesystem
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
        files,
        nodeId: result.nodeId,
    });
}
export async function insertText(tabId, text) {
    await ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}
function normalizeCapturePatterns(pattern) {
    return String(pattern || '')
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean);
}
function shouldCaptureUrl(url, patterns) {
    if (!url)
        return false;
    if (!patterns.length)
        return true;
    return patterns.some((pattern) => url.includes(pattern));
}
function normalizeHeaders(headers) {
    if (!headers || typeof headers !== 'object')
        return {};
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[String(key)] = String(value);
    }
    return out;
}
function getOrCreateNetworkCaptureEntry(tabId, requestId, fallback) {
    const state = networkCaptures.get(tabId);
    if (!state)
        return null;
    const existingIndex = state.requestToIndex.get(requestId);
    if (existingIndex !== undefined) {
        return state.entries[existingIndex] || null;
    }
    const url = fallback?.url || '';
    if (!shouldCaptureUrl(url, state.patterns))
        return null;
    const entry = {
        kind: 'cdp',
        url,
        method: fallback?.method || 'GET',
        requestHeaders: fallback?.requestHeaders || {},
        timestamp: Date.now(),
    };
    state.entries.push(entry);
    state.requestToIndex.set(requestId, state.entries.length - 1);
    return entry;
}
export async function startNetworkCapture(tabId, pattern) {
    await ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    networkCaptures.set(tabId, {
        patterns: normalizeCapturePatterns(pattern),
        entries: [],
        requestToIndex: new Map(),
        pendingBodyReads: new Set(),
    });
}
export async function readNetworkCapture(tabId) {
    const state = networkCaptures.get(tabId);
    if (!state)
        return [];
    // Network.responseReceived arrives before loadingFinished, and the response
    // body is fetched asynchronously from CDP. Wait for all body reads already
    // scheduled for this capture before draining it; otherwise callers can see
    // a 200 status with an empty responsePreview and lose a one-time API key.
    // Give the event queue a short settle window as well: a read request can be
    // issued in the narrow gap between responseReceived and loadingFinished,
    // before the body-read promise has been registered.
    await new Promise(resolve => setTimeout(resolve, 75));
    if (state.pendingBodyReads.size > 0) {
        await Promise.all([...state.pendingBodyReads]);
    }
    const entries = state.entries.slice();
    state.entries = [];
    state.requestToIndex.clear();
    return entries;
}
export async function detach(tabId) {
    if (!attached.has(tabId))
        return;
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    try {
        await chrome.debugger.detach({ tabId });
    }
    catch { /* ignore */ }
}
export function registerListeners() {
    chrome.tabs.onRemoved.addListener((tabId) => {
        attached.delete(tabId);
        networkCaptures.delete(tabId);
    });
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId) {
            attached.delete(source.tabId);
            networkCaptures.delete(source.tabId);
        }
    });
    // Invalidate attached cache when tab URL changes to non-debuggable
    chrome.tabs.onUpdated.addListener(async (tabId, info) => {
        if (info.url && !isDebuggableUrl(info.url)) {
            await detach(tabId);
        }
    });
    chrome.debugger.onEvent.addListener(async (source, method, params) => {
        const tabId = source.tabId;
        if (!tabId)
            return;
        const state = networkCaptures.get(tabId);
        if (!state)
            return;
        if (method === 'Network.requestWillBeSent') {
            const requestId = String(params?.requestId || '');
            const request = params?.request;
            const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
                url: request?.url,
                method: request?.method,
                requestHeaders: normalizeHeaders(request?.headers),
            });
            if (!entry)
                return;
            entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
            entry.requestBodyPreview = String(request?.postData || '').slice(0, 4000);
            try {
                const postData = await chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId });
                if (postData?.postData) {
                    entry.requestBodyKind = 'string';
                    entry.requestBodyPreview = postData.postData.slice(0, 4000);
                }
            }
            catch {
                // Optional; some requests do not expose postData.
            }
            return;
        }
        if (method === 'Network.responseReceived') {
            const requestId = String(params?.requestId || '');
            const response = params?.response;
            const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
                url: response?.url,
            });
            if (!entry)
                return;
            entry.responseStatus = response?.status;
            entry.responseContentType = response?.mimeType || '';
            entry.responseHeaders = normalizeHeaders(response?.headers);
            return;
        }
        if (method === 'Network.loadingFinished') {
            const requestId = String(params?.requestId || '');
            const stateEntryIndex = state.requestToIndex.get(requestId);
            if (stateEntryIndex === undefined)
                return;
            const entry = state.entries[stateEntryIndex];
            if (!entry)
                return;
            const bodyRead = (async () => {
                try {
                    const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId });
                    if (typeof body?.body === 'string') {
                        entry.responsePreview = body.base64Encoded
                            ? `base64:${body.body.slice(0, 4000)}`
                            : body.body.slice(0, 4000);
                    }
                }
                catch {
                    // Optional; bodies are unavailable for some requests (e.g. uploads).
                }
            })();
            state.pendingBodyReads.add(bodyRead);
            void bodyRead.then(() => state.pendingBodyReads.delete(bodyRead), () => state.pendingBodyReads.delete(bodyRead));
        }
    });
}
