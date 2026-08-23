const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const OKIT_DIR = path.join(os.homedir(), '.okit');
const BACKUP_DIR = path.join(OKIT_DIR, 'backups');
const MAX_BACKUPS = 3;
const IMPORTANT_FILES = [
  'user.json',
  'providers.json',
  path.join('vault', 'secrets.enc'),
  path.join('vault', 'master.key'),
  path.join('vault', 'registry.json'),
];

function safeReason(reason) {
  return String(reason || 'data').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'data';
}

async function backupImportantData(reason = 'data') {
  try {
    await fs.ensureDir(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotDir = path.join(BACKUP_DIR, `${stamp}-${safeReason(reason)}`);
    let copied = 0;

    for (const relPath of IMPORTANT_FILES) {
      const src = path.join(OKIT_DIR, relPath);
      if (!(await fs.pathExists(src))) continue;
      const dest = path.join(snapshotDir, relPath);
      await fs.ensureDir(path.dirname(dest));
      await fs.copy(src, dest);
      copied++;
    }

    if (copied === 0) return null;
    await pruneBackups();
    return snapshotDir;
  } catch {
    return null;
  }
}

async function pruneBackups() {
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  for (const name of dirs.slice(MAX_BACKUPS)) {
    await fs.remove(path.join(BACKUP_DIR, name));
  }
}

module.exports = { backupImportantData };
