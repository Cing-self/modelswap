export function appendLog(
  action: string,
  name: string,
  success: boolean,
  detail?: string | Record<string, unknown>,
): void;

export const HISTORY_FILE: string;
export const ROTATED_FILE: string;
export const MAX_LOG_BYTES: number;
