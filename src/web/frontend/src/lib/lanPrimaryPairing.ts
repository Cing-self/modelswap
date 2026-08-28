export interface LanListenerStatus {
  running: boolean;
  error?: string | null;
}

export interface LanPairingCode {
  address: string;
  code: string;
}

export interface LanPairingSession {
  success: boolean;
  expiresAt: string;
  codes: LanPairingCode[];
}

export interface EnablePrimaryPairingInput {
  needsPasswordSave: boolean;
  savePassword: () => Promise<boolean>;
  enableListener: () => Promise<LanListenerStatus>;
  createPairing: () => Promise<LanPairingSession>;
}

/** A primary pairing only succeeds when the listener is live and returns a code. */
export async function createPrimaryPairing(
  status: LanListenerStatus,
  create: () => Promise<LanPairingSession>,
): Promise<LanPairingSession> {
  if (!status.running) {
    throw new Error(status.error || '局域网同步服务未启动，无法生成配对码');
  }

  const session = await create();
  if (!Array.isArray(session?.codes) || !session.codes.some(item => item?.code)) {
    throw new Error('未生成可用配对码，请检查网络后重试');
  }
  return session;
}

/**
 * First-time primary pairing has three dependent operations.  This is kept as
 * a small, dependency-injected flow so the actual modal path can be tested
 * without a browser, real password, or LAN listener.
 */
export async function enableAndCreatePrimaryPairing({
  needsPasswordSave,
  savePassword,
  enableListener,
  createPairing,
}: EnablePrimaryPairingInput): Promise<LanPairingSession | null> {
  if (needsPasswordSave && !(await savePassword())) return null;
  const status = await enableListener();
  return createPrimaryPairing(status, createPairing);
}
