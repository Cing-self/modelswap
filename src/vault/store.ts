import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import os from "os";
import { OKIT_DIR } from "../config/registry";
import { backupImportantData } from "../config/backup";
import { atomicWrite, atomicWriteJSON } from "../utils/atomicWrite";

const VAULT_DIR = path.join(OKIT_DIR, "vault");
const SECRETS_FILE = path.join(VAULT_DIR, "secrets.enc");
const MASTER_KEY_FILE = path.join(VAULT_DIR, "master.key");
const REGISTRY_FILE = path.join(VAULT_DIR, "registry.json");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export interface SecretEntry {
  key: string;       // e.g. "GITHUB_TOKEN"
  value: string;     // plaintext (only in memory after decrypt)
  desc?: string;     // optional user-facing description
  group?: string;    // freeform group name, e.g. "OpenAI", "Stripe", empty = ungrouped
  expiresAt?: string; // ISO date when the secret expires, empty = no expiry
  createdAt: string;
  updatedAt: string;
}

export interface VaultData {
  secrets: SecretEntry[];
}

// Derive encryption key from machine fingerprint
function deriveMasterKey(): Buffer {
  const fp = path.join(VAULT_DIR, "master.key");
  if (fs.existsSync(fp)) {
    return Buffer.from(fs.readFileSync(fp, "utf-8"), "hex");
  }

  // Generate from machine identity
  const identity = `${os.hostname()}:${os.userInfo().username}:okit-vault`;
  const key = crypto.pbkdf2Sync(identity, "okit-vault-salt", 100000, KEY_LENGTH, "sha256");

  fs.ensureDirSync(VAULT_DIR);
  const tmp = fp + ".okit-tmp";
  fs.writeFileSync(tmp, key.toString("hex"), { mode: 0o600 });
  fs.renameSync(tmp, fp);
  return key;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(data: string, key: Buffer): string {
  const parts = data.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted data format");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

function maskValue(value: string): string {
  if (value.length <= 6) return "***";
  return value.slice(0, 3) + "***" + value.slice(-3);
}

export class VaultStore {
  private key: Buffer;
  private data: VaultData | null = null;
  private cacheStamp: string | null = null;

  constructor() {
    fs.ensureDirSync(VAULT_DIR);
    this.key = deriveMasterKey();
  }

  private async getCacheStamp(): Promise<string> {
    const [secretsStat, registryStat] = await Promise.all([
      fs.stat(SECRETS_FILE).catch(() => null),
      fs.stat(REGISTRY_FILE).catch(() => null),
    ]);
    return [
      secretsStat ? `${secretsStat.mtimeMs}:${secretsStat.size}` : "missing",
      registryStat ? `${registryStat.mtimeMs}:${registryStat.size}` : "missing",
    ].join("|");
  }

  private async load(): Promise<VaultData> {
    const stamp = await this.getCacheStamp();
    if (this.data && this.cacheStamp === stamp) return this.data;

    let secrets: SecretEntry[] = [];

    if (await fs.pathExists(SECRETS_FILE)) {
      const raw = await fs.readFile(SECRETS_FILE, "utf-8");
      const decrypted = decrypt(raw, this.key);
      const stored = JSON.parse(decrypted) as Array<SecretEntry & { alias?: string }>;
      const byKey = new Map<string, SecretEntry & { legacyAlias?: string }>();
      for (const raw of stored) {
        const legacyAlias = raw.alias || 'default';
        const normalized: SecretEntry & { legacyAlias?: string } = {
          key: raw.key,
          value: raw.value,
          desc: raw.desc || (legacyAlias !== 'default' ? legacyAlias : ''),
          group: raw.group || '',
          expiresAt: raw.expiresAt || '',
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          legacyAlias,
        };
        const existing = byKey.get(raw.key);
        if (!existing || (existing.legacyAlias !== 'default' && legacyAlias === 'default')) {
          byKey.set(raw.key, normalized);
        }
      }
      secrets = [...byKey.values()].map(({ legacyAlias: _legacyAlias, ...secret }) => secret);
    }

    if (await fs.pathExists(REGISTRY_FILE)) {
      const reg = await fs.readFile(REGISTRY_FILE, "utf-8");
      }

    this.data = { secrets };
    this.cacheStamp = stamp;

    return this.data!;
  }

  async reload(): Promise<void> {
    this.data = null;
    await this.load();
  }

  private async save(): Promise<void> {
    if (!this.data) return;

    await backupImportantData("vault");

    // Encrypt secrets
    const secretsJson = JSON.stringify(this.data.secrets);
    const encrypted = encrypt(secretsJson, this.key);
    await atomicWrite(SECRETS_FILE, encrypted);

    this.cacheStamp = await this.getCacheStamp();
  }

  async set(key: string, value: string, group?: string, expiresAt?: string, desc?: string): Promise<void> {
    const data = await this.load();
    const now = new Date().toISOString();

    const existing = data.secrets.find((s) => s.key === key);
    if (existing) {
      existing.value = value;
      if (group !== undefined) existing.group = group;
      if (expiresAt !== undefined) existing.expiresAt = expiresAt;
      if (desc !== undefined) existing.desc = desc;
      existing.updatedAt = now;
    } else {
      data.secrets.push({ key, value, desc: desc || '', group: group || '', expiresAt: expiresAt || '', createdAt: now, updatedAt: now });
    }

    await this.save();
  }

  async get(key: string): Promise<string | null> {
    const data = await this.load();
    const entry = data.secrets.find((s) => s.key === key);
    return entry?.value ?? null;
  }

  async delete(key: string): Promise<boolean> {
    const data = await this.load();
    const idx = data.secrets.findIndex((s) => s.key === key);
    if (idx === -1) return false;
    data.secrets.splice(idx, 1);
    await this.save();
    return true;
  }

  async list(): Promise<Array<{ key: string; masked: string; desc: string; group: string; expiresAt: string; updatedAt: string }>> {
    const data = await this.load();
    return data.secrets.map((s) => ({
      key: s.key,
      masked: maskValue(s.value),
      desc: s.desc || '',
      group: s.group || '',
      expiresAt: s.expiresAt || '',
      updatedAt: s.updatedAt,
    }));
  }

  async exportAll(): Promise<Array<{ key: string; value: string; desc: string; group: string; expiresAt: string; updatedAt: string }>> {
    const data = await this.load();
    return data.secrets.map((s) => ({
      key: s.key,
      value: s.value,
      desc: s.desc || '',
      group: s.group || '',
      expiresAt: s.expiresAt || '',
      updatedAt: s.updatedAt,
    }));
  }

}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
