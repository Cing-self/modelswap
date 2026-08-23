import { api } from './client';

export interface LogEntry {
  timestamp: string;
  name: string;
  action: string;
  success: boolean;
  duration?: number;
  command?: string;
  output?: string;
  message?: string;
}

export async function getLogs(): Promise<LogEntry[]> {
  const data = await api('/api/logs') as any;
  return data.logs || [];
}
