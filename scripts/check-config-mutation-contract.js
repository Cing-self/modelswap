const fs = require('fs');
const path = require('path');

const DEPRECATED_API = /\b(?:saveConfig|saveUserConfig|updateUserConfig|patchUserConfig)\s*\(/;
const SNAPSHOT_SAVE = /(?:const|let)\s+(\w+)\s*=\s*await\s+[^;]*\bload(?:User)?Config\s*\(\)[\s\S]{0,1600}?(?:saveConfig|saveUserConfig)\s*\(\s*\1\s*[,)\n]/m;

function assertConfigMutationContract(sources) {
  const violations = [];
  for (const [file, source] of Object.entries(sources)) {
    // Agent-native adapters own different config files; their private
    // `saveConfig(data)` methods are not user.json persistence APIs.
    const userConfigSource = !file.includes('/providers/adapters/');
    if (userConfigSource && DEPRECATED_API.test(source)) {
      violations.push(`${file}: deprecated generic user config save API`);
    }
    if (userConfigSource && SNAPSHOT_SAVE.test(source)) {
      violations.push(`${file}: load→save user config snapshot`);
    }
    if (
      !file.endsWith('/infrastructure/sync-config-store.js') &&
      !file.endsWith('/config/user.ts') &&
      /(?:USER_CONFIG_PATH|user\.json)[\s\S]{0,600}\b(?:writeJson|writeFile|rename)\s*\(/m.test(source)
    ) {
      violations.push(`${file}: direct user.json write outside config store`);
    }
  }
  if (violations.length) throw new Error(violations.join('\n'));
}

function collectProductionSources(root) {
  const sources = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'frontend' || entry.name === 'generated') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) sources[full] = fs.readFileSync(full, 'utf8');
    }
  };
  visit(path.join(root, 'src'));
  return sources;
}

if (require.main === module) {
  assertConfigMutationContract(collectProductionSources(path.resolve(__dirname, '..')));
}

module.exports = { assertConfigMutationContract, collectProductionSources };
