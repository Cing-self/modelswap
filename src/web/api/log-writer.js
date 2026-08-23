const fs = require('fs');
const path = require('path');
const os = require('os');

const LOGS_DIR = path.join(os.homedir(), '.okit', 'logs');
const HISTORY_FILE = path.join(LOGS_DIR, 'history.jsonl');
const ROTATED_FILE = `${HISTORY_FILE}.1`;

// Rotate once the active file crosses this size — a long-lived local install
// must not grow an unbounded history file.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(HISTORY_FILE);
    if (stat.size < MAX_LOG_BYTES) return;
    fs.renameSync(HISTORY_FILE, ROTATED_FILE); // replaces the previous .1
  } catch {
    // Missing file (first write) or race — never block the append.
  }
}

/**
 * Append one operation event using the shared log schema.
 * User-facing wording is intentionally resolved by the frontend presentation
 * layer so stored events remain language-neutral and useful for diagnostics.
 */
function appendLog(action, name, success, detail) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    rotateIfNeeded();
    const entry = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      name: String(name || ''),
      action: String(action || 'unknown'),
      success: Boolean(success),
      duration: 0,
    };
    if (detail !== undefined && detail !== null && detail !== '') {
      entry.output = typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break the user operation that produced the event.
  }
}

module.exports = { appendLog, HISTORY_FILE, ROTATED_FILE, MAX_LOG_BYTES };
