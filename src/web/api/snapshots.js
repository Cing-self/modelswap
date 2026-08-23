const { listSnapshots, getSnapshotFiles, getCurrentFiles, restoreSnapshot, capturePreSwitchSnapshot } = require('../../providers/snapshots');
const { appendLog } = require('./log-writer');

const AGENT_ID_RE = /^[a-z0-9-]+$/;
const SNAPSHOT_ID_RE = /^[a-zA-Z0-9-]+$/;

function requireAgentId(agentId) {
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    throw new Error('missing or invalid agentId');
  }
}

function requireSnapshotId(id) {
  if (!id || !SNAPSHOT_ID_RE.test(id)) {
    throw new Error('missing or invalid snapshot id');
  }
}

async function listSnapshotsHandler(req, res) {
  try {
    const { agentId } = req.query;
    requireAgentId(agentId);
    const snapshots = await listSnapshots(agentId);
    res.json({ snapshots });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function snapshotDetailHandler(req, res) {
  try {
    const { agentId, id } = req.query;
    requireAgentId(agentId);
    requireSnapshotId(id);
    const snapshotFiles = await getSnapshotFiles(agentId, id);
    const currentFiles = await getCurrentFiles(agentId);
    const currentByName = new Map(currentFiles.map(f => [f.name, f.content]));
    const files = snapshotFiles.map(f => ({
      name: f.name,
      snapshotContent: f.content,
      currentContent: currentByName.get(f.name) ?? null,
    }));
    res.json({ files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function restoreSnapshotHandler(req, res) {
  try {
    const { agentId, id } = req.body || {};
    requireAgentId(agentId);
    requireSnapshotId(id);
    // Snapshot the state we are about to leave so a restore is reversible.
    // Protect the restore target from retention pruning; a failed capture
    // warns but must not block the restore itself.
    try {
      await capturePreSwitchSnapshot(agentId, undefined, id);
    } catch (e) {
      console.warn(`[snapshots] pre-restore capture failed: ${e.message}`);
    }
    await restoreSnapshot(agentId, id);
    appendLog('snapshot-restore', `${agentId}:${id}`, true);
    res.json({ ok: true });
  } catch (err) {
    appendLog('snapshot-restore', `${agentId}:${id}`, false, err.message);
    res.status(400).json({ error: err.message });
  }
}

module.exports = { listSnapshotsHandler, snapshotDetailHandler, restoreSnapshotHandler };