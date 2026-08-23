const fse = require("fs-extra");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_WEB = path.join(ROOT, "src", "web");
const DIST_WEB = path.join(ROOT, "dist", "web");

async function main() {
  await fse.ensureDir(DIST_WEB);
  await fse.copyFile(path.join(SRC_WEB, "server.js"), path.join(DIST_WEB, "server.js"));
  await fse.remove(path.join(DIST_WEB, "api"));
  await fse.copy(path.join(SRC_WEB, "api"), path.join(DIST_WEB, "api"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});