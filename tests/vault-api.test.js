import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'module';
import fse from 'fs-extra';

const mockStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getBindings: vi.fn(),
};
const mockScheduler = {
  markDirty: vi.fn(),
};
function MockVaultStore() { return mockStore; }

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../../vault/store') return { VaultStore: MockVaultStore };
  if (id === './sync-scheduler') return mockScheduler;
  return origRequire.apply(this, arguments);
};

vi.spyOn(fse, 'existsSync').mockReturnValue(false);
vi.spyOn(fse, 'mkdirSync').mockReturnValue(undefined);
vi.spyOn(fse, 'appendFileSync').mockReturnValue(undefined);
vi.spyOn(fse, 'readJson').mockResolvedValue({});

const { listVault, setVault, deleteVault } = await import('../src/web/api/vault.js');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fse.existsSync.mockReturnValue(false);
});

describe('vault api setVault', () => {
  it('moves an edited secret when its key changes and saves its description', async () => {
    mockStore.get
      .mockResolvedValueOnce('old-value')
      .mockResolvedValueOnce(null);
    const res = createResponse();

    await setVault({
      body: {
        key: 'NEW_KEY',
        value: 'new-value',
        desc: 'Production credential',
        group: 'NPM',
        originalKey: 'OLD_KEY',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, key: 'NEW_KEY', desc: 'Production credential' });
    expect(mockStore.get).toHaveBeenNthCalledWith(1, 'OLD_KEY');
    expect(mockStore.get).toHaveBeenNthCalledWith(2, 'NEW_KEY');
    expect(mockStore.set).toHaveBeenCalledWith('NEW_KEY', 'new-value', 'NPM', undefined, 'Production credential');
    expect(mockStore.delete).toHaveBeenCalledWith('OLD_KEY');
  });

  it('repairs a legacy Kimi Coding Plan group when saving', async () => {
    const res = createResponse();

    await setVault({
      body: {
        key: 'KIMI_CODE_API_KEY-abc123',
        value: 'sk-kimi-test',
        group: 'Kimi 国际',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(mockStore.set).toHaveBeenCalledWith('KIMI_CODE_API_KEY-abc123', 'sk-kimi-test', 'Kimi', undefined, undefined);
  });

  it('repairs a legacy MiMo Token Plan group when saving', async () => {
    const res = createResponse();

    await setVault({
      body: {
        key: 'XIAOMI_MIMO_TOKEN_PLAN_API_KEY',
        value: 'tp-mimo-test',
        group: '小米 MiMo Token Plan',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(mockStore.set).toHaveBeenCalledWith('XIAOMI_MIMO_TOKEN_PLAN_API_KEY', 'tp-mimo-test', '小米 MiMo', undefined, undefined);
  });

  it('repairs a legacy StepFun group when saving', async () => {
    const res = createResponse();

    await setVault({
      body: {
        key: 'STEPFUN_API_KEY-new',
        value: 'stepfun-test-key',
        group: 'StepFun',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(mockStore.set).toHaveBeenCalledWith('STEPFUN_API_KEY-new', 'stepfun-test-key', '阶跃星辰', undefined, undefined);
  });

  it('rejects editing onto an existing target secret', async () => {
    mockStore.get
      .mockResolvedValueOnce('old-value')
      .mockResolvedValueOnce('existing-value');
    const res = createResponse();

    await setVault({
      body: {
        key: 'EXISTING_KEY',
        value: 'new-value',
        originalKey: 'OLD_KEY',
      },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('already exists');
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.delete).not.toHaveBeenCalled();
  });
});

describe('vault api key records', () => {
  it('lists one key with its optional description', async () => {
    mockStore.list.mockResolvedValue([{
      key: 'SERVICE_KEY',
      masked: 'sk-***123',
      desc: 'Production',
      group: 'AI',
      expiresAt: '',
      updatedAt: '2026-08-13T00:00:00.000Z',
    }]);
    mockStore.getBindings.mockResolvedValue([]);
    const res = createResponse();

    await listVault({}, res);

    expect(res.body.secrets).toEqual([
      expect.objectContaining({ key: 'SERVICE_KEY', desc: 'Production', masked: 'sk-***123' }),
    ]);
  });

  it('repairs a legacy Kimi Coding Plan group in list responses', async () => {
    mockStore.list.mockResolvedValue([{
      key: 'KIMI_CODE_API_KEY-abc123',
      masked: 'sk-***123',
      desc: '',
      group: 'Kimi 国际',
      expiresAt: '',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }]);
    mockStore.getBindings.mockResolvedValue([]);
    const res = createResponse();

    await listVault({}, res);

    expect(res.body.secrets[0].group).toBe('Kimi');
  });

  it('repairs a legacy MiMo Token Plan group in list responses', async () => {
    mockStore.list.mockResolvedValue([{
      key: 'XIAOMI_MIMO_TOKEN_PLAN_API_KEY',
      masked: 'tp-***123',
      desc: '',
      group: '小米 MiMo Token Plan',
      expiresAt: '',
      updatedAt: '2026-08-16T00:00:00.000Z',
    }]);
    mockStore.getBindings.mockResolvedValue([]);
    const res = createResponse();

    await listVault({}, res);

    expect(res.body.secrets[0].group).toBe('小米 MiMo');
  });

  it('repairs a legacy StepFun group in list responses', async () => {
    mockStore.list.mockResolvedValue([{
      key: 'STEPFUN_API_KEY-new',
      masked: 'abc***xyz',
      desc: '',
      group: 'StepFun',
      expiresAt: '',
      updatedAt: '2026-08-16T00:00:00.000Z',
    }]);
    mockStore.getBindings.mockResolvedValue([]);
    const res = createResponse();

    await listVault({}, res);

    expect(res.body.secrets[0].group).toBe('阶跃星辰');
  });

  it('deletes a key directly without alias lookup', async () => {
    mockStore.delete.mockResolvedValue(true);
    const res = createResponse();

    await deleteVault({ body: { key: 'SERVICE_KEY' } }, res);

    expect(res.body).toEqual({ success: true });
    expect(mockStore.delete).toHaveBeenCalledWith('SERVICE_KEY');
  });
});

describe('vault auto sync', () => {
  it('marks the secrets section dirty after a successful set', async () => {
    const res = createResponse();

    await setVault({ body: { key: 'SERVICE_KEY', value: 'v' } }, res);

    expect(res.body.success).toBe(true);
    expect(mockScheduler.markDirty).toHaveBeenCalledWith('secrets');
  });

  it('marks the secrets section dirty after a successful delete', async () => {
    mockStore.delete.mockResolvedValue(true);
    const res = createResponse();

    await deleteVault({ body: { key: 'SERVICE_KEY' } }, res);

    expect(res.body).toEqual({ success: true });
    expect(mockScheduler.markDirty).toHaveBeenCalledWith('secrets');
  });

  it('does not mark dirty when the delete target is missing', async () => {
    mockStore.delete.mockResolvedValue(false);
    const res = createResponse();

    await deleteVault({ body: { key: 'SERVICE_KEY' } }, res);

    expect(res.statusCode).toBe(404);
    expect(mockScheduler.markDirty).not.toHaveBeenCalled();
  });
});
