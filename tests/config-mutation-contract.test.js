const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const registry = require('../docs/testing/config-mutation-registry.json');
const { createSyncConfigStore } = require('../src/infrastructure/sync-config-store');

function files(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  ).filter(file => /\.(?:js|ts)$/.test(file));
}

function calls(source) {
  const found = [];
  const visit = node => {
    if (ts.isCallExpression(node)) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('configuration mutation contract', () => {
  it('keeps registry writer/schema/race sets and selectors one-to-one', () => {
    const writers = registry.entries.filter(entry => entry.kind === 'writer');
    expect(new Set(writers.map(entry => entry.id)).size).toBe(writers.length);
    expect(new Set(writers.map(entry => entry.schemaId)).size).toBe(writers.length);
    expect(new Set(writers.map(entry => entry.raceId)).size).toBe(writers.length);
    const selectorKeys = Object.entries(registry.astSelectors).map(([id, item]) =>
      `${item.sourceSymbol}:${JSON.stringify(item.selector)}:${JSON.stringify(item.position)}`,
    );
    expect(new Set(selectorKeys).size).toBe(selectorKeys.length);
  });

  it('rejects deprecated snapshot writer APIs and adapter user-config persistence', () => {
    const violations = [];
    const contractFiles = [...new Set(registry.entries.map(entry => entry.sourceModule))]
      .filter(relative => fs.existsSync(path.join(root, relative)));
    for (const relative of contractFiles) {
      const file = path.join(root, relative);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const text of calls(source)) {
        if (relative !== 'src/infrastructure/sync-config-store.js' && /(?:\.|\b)(?:mutateConfig|patchSyncConfig)\s*\(/.test(text)) violations.push(`${relative}: ${text}`);
      }
      if (relative.startsWith('src/providers/adapters/') && /(?:patchAgentSelection|applyAgentBinding)\s*\(/.test(fs.readFileSync(file, 'utf8'))) {
        violations.push(`${relative}: adapter persists user config`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects invalid semantic input before any config filesystem access', async () => {
    let reads = 0;
    let writes = 0;
    const store = createSyncConfigStore({
      fs: {
        ensureDir: async () => { writes++; },
        pathExists: async () => { reads++; return false; },
        readFile: async () => { reads++; return '{}'; },
        writeFile: async () => { writes++; },
        rename: async () => { writes++; },
        remove: async () => {},
      },
      configPath: '/isolated/user.json',
      backupImportantData: async () => { writes++; },
      migrateAgentProviders: () => false,
    });
    await expect(store.setSyncPlatformField('webdav', 'unknownField', 'snapshot')).rejects.toThrow('Invalid sync platform field');
    await expect(store.enableLan({ port: 0, token: 'x' })).rejects.toThrow('Invalid LAN port');
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
  });
});
