// Must be the first import of every entry point (CLI, web server, desktop
// app): it migrates the legacy ~/.okit data dir into ~/.modelswap before any
// store constructor can auto-initialize a fresh vault key or preset providers
// in the new location. Entry points that cannot control import order should
// call migrateLegacyOkitDir() themselves instead (see VaultStore).
import { migrateLegacyOkitDir } from "./registry";

migrateLegacyOkitDir();
