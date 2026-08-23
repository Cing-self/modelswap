import { api, apiRaw } from './client';

export interface VaultSecret {
  key: string;
  masked: string;
  desc?: string;
  updatedAt: string;
  group?: string;
  expiresAt?: string;
}

export interface AutoCreatePlatform {
  id: string;
  label: string;
  keyHint: string;
  defaultKeyName?: string;
  groupHint: string;
  mode: 'api' | 'browser';
  permissionNote?: 'volcengine-identity' | 'openrouter-management';
  keyLimits?: Array<{
    max: number;
    scope: string;
    kind?: 'hard' | 'default' | 'observed';
  }>;
}

export async function listVault(): Promise<{ secrets: VaultSecret[] }> {
  return api('/api/vault/list');
}

export async function getVaultValue(key: string): Promise<{ value: string }> {
  return api(`/api/vault/value?key=${encodeURIComponent(key)}`);
}

export interface AgentKeyFinding {
  agentId: string;
  file: string;
  path: string;
  providerId?: string;
  masked: string;
  inVault: boolean;
  vaultKey?: string;
  // true = model-invocation key (what users want in the vault);
  // false = app credential (discord/search/mcp) — not offered for import.
  model?: boolean;
}

// Reconciliation: plaintext keys found in agent config files. Keys NOT in
// the vault are at risk — OKIT rewrites those files and could clobber them.
export async function scanAgentKeys(): Promise<{ findings: AgentKeyFinding[]; filesScanned: number }> {
  return api('/api/vault/scan-agent-keys');
}

export async function importAgentKeys(items: Array<{ agentId: string; file: string; path: string }>): Promise<{ success: boolean; created: Array<{ key: string; agentId: string; providerId?: string; masked: string; file: string }>; skipped: Array<{ agentId: string; file: string; path: string; reason: string }> }> {
  return api('/api/vault/import-agent-keys', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function setVault(data: {
  key: string;
  value: string;
  desc?: string;
  group?: string;
  originalKey?: string;
}): Promise<{ success: boolean }> {
  return api('/api/vault', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listAutoCreatePlatforms(): Promise<{ platforms: AutoCreatePlatform[] }> {
  return api('/api/vault/auto-create/platforms');
}

export async function deleteVault(key: string): Promise<{ success: boolean }> {
  return api('/api/vault', {
    method: 'DELETE',
    body: JSON.stringify({ key }),
  });
}

export async function exportVault(): Promise<Blob> {
  const res = await apiRaw('/api/vault/export');
  return res.blob();
}

export async function importVault(data: { secrets: any[] }): Promise<{ success: boolean; imported: number; skipped: number }> {
  return api('/api/vault/import', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

