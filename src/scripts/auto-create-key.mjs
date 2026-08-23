/**
 * Auto-create API key — Playwright bundled Chromium with saved login state.
 * First time: browser opens, you log in manually (one-time).
 * After that: fully automatic.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PLATFORM = process.argv[2];
const KEY_NAME = process.argv[3];

if (!PLATFORM || !KEY_NAME) {
  console.error('Usage: node auto-create-key.mjs <platform> <keyName>');
  process.exit(1);
}

const STATE_DIR = path.join(os.homedir(), '.okit', 'auto-create');
fs.mkdirSync(STATE_DIR, { recursive: true });

const PLATFORM_CONFIG = {
  volcengine: {
    name: '火山引擎',
    url: 'https://console.volcengine.com/iam/keymanage/',
    selectors: {
      createBtn: 'button:has-text("创建 API Key"), button:has-text("创建 Access Key"), button:has-text("新建密钥"), button:has-text("新建"), a:has-text("新建密钥"), button:has-text("创建密钥")',
      nameInput: 'input[placeholder*="名称"], input[placeholder*="备注"], input[id*="name"]',
      confirmBtn: 'button:has-text("确定"), button:has-text("确认"), button:has-text("创建")',
    },
    waitAfterCreate: 3000,
    extraWait: 8000, // SPA needs more time
  },
  zhipu: {
    name: '智谱AI',
    url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    selectors: {
      createBtn: 'button:has-text("新建API Key"), button:has-text("添加新的"), button:has-text("创建新"), button:has-text("新建"), a:has-text("添加新的")',
      nameInput: 'input[placeholder*="名称"], input[placeholder*="描述"], input[id*="name"]',
      confirmBtn: 'button:has-text("确定"), button:has-text("确认"), button:has-text("创建"), button:has-text("保存")',
    },
    waitAfterCreate: 3000,
  },
  minimax: {
    name: 'MiniMax',
    url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    selectors: {
      createBtn: 'button:has-text("创建 API Key"), button:has-text("创建新的"), button:has-text("Create new"), button:has-text("新建"), a:has-text("创建"), a:has-text("Create")',
      nameInput: '.ant-modal input, .ant-modal-content input, input.ant-input, input:visible',
      confirmBtn: '.ant-modal-footer button.ant-btn-primary, .ant-modal-footer button:has-text("确定"), .ant-modal-footer button:has-text("创建"), .ant-modal button[type="submit"], .ant-modal-footer button:last-child',
    },
    waitAfterCreate: 3000,
  },
};

const config = PLATFORM_CONFIG[PLATFORM];
if (!config) {
  console.log(JSON.stringify({ success: false, error: `Unknown platform: ${PLATFORM}` }));
  process.exit(1);
}

const stateFile = path.join(STATE_DIR, `${PLATFORM}-state.json`);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findElement(page, selectors, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors.split(', ')) {
      try {
        const el = page.locator(sel.trim()).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) return el;
      } catch {}
    }
    await sleep(500);
  }
  return null;
}

async function extractKeyFromPage(page) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    const jwt = bodyText.match(/(eyJ[a-zA-Z0-9\-_]{50,})/);
    if (jwt) return jwt[0];
    const sk = bodyText.match(/(sk-[a-zA-Z0-9\-]{30,})/);
    if (sk) return sk[0];
    const generic = bodyText.match(/[a-zA-Z0-9\-_.]{40,}/g);
    if (generic) {
      for (const v of generic) {
        if (v.length > 500) continue;
        if (v.startsWith('.') || v.startsWith('ant-') || v.includes('-btn') || v.includes('-color-')) continue;
        if (v.includes('font-') || v.includes('http')) continue;
        if (/^[0-9]{10,}$/.test(v)) continue;
        return v;
      }
    }
  } catch {}
  return null;
}

async function main() {
  console.error(`[auto-create] ${config.name} | key: ${KEY_NAME}`);

  // Load saved login state
  let storageState = undefined;
  if (fs.existsSync(stateFile)) {
    try {
      storageState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      console.error(`[auto-create] Loaded saved login`);
    } catch {}
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState,
  });
  const page = await context.newPage();

  // Set up network interception to capture the API key
  let capturedKey = null;
  page.on('response', async (response) => {
    try {
      const body = await response.text();
      if (body.length > 50 && body.length < 5000) {
        // Look for API key patterns in response
        const keyMatch = body.match(/"(?:key|api_key|apiKey|token|value|secret)"\s*:\s*"([^"]{20,})"/);
        if (keyMatch) {
          capturedKey = keyMatch[1];
          console.error(`[auto-create] Key captured from API: ${capturedKey.substring(0, 15)}...`);
        }
        // Also look for JWT or long tokens
        const jwt = body.match(/eyJ[a-zA-Z0-9\-_]{50,}/);
        if (jwt && !capturedKey) {
          capturedKey = jwt[0];
          console.error(`[auto-create] JWT captured: ${capturedKey.substring(0, 15)}...`);
        }
      }
    } catch {}
  });

  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(config.extraWait || 3000);

    // Wait for Cloudflare Turnstile if present
    for (let i = 0; i < 15; i++) {
      const isChallenge = await page.evaluate(() =>
        document.body.innerText.includes('安全验证') ||
        document.body.innerText.includes('Verifying')
      ).catch(() => false);
      if (!isChallenge) break;
      await sleep(3000);
    }
    await sleep(2000);

    // Check for login page
    const url = page.url();
    if (['login', 'signin', 'passport', 'auth'].some(k => url.includes(k))) {
      console.error(`[auto-create] ⚠️  Login needed! Please log in manually.`);
      try {
        await page.evaluate(() => {
          const d = document.createElement('div');
          d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f59e0b;color:#000;padding:12px 20px;text-align:center;font-size:15px;font-weight:600;';
          d.textContent = '⚡ OKIT — 请登录，登录后将自动继续';
          document.body.prepend(d);
        });
      } catch {}
      const deadLine = Date.now() + 300000;
      let loggedIn = false;
      while (Date.now() < deadLine) {
        await sleep(2000);
        if (!['login', 'signin', 'passport', 'auth'].some(k => page.url().includes(k))) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        console.log(JSON.stringify({ success: false, error: 'Login timeout (5 min).' }));
        process.exit(1);
      }
      console.error(`[auto-create] ✅ Login detected`);
      await sleep(2000);
      await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    }

    // Dismiss popups
    for (let i = 0; i < 6; i++) {
      try {
        await page.keyboard.press('Escape');
        await sleep(400);
        const closeBtns = page.locator([
          'button:has-text("我知道了")', 'button:has-text("关闭")', 'button:has-text("取消")',
          '.ant-modal-close', '[aria-label="Close"]', '.ant-modal-mask',
        ].join(', '));
        for (let j = 0; j < Math.min(await closeBtns.count(), 5); j++) {
          try { await closeBtns.nth(j).click({ timeout: 1000, force: true }); await sleep(400); } catch {}
        }
        const hasModal = await page.evaluate(() => {
          return !!document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal-content');
        });
        if (!hasModal) break;
      } catch {}
    }
    await sleep(500);

    // Click create button
    console.error(`[auto-create] Looking for create button...`);
    const createBtn = await findElement(page, config.selectors.createBtn, 15000);
    if (!createBtn) {
      await page.screenshot({ path: `/tmp/okit-${PLATFORM}-debug.png` });
      throw new Error(`Create button not found on ${config.name}`);
    }
    await createBtn.click({ force: true });
    console.error(`[auto-create] Clicked create`);
    await sleep(3000);

    if (PLATFORM === 'minimax') {
      await sleep(2000);
      try { await page.waitForSelector('.ant-modal-content', { timeout: 5000 }); } catch {}
      await sleep(1000);
      const modalInputs = config.selectors.nameInput.split(', ');
      let filled = false;
      for (const sel of modalInputs) {
        try {
          const loc = page.locator(sel.trim()).first();
          if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
            await loc.fill(KEY_NAME);
            console.error(`[auto-create] Filled: ${sel.trim()}`);
            filled = true;
            break;
          }
        } catch {}
      }
      if (!filled) {
        await page.keyboard.press('Tab');
        await sleep(300);
        await page.keyboard.type(KEY_NAME, { delay: 50 });
      }
      await sleep(500);
      const confirmBtns = config.selectors.confirmBtn.split(', ');
      let confirmed = false;
      for (const sel of confirmBtns) {
        try {
          const loc = page.locator(sel.trim()).first();
          if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
            await loc.click({ force: true, timeout: 3000 });
            console.error(`[auto-create] Confirm: ${sel.trim()}`);
            confirmed = true;
            break;
          }
        } catch {}
      }
      if (!confirmed) { await page.keyboard.press('Enter'); }
    } else {
      const ni = await findElement(page, config.selectors.nameInput, 10000);
      if (ni) {
        await ni.fill(KEY_NAME);
        console.error(`[auto-create] Name: ${KEY_NAME}`);
        await sleep(500);
        const cf = await findElement(page, config.selectors.confirmBtn, 5000);
        if (cf) { await cf.click({ force: true }); console.error(`[auto-create] Confirm`); }
        else { await page.keyboard.press('Enter'); console.error(`[auto-create] Enter`); }
      }
    }

    await sleep(config.waitAfterCreate);

    // Use captured key from network, fall back to page extraction
    const keyValue = capturedKey || await extractKeyFromPage(page);
    if (keyValue) {
      console.error(`[auto-create] ✅ Key: ${keyValue.substring(0, 10)}...`);
      console.log(JSON.stringify({ success: true, value: keyValue, name: KEY_NAME, platform: PLATFORM }));
    } else {
      await page.screenshot({ path: `/tmp/okit-${PLATFORM}-result.png` });
      throw new Error('Key value not found');
    }

    // Save login state
    const state = await context.storageState();
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch (err) {
    console.error(`[auto-create] ❌ ${err.message}`);
    console.log(JSON.stringify({ success: false, error: err.message }));
  } finally {
    await browser.close().catch(() => {});
    console.error(`[auto-create] Done.`);
  }
}

main();
