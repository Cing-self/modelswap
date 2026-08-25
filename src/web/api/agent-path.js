// Agent CLI discovery under a crippled PATH.
//
// The desktop app is usually launched from Finder/Dock. macOS hands GUI
// processes launchd's default PATH (/usr/bin:/bin:/usr/sbin:/sbin) — every
// agent CLI installed via npm -g (nvm!), homebrew, cargo or an installer
// script is invisible to `which`, so the onboarding wizard and the launch
// button report agents as "not installed" even though they run fine in a
// terminal. Detection and launch both resolve through findCommand(), which
// runs with this augmented PATH.

const os = require('os');
const path = require('path');
const fs = require('fs');

function extraPathEntries(home = os.homedir()) {
  const entries = [];
  const push = (p) => { if (p) entries.push(p); };

  if (process.platform === 'win32') {
    push(path.join(home, 'AppData', 'Roaming', 'npm')); // npm -g default prefix
    return entries;
  }

  push('/opt/homebrew/bin');             // Apple Silicon homebrew
  push('/opt/homebrew/sbin');
  push('/usr/local/bin');                // Intel homebrew + manual installs
  push('/usr/local/sbin');
  push('/home/linuxbrew/.linuxbrew/bin');
  push(path.join(home, '.local', 'bin'));   // codex installer, pipx
  push(path.join(home, '.npm-global', 'bin'));// common custom npm prefix
  push(path.join(home, '.cargo', 'bin'));    // rust installers
  push(path.join(home, 'bin'));

  // Agent-specific installer defaults (each vendor picked its own directory):
  push(path.join(home, '.claude', 'local'));  // Claude Code native installer
  push(path.join(home, '.opencode', 'bin'));  // opencode curl installer
  push(path.join(home, '.kimi-code', 'bin'));
  push(path.join(home, '.grok', 'bin'));
  push(path.join(home, '.mimocode', 'bin'));

  // nvm keeps one bin dir per installed node version — glob them all so the
  // currently-active version's global CLIs resolve regardless of selection.
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmRoot)) {
      push(path.join(nvmRoot, v, 'bin'));
    }
  } catch { /* nvm not installed */ }

  return entries;
}

// Original PATH first (terminal-launched servers already see everything),
// then the standard install locations, deduplicated.
function augmentedPath() {
  const base = process.env.PATH || '';
  const seen = new Set();
  const parts = [];
  for (const p of base.split(path.delimiter)) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  for (const p of extraPathEntries()) {
    if (seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  return parts.join(path.delimiter);
}

function detectionEnv() {
  return { ...process.env, PATH: augmentedPath() };
}

module.exports = { augmentedPath, detectionEnv, extraPathEntries };
