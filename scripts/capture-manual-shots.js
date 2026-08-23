// Captures product screenshots for the user manual (docs/manual/images).
//
// Prerequisites: OKIT web running with the build you want to shoot:
//   node dist/main.js web        (from the repo root, port 3780)
//
// Usage: node scripts/capture-manual-shots.js
// Env:   OKIT_BASE (default http://localhost:3780), SHOTS (comma list to filter)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.OKIT_BASE || 'http://localhost:3780';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'manual', 'images');
const FILTER = process.env.SHOTS ? process.env.SHOTS.split(',').map((s) => s.trim()) : null;

// name → { path, click?, scrollTo? } — shots with `click` open a dialog,
// shots with `scrollTo` scroll a section into view before capturing.
const SHOTS = [
  { name: 'quick-start', path: '/' },
  { name: 'vault', path: '/vault' },
  { name: 'vault-detail', path: '/vault', skip: true }, // reserved
  { name: 'auto-create', path: '/vault', clickText: '添加' },
  { name: 'models', path: '/models' },
  { name: 'usage', path: '/usage' },
  // /agents redirects to the home page (agents live in its tabs) — shoot the
  // agent config section scrolled into view instead of a duplicate hero shot.
  { name: 'agents', path: '/?tab=agents', scrollToText: 'AGENT' },
  { name: 'catalog', path: '/catalog' },
  { name: 'settings', path: '/settings?section=sync' },
  { name: 'snapshots', path: '/settings?section=snapshots' },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  });
  // Force Chinese UI + light theme before any app code runs.
  await context.addInitScript(() => {
    localStorage.setItem('okit-lang', 'zh');
    localStorage.setItem('okit-theme', 'light');
  });
  const page = await context.newPage();

  for (const shot of SHOTS) {
    if (shot.skip || (FILTER && !FILTER.includes(shot.name))) continue;
    const url = BASE + shot.path;
    process.stdout.write(`shooting ${shot.name} … `);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    if (shot.clickText) {
      await page.getByRole('button', { name: shot.clickText }).first().click();
      await page.waitForTimeout(900);
    }
    if (shot.scrollToText) {
      await page.getByText(shot.scrollToText, { exact: false }).first()
        .scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -70));
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: path.join(OUT_DIR, `${shot.name}.png`) });
    process.stdout.write('done\n');
  }

  await browser.close();
  console.log(`\nSaved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
