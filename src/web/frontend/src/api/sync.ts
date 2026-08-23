import { api } from './client';

export async function pushSync(): Promise<{ success: boolean; message: string; secrets?: number; platform?: string }> {
  return api('/api/sync/push', { method: 'POST' });
}

export async function pullSync(): Promise<{ success: boolean; message: string; added: number; updated: number; providers?: number; total: number }> {
  return api('/api/sync/pull', { method: 'POST' });
}

export async function getSyncStatus(): Promise<{ machineId: string | null; machineName: string | null; lastSyncAt: string | null; platformId: string | null; platforms: string[]; hasPassword: boolean; autoSync: boolean; autoBusy: boolean; localDirty: boolean }> {
  return api('/api/sync/status');
}

export async function exportSyncCode(password?: string): Promise<{ success: boolean; code: string; platform: string; secrets: number }> {
  return api('/api/sync/code/export', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function importSyncCode(code: string, password: string): Promise<{ success: boolean; platform: string; secrets: number }> {
  return api('/api/sync/code/import', {
    method: 'POST',
    body: JSON.stringify({ code, password }),
  });
}

export interface LanSyncStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  error: string | null;
  addresses: string[];
  codes: { address: string; code: string }[];
  peer: string | null;
  platformEnabled: boolean;
  hasPassword: boolean;
  autoSync: boolean;
  machineName: string;
}

export async function getLanSyncStatus(): Promise<LanSyncStatus> {
  return api('/api/sync/lan/status');
}

export async function enableLanSync(port?: number): Promise<LanSyncStatus & { success: boolean; autoSyncTurnedOn?: boolean }> {
  return api('/api/sync/lan/enable', {
    method: 'POST',
    body: JSON.stringify({ port }),
  });
}

export async function disableLanSync(): Promise<LanSyncStatus & { success: boolean }> {
  return api('/api/sync/lan/disable', { method: 'POST' });
}

export async function regenerateLanToken(): Promise<LanSyncStatus & { success: boolean }> {
  return api('/api/sync/lan/regenerate', { method: 'POST' });
}

export async function pairLanDevice(code: string): Promise<{ success: boolean; peerName: string; machineId: string | null; hubDisabled: boolean; autoSyncTurnedOn: boolean }> {
  return api('/api/sync/lan/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export interface SyncOverviewDevice {
  id: string;
  name: string;
  address: string;
  lastSeen: string;
  online: boolean;
}

export interface SyncOverview {
  machine: { id: string | null; name: string; role: 'hub' | 'spoke' | 'none' };
  hasPassword: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  lan: { enabled: boolean; running: boolean; port: number; error: string | null; codes: { address: string; code: string }[] };
  peer: { online: boolean; url: string; name?: string; id?: string | null } | null;
  devices: SyncOverviewDevice[];
  cloudPlatforms: string[];
  lanPlatformEnabled: boolean;
  lanPlatformUrl: string | null;
}

export async function getSyncOverview(): Promise<SyncOverview> {
  return api('/api/sync/overview');
}

export interface LanPairingSession {
  success: boolean;
  expiresAt: string;
  codes: { address: string; code: string }[];
}

export async function createLanPairing(): Promise<LanPairingSession> {
  return api('/api/sync/lan/pairing', { method: 'POST' });
}

export async function getLanPairing(): Promise<{ active: boolean; expiresAt?: string; codes?: { address: string; code: string }[] }> {
  return api('/api/sync/lan/pairing');
}
