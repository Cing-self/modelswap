// Real-signal fixture for the P1 cleanup test (not collected by vitest).
//
// The process registers the production signal cleanup against a fake driver
// whose dispose removes a temp profile directory, then delivers a REAL
// SIGINT/SIGTERM to itself. The parent test asserts exit code 130/143, the
// DISPOSED marker, and that the directory is gone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSignalCleanup } from '../../scripts/lib/live-acceptance/signals.mjs';

const signal = process.argv[2] === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sig-'));
fs.writeFileSync(path.join(dir, 'marker.txt'), 'throwaway');

const driver = {
  async dispose() {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('DISPOSED');
  },
};

registerSignalCleanup({ driver });
console.log(`READY ${dir}`);
setTimeout(() => process.kill(process.pid, signal), 50);
setTimeout(() => {
  console.log('NO-EXIT-WITHIN-BUDGET');
  process.exit(9);
}, 8000);
