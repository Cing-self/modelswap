const path = require('path');
const {
  assertConfigMutationContract,
  collectProductionSources,
} = require('../scripts/check-config-mutation-contract');

describe('user config mutation contract', () => {
  it('accepts the production source tree', () => {
    expect(() => assertConfigMutationContract(collectProductionSources(path.resolve(__dirname, '..')))).not.toThrow();
  });

  it('rejects an injected queue-external read and full snapshot save', () => {
    expect(() => assertConfigMutationContract({
      '/fixture.js': 'async function bad(core) { const config = await core.loadConfig(); await core.saveConfig(config); }',
    })).toThrow(/deprecated generic user config save API|load→save user config snapshot/);
  });
});
