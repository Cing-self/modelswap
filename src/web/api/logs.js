const fs = require('fs');
const path = require('path');
const os = require('os');

const LOGS_DIR = path.join(os.homedir(), '.okit', 'logs');
const HISTORY_FILE = path.join(LOGS_DIR, 'history.jsonl');

// Read at most this many bytes from the tail of the history file. The log UI
// shows the newest events; loading a multi-MB file synchronously on every
// request freezes the dashboard for no benefit.
const MAX_READ_BYTES = 512 * 1024;

const SECRET_PREFIX_PATTERN = /\b(?:npm_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+)\b/gi;
const SECRET_FIELD_PATTERN = /((?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|secret(?:[_-]?key)?|password|authorization|_authToken)\s*[:=]\s*['"]?)([^'"\s,;&]{8,})/gi;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function redactText(value) {
  return String(value)
    .replace(AUTH_HEADER_PATTERN, '$1 [REDACTED]')
    .replace(SECRET_FIELD_PATTERN, '$1[REDACTED]')
    .replace(SECRET_PREFIX_PATTERN, '[REDACTED]');
}

function redactLog(log) {
  const safe = { ...log };
  for (const field of ['command', 'output', 'message', 'target']) {
    if (typeof safe[field] === 'string') safe[field] = redactText(safe[field]);
  }
  return safe;
}

// Tail-read the newest portion of the file. When the file is larger than
// MAX_READ_BYTES we start mid-file; drop the first (partial) line so only
// complete JSON lines are parsed.
function readTailContent(file) {
  const stat = fs.statSync(file);
  if (stat.size <= MAX_READ_BYTES) {
    return fs.readFileSync(file, 'utf8');
  }
  const fd = fs.openSync(file, 'r');
  try {
    const length = MAX_READ_BYTES;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    let text = buffer.toString('utf8');
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

// Newest N failed operations — powers the diagnostics summary so support
// requests come with the actual recent errors instead of "it broke".
function recentFailures(count = 5) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const content = readTailContent(HISTORY_FILE);
    return content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean).filter(l => l.success === false)
      .slice(0, count)
      .map(l => redactLog(l));
  } catch {
    return [];
  }
}

async function getLogs(req, res) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return res.json({ logs: [] });
    }
    const content = readTailContent(HISTORY_FILE);
    const logs = content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean).reverse().map(redactLog);

    res.json({ logs });
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs' });
  }
}

module.exports = { getLogs, redactLog, recentFailures };
