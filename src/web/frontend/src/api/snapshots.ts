import { api } from './client';

export interface SnapshotFile {
  name: string;
  size: number;
}

export interface Snapshot {
  id: string;
  createdAt: string;
  files: SnapshotFile[];
}

export interface SnapshotDetailFile {
  name: string;
  snapshotContent: string | null;
  currentContent: string | null;
}

export async function listSnapshots(agentId: string): Promise<{ snapshots: Snapshot[] }> {
  return api(`/api/snapshots?agentId=${encodeURIComponent(agentId)}`);
}

export async function getSnapshotDetail(agentId: string, id: string): Promise<{ files: SnapshotDetailFile[] }> {
  return api(`/api/snapshots/detail?agentId=${encodeURIComponent(agentId)}&id=${encodeURIComponent(id)}`);
}

export async function restoreSnapshot(agentId: string, id: string): Promise<{ ok: boolean }> {
  return api('/api/snapshots/restore', {
    method: 'POST',
    body: JSON.stringify({ agentId, id }),
  });
}