import { api } from './client';

export interface PlatformConfig {
  enabled: boolean;
  [key: string]: any;
}

export interface Settings {
  sync: {
    autoSync: boolean;
    syncPlatform?: string;
    password?: string;
    platforms: Record<string, PlatformConfig>;
  };
}

export async function getSettings(): Promise<Settings> {
  return api('/api/settings');
}

export type SettingsOperation =
  | { kind: 'sync'; field: 'autoSync' | 'password' | 'syncPlatform'; value: string | boolean }
  | { kind: 'platform'; platformId: string; field: string; value: string | boolean }
  | { kind: 'lan'; field: 'enabled' | 'port' | 'token'; value: string | boolean | number };

export async function updateSettings(operations: SettingsOperation[]): Promise<{ ok: boolean }> {
  return api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ operations }),
  });
}

export async function testPlatform(platform: string): Promise<{ success: boolean; message: string }> {
  return api('/api/settings/test', {
    method: 'POST',
    body: JSON.stringify({ platform }),
  });
}

export async function getOnboarding(): Promise<any> {
  return api('/api/settings/onboarding');
}

export async function dismissOnboarding(): Promise<any> {
  return api('/api/settings/onboarding/dismiss', { method: 'POST' });
}

export async function resetOnboarding(): Promise<any> {
  return api('/api/settings/onboarding/reset', { method: 'POST' });
}

export async function getPresets(): Promise<any> {
  return api('/api/settings/presets');
}
