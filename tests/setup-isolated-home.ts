import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";

// Tests exercise CommonJS API modules that resolve ~/.okit at import time.
// Keep every worker in its own HOME so an incomplete mock can never write a
// developer's vault, provider file, sync payload, or history log.
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "okit-vitest-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

afterAll(() => {
  if (process.env.HOME === testHome) {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  if (process.env.USERPROFILE === testHome) {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
  fs.rmSync(testHome, { recursive: true, force: true });
});
