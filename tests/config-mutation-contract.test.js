const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { createSyncConfigStore } = require('../src/infrastructure/sync-config-store');
const { normalizeAgentModelSelectionNamespaces } = require('../src/web/api/agent-providers');
const registry = require('../docs/testing/config-mutation-registry.json');

describe('user.json mutation boundary', () => {
  it('keeps the 41-writer AST inventory and 11 native-only rows one-to-one', () => {
    expect(registry.entries).toHaveLength(41);
    expect(new Set(registry.entries.map(([id]) => id)).size).toBe(41);
    for (const [, relative, symbol] of registry.entries) {
      const file = path.join(__dirname, '..', relative);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      let found = false;
      const visit = node => {
        if (ts.isIdentifier(node) && node.text === symbol) found = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(found, `${relative}:${symbol}`).toBe(true);
    }
    expect(registry.nativeOnlyNoUserJsonWrite).toHaveLength(11);
    const adapters = registry.nativeOnlyNoUserJsonWrite.filter(file => file.includes('/adapters/'));
    expect(adapters).toHaveLength(10);
  });

  it('exposes only semantic writer intents', () => {
    const store = createSyncConfigStore({
      fs: {}, configPath: '/isolated/user.json', backupImportantData: async () => {}, migrateAgentProviders: () => false,
    });
    expect(Object.keys(store).sort()).toEqual([
      'acceptPulledDesired', 'applyLegacyMigration', 'disableLan', 'enableLan', 'initializeLegacyClaude', 'loadConfig',
      'pairLan', 'recordLocalChange', 'recordSyncPush',
      'removeAgentSite', 'removeProviderConfiguration', 'replaceAgentState',
      'rotateLanToken', 'setLanField', 'setPlatformField', 'setPreference', 'setSyncField',
    ].sort());
  });

  it('rejects malformed semantic intent before any filesystem access', async () => {
    let accesses = 0;
    const store = createSyncConfigStore({
      fs: {
        ensureDir: async () => { accesses++; }, pathExists: async () => { accesses++; return false; },
        readFile: async () => { accesses++; return '{}'; }, writeFile: async () => { accesses++; },
        rename: async () => { accesses++; }, remove: async () => {},
      },
      configPath: '/isolated/user.json', backupImportantData: async () => { accesses++; }, migrateAgentProviders: () => false,
    });
    await expect(store.setPlatformField('webdav', 'unknown', 'snapshot')).rejects.toThrow('Invalid sync platform field');
    await expect(store.replaceAgentState('codex', { sites: { provider: { modelIds: ['bad model id'] } } })).rejects.toThrow('Invalid agent state');
    await expect(store.acceptPulledDesired('not-a-date', 'remote', 'lan', [], [])).rejects.toThrow('Invalid pulled desired state');
    expect(accesses).toBe(0);
  });

  it('serializes independent field writers against the live file', async () => {
    let data = { sync: { platforms: {} } };
    const store = createSyncConfigStore({
      fs: {
        ensureDir: async () => {}, pathExists: async () => true,
        readFile: async () => JSON.stringify(data),
        writeFile: async (_path, value) => { data = JSON.parse(value); },
        rename: async () => {}, remove: async () => {},
      },
      configPath: '/isolated/user.json', backupImportantData: async () => {}, migrateAgentProviders: () => false,
    });
    await Promise.all([
      store.setSyncField('autoSync', true),
      store.setPlatformField('supabase', 'projectId', 'project'),
      store.setPlatformField('supabase', 'apiKey', 'key'),
    ]);
    expect(data).toEqual({ sync: { autoSync: true, platforms: { supabase: { projectId: 'project', apiKey: 'key' } } } });
  });

  it('persists Google "models/" namespace healing on load and on every write', async () => {
    let data = {
      agentProviders: {
        zcode: {
          activeProviderId: 'google',
          activeModelId: 'models/gemini-3.8-flash',
          sites: { google: { modelIds: ['models/gemini-3.8-flash'], enabled: true } },
        },
      },
    };
    const store = createSyncConfigStore({
      fs: {
        ensureDir: async () => {}, pathExists: async () => true,
        readJson: async () => data,
        readFile: async () => JSON.stringify(data),
        writeFile: async (_path, value) => { data = JSON.parse(value); },
        rename: async () => {}, remove: async () => {},
      },
      configPath: '/isolated/user.json', backupImportantData: async () => {},
      migrateAgentProviders: () => false,
      normalizeAgentModelSelectionNamespaces,
    });

    const loaded = await store.loadConfig();
    expect(loaded.agentProviders.zcode.activeModelId).toBe('gemini-3.8-flash');
    expect(loaded.agentProviders.zcode.sites.google.modelIds).toEqual(['gemini-3.8-flash']);
    expect(data.agentProviders.zcode.sites.google.modelIds).toEqual(['gemini-3.8-flash']);
  });

  it('keeps every adapter native-only for user.json writes', () => {
    const adapters = fs.readdirSync(path.join(__dirname, '../src/providers/adapters')).filter(name => name.endsWith('.ts'));
    const offenders = adapters.filter(name => /(?:updateUserConfig|saveUserConfig|replaceAgentProviderState|replaceAgentState)\s*\(/.test(fs.readFileSync(path.join(__dirname, '../src/providers/adapters', name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
