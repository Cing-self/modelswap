/**
 * CDP connector — ensures Chrome is running with remote debugging.
 * Cross-platform: macOS, Linux, Windows.
 */

const { execSync, spawn } = require('child_process');
const http = require('http');
const os = require('os');

const CDP_PORT = 9222;

/**
 * Check if Chrome CDP is available.
 */
function checkCDP() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Try to launch Chrome with CDP. Returns true if CDP became available.
 */
async function launchChromeCDP() {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      // macOS: try open -a (works if Chrome isn't running, or launches new window)
      execSync('open -a "Google Chrome" --args --remote-debugging-port=' + CDP_PORT, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else if (platform === 'linux') {
      // Linux: try various binary names
      for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try {
          spawn(bin, [`--remote-debugging-port=${CDP_PORT}`], {
            detached: true,
            stdio: 'ignore',
          }).unref();
          break;
        } catch {}
      }
    } else if (platform === 'win32') {
      // Windows
      for (const path of [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ]) {
        try {
          spawn(path, [`--remote-debugging-port=${CDP_PORT}`], {
            detached: true,
            stdio: 'ignore',
          }).unref();
          break;
        } catch {}
      }
    }
  } catch {
    // Launch might fail if Chrome is already running — that's ok, we check below
  }

  // Wait up to 5s for CDP to become available
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await checkCDP();
    if (status) return true;
  }
  return false;
}

/**
 * Get platform-specific instructions for enabling CDP manually.
 */
function getCDPInstructions() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return '请在终端运行：\n  open -a "Google Chrome" --args --remote-debugging-port=9222\n\n如果 Chrome 已经在运行，请先完全退出 Chrome 再运行此命令。';
  } else if (platform === 'linux') {
    return '请在终端运行：\n  google-chrome --remote-debugging-port=9222 &\n\n如果 Chrome 已经在运行，请先完全退出再启动。';
  } else {
    return `请用 --remote-debugging-port=${CDP_PORT} 参数启动 Chrome。`;
  }
}

module.exports = { checkCDP, launchChromeCDP, getCDPInstructions, CDP_PORT };
