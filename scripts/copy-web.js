const fse = require("fs-extra");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_WEB = path.join(ROOT, "src", "web");
const DIST_WEB = path.join(ROOT, "dist", "web");
const RUNTIME_DIRECTORIES = ["application", "infrastructure"];

async function main() {
  await fse.ensureDir(DIST_WEB);
  await fse.copyFile(path.join(SRC_WEB, "server.js"), path.join(DIST_WEB, "server.js"));
  await fse.remove(path.join(DIST_WEB, "api"));
  await fse.copy(path.join(SRC_WEB, "api"), path.join(DIST_WEB, "api"));

  // These CommonJS runtime layers deliberately stay out of TypeScript's emit.
  // Web controllers and the provider CLI load them from dist/, so refresh them
  // alongside web/api rather than relying on source files being present.
  for (const directory of RUNTIME_DIRECTORIES) {
    const source = path.join(ROOT, "src", directory);
    const destination = path.join(ROOT, "dist", directory);
    await fse.remove(destination);
    await fse.copy(source, destination);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
