import fs from "fs-extra";
import path from "path";
import os from "os";
import { atomicWrite } from "../utils/atomicWrite";

export type SnapshotMeta = { id: string; createdAt: string; files: { name: string; size: number }[] };

const DEFAULT_ROOT = path.join(os.homedir(), ".okit");
const SNAPSHOTS_DIR_NAME = "agent-snapshots";
const MAX_SNAPSHOTS = 10;

// Relative (to os.homedir()) config files owned by each agent. These are the
// files a switch rewrites, so they are the ones we snapshot before a switch.
const AGENT_CONFIG_FILES: Record<string, string[]> = {
  claude: [".claude/settings.json", ".claude/.credentials.json", ".claude/.okit-key-helper.sh"],
  codex: [".codex/config.toml", ".codex/auth.json", ".codex/model-catalogs/model-catalogs.json"],
  grok: [".grok/config.toml"],
  "kimi-code": [".kimi-code/config.toml"],
  "mimo-code": [".config/mimocode/mimocode.jsonc"],
  opencode: [".config/opencode/opencode.json", ".local/share/opencode/auth.json"],
  openclaw: [".openclaw/openclaw.json"],
  hermes: [".hermes/config.yaml"],
  workbuddy: [".workbuddy/models.json"],
  zcode: [".zcode/v2/config.json", ".zcode/cli/config.json"],
};

const AGENT_ID_RE = /^[a-z0-9-]+$/;
const SNAPSHOT_ID_RE = /^[a-zA-Z0-9-]+$/;

function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}

function validateSnapshotId(id: string): void {
  if (typeof id !== "string" || !SNAPSHOT_ID_RE.test(id)) {
    throw new Error(`Invalid snapshot id: ${id}`);
  }
}

function snapshotRoot(rootDir?: string): string {
  return path.join(rootDir || DEFAULT_ROOT, SNAPSHOTS_DIR_NAME);
}

export function agentConfigFiles(agentId: string): string[] {
  validateAgentId(agentId);
  const relPaths = AGENT_CONFIG_FILES[agentId];
  if (!relPaths) return [];
  return relPaths.map(p => path.join(os.homedir(), p));
}

// Names used to store config files inside a snapshot directory. Basenames must
// be unique there — zcode owns TWO files called config.json
// (~/.zcode/v2/config.json and ~/.zcode/cli/config.json), and storing both
// under the bare basename made the second write silently overwrite the first
// (snapshots captured only one file, restores could only put one back).
// Duplicate basenames are disambiguated by prefixing the parent directory:
// v2__config.json / cli__config.json. Agents with unique basenames are
// unaffected, so existing snapshots stay readable.
function storageNamesFor(agentId: string): { abs: string; name: string }[] {
  const absPaths = agentConfigFiles(agentId);
  const counts = new Map<string, number>();
  for (const abs of absPaths) {
    const base = path.basename(abs);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  return absPaths.map(abs => {
    const base = path.basename(abs);
    if ((counts.get(base) || 0) > 1) {
      return { abs, name: `${path.basename(path.dirname(abs))}__${base}` };
    }
    return { abs, name: base };
  });
}

async function listSnapshotIds(agentDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(agentDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(path.join(agentDir, entry));
    } catch {
      continue;
    }
    if (stat.isDirectory()) ids.push(entry);
  }
  return ids.sort((a, b) => b.localeCompare(a));
}

// Captures the agent's current config files as a new snapshot. `protectId`
// names a snapshot that must survive retention pruning even when it is the
// oldest — used before a restore so the capture cannot evict the very
// snapshot we are about to read back.
export async function capturePreSwitchSnapshot(
  agentId: string,
  rootDir?: string,
  protectId?: string,
): Promise<string | null> {
  validateAgentId(agentId);
  const candidates = storageNamesFor(agentId);
  const existing: { abs: string; name: string }[] = [];
  for (const { abs, name } of candidates) {
    if (await fs.pathExists(abs)) {
      existing.push({ abs, name });
    }
  }
  if (existing.length === 0) return null;

  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(snapshotRoot(rootDir), agentId, id);
  await fs.ensureDir(dir);
  await fs.chmod(dir, 0o700);

  for (const { abs, name } of existing) {
    const content = await fs.readFile(abs, "utf-8");
    await fs.writeFile(path.join(dir, name), content);
  }

  const agentDir = path.dirname(dir);
  const ids = await listSnapshotIds(agentDir);
  for (const oldId of ids.slice(MAX_SNAPSHOTS)) {
    if (protectId && oldId === protectId) continue;
    await fs.remove(path.join(agentDir, oldId));
  }

  return id;
}

export async function listSnapshots(agentId: string, rootDir?: string): Promise<SnapshotMeta[]> {
  validateAgentId(agentId);
  const agentDir = path.join(snapshotRoot(rootDir), agentId);
  const ids = await listSnapshotIds(agentDir);

  const metas: SnapshotMeta[] = [];
  for (const id of ids) {
    const dir = path.join(agentDir, id);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const fileInfos: { name: string; size: number }[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: { isDirectory(): boolean; size: number };
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) fileInfos.push({ name: entry, size: stat.size });
    }
    metas.push({
      id,
      createdAt: id,
      files: fileInfos.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshotFiles(
  agentId: string,
  id: string,
  rootDir?: string,
): Promise<{ name: string; content: string }[]> {
  validateAgentId(agentId);
  validateSnapshotId(id);
  const dir = path.join(snapshotRoot(rootDir), agentId, id);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(`Snapshot not found: ${agentId}/${id}`);
  }
  const out: { name: string; content: string }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) out.push({ name: entry, content: await fs.readFile(full, "utf-8") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCurrentFiles(
  agentId: string,
  rootDir?: string,
): Promise<{ name: string; content: string | null }[]> {
  validateAgentId(agentId);
  const out: { name: string; content: string | null }[] = [];
  for (const { abs, name } of storageNamesFor(agentId)) {
    if (await fs.pathExists(abs)) {
      out.push({ name, content: await fs.readFile(abs, "utf-8") });
    } else {
      out.push({ name, content: null });
    }
  }
  return out;
}

export async function restoreSnapshot(agentId: string, id: string, rootDir?: string): Promise<void> {
  validateAgentId(agentId);
  validateSnapshotId(id);
  const dir = path.join(snapshotRoot(rootDir), agentId, id);
  const named = storageNamesFor(agentId);
  // Exact storage-name match first (current format).
  const targetByName = new Map(named.map(n => [n.name, n.abs] as const));
  // Legacy fallback: snapshots written before duplicate-basename handling
  // stored bare basenames. Map those to the LAST config file carrying that
  // basename — matching the old (lossy) capture order, where the later file
  // overwrote the earlier one inside the snapshot.
  const targetByBase = new Map<string, string>();
  for (const n of named) {
    targetByBase.set(path.basename(n.abs), n.abs);
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(`Snapshot not found: ${agentId}/${id}`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) continue;
    const target = targetByName.get(entry) ?? targetByBase.get(entry);
    if (!target) continue;
    const content = await fs.readFile(full, "utf-8");
    await atomicWrite(target, content);
  }
}